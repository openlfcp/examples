// The TypeScript side of the shared sections exchange (LFCP-02-023),
// `lfcp-interop-sections/1`: sdk-ts writes ten scenarios through its
// section writer and consumes another SDK's through its section admission
// (SectionReplica.receiveChanges), comparing the derived summary with the
// producer's. The scenario content is the producer's own; only the ids and
// the summary format are shared (see ts-adapter.ts for the format).

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as A from "@automerge/automerge";
import { fromHex, type PrincipalId, principalId, resourceId, toHex } from "@openlfcp/core";
import { createTask, frameProfilePayload, unframeChange } from "@openlfcp/shared-objects";
import {
  deriveSectionActorId,
  type SectionIntent,
  SectionReplica,
  type SectionUnit,
} from "@openlfcp/shared-objects/sections";

const FORMAT = "lfcp-interop-sections/1";

/** A document a malicious writer edits with raw Automerge: any shape. */
// biome-ignore lint/suspicious/noExplicitAny: raw changes write arbitrary shapes
type RawDoc = Record<string, any>;

interface Summary {
  classification: string;
  tree: [string, string, number, string][];
  hidden: string[];
  recovery: Record<string, string>;
  invalid: Record<string, string>;
  collisions: string[];
  refused: Record<string, string>;
  waiting: string[];
  retained_concurrent_edits: string[];
  texts: Record<string, string>;
  titles: Record<string, string>;
}
interface Scenario {
  id: string;
  description: string;
  resource_id: string;
  principals: Record<string, string>;
  changes: { signer: string; framed_plaintext: string }[];
  expected: Summary;
}
interface Bundle {
  format: string;
  producer: string;
  scenarios: Scenario[];
}

