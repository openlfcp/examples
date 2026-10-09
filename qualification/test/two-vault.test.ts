// LFCP-02-056: the secure two-vault qualification of shared sections,
// MVP-0.2-TEST-AND-RELEASE-PLAN §7, on the real SDK (sdk-ts at the pin) and
// the Rust reference server, with two independent Principals: separate
// keys, storage and secrets, nothing cloned between them. Every Data Unit
// is sealed, signed and encrypted; the server sees ciphertext only.
//
// Steps 1–4 (this file): A previews a private section with child content
// between private canaries, creates a dedicated section Resource and waits
// until it is hosted; A issues one invitation and B joins through the
// one-time claim and key delivery; B keeps the section beside its own
// private canaries; both create and edit nodes and see each other's
// changes, with accepted batch statuses. Run for W20 and W200, one after
// the other. Skipped, saying why, without cargo or a server checkout,
// unless LFCP_REQUIRE_LIVE=1.

import {
  acceptInvitation,
  createInvitation,
  type StatusEvent,
  type SyncEvent,
} from "@openlfcp/client";
import { resourceId } from "@openlfcp/core";
import { importResourceDEK } from "@openlfcp/crypto";
import { createTask } from "@openlfcp/shared-objects";
import {
  SECTIONS_PROFILE_ID,
  type SectionIntent,
  SectionReplica,
  SharedSectionsDataProfile,
} from "@openlfcp/shared-objects/sections";
import { InMemoryLfcpStorage, InMemorySecretStore } from "@openlfcp/storage";
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

declare const console: { warn(...a: unknown[]): void };

