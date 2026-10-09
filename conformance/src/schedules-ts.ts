// The TypeScript side of the schedule runs (LFCP-02-024): sdk-ts runs each
// seed of `schedules.json` with its production section writer
// (SectionReplica) and consumes another SDK's histories through its section
// admission. The formats are the Rust adapter's (sdk-rs
// crates/lfcp/examples/interop_sections.rs); the histories two SDKs write
// from one seed differ and are never compared byte for byte.
//
// `produce-schedules` writes `sections-schedules.json` in the sections
// bundle format: per seed, the changes in causal order with their signers,
// the delivery orders made explicit (a shuffle, a shuffle with duplicates,
// a dropped connection: a prefix, then everything again) and the summary
// after admission. `consume-schedules` replays every scenario in order, in
// reverse with duplicates and in each delivery, compares the summary with
// the producer's, minimizes a failing delivery into `<dir>/regressions/`,
// replays the kept regressions (`sections-regressions.json`) and writes
// `schedules-results-ts.json` with the checks `schedules.minimizer`,
// `schedules.random` and `schedules.regressions`.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as A from "@automerge/automerge";
import {
  fromHex,
  type PrincipalId,
  principalId,
  type ResourceId,
  resourceId,
  toHex,
} from "@openlfcp/core";
import { createTask, frameProfilePayload, unframeChange } from "@openlfcp/shared-objects";
import {
  PARENT_KINDS,
  type SectionIntent,
  SectionReplica,
  type SectionUnit,
} from "@openlfcp/shared-objects/sections";
import { mulberry32, type Schedule } from "./schedules.js";
import { canonical, FORMAT, type Summary, summarize } from "./sections-ts.js";

const AUTHORS = ["A", "B", "C"] as const;
type Author = (typeof AUTHORS)[number];
const SECTION = "019a2f85-0000-7c42-8000-000000000001";
const WORDS = ["alpha", "Задача", "😀 emoji", "β", "line\nbreak"];

interface Scenario {
  id: string;
  description: string;
  resource_id: string;
  principals: Record<string, string>;
  changes: { signer: string; framed_plaintext: string }[];
  deliveries?: number[][];
  expected: Summary;
}
interface Bundle {
  format: string;
  producer: string;
  scenarios: Scenario[];
}
interface Check {
  id: string;
  category: string;
  result: "PASS" | "FAIL";
  detail: string;
}

/** 32 bytes of production randomness: identities made for one run. */
const random32 = () => crypto.getRandomValues(new Uint8Array(32));

/** A canonical UUIDv7 for object `n` of purpose `k` in seed `s`. */
const uuid = (s: number, k: number, n: number) =>
  `019a2f85-${s.toString(16).padStart(4, "0")}-7c42-${(0x8000 | k).toString(16)}-${n
    .toString(16)
    .padStart(12, "0")}`;

/** The length of `text` in Unicode scalar values, the positions of text.edit (§10). */
const scalars = (text: string) => [...text].length;

/**
 * The intent of one step for an author's current view (the generator's
 * numbers pick its nodes), or null when the view gives it nothing to act on.
 */