const bytes32 = (seed: number) => Uint8Array.from({ length: 32 }, (_, i) => (seed + i) & 0xff);
const RESOURCE = resourceId(bytes32(0x51));
const PRINCIPALS: Record<string, PrincipalId> = {
  A: principalId(bytes32(0x61)),
  B: principalId(bytes32(0x71)),
  C: principalId(bytes32(0x81)),
};
const opts = (who: string) => ({ resource: RESOURCE, principal: PRINCIPALS[who] as PrincipalId });
/** Deterministic canonical UUIDv7-shaped IDs: identities, not clocks. */
const uid = (n: number) => `0192e4a0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const [SECTION, T, P, X, Y, N, M] = [1, 2, 3, 4, 5, 6, 7].map(uid) as [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
];

/** JSON with object keys sorted at every level, so summaries compare whatever their writer. */
function canonical(value: unknown): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v !== null && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
          )
        : v;
  return JSON.stringify(sort(value));
}

/** The summary both SDKs derive: the format's fields, from the production model. */
function summarize(
  replica: SectionReplica,
  refused: Record<string, string>,
  waiting: readonly string[],
): Summary {
  const s = replica.snapshot();
  const json = replica.toJSON() as {
    nodes?: Record<string, { text?: string }>;
    objects?: Record<string, { title?: string; type?: string }>;
  };
  const sorted = (xs: readonly string[]) => [...xs].sort();
  return {
    classification: s.classification,
    tree: s.order.map((e) => [e.id, e.parent, e.depth, e.kind]),
    hidden: sorted(Object.entries(s.nodes).flatMap(([id, n]) => (n.hidden ? [id] : []))),
    recovery: Object.fromEntries(s.problems.recovery.map((x) => [x.id, x.code])),
    invalid: Object.fromEntries(s.problems.invalid.map((x) => [x.id, x.diagnostic])),
    collisions: sorted(s.problems.collisions),
    refused,
    waiting: sorted(waiting),
    retained_concurrent_edits: sorted(s.problems.retainedConcurrentEdits),
    texts: Object.fromEntries(
      Object.entries(json.nodes ?? {})
        .filter(([, n]) => n.text !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([id, n]) => [id, n.text as string]),
    ),
    titles: Object.fromEntries(
      Object.entries(json.objects ?? {})
        .filter(([, o]) => o.type === "task" && o.title !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([id, o]) => [id, o.title as string]),
    ),
  };
}

/** Receives `units` and summarizes; refused changes by hash, waiting ones listed. */
function receive(units: readonly SectionUnit[], who = "C"): Summary {
  const replica = SectionReplica.empty(opts(who));
  const out = replica.receiveChanges(units);
  const refused: Record<string, string> = {};
  for (const r of out.refused) if (!r.held && r.hash !== undefined) refused[r.hash] = r.diagnostic;
  return summarize(replica, refused, out.waiting);
}

/** A scenario under construction: replicas per writer, and the changes in the order written. */
class Writer {
  readonly changes: { signer: string; bytes: Uint8Array }[] = [];
  readonly replicas = new Map<string, SectionReplica>();

  /** A writer's replica, loaded from every change written so far when it first writes. */
  of(who: string): SectionReplica {
    let r = this.replicas.get(who);
    if (r === undefined) {
      r = SectionReplica.fromChanges(
        this.changes.map((c) => c.bytes),
        opts(who),
      ).replica;
      this.replicas.set(who, r);
    }
    return r;
  }

  commit(who: string, intents: (r: SectionReplica) => SectionIntent[]): void {
    const r = this.of(who);
    const c = r.commit(intents(r));
    if (c !== null) this.changes.push({ signer: who, bytes: c.change });
  }

  /** Brings `who` up to date with every change written so far. */
  sync(who: string): void {
    this.of(who).receiveChanges(this.changes.map((c) => c.bytes));
  }

  /** A change built with raw Automerge on `who`'s replica, as a malicious writer could. */
  raw(who: string, fn: (d: RawDoc) => void, signer = who): void {
    const actor = toHex(deriveSectionActorId(RESOURCE, PRINCIPALS[who] as PrincipalId));
    const doc = A.change(A.load<RawDoc>(this.of(who).save(), { actor }), { time: 0 }, fn);
    this.changes.push({ signer, bytes: A.getLastLocalChange(doc) as Uint8Array });
  }
}

/** The base of every scenario: a ready section with a Task, its paragraph and two items. */
function base(w: Writer): void {
  const A_ = PRINCIPALS.A as PrincipalId;
  w.commit("A", () => [
    { intent: "section.create", sectionId: SECTION, title: "Launch", createdBy: A_ },
    {
      intent: "task.create_in_section",
      task: createTask({ id: T as never, title: "Prepare contract", createdBy: A_ }).task,
      parent: SECTION,
      after: null,
    },
    {
      intent: "paragraph.create",
      id: P,
      parent: T,
      after: null,
      text: "Draft contract",
      createdBy: A_,
    },
    { intent: "item.create", id: X, parent: SECTION, after: T, text: "Group X", createdBy: A_ },
    { intent: "item.create", id: Y, parent: SECTION, after: X, text: "Group Y", createdBy: A_ },
  ]);
}

const B_ = () => PRINCIPALS.B as PrincipalId;
const SCENARIOS: { id: string; description: string; build: (w: Writer) => void }[] = [
  { id: "basic", description: "A section with a Task, a paragraph and two items", build: base },
  {
    id: "concurrent_insert",
    description: "A and B insert different paragraphs after the Task concurrently",
    build: (w) => {
      base(w);
      w.of("B");
      w.commit("A", () => [
        {
          intent: "paragraph.create",
          id: N,
          parent: SECTION,
          after: T,
          text: "From A",
          createdBy: PRINCIPALS.A as PrincipalId,
        },
      ]);
      w.commit("B", () => [
        {
          intent: "paragraph.create",
          id: M,
          parent: SECTION,
          after: T,
          text: "From B",
          createdBy: B_(),
        },
      ]);
    },
  },
  {
    id: "placement_conflict",
    description: "A moves the Task under X, B under Y, concurrently",
    build: (w) => {
      base(w);
      w.of("B");
      w.commit("A", () => [{ intent: "node.move", id: T, parent: X, after: null }]);
      w.commit("B", () => [{ intent: "node.move", id: T, parent: Y, after: null }]);
    },
  },
  {
    id: "parent_cycle",
    description: "A moves X under Y, B moves Y under X, concurrently",
    build: (w) => {
      base(w);
      w.of("B");
      w.commit("A", () => [{ intent: "node.move", id: X, parent: Y, after: null }]);
      w.commit("B", () => [{ intent: "node.move", id: Y, parent: X, after: null }]);
    },
  },
  {
    id: "delete_vs_edit",
    description: "A deletes the Task while B edits its paragraph",
    build: (w) => {
      base(w);
      w.of("B");
      w.commit("A", () => [{ intent: "node.delete", id: T }]);
      w.commit("B", (r) => [
        {
          intent: "text.edit",
          id: P,
          base: r.revision(),
          edits: [{ index: 0, deleteCount: 0, insert: "Kept " }],
        },
      ]);
    },
  },
  {
    id: "split_join",
    description: "A splits the paragraph, then joins X and Y",
    build: (w) => {
      base(w);
      w.commit("A", (r) => [
        {
          intent: "paragraph.split",
          id: P,
          base: r.revision(),
          at: 6,
          newId: N,
          createdBy: PRINCIPALS.A as PrincipalId,
        },
      ]);
      w.commit("A", () => [{ intent: "node.join", id: X, second: Y }]);
    },
  },
  {
    id: "text_unicode",
    description: "Cyrillic and emoji edits by A and B concurrently, in Unicode scalar positions",
    build: (w) => {
      base(w);
      w.commit("A", (r) => [
        {
          intent: "text.edit",
          id: P,
          base: r.revision(),
          edits: [{ index: 0, deleteCount: 14, insert: "А😀Б" }],
        },
      ]);
      w.sync("B");
      w.commit("A", (r) => [
        {
          intent: "text.edit",
          id: P,
          base: r.revision(),
          edits: [{ index: 2, deleteCount: 0, insert: "!" }],
        },
      ]);
      w.commit("B", (r) => [
        {
          intent: "text.edit",
          id: P,
          base: r.revision(),
          edits: [{ index: 0, deleteCount: 0, insert: "Я: " }],
        },
      ]);
    },
  },
  {
    id: "refused_children_mutated",
    description:
      "B deletes a slot of the section's children list (A1), and writes a title after it",
    build: (w) => {
      base(w);
      w.raw("B", (d) => d.section.children.splice(0, 1));
      const bad = w.changes.at(-1)?.bytes as Uint8Array;
      const actor = toHex(deriveSectionActorId(RESOURCE, B_()));
      const after = A.applyChanges(A.load<RawDoc>(w.of("B").save(), { actor }), [bad])[0];
      const next = A.change(after, { time: 0 }, (d) => {
        d.objects[T].title = new A.ImmutableString("After");
      });
      w.changes.push({ signer: "B", bytes: A.getLastLocalChange(next) as Uint8Array });
    },
  },
  {
    id: "refused_actor_mismatch",
    description: "A's valid change carried in a Data Unit signed by B",
    build: (w) => {
      base(w);
      w.commit("A", () => [{ intent: "task.set_title", id: T as never, title: "Forwarded" }]);
      const last = w.changes.at(-1);
      if (last !== undefined) last.signer = "B";
    },
  },
  {
    id: "id_collision",
    description: "A and B create a node under one ID concurrently",
    build: (w) => {
      base(w);
      w.of("B");
      w.commit("A", () => [
        {
          intent: "paragraph.create",
          id: N,
          parent: SECTION,
          after: Y,
          text: "From A",
          createdBy: PRINCIPALS.A as PrincipalId,
        },
      ]);
      w.commit("B", () => [
        {
          intent: "item.create",
          id: N,
          parent: SECTION,
          after: Y,
          text: "From B",
          createdBy: B_(),
        },
      ]);
    },
  },
];

/** Writes `<dir>/sections.json`: every scenario with the summary sdk-ts derives from it. */
export async function produceSections(dir: string): Promise<void> {
  const scenarios: Scenario[] = SCENARIOS.map(({ id, description, build }) => {
    const w = new Writer();
    build(w);
    const units: SectionUnit[] = w.changes.map((c) => ({
      bytes: c.bytes,
      signer: PRINCIPALS[c.signer] as PrincipalId,
    }));
    return {
      id,
      description,
      resource_id: toHex(RESOURCE),
      principals: Object.fromEntries(Object.entries(PRINCIPALS).map(([n, p]) => [n, toHex(p)])),
      changes: w.changes.map((c) => ({
        signer: c.signer,
        framed_plaintext: toHex(frameProfilePayload(c.bytes)),
      })),
      expected: receive(units),
    };
  });
  const bundle: Bundle = { format: FORMAT, producer: "ts", scenarios };
  writeFileSync(join(dir, "sections.json"), `${JSON.stringify(bundle, null, 2)}\n`);
}

/**
 * Reads `<dir>/sections.json`, replays every scenario through the sdk-ts
 * section admission in order and in reverse with duplicates, and writes
 * `<dir>/sections-results-ts.json` with one check per scenario.
 */
export async function consumeSections(dir: string): Promise<void> {
  const bundle: Bundle = JSON.parse(readFileSync(join(dir, "sections.json"), "utf8"));
  if (bundle.format !== FORMAT) throw new Error(`sections format ${bundle.format}`);
  const checks: { id: string; category: string; result: "PASS" | "FAIL"; detail: string }[] = [];
  for (const s of bundle.scenarios) {
    let detail = "";
    try {
      const resource = resourceId(fromHex(s.resource_id));
      const principals = Object.fromEntries(
        Object.entries(s.principals).map(([n, h]) => [n, principalId(fromHex(h))]),
      );
      // The plaintext is [1, change] (SOP §11); a framing the profile refuses is the change's refusal.
      const units: SectionUnit[] = s.changes.map((c) => {
        const plaintext = fromHex(c.framed_plaintext);
        let change: Uint8Array;
        try {
          change = unframeChange(plaintext).bytes;
        } catch {
          change = plaintext;
        }
        return { bytes: change, signer: principals[c.signer] as PrincipalId };
      });
      const run = (list: readonly SectionUnit[]) => {
        const replica = SectionReplica.empty({ resource, principal: principalId(bytes32(0xf1)) });
        const out = replica.receiveChanges(list);
        const refused: Record<string, string> = {};
        for (const r of out.refused)
          if (!r.held && r.hash !== undefined) refused[r.hash] = r.diagnostic;
        return summarize(replica, refused, out.waiting);
      };
      const want = canonical(s.expected);
      for (const [mode, list] of [
        ["in order", units],
        ["in reverse with duplicates", [...units].reverse().flatMap((u) => [u, u])],
      ] as const) {
        const got = canonical(run(list));
        if (got !== want) {
          detail = `${mode}: expected ${want}, got ${got}`;
          break;
        }
      }
    } catch (e) {
      detail = `threw ${e instanceof Error ? e.message : String(e)}`;
    }
    checks.push({
      id: `sections.${s.id}`,
      category: "sections",
      result: detail === "" ? "PASS" : "FAIL",
      detail,
    });
  }
  writeFileSync(
    join(dir, "sections-results-ts.json"),
    `${JSON.stringify({ consumer: "ts", checks }, null, 2)}\n`,
  );
}