const A = party(141);
const B = party(171);
const DEK0 = importResourceDEK(bytes32(201));
const uid = (n: number) => `0192e4a0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

/** Text that must never leave its vault: the notes around each projection. */
const CANARY_A = "A-private-canary-0561 note text around the section";
const CANARY_B = "B-private-canary-0562 note text around the inserted section";

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

const sectionSide = (
  url: string,
  resource: ReturnType<typeof resourceId>,
  who: Party,
  stores?: { storage: InMemoryLfcpStorage; secrets: InMemorySecretStore },
) => {
  const profile = new SharedSectionsDataProfile(
    SectionReplica.empty({ resource, principal: who.signer.descriptor.principalId }),
  );
  return new Side({
    url,
    resource,
    who,
    profile,
    commit: profile.commitBinding(who.signer.descriptor.principalId) as never,
    ...(stores ?? {}),
  });
};

/** The batch status events of a side for one operation. */
const batchEvents = (events: readonly SyncEvent[], operationId: string): StatusEvent[] =>
  events.flatMap((e) =>
    e.type === "status" && e.event.kind === "batch" && e.event.operationId === operationId
      ? [e.event]
      : [],
  );

/** W tasks, each with a paragraph child: the private section A previews (§7 step 1). */
function section(W: number, me: Party["signer"]["descriptor"]["principalId"]): SectionIntent[] {
  const intents: SectionIntent[] = [
    { intent: "section.create", sectionId: uid(1), title: `Launch plan (${W})`, createdBy: me },
  ];
  let after: string | null = null;
  for (let k = 0; k < W; k++) {
    const task = uid(1000 + k);
    intents.push({
      intent: "task.create_in_section",
      task: createTask({ id: task as never, title: `Task ${k} of the plan`, createdBy: me }).task,
      parent: uid(1),
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

for (const W of [20, 200])
  describe(`two vaults, W${W} (§7 steps 1–4)`, () => {
    it("creates, invites, joins, inserts and edits with independent identities", async (ctx) => {
      if (server === undefined) {
        console.warn(`SKIPPED: the two-vault qualification (${skip})`);
        ctx.skip();
        return;
      }
      const url = server.url;
      const R = resourceId(bytes32(W === 20 ? 31 : 61));
      const meA = A.signer.descriptor.principalId;
      const meB = B.signer.descriptor.principalId;
      const sides: Side<SharedSectionsDataProfile>[] = [];
      try {
        // 1. A's private preview becomes a dedicated section Resource.
        const a = sectionSide(url, R, A);
        sides.push(a);
        const genesis = await createResource(a, url, DEK0);
        a.start({ open: false });
        await waitFor("A READY", () => a.client.connectionState === "READY");
        await a.client.host(genesis.bytes);
        a.open();
        await waitFor("A LIVE", () => a.client.resourceState(R) === "LIVE");
        const created = await a.client.commit(R, section(W, meA), { operationId: "create" });
        // W200 with its paragraphs is over one change's budgets: several units, one receipt.
        expect(created.unitIds.length).toBe(W === 20 ? 1 : 2);
        await waitFor("A's section sent", () => a.queueEmpty(), 60_000);
        await waitFor(
          "A's batch accepted",
          () =>
            batchEvents(a.events, "create").some(
              (e) => e.kind === "batch" && e.status === "accepted",
            ),
          30_000,
        );
        expect(a.profile.replica.snapshot().classification).toBe("VALID");
        expect(a.profile.replica.snapshot().order).toHaveLength(2 * W);

        // 2. One invitation; B joins through the one-time claim and key delivery.
        const invitation = await createInvitation({
          storage: a.storage,
          resourceId: R,
          inviter: A.signer,
          dek: DEK0,
          endpoints: [url],
        });
        a.client.flush();
        await waitFor("invitation sent", () => a.queueEmpty(), 30_000);
        const stores = { storage: new InMemoryLfcpStorage(), secrets: new InMemorySecretStore() };
        const joined = await acceptInvitation({
          link: invitation.link,
          claimant: B,
          ...stores,
          now: () => Date.now(),
          timeout: sleep(20_000),
          dataProfiles: [SECTIONS_PROFILE_ID],
        });
        expect(joined).toMatchObject({ kind: "claimed" });

        // 3. B keeps the section beside its own private note: only the section syncs.
        const b = sectionSide(url, R, B, stores);
        sides.push(b);
        b.start();
        await waitFor("B LIVE", () => b.client.resourceState(R) === "LIVE", 60_000);
        await waitFor(
          "B has A's section",
          () => b.profile.replica.snapshot().order.length === 2 * W,
          120_000,
        );
        expect(b.profile.replica.revision()).toBe(a.profile.replica.revision());

        // 4. Both create and edit nodes; each sees the other's, and each batch is accepted.
        const bTask = uid(9000);
        await b.client.commit(
          R,
          [
            {
              intent: "task.create_in_section",
              task: createTask({ id: bTask as never, title: "B's follow-up", createdBy: meB }).task,
              parent: uid(1),
              after: null,
            },
          ],
          { operationId: "b-1" },
        );
        await a.client.commit(
          R,
          [{ intent: "task.set_status", id: uid(1000) as never, status: "done" }],
          {
            operationId: "a-1",
          },
        );
        await a.client.commit(
          R,
          [
            {
              intent: "text.edit",
              id: uid(5000),
              base: a.profile.replica.revision(),
              edits: [{ index: 0, deleteCount: 0, insert: "Agreed: " }],
            },
          ],
          { operationId: "a-2" },
        );
        await waitFor(
          "both converge",
          () => a.profile.replica.revision() === b.profile.replica.revision(),
          60_000,
        );
        const view = b.profile.replica.snapshot();
        expect(view.order.map((e) => e.id)).toContain(bTask);
        expect(view.nodes[uid(5000)]?.text?.startsWith("Agreed: ")).toBe(true);
        for (const [side, op] of [
          [b, "b-1"],
          [a, "a-1"],
          [a, "a-2"],
        ] as const)
          await waitFor(
            `${op} accepted`,
            () =>
              batchEvents(side.events, op).some(
                (e) => e.kind === "batch" && e.status === "accepted",
              ),
            30_000,
          );
        expect(a.errors()).toEqual([]);
        expect(b.errors()).toEqual([]);

        // No task or note text and no canary reaches the server (opacity, §7 step 11, early).
        const files = server.files();
        const log = server.log();
        for (const secret of [
          CANARY_A,
          CANARY_B,
          "Task 0 of the plan",
          "Notes for task 0",
          "B's follow-up",
          "Agreed: ",
        ]) {
          const needle = new TextEncoder().encode(secret);
          for (const f of files)
            expect(indexOf(f.bytes, needle), `${secret} in ${f.path}`).toBe(-1);
          expect(log.includes(secret), `${secret} in the server log`).toBe(false);
        }
      } finally {
        for (const s of sides) await s.stop();
      }
    }, 300_000);
  });

function indexOf(hay: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}
