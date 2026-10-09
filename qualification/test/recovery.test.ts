// LFCP-02-070, the fault part, live: faults that cross the SDK, its sealed
// vault and the Rust reference server, on a section Resource of two
// independent vaults (two-vault setup of LFCP-02-056, steps 1–3). Each case
// starts its own server, so a server fault touches nothing else.
//
// F1. ACK lost, then the client restarts: the server holds B's batch and A
//     has applied it, but B never saw the ACK. B's vault is closed and
//     reopened with the batch still queued; B sends it again, the server
//     answers the repeat (§47), and the batch is accepted under the same
//     receipt. A applies it once; B's next batch continues its sequence.
// F2. The server loses data (ADR 0008): its store is replaced by a copy
//     taken before B's accepted batch, while A (which holds the batch too)
//     is stopped. B offers it again (status "reoffered", §4.2 of
//     SDK-SECTIONS-INTEGRATION-01), and a member who joins after the
//     restore receives it.
// F3. Revoked while offline, then restarted twice: B's batch is blocked,
//     access server-refused; each restart keeps the queue, the receipt and
//     the local candidate as they were. A never receives the batch.
// F4. The server crashes after it committed a Control Record and before
//     its ACK reached A: A sends the record again after the restart, the
//     server answers the repeat (§70), and the invitation it carried admits
//     a new member.

import {
  acceptInvitation,
  createInvitation,
  type InvitationLink,
  receiptOf,
} from "@openlfcp/client";
import { actorSequence, type ResourceId, resourceId } from "@openlfcp/core";
import { importResourceDEK, type ResourceDEK } from "@openlfcp/crypto";
import {
  SECTIONS_PROFILE_ID,
  type SharedSectionsDataProfile,
} from "@openlfcp/shared-objects/sections";
import { describe, expect, it } from "vitest";
import {
  bytes32,
  type Party,
  party,
  type Side,
  sleep,
  waitFor,
} from "../../../sdk-ts/conformance/interop/harness.js";
import {
  type RunningRustServer,
  startRustServer,
} from "../../../sdk-ts/conformance/interop/rust-server.mjs";
import { WireTap } from "../../../sdk-ts/conformance/interop/wire-tap.js";
import {
  accepted,
  batchEvents,
  openVault,
  record,
  removeVault,
  reopenVault,
  sectionSide,
  twoVaults,
  uid,
  type Vault,
} from "./support.js";

declare const console: { warn(...a: unknown[]): void };

const A = party(149);
const B = party(179);
const C = party(189);

type Sections = Side<SharedSectionsDataProfile>;

/** A fresh server and vaults for one case, A and B joined on `R`; everything is stopped and removed after. */
async function live(
  name: string,
  R: ResourceId,
  dek: ResourceDEK,
  body: (o: {
    server: RunningRustServer;
    a: Sections;
    b: Sections;
    vaultA: Vault;
    vaultB: Vault;
    keep: (s: Sections) => Sections;
    tapA: WireTap;
    tapB: WireTap;
    /** Runs `fn` once every side has stopped (e.g. removes a third vault). */
    after: (fn: () => void) => void;
  }) => Promise<void>,
): Promise<boolean> {
  const started = await startRustServer();
  if ("skip" in started) {
    console.warn(`SKIPPED: ${name} (${started.skip})`);
    return false;
  }
  const server = started;
  const vaultA = await openVault();
  const vaultB = await openVault();
  const sides: Sections[] = [];
  const tapA = new WireTap();
  const tapB = new WireTap();
  const afters: (() => void)[] = [];
  try {
    const { a, b } = await twoVaults({
      url: server.url,
      resource: R,
      A,
      B,
      dek,
      W: 3,
      vaultA,
      vaultB,
      wsA: tapA.factory,
      wsB: tapB.factory,
    });
    sides.push(a, b);
    await body({
      server,
      a,
      b,
      vaultA,
      vaultB,
      keep: (s) => {
        sides.push(s);
        return s;
      },
      tapA,
      tapB,
      after: (fn) => afters.push(fn),
    });
  } catch (e) {
    throw new Error(
      `${e instanceof Error ? e.message : String(e)}\n--- server log (tail) ---\n${server.log().slice(-4000)}`,
    );
  } finally {
    for (const s of sides) await s.stop();
    for (const fn of afters) fn();
    removeVault(vaultA);
    removeVault(vaultB);
    await server.stop();
  }
  return true;
}

