// LFCP-02-056, MVP-0.2-TEST-AND-RELEASE-PLAN §7 step 11, live: opacity and
// coexistence. Two sealed vaults join a section Resource (steps 1–3) over
// tapped WebSockets and edit it; each vault also keeps a private label
// (a canary) that never enters any shared state. Then, on the same vaults
// and server, A creates a legacy Shared Objects (SOP) Resource beside the
// section and B joins it: the legacy secure smoke still passes.
//
// The scan: no task title, paragraph text, edit, legacy title or canary,
// no DEK and no private key is found in any LFCP message either client sent
// or received, in any server file, in the server log, or in any file of
// either vault's sealed database (the secret stores are excluded: they hold
// the keys by design). Protocol metadata (IDs, sequences, epochs, sizes) is
// not claimed hidden; a positive control shows the scan finds it.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { acceptInvitation, createInvitation } from "@openlfcp/client";
import { type ObjectId, resourceId } from "@openlfcp/core";
import { exportSecretKeyBytes, importResourceDEK } from "@openlfcp/crypto";
import {
  createTask,
  type LocalChange,
  SharedObjectsDataProfile,
  SharedObjectsReplica,
  setTitle,
  type Task,
} from "@openlfcp/shared-objects";
import type { SharedSectionsDataProfile } from "@openlfcp/shared-objects/sections";
import type { LfcpStorage } from "@openlfcp/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bytes32,
  createResource,
  party,
  Side,
  type SideProfile,
  sleep,
  waitFor,
} from "../../../sdk-ts/conformance/interop/harness.js";
import {
  type RunningRustServer,
  startRustServer,
} from "../../../sdk-ts/conformance/interop/rust-server.mjs";
import { containsBytes, WireTap } from "../../../sdk-ts/conformance/interop/wire-tap.js";
import {
  accepted,
  openVault,
  record,
  removeVault,
  SECTION,
  twoVaults,
  uid,
  type Vault,
} from "./support.js";

declare const console: { warn(...a: unknown[]): void };

const A = party(147);
const B = party(177);
const DEK0 = importResourceDEK(bytes32(207));
const DEK_LEGACY = importResourceDEK(bytes32(209));
const R = resourceId(bytes32(131));
const R_LEGACY = resourceId(bytes32(133));
const R_NOTE = resourceId(bytes32(135));

/** Text that must never leave its vault: each device's private note. */
const CANARY_A = "A-private-canary-0563 note kept beside the section";
const CANARY_B = "B-private-canary-0564 note kept beside the section";
const B_TASK = "B-0565 follow-up written into the section";
const A_EDIT = "A-0566 agreed edit: ";
const LEGACY = ["legacy-0567 task title one", "legacy-0568 task title two"];

let server: RunningRustServer | undefined;
let skip: string | undefined;

beforeAll(async () => {
  const started = await startRustServer();
  if ("skip" in started) skip = started.skip;
  else server = started;
}, 600_000);

afterAll(async () => {
  await server?.stop();
});

const utf8 = (s: string) => new TextEncoder().encode(s);

/**
 * A private note: the local state of a local-only projection, written as a
 * profile checkpoint (the vault's sealed local state). Resource labels are not
 * used: the storage contract makes them public metadata, stored in the clear.
 */
async function note(storage: LfcpStorage, resource: typeof R, text: string) {
  await storage.commit([
    {
      op: "put-profile-checkpoint",
      checkpoint: {
        resourceId: resource,
        dataProfile: "org.example.private-note",
        state: utf8(text),
        actorSeq: 0,
        units: [],
      },
    },
  ]);
}

/** Every file under a vault except its secret store, with its bytes. */
function vaultFiles(v: Vault): { path: string; bytes: Uint8Array }[] {
  return readdirSync(v.dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name))
    .map((p) => ({ path: p.slice(v.dir.length + 1), bytes: new Uint8Array(readFileSync(p)) }))
    .filter((f) => !f.path.startsWith("secrets"));
}

