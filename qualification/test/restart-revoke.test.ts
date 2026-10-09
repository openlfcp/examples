// LFCP-02-056, MVP-0.2-TEST-AND-RELEASE-PLAN §7 steps 8–10, live, after the
// two vaults are joined (steps 1–3):
//
// 8. A publishes a Snapshot and writes a tail; the server restarts on its
//    persisted state. C, a third independent Principal, joins afterwards:
//    it loads the Snapshot, accepts its frontier, fetches only the tail and
//    reaches A's revision. B reconnects and converges too.
// 9. B goes offline and writes. A revokes B and rotates the Data Epoch, then
//    writes at the new epoch: C reads it, B never gets it. B's stale offline
//    batch is never merged by A or C and is not accepted, while B keeps it
//    in its own state (the local candidate is not erased).
// 10. C detaches its local projection: C stops; no shared change follows,
//     and A and the Resource on the server carry on.

import { acceptInvitation, createInvitation } from "@openlfcp/client";
import { resourceId } from "@openlfcp/core";
import { importResourceDEK } from "@openlfcp/crypto";
import {
  SECTIONS_PROFILE_ID,
  type SharedSectionsDataProfile,
} from "@openlfcp/shared-objects/sections";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bytes32,
  party,
  type Side,
  sleep,
  waitFor,
} from "../../../sdk-ts/conformance/interop/harness.js";
import {
  type RunningRustServer,
  startRustServer,
} from "../../../sdk-ts/conformance/interop/rust-server.mjs";
import {
  accepted,
  batchEvents,
  openVault,
  record,
  removeVault,
  SECTION,
  sectionSide,
  twoVaults,
  uid,
  type Vault,
} from "./support.js";

declare const console: { warn(...a: unknown[]): void };

const A = party(145);
const B = party(175);
const C = party(185);
const DEK0 = importResourceDEK(bytes32(205));
const R = resourceId(bytes32(121));

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

const item = (n: number, text: string, by: typeof A) => ({
  intent: "item.create" as const,
  id: uid(n),
  parent: SECTION,
  after: null,
  text,
  createdBy: by.signer.descriptor.principalId,
});