/** B's units as A stored them: the actor sequences, in order. */
async function unitsOf(side: Sections, R: ResourceId, who: Party): Promise<bigint[]> {
  return (
    await side.storage.dataUnits.range(
      R,
      who.signer.descriptor.principalId,
      actorSequence(1n),
      actorSequence(2n ** 32n),
    )
  ).map((u) => u.actorSeq);
}

const title = (side: Sections, n: number) =>
  side.profile.replica.task(uid(n) as never)?.task?.title;

describe("integrated crash, access and recovery faults (LFCP-02-070)", () => {
  it("F1: an ACK lost, then a client restart: sent again, accepted once", async (ctx) => {
    const R = resourceId(bytes32(135));
    const ran = await live("F1", R, importResourceDEK(bytes32(211)), async (o) => {
      const { a, b, vaultB } = o;
      const unitsBefore = await unitsOf(a, R, B);
      const dropAcks = o.tapB.rule((f) =>
        f.direction === "in" && f.message?.type === "ACK" ? { kind: "drop" } : undefined,
      );
      await b.client.commit(
        R,
        [{ intent: "task.set_title", id: uid(1001) as never, title: "B, its ACK lost" }],
        { operationId: "b-ack-lost" },
      );
      await waitFor("A has B's batch", () => title(a, 1001) === "B, its ACK lost", 60_000);
      await sleep(1_000);
      expect(accepted(b, "b-ack-lost")).toBe(false);
      const queued = await vaultB.storage.outbound.list(R);
      expect(queued.length).toBeGreaterThan(0);
      const receipt = await receiptOf(vaultB.storage, R, "b-ack-lost");
      expect(receipt?.durable).toBe(true);
      const seqBefore = b.profile.replica.actorSeq;

      // B restarts: the session ends, the vault is closed and reopened.
      await b.stop();
      dropAcks();
      await reopenVault(vaultB);
      const b2 = o.keep(await sectionSide(o.server.url, R, B, vaultB, true, o.tapB.factory));
      expect(b2.profile.replica.actorSeq).toBe(seqBefore);
      expect(await vaultB.storage.outbound.list(R)).toEqual(queued);
      b2.start();
      await waitFor("accepted after the restart", () => accepted(b2, "b-ack-lost"), 60_000);
      expect(await receiptOf(vaultB.storage, R, "b-ack-lost")).toMatchObject({
        operationId: receipt?.operationId,
      });
      await waitFor("B's queue empty", () => b2.queueEmpty(), 30_000);
      // The batch went out once before the restart and again after it.
      const putConnections = new Set(o.tapB.messages("DATA_PUT", "out").map((f) => f.connection));
      expect(putConnections.size).toBeGreaterThanOrEqual(2);

      // The next batch continues B's sequence; A has each unit once.
      await b2.client.commit(
        R,
        [{ intent: "task.set_status", id: uid(1002) as never, status: "done" }],
        { operationId: "b-next" },
      );
      await waitFor("b-next accepted", () => accepted(b2, "b-next"), 60_000);
      await waitFor(
        "A has b-next",
        () => a.profile.replica.revision() === b2.profile.replica.revision(),
        60_000,
      );
      const units = await unitsOf(a, R, B);
      expect(new Set(units.map(String)).size).toBe(units.length);
      expect(units.length).toBeGreaterThan(unitsBefore.length + 1);
      expect(units).toEqual([...units].sort((x, y) => (x < y ? -1 : 1)));
      expect(a.errors()).toEqual([]);
      expect(b2.errors()).toEqual([]);
      record("recovery", "F1", {
        dataPutsByBByConnection: o.tapB.messages("DATA_PUT", "out").map((f) => f.connection),
        acksDropped: o.tapB.messages("ACK", "in").length,
        bUnitsOnA: units,
        receipt: { operationId: receipt?.operationId, durable: receipt?.durable },
        batchStatuses: batchEvents(b2.events, "b-ack-lost").map((e) =>
          e.kind === "batch" ? e.status : e.kind,
        ),
      });
    });
    if (!ran) ctx.skip();
  }, 600_000);

  it("F2: the server restored from an older copy: B offers its batch again", async (ctx) => {
    const R = resourceId(bytes32(137));
    const dek = importResourceDEK(bytes32(213));
    const ran = await live("F2", R, dek, async (o) => {
      const { a, b, server } = o;
      const backup = server.files();
      await b.client.commit(
        R,
        [{ intent: "task.set_title", id: uid(1001) as never, title: "B, before the loss" }],
        { operationId: "b-before-loss" },
      );
      await waitFor("accepted", () => accepted(b, "b-before-loss"), 60_000);
      await waitFor("A has it", () => title(a, 1001) === "B, before the loss", 60_000);

      // A holds B's batch too and could re-supply it first; with A stopped,
      // B is the only holder, so B must offer it again.
      await a.stop();
      await server.restore(backup);
      await waitFor(
        "B offers the lost batch again",
        () => b.events.some((e) => e.type === "status" && e.event.kind === "reoffered"),
        60_000,
      );
      await waitFor("B's queue empty", () => b.queueEmpty(), 60_000);
      a.start();
      await waitFor("A LIVE again", () => a.client.resourceState(R) === "LIVE", 60_000);

      // A member who joins after the restore receives B's batch from the server.
      const vaultC = await openVault();
      o.after(() => removeVault(vaultC));
      {
        const invitation = await createInvitation({
          storage: o.vaultA.storage,
          resourceId: R,
          inviter: A.signer,
          dek,
          endpoints: [server.url],
        });
        a.client.flush();
        await waitFor("invitation sent", () => a.queueEmpty(), 30_000);
        const joined = await acceptInvitation({
          link: (invitation.link as InvitationLink).reveal(),
          claimant: C,
          storage: vaultC.storage,
          secrets: vaultC.secrets,
          now: () => Date.now(),
          timeout: sleep(20_000),
          dataProfiles: [SECTIONS_PROFILE_ID],
        });
        expect(joined.kind).toBe("claimed");
        const c = o.keep(await sectionSide(server.url, R, C, vaultC));
        c.start();
        await waitFor("C has B's batch", () => title(c, 1001) === "B, before the loss", 60_000);
        expect(c.errors()).toEqual([]);
        const reoffered = b.events.flatMap((e) =>
          e.type === "status" && e.event.kind === "reoffered" ? [e.event] : [],
        );
        record("recovery", "F2", {
          reoffered: reoffered.map((e) =>
            e.kind === "reoffered" ? { units: e.unitIds.length, reason: e.reason } : null,
          ),
          joinedAfterRestore: joined.kind,
        });
      }
    });
    if (!ran) ctx.skip();
  }, 600_000);

  it("F3: revoked while offline, restarted twice: blocked, nothing reset", async (ctx) => {
    const R = resourceId(bytes32(139));
    const ran = await live("F3", R, importResourceDEK(bytes32(215)), async (o) => {
      const { a, b, vaultB } = o;
      await b.stop();
      await b.client.commit(
        R,
        [{ intent: "task.set_title", id: uid(1001) as never, title: "B, offline and revoked" }],
        { operationId: "b-stale" },
      );
      const queued = await vaultB.storage.outbound.list(R);
      const receipt = await receiptOf(vaultB.storage, R, "b-stale");
      expect(await a.client.revokeAccess(R, B.signer.descriptor.principalId)).toMatchObject({
        kind: "queued",
      });
      await waitFor("the revocation sent", () => a.queueEmpty(), 30_000);

      const facts: unknown[] = [];
      for (const restart of [1, 2]) {
        await reopenVault(vaultB);
        const bn = o.keep(await sectionSide(o.server.url, R, B, vaultB, true));
        bn.start();
        await waitFor(
          `restart ${restart}: blocked`,
          async () =>
            (await bn.client.statusSnapshot(R)).batches.find((x) => x.operationId === "b-stale")
              ?.status === "blocked",
          60_000,
        );
        const snap = await bn.client.statusSnapshot(R);
        expect(snap.access).toMatchObject({ allowed: false, reason: "server-refused" });
        expect(snap.catchUp.state).toBe("unknown");
        expect(await vaultB.storage.outbound.list(R)).toEqual(queued);
        expect(await receiptOf(vaultB.storage, R, "b-stale")).toEqual(receipt);
        expect(title(bn, 1001)).toBe("B, offline and revoked");
        facts.push({
          restart,
          access: snap.access,
          batch: snap.batches.find((x) => x.operationId === "b-stale")?.status,
          catchUp: snap.catchUp.state,
          queued: queued.length,
        });
        await bn.stop();
      }
      await sleep(1_000);
      expect(title(a, 1001)).not.toBe("B, offline and revoked");
      expect(a.errors()).toEqual([]);
      record("recovery", "F3", facts);
    });
    if (!ran) ctx.skip();
  }, 600_000);

  it("F4: the server crashes after committing a Control Record, before the ACK", async (ctx) => {
    const R = resourceId(bytes32(141));
    const dek = importResourceDEK(bytes32(217));
    const ran = await live("F4", R, dek, async (o) => {
      const { a, server } = o;
      const committed = () => server.log().split("Control Record committed").length - 1;
      const before = committed();
      const dropAcks = o.tapA.rule((f) =>
        f.direction === "in" && f.message?.type === "ACK" ? { kind: "drop" } : undefined,
      );
      const invitation = await createInvitation({
        storage: o.vaultA.storage,
        resourceId: R,
        inviter: A.signer,
        dek,
        endpoints: [server.url],
      });
      a.client.flush();
      await waitFor("the server committed the record", () => committed() > before, 30_000);
      expect(await a.queueEmpty()).toBe(false);
      await server.restart();
      dropAcks();
      await waitFor("A's record ACKed after the restart", () => a.queueEmpty(), 60_000);
      const puts = o.tapA.messages("CONTROL_PUT", "out").length;
      expect(puts).toBeGreaterThan(1);

      const vaultC = await openVault();
      o.after(() => removeVault(vaultC));
      {
        const joined = await acceptInvitation({
          link: (invitation.link as InvitationLink).reveal(),
          claimant: C,
          storage: vaultC.storage,
          secrets: vaultC.secrets,
          now: () => Date.now(),
          timeout: sleep(20_000),
          dataProfiles: [SECTIONS_PROFILE_ID],
        });
        expect(joined.kind).toBe("claimed");
        const c = o.keep(await sectionSide(server.url, R, C, vaultC));
        c.start();
        await waitFor(
          "C converges",
          () => c.profile.replica.revision() === a.profile.replica.revision(),
          60_000,
        );
        expect(a.errors()).toEqual([]);
        expect(c.errors()).toEqual([]);
        record("recovery", "F4", {
          committedBeforeCrash: committed() - before,
          controlPutsByA: puts,
          joined: joined.kind,
          aControlSeq: (await o.vaultA.storage.control.head(R))?.controlSeq,
        });
      }
    });
    if (!ran) ctx.skip();
  }, 600_000);
});