function intentOf(
  r: SectionReplica,
  me: PrincipalId,
  op: { readonly kind: string; readonly n: readonly number[] },
  ids: (purpose: number) => string,
): SectionIntent | null {
  const at = (i: number) => op.n[i] ?? 0;
  const snap = r.snapshot();
  const view = snap.order.map((e) => ({ id: e.id, parent: e.parent, kind: e.kind }));
  const parents = [
    SECTION,
    ...view.filter((v) => PARENT_KINDS.has(v.kind as never)).map((v) => v.id),
  ];
  const afterIn = (parent: string, pick: number): string | null => {
    const children = view.filter((v) => v.parent === parent).map((v) => v.id);
    const k = pick % (children.length + 1);
    return k === 0 ? null : (children[k - 1] as string);
  };
  const pick = (i: number) => view[at(i) % Math.max(view.length, 1)]?.id;
  const texts = view.filter((v) => v.kind !== "task").map((v) => v.id);
  const textPick = (i: number) => texts[at(i) % Math.max(texts.length, 1)];
  const textOf = (id: string) => snap.nodes[id]?.text ?? "";
  const word = (i: number) => WORDS[at(i) % WORDS.length] as string;
  switch (op.kind) {
    case "create": {
      const parent = parents[at(1) % parents.length] as string;
      const after = afterIn(parent, at(2));
      const text = word(3);
      const [id, placementId] = [ids(1), ids(2)];
      switch (at(0) % 3) {
        case 0:
          return {
            intent: "task.create_in_section",
            task: createTask({ id: id as never, title: text, createdBy: me }).task,
            parent,
            after,
            placementId,
          };
        case 1:
          return {
            intent: "paragraph.create",
            id,
            parent,
            after,
            placementId,
            text,
            createdBy: me,
          };
        default:
          return { intent: "item.create", id, parent, after, placementId, text, createdBy: me };
      }
    }
    case "move": {
      const node = pick(0);
      if (node === undefined) return null;
      const parent = parents[at(1) % parents.length] as string;
      return {
        intent: "node.move",
        id: node,
        parent,
        after: afterIn(parent, at(2)),
        placementId: ids(2),
      };
    }
    case "delete": {
      const node = pick(0);
      return node === undefined ? null : { intent: "node.delete", id: node };
    }
    case "restore": {
      const all = Object.keys(snap.nodes).sort();
      const node = all[at(0) % Math.max(all.length, 1)];
      return node === undefined ? null : { intent: "node.restore", id: node };
    }
    case "text": {
      const node = textPick(0);
      if (node === undefined) return null;
      const len = scalars(textOf(node));
      const index = at(1) % (len + 1);
      const deleteCount = at(2) % Math.min(len - index + 1, 4);
      return {
        intent: "text.edit",
        id: node,
        base: r.revision(),
        edits: [{ index, deleteCount, insert: word(3) }],
      };
    }
    case "split": {
      const node = textPick(0);
      if (node === undefined) return null;
      const kind = snap.nodes[node]?.kind;
      if (kind !== "paragraph" && kind !== "item") return null;
      const [newId, placementId] = [ids(3), ids(4)];
      return {
        intent: kind === "paragraph" ? "paragraph.split" : "item.split",
        id: node,
        base: r.revision(),
        at: at(1) % (scalars(textOf(node)) + 1),
        newId,
        placementId,
        createdBy: me,
      };
    }
    case "join": {
      const first = textPick(0);
      const parent = view.find((v) => v.id === first)?.parent;
      if (first === undefined || parent === undefined) return null;
      const siblings = view.filter((v) => v.parent === parent).map((v) => v.id);
      const second = siblings[siblings.indexOf(first) + 1];
      return second === undefined
        ? null
        : { intent: "node.join", id: first, second, separator: "\n" };
    }
    case "title":
      return { intent: "section.set_title", title: word(0) };
    default:
      throw new Error(`unknown schedule step ${op.kind}`);
  }
}

/** The summary after admitting `units` in order on a fresh replica. */
function replay(resource: ResourceId, units: readonly SectionUnit[]): Summary {
  const replica = SectionReplica.empty({
    resource,
    principal: principalId(new Uint8Array(32).fill(0xf1)),
  });
  const out = replica.receiveChanges(units);
  const refused: Record<string, string> = {};
  for (const r of out.refused) if (!r.held && r.hash !== undefined) refused[r.hash] = r.diagnostic;
  return summarize(replica, refused, out.waiting);
}

