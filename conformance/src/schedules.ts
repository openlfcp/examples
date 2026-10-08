// Deterministic concurrency schedules for shared sections (LFCP-02-024).
//
// A seed gives one schedule: three authors (A, B, C) on one section, a
// sequence of steps and the number of delivery orders to replay. A step is
// either an intent of one author or a sync from one author to another; with
// no sync between two authors they are partitioned. An intent names its
// kind and a few numbers; the SDK that runs the schedule picks the nodes
// they denote from the author's current view (node `n % count` in tree
// order) and skips an intent its view refuses, so every written change is a
// valid intent of its author. The same seed always gives the same schedule;
// the histories two SDKs write from it differ, and are never compared byte
// for byte.

export interface Schedule {
  readonly seed: number;
  readonly steps: readonly Step[];
  readonly deliveries: number;
}

export type Step =
  | { readonly actor: Author; readonly op: { readonly kind: Kind; readonly n: readonly number[] } }
  | { readonly sync: { readonly from: Author; readonly to: Author } };

type Author = "A" | "B" | "C";
type Kind = "create" | "move" | "delete" | "restore" | "text" | "split" | "join" | "title";

const AUTHORS: readonly Author[] = ["A", "B", "C"];
// Weighted: creations and Text edits dominate, as in editing.
const KINDS: readonly Kind[] = [
  "create",
  "create",
  "create",
  "text",
  "text",
  "move",
  "move",
  "delete",
  "restore",
  "split",
  "join",
  "title",
];

/** mulberry32: a small deterministic PRNG over 32-bit state. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}

/** The schedule of `seed`: `steps` steps, a sync every few on average. */
export function schedule(seed: number, steps: number, deliveries: number): Schedule {
  const next = mulberry32(seed);
  const below = (n: number) => next() % n;
  const out: Step[] = [];
  for (let i = 0; i < steps; i++) {
    if (below(5) === 0) {
      const from = AUTHORS[below(3)] as Author;
      const others = AUTHORS.filter((a) => a !== from);
      out.push({ sync: { from, to: others[below(2)] as Author } });
    } else {
      out.push({
        actor: AUTHORS[below(3)] as Author,
        op: {
          kind: KINDS[below(KINDS.length)] as Kind,
          n: [next(), next(), next(), next()].map((x) => x % 1000),
        },
      });
    }
  }
  return { seed, steps: out, deliveries };
}

/** The recorded run: `count` seeds from `first`. */
export function schedules(
  count: number,
  options: { readonly first?: number; readonly steps?: number; readonly deliveries?: number } = {},
): { readonly format: string; readonly schedules: readonly Schedule[] } {
  const first = options.first ?? 1;
  return {
    format: "lfcp-section-schedules/1",
    schedules: Array.from({ length: count }, (_, i) =>
      schedule(first + i, options.steps ?? 24, options.deliveries ?? 3),
    ),
  };
}
