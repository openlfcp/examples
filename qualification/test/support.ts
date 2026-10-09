// Shared setup of the two-vault qualification (LFCP-02-056): durable,
// sealed vaults, section sides, and the create/host/invite/join path of
// MVP-0.2-TEST-AND-RELEASE-PLAN §7 steps 1–3, on the real SDK and the Rust
// reference server.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  acceptInvitation,
  createInvitation,
  type StatusEvent,
  type SyncEvent,
  type WebSocketFactory,
} from "@openlfcp/client";
import type { ResourceId } from "@openlfcp/core";
import { localStateCipher, type ResourceDEK } from "@openlfcp/crypto";
import { createTask } from "@openlfcp/shared-objects";
import {
  SECTIONS_PROFILE_ID,
  type SectionIntent,
  SectionReplica,
  SharedSectionsDataProfile,
} from "@openlfcp/shared-objects/sections";
import type { LfcpStorage, SecretStore } from "@openlfcp/storage";
import { FileSecretStore, SqliteLfcpStorage } from "@openlfcp/storage-node";
import {
  createResource,
  type Party,
  Side,
  sleep,
  waitFor,
} from "../../../sdk-ts/conformance/interop/harness.js";

export const uid = (n: number) => `0192e4a0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
export const SECTION = uid(1);

/** A device's vault: a sealed SQLite store and a file secret store in its own directory. */
export interface Vault {
  readonly dir: string;
  storage: SqliteLfcpStorage;
  readonly secrets: SecretStore;
}

export async function openVault(dir = mkdtempSync(join(tmpdir(), "lfcp-vault-"))): Promise<Vault> {
  const secrets = new FileSecretStore(join(dir, "secrets"));
  const storage = await SqliteLfcpStorage.openSealed(join(dir, "lfcp.sqlite"), {
    secrets,
    cipher: localStateCipher,
  });
  return { dir, storage, secrets };
}

/** Closes and opens the vault's database again (a process restart). */
export async function reopenVault(v: Vault): Promise<void> {
  v.storage.close();
  v.storage = await SqliteLfcpStorage.openSealed(join(v.dir, "lfcp.sqlite"), {
    secrets: v.secrets,
    cipher: localStateCipher,
  });
}

export function removeVault(v: Vault): void {
  try {
    v.storage.close();
  } catch {
    // closed already
  }
  rmSync(v.dir, { recursive: true, force: true });
}

/**
 * A section side on a vault. With `restore`, the profile comes from the
 * vault's checkpoint (a restarted device); otherwise it starts empty.
 */
export async function sectionSide(
  url: string,
  resource: ResourceId,
  who: Party,
  vault: Vault,
  restore = false,
  webSocket?: WebSocketFactory,
): Promise<Side<SharedSectionsDataProfile>> {
  const principal = who.signer.descriptor.principalId;
  const checkpoint = restore ? await vault.storage.profileState.checkpoint(resource) : undefined;
  const profile =
    checkpoint !== undefined
      ? SharedSectionsDataProfile.restore(checkpoint, { resource, principal })
      : new SharedSectionsDataProfile(SectionReplica.empty({ resource, principal }));
  return new Side({
    url,
    resource,
    who,
    profile,
    commit: profile.commitBinding(principal) as never,
    storage: vault.storage as LfcpStorage,
    secrets: vault.secrets,
    checkpoints: true,
    ...(webSocket === undefined ? {} : { webSocket }),
  });
}

/** The batch status events of a side for one operation. */
export const batchEvents = (events: readonly SyncEvent[], operationId: string): StatusEvent[] =>
  events.flatMap((e) =>
    e.type === "status" && e.event.kind === "batch" && e.event.operationId === operationId
      ? [e.event]
      : [],
  );

export const accepted = (side: Side<SharedSectionsDataProfile>, operationId: string) =>
  batchEvents(side.events, operationId).some((e) => e.kind === "batch" && e.status === "accepted");

/** W tasks, each with a paragraph child: the private section A previews (§7 step 1). */
export function section(
  W: number,
  me: Party["signer"]["descriptor"]["principalId"],
): SectionIntent[] {
  const intents: SectionIntent[] = [
    { intent: "section.create", sectionId: SECTION, title: `Launch plan (${W})`, createdBy: me },
  ];
  let after: string | null = null;
  for (let k = 0; k < W; k++) {
    const task = uid(1000 + k);
    intents.push({
      intent: "task.create_in_section",
      task: createTask({ id: task as never, title: `Task ${k} of the plan`, createdBy: me }).task,
      parent: SECTION,
      after,
    });
    intents.push({
      intent: "paragraph.create",
      id: uid(5000 + k),
      parent: task,
      after: null,
      text: `Notes for task ${k}: ${"detail ".repeat(5)}`,
      createdBy: me,
    });
    after = task;
  }
  return intents;
}

/**
 * §7 steps 1–3: A creates and hosts the section Resource with W tasks, issues
 * one invitation, and B joins through the one-time claim; both are LIVE and
 * converged. The sides are returned started.
 */
export async function twoVaults(o: {
  readonly url: string;
  readonly resource: ResourceId;
  readonly A: Party;
  readonly B: Party;
  readonly dek: ResourceDEK;
  readonly W: number;
  readonly vaultA: Vault;
  readonly vaultB: Vault;
  /** WebSockets for A and B (e.g. wire taps); the platform's by default. */
  readonly wsA?: WebSocketFactory;
  readonly wsB?: WebSocketFactory;
}) {
  const { url, resource: R, A, B, W } = o;
  const a = await sectionSide(url, R, A, o.vaultA, false, o.wsA);
  const genesis = await createResource(a, url, o.dek);
  a.start({ open: false });
  await waitFor("A READY", () => a.client.connectionState === "READY");
  await a.client.host(genesis.bytes);
  a.open();
  await waitFor("A LIVE", () => a.client.resourceState(R) === "LIVE");
  const created = await a.client.commit(R, section(W, A.signer.descriptor.principalId), {
    operationId: "create",
  });
  await waitFor("A's section sent", () => a.queueEmpty(), 60_000);
  await waitFor("A's batch accepted", () => accepted(a, "create"), 30_000);

  const invitation = await createInvitation({
    storage: o.vaultA.storage,
    resourceId: R,
    inviter: A.signer,
    dek: o.dek,
    endpoints: [url],
  });
  a.client.flush();
  await waitFor("invitation sent", () => a.queueEmpty(), 30_000);
  const joined = await acceptInvitation({
    link: invitation.link,
    claimant: B,
    storage: o.vaultB.storage,
    secrets: o.vaultB.secrets,
    now: () => Date.now(),
    timeout: sleep(20_000),
    dataProfiles: [SECTIONS_PROFILE_ID],
    ...(o.wsB === undefined ? {} : { webSocket: o.wsB }),
  });
  if (joined.kind !== "claimed") throw new Error(`B did not join: ${joined.kind}`);
  const b = await sectionSide(url, R, B, o.vaultB, false, o.wsB);
  b.start();
  await waitFor("B LIVE", () => b.client.resourceState(R) === "LIVE", 60_000);
  await waitFor(
    "B has A's section",
    () => b.profile.replica.revision() === a.profile.replica.revision(),
    120_000,
  );
  return { a, b, created, joined };
}

/** Every file under `dir` that holds `needle` (UTF-8), by relative path. */
export function filesContaining(dir: string, needle: string): string[] {
  const bytes = new TextEncoder().encode(needle);
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name))
    .filter((p) => indexOf(new Uint8Array(readFileSync(p)), bytes) >= 0)
    .map((p) => p.slice(dir.length + 1));
}

export function indexOf(hay: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/** Where the qualification records its facts for the evidence report (gitignored). */
export const RESULTS = join(dirname(fileURLToPath(import.meta.url)), "..", ".results");

/** Records the facts of one step of a run: `<RESULTS>/<run>.json`, a step → facts map. */
export function record(run: string, step: string, facts: unknown): void {
  mkdirSync(RESULTS, { recursive: true });
  const file = join(RESULTS, `${run}.json`);
  let all: Record<string, unknown> = {};
  try {
    all = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    all = {};
  }
  all[step] = facts;
  writeFileSync(
    file,
    `${JSON.stringify(all, (_, v) => (typeof v === "bigint" ? v.toString() : v instanceof Uint8Array ? Buffer.from(v).toString("hex") : v), 2)}\n`,
  );
}
