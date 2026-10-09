// LFCP-02-074: the client side of the restore rehearsal, one phase per run,
// driven by qualification/rehearsal/rehearse-restore.sh against the server
// in Docker Compose (the deploy compose with a persistent volume). The
// vaults and the facts stay in LFCP_REHEARSAL_DIR between phases, so every
// phase after the first is a restarted device.
//
//   populate      A hosts a section Resource and a legacy Shared Objects
//                 Resource; B joins both. (The script then backs the volume up.)
//   after-backup  B writes a section batch, A a legacy edit; both accepted.
//                 (The script then restores the volume from the backup.)
//   reconcile     A and B restart from their vaults: they offer the lost
//                 units again and converge. C, a new member, joins both
//                 Resources and reads both edits (the encrypted smoke).
//                 New writes by A and B are accepted: no actor sequence is
//                 reused and no queued work is lost.
//
// Without LFCP_REHEARSAL_PHASE the file is skipped.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  acceptInvitation,
  createInvitation,
  type InvitationLink,
  receiptOf,
  type SyncEvent,
} from "@openlfcp/client";
import { actorSequence, type ObjectId, type ResourceId, resourceId } from "@openlfcp/core";
import { importResourceDEK, type ResourceDEK } from "@openlfcp/crypto";
import {
  createTask,
  type LocalChange,
  PROFILE_ID,
  SharedObjectsDataProfile,
  SharedObjectsReplica,
  setTitle,
} from "@openlfcp/shared-objects";
import { SECTIONS_PROFILE_ID } from "@openlfcp/shared-objects/sections";
import type { LfcpStorage } from "@openlfcp/storage";
import { describe, expect, it } from "vitest";
import {
  bytes32,
  createResource,
  type Party,
  party,
  Side,
  sleep,
  waitFor,
} from "../../../sdk-ts/conformance/interop/harness.js";
import { accepted, openVault, sectionSide, twoVaults, uid, type Vault } from "./support.js";

const PHASE = process.env.LFCP_REHEARSAL_PHASE;
const URL = process.env.LFCP_REHEARSAL_URL ?? "";
const DIR = process.env.LFCP_REHEARSAL_DIR ?? "";

const A = party(151);
const B = party(181);
const C = party(191);
const S = resourceId(bytes32(143));
const L = resourceId(bytes32(145));
const DEK_S = importResourceDEK(bytes32(219));
const DEK_L = importResourceDEK(bytes32(221));
const TASK = "0192e4a0-0000-7000-8000-000000000020" as ObjectId;

const vaultDir = (name: string) => join(DIR, name);
const factsFile = () => join(DIR, "facts.json");
function facts(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(factsFile(), "utf8"));
  } catch {
    return {};
  }
}
function note(key: string, value: unknown): void {
  const all = facts();
  all[key] = value;
  writeFileSync(
    factsFile(),
    `${JSON.stringify(all, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2)}\n`,
  );
}

async function vault(name: string): Promise<Vault> {
  mkdirSync(vaultDir(name), { recursive: true });
  return openVault(vaultDir(name));
}

/** A Shared Objects side for L on a vault, restored from its checkpoint when there is one. */
async function legacySide(who: Party, v: Vault) {
  const principal = who.signer.descriptor.principalId;
  const cp = await v.storage.profileState.checkpoint(L);
  const opts = { resource: L, principal };
  const profile =
    cp === undefined
      ? new SharedObjectsDataProfile(SharedObjectsReplica.empty(opts))
      : SharedObjectsDataProfile.restore(cp, opts);
  return new Side({
    url: URL,
    resource: L,
    who,
    profile,
    storage: v.storage as LfcpStorage,
    secrets: v.secrets,
    checkpoints: true,
  });
}

const titleOf = (side: Side, id: ObjectId) => side.profile.replica.task(id)?.task?.title;

async function ownUnits(storage: LfcpStorage, R: ResourceId, who: Party): Promise<string[]> {
  return (
    await storage.dataUnits.range(
      R,
      who.signer.descriptor.principalId,
      actorSequence(1n),
      actorSequence(2n ** 32n),
    )
  ).map((u) => u.actorSeq.toString());
}