describe("two vaults: server restart with Snapshot and tail, revocation, detach (§7 steps 8–10)", () => {
  it("joins after a restart from the Snapshot, revokes B with its stale work kept out, and detaches", async (ctx) => {
    if (server === undefined) {
      console.warn(`SKIPPED: the two-vault restart and revocation (${skip})`);
      ctx.skip();
      return;
    }
    const srv = server;
    const url = srv.url;
    const vaults: Vault[] = [await openVault(), await openVault(), await openVault()];
    const [vaultA, vaultB, vaultC] = vaults as [Vault, Vault, Vault];
    const sides: Side<SharedSectionsDataProfile>[] = [];
    try {
      const { a, b } = await twoVaults({
        url,
        resource: R,
        A,
        B,
        dek: DEK0,
        W: 20,
        vaultA,
        vaultB,
      });
      sides.push(a, b);

      // 8. Snapshot, tail, server restart; C joins from the Snapshot.
      await a.client.publishSnapshot(R);
      await waitFor("Snapshot ACKed", () => a.queueEmpty(), 30_000);
      await a.client.commit(R, [item(7000, "tail one", A)], { operationId: "tail-1" });
      await a.client.commit(R, [item(7001, "tail two", A)], { operationId: "tail-2" });
      await waitFor("tail ACKed", () => a.queueEmpty(), 30_000);
      await srv.restart();
      await waitFor("A LIVE after the restart", () => a.client.resourceState(R) === "LIVE", 60_000);
      await waitFor("B LIVE after the restart", () => b.client.resourceState(R) === "LIVE", 60_000);

      const invitation = await createInvitation({
        storage: vaultA.storage,
        resourceId: R,
        inviter: A.signer,
        dek: DEK0,
        endpoints: [url],
      });
      a.client.flush();
      await waitFor("invitation for C sent", () => a.queueEmpty(), 30_000);
      const joined = await acceptInvitation({
        link: invitation.link,
        claimant: C,
        storage: vaultC.storage,
        secrets: vaultC.secrets,
        now: () => Date.now(),
        timeout: sleep(20_000),
        dataProfiles: [SECTIONS_PROFILE_ID],
      });
      expect(joined.kind).toBe("claimed");
      const c = await sectionSide(url, R, C, vaultC);
      sides.push(c);
      c.start();
      await waitFor(
        "C converged with A",
        () => c.profile.replica.revision() === a.profile.replica.revision(),
        120_000,
      );
      expect(c.events.some((e) => e.type === "snapshot-loaded")).toBe(true);
      expect(
        c.events.filter((e) => e.type === "unit" && e.outcome.kind === "applied").length,
      ).toBeLessThan(a.profile.replica.changes().length);
      await waitFor(
        "B converged with A",
        () => b.profile.replica.revision() === a.profile.replica.revision(),
        60_000,
      );

      // 9. B offline writes; A revokes B and rotates the epoch, then writes on.
      await b.stop();
      await b.client.commit(R, [item(7100, "B's work after the cut", B)], {
        operationId: "b-stale",
      });
      const revoked = await a.client.revokeAccess(R, B.signer.descriptor.principalId);
      expect(revoked).toMatchObject({ kind: "queued", epoch: 1n });
      await waitFor("revocation and Key Epoch committed", () => a.queueEmpty(), 30_000);
      await a.client.commit(R, [item(7200, "after the revocation", A)], {
        operationId: "a-epoch-1",
      });
      await waitFor("A's new-epoch batch accepted", () => accepted(a, "a-epoch-1"), 30_000);
      await waitFor(
        "C reads the new epoch",
        () => c.profile.replica.snapshot().nodes[uid(7200)]?.text === "after the revocation",
        60_000,
      );
      b.start();
      await sleep(5_000);
      expect(b.profile.replica.snapshot().nodes[uid(7200)]).toBeUndefined();
      // B keeps its own stale work locally; nobody else merges it, and it is not accepted.
      expect(b.profile.replica.snapshot().nodes[uid(7100)]?.text).toBe("B's work after the cut");
      expect(a.profile.replica.snapshot().nodes[uid(7100)]).toBeUndefined();
      expect(c.profile.replica.snapshot().nodes[uid(7100)]).toBeUndefined();
      expect(
        batchEvents(b.events, "b-stale").some((e) => e.kind === "batch" && e.status === "accepted"),
      ).toBe(false);

      record("restart-revoke", "9-stale-offline-work", {
        statuses: batchEvents(b.events, "b-stale").map((e) =>
          e.kind === "batch" ? e.status : e.kind,
        ),
        nacks: b.events.flatMap((e) => (e.type === "nack" ? [e.outcome.kind] : [])),
        units: b.events.flatMap((e) => (e.type === "unit" ? [e.outcome.kind] : [])),
        outbound: (await vaultB.storage.outbound.list(R)).map((o) => ({
          kind: o.kind,
          blocked: o.blocked,
        })),
        keptInB: b.profile.replica.snapshot().nodes[uid(7100)] !== undefined,
        access: b.events.flatMap((e) =>
          e.type === "status" && e.event.kind === "access" ? [e.event.access] : [],
        ),
        errors: b.events.flatMap((e) => (e.type === "error" ? [e.code] : [])),
        state: b.client.resourceState(R),
      });

      // 10. C detaches its projection: C stops; nothing shared follows.
      const before = a.profile.replica.revision();
      await c.stop();
      await sleep(1_500);
      expect(a.profile.replica.revision()).toBe(before);
      await a.client.commit(R, [item(7300, "still writing", A)], { operationId: "a-after-detach" });
      await waitFor("A carries on", () => accepted(a, "a-after-detach"), 30_000);
      expect(a.errors()).toEqual([]);
    } catch (e) {
      throw new Error(
        `${e instanceof Error ? e.message : String(e)}\n--- server log (tail) ---\n${srv.log().slice(-3000)}`,
      );
    } finally {
      for (const s of sides) await s.stop();
      for (const v of vaults) removeVault(v);
    }
  }, 300_000);
});