describe("two vaults: opacity, and a legacy SOP Resource beside the section (§7 step 11)", () => {
  it("keeps every plaintext and key off the wire, the server and the sealed vaults", async (ctx) => {
    if (server === undefined) {
      console.warn(`SKIPPED: the two-vault opacity run (${skip})`);
      ctx.skip();
      return;
    }
    const srv = server;
    const url = srv.url;
    const vaultA = await openVault();
    const vaultB = await openVault();
    const tapA = new WireTap();
    const tapB = new WireTap();
    const sides: Side<SideProfile>[] = [];
    try {
      // The section, joined over tapped sockets; each vault keeps a private note.
      const { a, b } = await twoVaults({
        url,
        resource: R,
        A,
        B,
        dek: DEK0,
        W: 20,
        vaultA,
        vaultB,
        wsA: tapA.factory,
        wsB: tapB.factory,
      });
      sides.push(a as Side<SideProfile>, b as Side<SideProfile>);
      await note(vaultA.storage, R_NOTE, CANARY_A);
      await note(vaultB.storage, R_NOTE, CANARY_B);
      await b.client.commit(
        R,
        [
          {
            intent: "task.create_in_section",
            task: createTask({
              id: uid(9100) as never,
              title: B_TASK,
              createdBy: B.signer.descriptor.principalId,
            }).task,
            parent: SECTION,
            after: null,
          },
        ],
        { operationId: "b-task" },
      );
      await a.client.commit(
        R,
        [
          {
            intent: "text.edit",
            id: uid(5000),
            base: a.profile.replica.revision(),
            edits: [{ index: 0, deleteCount: 0, insert: A_EDIT }],
          },
        ],
        { operationId: "a-edit" },
      );
      const sectionsAgree = () => {
        const sa = (a as Side<SharedSectionsDataProfile>).profile.replica;
        const sb = (b as Side<SharedSectionsDataProfile>).profile.replica;
        return sa.revision() === sb.revision();
      };
      await waitFor("both converge", sectionsAgree, 60_000);
      await waitFor("B's task accepted", () => accepted(b, "b-task"), 30_000);
      await waitFor("A's edit accepted", () => accepted(a, "a-edit"), 30_000);
      expect(
        (a as Side<SharedSectionsDataProfile>).profile.replica.snapshot().nodes[uid(5000)]?.text,
      ).toMatch(new RegExp(`^${A_EDIT}`));
      await a.stop();
      await b.stop();

      // The legacy SOP Resource beside it, on the same vaults: the legacy secure smoke.
      const { replica, change: init } = SharedObjectsReplica.create({
        resource: R_LEGACY,
        principal: A.signer.descriptor.principalId,
      });
      const la = new Side({
        url,
        resource: R_LEGACY,
        who: A,
        profile: new SharedObjectsDataProfile(replica),
        storage: vaultA.storage,
        secrets: vaultA.secrets,
        webSocket: tapA.factory,
        snapshots: false,
      });
      sides.push(la as Side<SideProfile>);
      const genesis = await createResource(la, url, DEK_LEGACY);
      await la.write(init);
      la.start({ open: false });
      await waitFor("A READY (legacy)", () => la.client.connectionState === "READY");
      await la.client.host(genesis.bytes);
      la.open();
      await waitFor("A LIVE (legacy)", () => la.client.resourceState(R_LEGACY) === "LIVE");
      const invitation = await createInvitation({
        storage: vaultA.storage,
        resourceId: R_LEGACY,
        inviter: A.signer,
        dek: DEK_LEGACY,
        endpoints: [url],
      });
      la.client.flush();
      await waitFor("legacy invitation sent", () => la.queueEmpty(), 30_000);
      const joined = await acceptInvitation({
        link: invitation.link,
        claimant: B,
        storage: vaultB.storage,
        secrets: vaultB.secrets,
        now: () => Date.now(),
        timeout: sleep(20_000),
        webSocket: tapB.factory,
      });
      expect(joined.kind).toBe("claimed");
      const lb = new Side({
        url,
        resource: R_LEGACY,
        who: B,
        profile: new SharedObjectsDataProfile(
          SharedObjectsReplica.empty({
            resource: R_LEGACY,
            principal: B.signer.descriptor.principalId,
          }),
        ),
        storage: vaultB.storage,
        secrets: vaultB.secrets,
        webSocket: tapB.factory,
        snapshots: false,
      });
      sides.push(lb as Side<SideProfile>);
      lb.start();
      await waitFor("B LIVE (legacy)", () => lb.client.resourceState(R_LEGACY) === "LIVE", 60_000);
      const created = createTask({
        title: LEGACY[0] as string,
        createdBy: A.signer.descriptor.principalId,
      });
      const ID = created.task.id as ObjectId;
      await la.write(la.profile.replica.apply(created.intent) as LocalChange);
      await waitFor(
        "B sees A's legacy Task",
        () => lb.profile.replica.task(ID)?.task?.title === LEGACY[0],
        30_000,
      );
      await lb.write(
        lb.profile.replica.apply(
          setTitle(lb.profile.replica.task(ID)?.task as Task, LEGACY[1] as string).intent,
        ) as LocalChange,
      );
      await waitFor(
        "A sees B's legacy edit",
        () => la.profile.replica.task(ID)?.task?.title === LEGACY[1],
        30_000,
      );
      await waitFor(
        "legacy edits ACKed",
        async () => (await la.queueEmpty()) && (await lb.queueEmpty()),
        30_000,
      );
      expect(la.errors()).toEqual([]);
      expect(lb.errors()).toEqual([]);
      await la.stop();
      await lb.stop();
      // Both Resources live side by side in each vault: each holds both control logs.
      for (const v of [vaultA, vaultB])
        for (const r of [R, R_LEGACY])
          expect((await v.storage.control.records(r)).length).toBeGreaterThan(0);

      // The scan.
      const plaintexts = [
        CANARY_A,
        CANARY_B,
        B_TASK,
        A_EDIT,
        "Task 0 of the plan",
        "Notes for task 0",
        ...LEGACY,
      ].map((s) => ({ what: s, bytes: utf8(s) }));
      const keys = [
        { what: "the section DEK", bytes: exportSecretKeyBytes(DEK0) },
        { what: "the legacy DEK", bytes: exportSecretKeyBytes(DEK_LEGACY) },
        { what: "A's signing key", bytes: exportSecretKeyBytes(A.signer.key) },
        { what: "A's agreement key", bytes: exportSecretKeyBytes(A.agreement) },
        { what: "B's signing key", bytes: exportSecretKeyBytes(B.signer.key) },
        { what: "B's agreement key", bytes: exportSecretKeyBytes(B.agreement) },
      ];
      const wire = [...tapA.frames, ...tapB.frames];
      const files = srv.files();
      const log = utf8(srv.log());
      const vaults = [
        ...vaultFiles(vaultA).map((f) => ({ ...f, path: `A/${f.path}` })),
        ...vaultFiles(vaultB).map((f) => ({ ...f, path: `B/${f.path}` })),
      ];
      const leaks: string[] = [];
      for (const s of [...plaintexts, ...keys]) {
        for (const f of wire)
          if (containsBytes(f.bytes, s.bytes))
            leaks.push(`${s.what} in a ${f.message?.type ?? "?"} message (${f.direction})`);
        for (const f of files)
          if (containsBytes(f.bytes, s.bytes)) leaks.push(`${s.what} in server file ${f.path}`);
        if (containsBytes(log, s.bytes)) leaks.push(`${s.what} in the server log`);
        for (const f of vaults)
          if (containsBytes(f.bytes, s.bytes)) leaks.push(`${s.what} in vault file ${f.path}`);
      }
      // Positive control: metadata is not claimed hidden, and the scan finds it.
      const aId = A.signer.descriptor.principalId;
      const control = {
        wire: wire.some((f) => containsBytes(f.bytes, aId)),
        serverFiles: files.some((f) => containsBytes(f.bytes, aId)),
        vaultFiles: vaults.some((f) => containsBytes(f.bytes, R)),
      };
      record("opacity", "11-opacity", {
        scanned: {
          wireFrames: wire.length,
          serverFiles: files.map((f) => f.path),
          serverLogBytes: log.length,
          vaultFiles: vaults.map((f) => f.path),
          needles: [...plaintexts, ...keys].map((s) => s.what),
        },
        leaks,
        positiveControl: control,
      });
      record("opacity", "11-legacy-smoke", {
        resources: 2,
        legacyTitle: la.profile.replica.task(ID)?.task?.title,
        sectionRevisionsAgree: sectionsAgree(),
      });
      expect(wire.length).toBeGreaterThan(20);
      expect(vaults.length).toBeGreaterThan(0);
      expect(leaks).toEqual([]);
      expect(control).toEqual({ wire: true, serverFiles: true, vaultFiles: true });
    } catch (e) {
      throw new Error(
        `${e instanceof Error ? e.message : String(e)}\n--- server log (tail) ---\n${srv.log().slice(-3000)}`,
      );
    } finally {
      for (const s of sides) await s.stop();
      removeVault(vaultA);
      removeVault(vaultB);
    }
  }, 300_000);
});
