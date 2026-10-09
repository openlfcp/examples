// LFCP-02-056, MVP-0.2-TEST-AND-RELEASE-PLAN §7 steps 5–7, live: after the
// two vaults are joined (steps 1–3), the clients are partitioned; each
// edits offline — independent fields and Text, and one conflicting move of
// the same Task to different parents. B restarts with its pending work
// (vault closed and reopened, profile from its checkpoint) and keeps its
// receipts and actor sequence. Both reconnect: the units cross, both reach
// the same revision, and both show the placement conflict with its
// candidates, nothing duplicated. A resolves it causally; both end VALID.

import { receiptOf } from "@openlfcp/client";
import { resourceId } from "@openlfcp/core";
import { importResourceDEK } from "@openlfcp/crypto";
import type { SharedSectionsDataProfile } from "@openlfcp/shared-objects/sections";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bytes32, party, type Side, waitFor } from "../../../sdk-ts/conformance/interop/harness.js";
import {
  type RunningRustServer,
  startRustServer,
} from "../../../sdk-ts/conformance/interop/rust-server.mjs";
import {
  accepted,
  openVault,
  removeVault,
  reopenVault,
  SECTION,
  sectionSide,
  twoVaults,
  uid,
  type Vault,
} from "./support.js";

declare const console: { warn(...a: unknown[]): void };

const A = party(143);
const B = party(173);
const DEK0 = importResourceDEK(bytes32(203));
const R = resourceId(bytes32(91));

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

describe("two vaults: partition, restart with pending work, conflict and resolution (§7 steps 5–7)", () => {
  it("converges, shows the conflict on both sides, and resolves it causally", async (ctx) => {
    if (server === undefined) {
      console.warn(`SKIPPED: the two-vault partition (${skip})`);
      ctx.skip();
      return;
    }
    const url = server.url;
    const vaultA: Vault = await openVault();
    const vaultB: Vault = await openVault();
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
      const moved = uid(1003);

      // 5. Partition: both stop; each edits offline, and both move one Task elsewhere.
      await a.stop();
      await b.stop();
      await a.client.commit(
        R,
        [
          {
            intent: "text.edit",
            id: uid(5001),
            base: a.profile.replica.revision(),
            edits: [{ index: 0, deleteCount: 0, insert: "A offline: " }],
          },
          { intent: "node.move", id: moved, parent: uid(1004), after: null },
        ],
        { operationId: "a-offline" },
      );
      await b.client.commit(
        R,
        [
          { intent: "task.set_title", id: uid(1002) as never, title: "Renamed by B offline" },
          { intent: "node.move", id: moved, parent: uid(1005), after: null },
        ],
        { operationId: "b-offline-1" },
      );
      await b.client.commit(
        R,
        [{ intent: "task.set_status", id: uid(1006) as never, status: "done" }],
        {
          operationId: "b-offline-2",
        },
      );
      const pendingB = (await vaultB.storage.outbound.list(R)).length;
      expect(pendingB).toBe(2);
      const seqBefore = b.profile.replica.actorSeq;

      // 6. B restarts with its pending work: the vault is closed and reopened.
      await reopenVault(vaultB);
      const b2 = await sectionSide(url, R, B, vaultB, true);
      sides.push(b2);
      expect(b2.profile.replica.actorSeq).toBe(seqBefore);
      expect(b2.profile.replica.writable).toBe(true);
      expect(await vaultB.storage.outbound.list(R)).toHaveLength(pendingB);
      for (const op of ["b-offline-1", "b-offline-2"])
        expect((await receiptOf(vaultB.storage, R, op))?.durable).toBe(true);

      // Reconnect both.
      const a2 = await sectionSide(url, R, A, vaultA, true);
      sides.push(a2);
      a2.start();
      b2.start();
      await waitFor(
        "both converge after the partition",
        () =>
          a2.profile.replica.revision() === b2.profile.replica.revision() &&
          a2.profile.replica.changes().length >= 4,
        120_000,
      );
      for (const side of [a2, b2]) {
        const view = side.profile.replica.snapshot();
        expect(view.classification).toBe("STRUCTURAL_ATTENTION");
        expect(view.problems.recovery).toContainEqual({ id: moved, code: "PLACEMENT_CONFLICT" });
        expect(
          side.profile.replica
            .tree()
            .candidates.get(moved)
            ?.map((c) => c.parent)
            .sort(),
        ).toEqual([uid(1004), uid(1005)].sort());
        expect(view.nodes[uid(5001)]?.text?.startsWith("A offline: ")).toBe(true);
        // No node is duplicated: one entry per node in the visible order.
        const ids = view.order.map((e) => e.id);
        expect(new Set(ids).size).toBe(ids.length);
      }
      expect(b2.profile.replica.task(uid(1002))?.task?.title).toBe("Renamed by B offline");
      for (const op of ["b-offline-1", "b-offline-2"])
        await waitFor(`${op} accepted after the restart`, () => accepted(b2, op), 60_000);

      // 7. A resolves the conflict causally; both end VALID with the Task under the section.
      await a2.client.commit(
        R,
        [{ intent: "node.resolve_placement", id: moved, parent: SECTION, after: null }],
        {
          operationId: "a-resolve",
        },
      );
      await waitFor(
        "both converge after the resolution",
        () =>
          a2.profile.replica.revision() === b2.profile.replica.revision() &&
          b2.profile.replica.snapshot().classification === "VALID",
        60_000,
      );
      expect(a2.profile.replica.snapshot().order.find((e) => e.id === moved)?.parent).toBe(SECTION);
      expect(a2.errors()).toEqual([]);
      expect(b2.errors()).toEqual([]);
    } finally {
      for (const s of sides) await s.stop();
      removeVault(vaultA);
      removeVault(vaultB);
    }
  }, 300_000);
});
