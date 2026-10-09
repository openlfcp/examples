// LFCP-02-070, the compatibility part, live: the released 0.1.3 client
// (npm, in its own process: legacy-0.1.3/legacy-client.mjs) and the
// candidate SDK on the same vault and the same Rust reference server.
//
// CM01. 0.1.3 hosts a Shared Objects Resource, writes a Task, issues an
//       invitation and exits with two edits still queued. The candidate
//       opens the same vault (the storage upgrade, sealed), restores the
//       profile from its checkpoint and sends the queue: the actor
//       sequence continues and nothing is lost or sent twice.
// CM02. The upgraded owner adds a section Resource beside the legacy one;
//       a member joined through the 0.1.3 invitation keeps syncing the
//       legacy Task, and sees nothing of the section.
// CM03. 0.1.3, offering only the legacy profile, is invited to the section
//       Resource: it refuses without claiming, and the same invitation
//       still admits a candidate client.
// CM10. 0.1.3 opens the upgraded vault again (a downgrade): it refuses, and
//       the vault's files are unchanged.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { acceptInvitation, createInvitation, type InvitationLink } from "@openlfcp/client";
import { actorSequence, type ObjectId, resourceId, toHex } from "@openlfcp/core";
import { importResourceDEK } from "@openlfcp/crypto";
import {
  PROFILE_ID,
  SharedObjectsDataProfile,
  SharedObjectsReplica,
  setTitle,
} from "@openlfcp/shared-objects";
import { SECTIONS_PROFILE_ID } from "@openlfcp/shared-objects/sections";
import type { LfcpStorage } from "@openlfcp/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bytes32,
  createResource,
  type Party,
  party,
  Side,
  sleep,
  waitFor,
} from "../../../sdk-ts/conformance/interop/harness.js";
import {
  type RunningRustServer,
  startRustServer,
} from "../../../sdk-ts/conformance/interop/rust-server.mjs";
import {
  accepted,
  openVault,
  record,
  removeVault,
  section,
  sectionSide,
  uid,
  type Vault,
} from "./support.js";

declare const console: { warn(...a: unknown[]): void };

const LEGACY = join(dirname(fileURLToPath(import.meta.url)), "..", "legacy-0.1.3");
const A = party(147);
const B = party(177);
const C = party(187);
const L = resourceId(bytes32(131));
const S = resourceId(bytes32(133));
const DEK_S = importResourceDEK(bytes32(209));
const TASK = "0192e4a0-0000-7000-8000-000000000010" as ObjectId;

/** One run of the 0.1.3 client: its JSON lines. */
async function legacy(command: string, args: object): Promise<Record<string, unknown>[]> {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [join(LEGACY, "legacy-client.mjs"), command, JSON.stringify(args)],
    { cwd: LEGACY, timeout: 120_000 },
  );
  return stdout
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

const legacyInstalled = () =>
  existsSync(join(LEGACY, "node_modules", "@openlfcp", "client", "package.json"));

/** The sha256 of every file of a directory, by relative path. */
function digest(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const p = join(e.parentPath, e.name);
    out[p.slice(dir.length + 1)] = createHash("sha256").update(readFileSync(p)).digest("hex");
  }
  return out;
}

/** A Shared Objects side on a vault, its profile restored from the vault's checkpoint when there is one. */
async function legacySide(url: string, who: Party, vault: Vault) {
  const principal = who.signer.descriptor.principalId;
  const cp = await vault.storage.profileState.checkpoint(L);
  const opts = { resource: L, principal };
  const profile =
    cp === undefined
      ? new SharedObjectsDataProfile(SharedObjectsReplica.empty(opts))
      : SharedObjectsDataProfile.restore(cp, opts);
  return new Side({
    url,
    resource: L,
    who,
    profile,
    storage: vault.storage as LfcpStorage,
    secrets: vault.secrets,
    checkpoints: true,
  });
}

let server: RunningRustServer | undefined;
let skip: string | undefined;

beforeAll(async () => {
  if (!legacyInstalled()) {
    skip = "the 0.1.3 client is not installed (npm ci in qualification/legacy-0.1.3)";
    if (process.env.LFCP_REQUIRE_LIVE === "1")
      throw new Error(`LFCP_REQUIRE_LIVE=1 but the compatibility run would skip: ${skip}`);
    return;
  }
  const started = await startRustServer();
  if ("skip" in started) skip = started.skip;
  else server = started;
}, 600_000);

afterAll(async () => {
  await server?.stop();
});