/** Runs one schedule with sdk-ts; returns the scenario in the bundle format. */
function runSchedule(schedule: Schedule): Scenario {
  const seed = schedule.seed;
  const resource = resourceId(random32());
  const principals = Object.fromEntries(AUTHORS.map((a) => [a, principalId(random32())])) as Record<
    Author,
    PrincipalId
  >;
  let counter = 0;
  const ids = (purpose: number) => uuid(seed & 0xffff, purpose, ++counter);
  const changes: { signer: Author; bytes: Uint8Array }[] = [];
  const writer = (a: Author) => ({ resource, principal: principals[a] });
  // A creates the section; B and C start from it.
  const a = SectionReplica.empty(writer("A"));
  const created = a.commit([
    { intent: "section.create", sectionId: SECTION, title: "Schedule", createdBy: principals.A },
  ]);
  for (const p of created?.parts ?? []) changes.push({ signer: "A", bytes: p.change });
  const replicas: Record<Author, SectionReplica> = {
    A: a,
    B: SectionReplica.fromChanges(a.changes(), writer("B")).replica,
    C: SectionReplica.fromChanges(a.changes(), writer("C")).replica,
  };
  let skipped = 0;
  for (const st of schedule.steps) {
    if ("sync" in st) {
      replicas[st.sync.to as Author].receiveChanges(replicas[st.sync.from as Author].changes());
      continue;
    }
    const who = st.actor as Author;
    const r = replicas[who];
    let intent: SectionIntent | null = null;
    try {
      intent = intentOf(r, principals[who], st.op, ids);
      const c = intent === null ? null : r.commit([intent]);
      if (c === null) skipped++;
      else for (const p of c.parts) changes.push({ signer: who, bytes: p.change });
    } catch {
      // The author's view refuses the intent: skipped, as in the Rust adapter.
      skipped++;
    }
  }
  // The causal order: every change after its dependencies.
  const all = SectionReplica.empty({
    resource,
    principal: principalId(new Uint8Array(32).fill(1)),
  });
  for (const who of AUTHORS) all.receiveChanges(replicas[who].changes());
  const order = new Map(all.changes().map((c, i) => [A.decodeChange(c).hash, i]));
  const position = (c: { bytes: Uint8Array }) => order.get(A.decodeChange(c.bytes).hash) ?? -1;
  changes.sort((x, y) => position(x) - position(y));
  const units: SectionUnit[] = changes.map((c) => ({
    bytes: c.bytes,
    signer: principals[c.signer],
  }));
  // Deliveries: a shuffle, a shuffle with duplicates, a dropped connection.
  const next = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  const below = (n: number) => next() % Math.max(n, 1);
  const n = changes.length;
  const deliveries = Array.from({ length: schedule.deliveries }, (_, k) => {
    const order: number[] = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i >= 1; i--) {
      const j = below(i + 1);
      [order[i], order[j]] = [order[j] as number, order[i] as number];
    }
    if (k % 3 === 1) return order.flatMap((i) => (below(3) === 0 ? [i, i] : [i]));
    if (k % 3 === 2) return [...order.slice(0, below(n + 1)), ...order];
    return order;
  });
  return {
    id: `seed-${seed}`,
    description: `schedule seed ${seed}: ${schedule.steps.length} steps, ${n} changes, ${skipped} intents skipped`,
    resource_id: toHex(resource),
    principals: Object.fromEntries(AUTHORS.map((w) => [w, toHex(principals[w])])),
    changes: changes.map((c) => ({
      signer: c.signer,
      framed_plaintext: toHex(frameProfilePayload(c.bytes)),
    })),
    deliveries,
    expected: replay(resource, units),
  };
}

export async function produceSchedules(dir: string): Promise<void> {
  const input: { schedules: Schedule[] } = JSON.parse(
    readFileSync(join(dir, "schedules.json"), "utf8"),
  );
  const bundle: Bundle = {
    format: FORMAT,
    producer: "ts",
    scenarios: input.schedules.map(runSchedule),
  };
  writeFileSync(join(dir, "sections-schedules.json"), `${JSON.stringify(bundle, null, 2)}\n`);
}

/** A scenario of a bundle, decoded for delivery. */
function parsed(s: Scenario) {
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
  /** The canonical summary after delivering `order` (indices into the changes). */
  const deliver = (order: readonly number[]) =>
    canonical(
      replay(
        resource,
        order.map((i) => units[i] as SectionUnit),
      ),
    );
  return { units, deliver };
}

/** The scenario replayed in order, reversed with duplicates and in each delivery, against the producer's summary. */
function check(s: Scenario): string {
  const { units, deliver } = parsed(s);
  const want = canonical(s.expected);
  const n = units.length;
  const orders: [string, number[]][] = [
    ["in order", Array.from({ length: n }, (_, i) => i)],
    [
      "reversed with duplicates",
      Array.from({ length: n }, (_, i) => n - 1 - i).flatMap((i) => [i, i]),
    ],
    ...(s.deliveries ?? []).map((d, k): [string, number[]] => [`delivery ${k}`, d]),
  ];
  for (const [mode, order] of orders) {
    const got = deliver(order);
    if (got !== want) return `${mode}: expected ${want}, got ${got}`;
  }
  return "";
}