async function claim(link: string, who: Party, v: Vault, profile: string): Promise<string> {
  const r = await acceptInvitation({
    link,
    claimant: who,
    storage: v.storage,
    secrets: v.secrets,
    now: () => Date.now(),
    timeout: sleep(20_000),
    dataProfiles: [profile],
  });
  return r.kind;
}

async function invite(
  v: Vault,
  R: ResourceId,
  dek: ResourceDEK,
  side: { client: { flush(): void }; queueEmpty(): Promise<boolean> },
) {
  const created = await createInvitation({
    storage: v.storage,
    resourceId: R,
    inviter: A.signer,
    dek,
    endpoints: [URL],
  });
  side.client.flush();
  await waitFor("invitation sent", () => side.queueEmpty(), 30_000);
  return (created.link as InvitationLink).reveal();
}

const errorsOf = (events: readonly SyncEvent[]) => events.filter((e) => e.type === "error");

describe.runIf(PHASE !== undefined)("restore rehearsal (LFCP-02-074)", () => {
  it(`phase ${PHASE}`, async () => {
    expect(URL).not.toBe("");
    expect(DIR).not.toBe("");
    const vA = await vault("a");
    const vB = await vault("b");
    const sides: Side<never>[] = [];
    const keep = <T>(s: T): T => {
      sides.push(s as never);
      return s;
    };
    try {
      if (PHASE === "populate") {
        const { a, b } = await twoVaults({
          url: URL,
          resource: S,
          A,
          B,
          dek: DEK_S,
          W: 3,
          vaultA: vA,
          vaultB: vB,
        });
        keep(a);
        keep(b);
        const { replica, change } = SharedObjectsReplica.create({
          resource: L,
          principal: A.signer.descriptor.principalId,
        });
        const la = keep(
          new Side({
            url: URL,
            resource: L,
            who: A,
            profile: new SharedObjectsDataProfile(replica),
            storage: vA.storage as LfcpStorage,
            secrets: vA.secrets,
            checkpoints: true,
          }),
        );
        const genesis = await createResource(la, URL, DEK_L);
        la.start({ open: false });
        await waitFor("L READY", () => la.client.connectionState === "READY");
        await la.client.host(genesis.bytes);
        la.open();
        await waitFor("L LIVE", () => la.client.resourceState(L) === "LIVE");
        await la.write(change);
        await la.write(
          la.profile.replica.apply(
            createTask({
              id: TASK,
              title: "Before the backup",
              createdBy: A.signer.descriptor.principalId,
            }).intent,
          ) as LocalChange,
        );
        const link = await invite(vA, L, DEK_L, la);
        expect(await claim(link, B, vB, PROFILE_ID)).toBe("claimed");
        const lb = keep(await legacySide(B, vB));
        lb.start();
        await waitFor(
          "B has the legacy Task",
          () => titleOf(lb, TASK) === "Before the backup",
          60_000,
        );
        note("populate", {
          sectionRevision: a.profile.replica.revision(),
          aSectionUnits: await ownUnits(vA.storage, S, A),
          aLegacyUnits: await ownUnits(vA.storage, L, A),
        });
      } else if (PHASE === "after-backup") {
        const a = keep(await sectionSide(URL, S, A, vA, true));
        const b = keep(await sectionSide(URL, S, B, vB, true));
        const la = keep(await legacySide(A, vA));
        const lb = keep(await legacySide(B, vB));
        for (const s of [a, b, la, lb]) s.start();
        await b.client.commit(
          S,
          [{ intent: "task.set_title", id: uid(1001) as never, title: "B, after the backup" }],
          { operationId: "b-after-backup" },
        );
        await waitFor("b-after-backup accepted", () => accepted(b, "b-after-backup"), 60_000);
        await la.write(
          la.profile.replica.apply(
            setTitle(la.profile.replica.task(TASK)?.task as never, "A, after the backup").intent,
          ) as LocalChange,
        );
        await waitFor("A's legacy edit sent", () => la.queueEmpty(), 60_000);
        await waitFor(
          "B has A's legacy edit",
          () => titleOf(lb, TASK) === "A, after the backup",
          60_000,
        );
        await waitFor(
          "A has B's batch",
          () => a.profile.replica.task(uid(1001) as never)?.task?.title === "B, after the backup",
          60_000,
        );
        note("after-backup", {
          bSectionUnits: await ownUnits(vB.storage, S, B),
          aLegacyUnits: await ownUnits(vA.storage, L, A),
          receipt: (await receiptOf(vB.storage, S, "b-after-backup"))?.durable,
        });
      } else if (PHASE === "reconcile") {
        const a = keep(await sectionSide(URL, S, A, vA, true));
        const b = keep(await sectionSide(URL, S, B, vB, true));
        const la = keep(await legacySide(A, vA));
        const lb = keep(await legacySide(B, vB));
        for (const s of [a, b, la, lb]) s.start();
        const reoffered = (s: Side<never>) =>
          s.events.some((e) => e.type === "status" && e.event.kind === "reoffered");
        await waitFor("B offers its lost section batch again", () => reoffered(b as never), 60_000);
        await waitFor(
          "all queues empty",
          async () => {
            for (const s of [a, b, la, lb]) if (!(await s.queueEmpty())) return false;
            return true;
          },
          60_000,
        );

        // C, a new member, joins both Resources on the restored server.
        const vC = await vault("c");
        const linkS = await invite(vA, S, DEK_S, a);
        const linkL = await invite(vA, L, DEK_L, la);
        expect(await claim(linkS, C, vC, SECTIONS_PROFILE_ID)).toBe("claimed");
        expect(await claim(linkL, C, vC, PROFILE_ID)).toBe("claimed");
        const cs = keep(await sectionSide(URL, S, C, vC));
        const cl = keep(await legacySide(C, vC));
        cs.start();
        cl.start();
        await waitFor(
          "C reads B's section batch",
          () => cs.profile.replica.task(uid(1001) as never)?.task?.title === "B, after the backup",
          60_000,
        );
        await waitFor(
          "C reads A's legacy edit",
          () => titleOf(cl, TASK) === "A, after the backup",
          60_000,
        );

        // New writes continue each actor's sequence and are accepted.
        await b.client.commit(
          S,
          [{ intent: "task.set_status", id: uid(1002) as never, status: "done" }],
          { operationId: "b-after-restore" },
        );
        await waitFor("b-after-restore accepted", () => accepted(b, "b-after-restore"), 60_000);
        await la.write(
          la.profile.replica.apply(
            setTitle(la.profile.replica.task(TASK)?.task as never, "A, after the restore").intent,
          ) as LocalChange,
        );
        await waitFor(
          "C reads A's new edit",
          () => titleOf(cl, TASK) === "A, after the restore",
          60_000,
        );
        await waitFor(
          "C reads B's new batch",
          () => cs.profile.replica.revision() === b.profile.replica.revision(),
          60_000,
        );
        for (const s of [a, b, la, lb, cs, cl]) expect(errorsOf(s.events)).toEqual([]);
        const bUnits = await ownUnits(vC.storage, S, B);
        const aUnits = await ownUnits(vC.storage, L, A);
        expect(new Set(bUnits).size).toBe(bUnits.length);
        expect(new Set(aUnits).size).toBe(aUnits.length);
        note("reconcile", {
          reoffered: b.events.flatMap((e) =>
            e.type === "status" && e.event.kind === "reoffered"
              ? [{ units: e.event.unitIds.length, reason: e.event.reason }]
              : [],
          ),
          legacyReoffered: la.events.flatMap((e) =>
            e.type === "status" && e.event.kind === "reoffered"
              ? [{ units: e.event.unitIds.length, reason: e.event.reason }]
              : [],
          ),
          bSectionUnitsOnC: bUnits,
          aLegacyUnitsOnC: aUnits,
          cJoined: true,
        });
        for (const s of sides.splice(0)) await s.stop();
        vC.storage.close();
      } else {
        throw new Error(`unknown phase ${PHASE}`);
      }
    } finally {
      for (const s of sides) await s.stop();
      vA.storage.close();
      vB.storage.close();
    }
  }, 300_000);
});