describe("0.1.3 and the candidate on one vault and one server (LFCP-02-070, CM01–CM03, CM10)", () => {
  it("upgrades with pending legacy work, coexists with sections, and refuses both ways", async (ctx) => {
    if (server === undefined) {
      console.warn(`SKIPPED: the 0.1.3 compatibility run (${skip})`);
      ctx.skip();
      return;
    }
    const url = server.url;
    const vaultA = await openVault();
    const vaultB = await openVault();
    const vaultC = await openVault();
    const legacyC = await openVault();
    removeVault(legacyC); // an empty directory for the 0.1.3 joiner
    removeVault(vaultA); // 0.1.3 creates the vault itself
    const sides: Side<never>[] = [];
    try {
      // CM01: 0.1.3 hosts, writes, invites, and exits with two edits queued.
      const owner = await legacy("owner", {
        dir: vaultA.dir,
        url,
        seed: 147,
        resource: toHex(L),
        dek: 207,
        task: TASK,
      });
      const pending = owner.find((o) => o.t === "pending");
      expect(pending).toMatchObject({ queued: 2, title: "Offline edit 2" });
      const wrote = owner.filter((o) => o.t === "wrote").map((o) => o.seq);
      expect(wrote).toEqual(["3", "4"]);
      const link = owner.find((o) => o.t === "invitation")?.link as string;
      const before = digest(vaultA.dir);

      // The candidate opens the 0.1.3 vault: the upgrade.
      const upgraded = await openVault(vaultA.dir);
      Object.assign(vaultA, upgraded);
      const queued = await vaultA.storage.outbound.list(L);
      expect(queued).toHaveLength(2);
      const a = await legacySide(url, A, vaultA);
      sides.push(a as never);
      expect(a.profile.replica.task(TASK)?.task?.title).toBe("Offline edit 2");
      a.start();
      await waitFor("A's 0.1.3 queue sent by the candidate", () => a.queueEmpty(), 60_000);
      expect(a.errors()).toEqual([]);

      // B joins through the invitation 0.1.3 issued, with the candidate.
      const joined = await acceptInvitation({
        link,
        claimant: B,
        storage: vaultB.storage,
        secrets: vaultB.secrets,
        now: () => Date.now(),
        timeout: sleep(20_000),
        dataProfiles: [PROFILE_ID],
      });
      expect(joined.kind).toBe("claimed");
      const b = await legacySide(url, B, vaultB);
      sides.push(b as never);
      b.start();
      await waitFor(
        "B has the edits 0.1.3 queued",
        () => b.profile.replica.task(TASK)?.task?.title === "Offline edit 2",
        60_000,
      );
      // Each of A's units reached the server once: B applied seqs 1..4, no more.
      const seqs = (
        await vaultB.storage.dataUnits.range(
          L,
          A.signer.descriptor.principalId,
          actorSequence(1n),
          actorSequence(100n),
        )
      ).map((u) => u.actorSeq);
      expect(seqs).toEqual([1n, 2n, 3n, 4n]);
      record("compat", "CM01", {
        legacyWrote: wrote,
        queuedAtUpgrade: queued.length,
        unitsOnB: seqs,
        filesChangedByTheUpgrade: Object.entries(digest(vaultA.dir))
          .filter(([k, v]) => v !== before[k])
          .map(([k]) => k),
      });

      // CM02: a section Resource beside the legacy one, on the same vault.
      const s = await sectionSide(url, S, A, vaultA);
      sides.push(s as never);
      const genesis = await createResource(s, url, DEK_S);
      s.start({ open: false });
      await waitFor("S READY", () => s.client.connectionState === "READY");
      await s.client.host(genesis.bytes);
      s.open();
      await waitFor("S LIVE", () => s.client.resourceState(S) === "LIVE");
      await s.client.commit(S, section(3, A.signer.descriptor.principalId), {
        operationId: "s-create",
      });
      await waitFor("the section accepted", () => accepted(s, "s-create"), 60_000);
      await a.write(
        a.profile.replica.apply(
          setTitle(a.profile.replica.task(TASK)?.task as never, "After the upgrade").intent,
        ) as never,
      );
      await waitFor(
        "B gets A's legacy edit after the section exists",
        () => b.profile.replica.task(TASK)?.task?.title === "After the upgrade",
        60_000,
      );
      expect(await vaultB.storage.control.head(S)).toBeUndefined();
      expect(a.errors()).toEqual([]);
      expect(s.errors()).toEqual([]);

      // CM03: 0.1.3 refuses the section invitation without claiming it.
      const invitation = await createInvitation({
        storage: vaultA.storage,
        resourceId: S,
        inviter: A.signer,
        dek: DEK_S,
        endpoints: [url],
      });
      s.client.flush();
      await waitFor("the section invitation sent", () => s.queueEmpty(), 30_000);
      const sectionLink = (invitation.link as InvitationLink).reveal();
      const refused = await legacy("join", {
        dir: legacyC.dir,
        url,
        seed: 197,
        link: sectionLink,
        profiles: [PROFILE_ID],
      });
      expect(refused.at(-1)).toMatchObject({
        t: "joined",
        kind: "profile-unsupported",
        code: "PROFILE_UNSUPPORTED",
        dataProfile: SECTIONS_PROFILE_ID,
      });
      const claimed = await acceptInvitation({
        link: sectionLink,
        claimant: C,
        storage: vaultC.storage,
        secrets: vaultC.secrets,
        now: () => Date.now(),
        timeout: sleep(20_000),
        dataProfiles: [SECTIONS_PROFILE_ID],
      });
      expect(claimed.kind).toBe("claimed");
      const c = await sectionSide(url, S, C, vaultC);
      sides.push(c as never);
      c.start();
      await waitFor(
        "C has the section",
        () => c.profile.replica.revision() === s.profile.replica.revision(),
        60_000,
      );
      expect(c.profile.replica.snapshot().nodes[uid(1000)]).toBeDefined();
      record("compat", "CM02-CM03", {
        legacyJoin: refused.at(-1),
        candidateJoin: claimed.kind,
      });

      // CM10: 0.1.3 opens the upgraded vault and refuses it; nothing changes.
      for (const x of [a, b, s, c]) await x.stop();
      sides.length = 0;
      vaultA.storage.close();
      const closed = digest(vaultA.dir);
      const downgrade = await legacy("open", { dir: vaultA.dir, resource: toHex(L) });
      expect(downgrade.at(-1)?.t).toBe("refused");
      expect(digest(vaultA.dir)).toEqual(closed);
      record("compat", "CM10", { legacyOpen: downgrade.at(-1) });
      Object.assign(vaultA, await openVault(vaultA.dir));
    } catch (e) {
      throw new Error(
        `${e instanceof Error ? e.message : String(e)}\n--- server log (tail) ---\n${server.log().slice(-4000)}`,
      );
    } finally {
      for (const x of sides) await x.stop();
      for (const v of [vaultA, vaultB, vaultC, legacyC]) removeVault(v);
    }
  }, 600_000);
});