/** The smallest sublist of `items` for which `fails` still holds (delta debugging); `fails(items)` holds. */
export function minimize(
  items: readonly number[],
  fails: (order: readonly number[]) => boolean,
): number[] {
  let out = [...items];
  let chunk = Math.max(Math.ceil(out.length / 2), 1);
  for (;;) {
    let removed = false;
    let start = 0;
    while (start < out.length) {
      const candidate = [...out.slice(0, start), ...out.slice(Math.min(start + chunk, out.length))];
      if (candidate.length > 0 && fails(candidate)) {
        out = candidate;
        removed = true;
      } else start += chunk;
    }
    if (chunk === 1 && !removed) return out;
    if (!removed) chunk = Math.ceil(chunk / 2);
  }
}

/** A failing delivery of `s`, minimized into a regression scenario, as the Rust adapter writes it. */
function regression(s: Scenario): Scenario | null {
  const { units, deliver } = parsed(s);
  const n = units.length;
  const candidates = [
    Array.from({ length: n }, (_, i) => n - 1 - i).flatMap((i) => [i, i]),
    ...(s.deliveries ?? []),
  ];
  const causal = (order: readonly number[]) => [...new Set(order)].sort((x, y) => x - y);
  const fails = (order: readonly number[]) => deliver(order) !== deliver(causal(order));
  const failing = candidates.find(fails);
  if (failing === undefined) return null;
  const minimal = minimize(failing, fails);
  const kept = causal(minimal);
  return {
    ...s,
    id: `${s.id}-minimized`,
    changes: kept.map((i) => s.changes[i] as Scenario["changes"][number]),
    deliveries: [minimal.map((i) => kept.indexOf(i))],
    expected: JSON.parse(deliver(kept)) as Summary,
  };
}

export async function consumeSchedules(dir: string): Promise<void> {
  const checks: Check[] = [];
  // The minimizer on a known predicate: the smallest order holding 3 and 7.
  const found = minimize(
    Array.from({ length: 20 }, (_, i) => i),
    (o) => o.includes(3) && o.includes(7),
  );
  const ok = found.length === 2 && found[0] === 3 && found[1] === 7;
  checks.push({
    id: "schedules.minimizer",
    category: "schedules",
    result: ok ? "PASS" : "FAIL",
    detail: ok ? "" : `minimized to ${JSON.stringify(found)}`,
  });
  const read = (name: string): Bundle | undefined => {
    try {
      return JSON.parse(readFileSync(join(dir, name), "utf8"));
    } catch {
      return undefined;
    }
  };
  const bundle = read("sections-schedules.json");
  if (bundle !== undefined) {
    if (bundle.format !== FORMAT) throw new Error(`schedules format ${bundle.format}`);
    const failures: string[] = [];
    for (const s of bundle.scenarios) {
      const detail = check(s);
      if (detail === "") continue;
      const fixture = regression(s);
      if (fixture !== null) {
        mkdirSync(join(dir, "regressions"), { recursive: true });
        writeFileSync(
          join(dir, "regressions", `${s.id}.json`),
          `${JSON.stringify(fixture, null, 2)}\n`,
        );
      }
      failures.push(`${s.id}: ${detail}`);
    }
    checks.push({
      id: "schedules.random",
      category: "schedules",
      result: failures.length === 0 ? "PASS" : "FAIL",
      detail:
        failures.length === 0
          ? `${bundle.scenarios.length} schedules converge`
          : failures.join("; "),
    });
  }
  const kept = read("sections-regressions.json");
  if (kept !== undefined) {
    const failures = kept.scenarios.flatMap((s) => {
      const d = check(s);
      return d === "" ? [] : [`${s.id}: ${d}`];
    });
    checks.push({
      id: "schedules.regressions",
      category: "schedules",
      result: failures.length === 0 ? "PASS" : "FAIL",
      detail: failures.join("; "),
    });
  }
  writeFileSync(
    join(dir, "schedules-results-ts.json"),
    `${JSON.stringify({ consumer: "ts", checks }, null, 2)}\n`,
  );
}
