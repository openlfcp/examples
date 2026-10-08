// The cross-language conformance run (LFCP-070).
//
//   node dist/run.js [--out <dir>] [--skip-vectors] [--strict] [--write-matrix <path>]
//
// For every producer (Rust, TypeScript) and consumer (Rust, TypeScript),
// the producer writes a bundle of fresh protocol objects to a temporary
// directory and the consumer checks it: the exchange is protocol bytes in
// files, across processes. The run also reads both SDKs' official vector
// results (mode A). It writes report.json (machine-readable) and
// COMPATIBILITY.md (the matrix; --write-matrix also writes it to <path>, the
// published snapshot) and exits non-zero when any check fails
// that is not a tracked expected failure, or when a tracked expected
// failure passes (so it gets removed).
//
// Paths: the sibling checkouts ../../sdk-rs and ../../sdk-ts relative to
// this package, or LFCP_SDK_RS / LFCP_SDK_TS.

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { schedules } from "./schedules.js";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, "..");
const SDK_RS = process.env.LFCP_SDK_RS ?? resolve(pkg, "../../sdk-rs");
const SDK_TS = process.env.LFCP_SDK_TS ?? resolve(pkg, "../../sdk-ts");
const args = process.argv.slice(2);
const OUT = resolve(
  args.includes("--out") ? (args[args.indexOf("--out") + 1] as string) : join(pkg, "report"),
);
const SKIP_VECTORS = args.includes("--skip-vectors");
// --strict (CI): the SDK checkouts must be the commits in pins.json.
const STRICT = args.includes("--strict");
// --write-matrix <path>: also write the matrix there (the published snapshot).
const WRITE_MATRIX = args.includes("--write-matrix")
  ? resolve(args[args.indexOf("--write-matrix") + 1] as string)
  : undefined;
// LFCP-02-024: the recorded schedule seeds. The default run is the 100
// recorded seeds; --schedules-large is the long run for CI or a Linux box.
const LARGE = args.includes("--schedules-large");
const SCHEDULES = args.includes("--schedules")
  ? Number(args[args.indexOf("--schedules") + 1])
  : LARGE
    ? 1000
    : 100;
const SCHEDULE_STEPS = LARGE ? 48 : 24;

type Side = "rust" | "ts";
type Result = "PASS" | "FAIL" | "NOT_APPLICABLE";
interface Check {
  id: string;
  category: string;
  result: "PASS" | "FAIL";
  detail: string;
}
interface Expected {
  id: string;
  producer: Side;
  consumer: Side;
  reason: string;
}

function run(cmd: string, argv: string[], cwd?: string): string {
  const r = spawnSync(cmd, argv, { cwd, encoding: "utf8", maxBuffer: 64 << 20 });
  if (r.status !== 0)
    throw new Error(`${cmd} ${argv.join(" ")} failed (${r.status}):\n${r.stdout}\n${r.stderr}`);
  return r.stdout + r.stderr;
}

type Command =
  | "produce"
  | "consume"
  | "produce-sections"
  | "consume-sections"
  | "produce-schedules"
  | "consume-schedules";
const adapter: Record<Side, (command: Command, dir: string) => void> = {
  // The shared sections exchange (LFCP-02-023) is its own Rust example.
  rust: (command, dir) => {
    const sections = command.endsWith("-sections") || command.endsWith("-schedules");
    void run("cargo", [
      "run",
      "--quiet",
      "--manifest-path",
      join(SDK_RS, "Cargo.toml"),
      "--example",
      sections ? "interop_sections" : "interop",
      "--features",
      sections ? "shared-sections" : "shared-objects",
      "--",
      command.endsWith("-sections") ? command.replace("-sections", "") : command,
      dir,
    ]);
  },
  ts: (command, dir) => void run(process.execPath, [join(here, "ts-adapter.js"), command, dir]),
};

const expected: Expected[] = JSON.parse(
  readFileSync(join(pkg, "expected-failures.json"), "utf8"),
).failures;
const gaps: { rows: Record<string, string>; general: string[] } = JSON.parse(
  readFileSync(join(pkg, "known-gaps.json"), "utf8"),
);
const isExpected = (id: string, producer: Side, consumer: Side) =>
  expected.find((e) => e.id === id && e.producer === producer && e.consumer === consumer);

// Mode B and C: every producer to every consumer.
const sides: Side[] = ["rust", "ts"];
const runs: { producer: Side; consumer: Side; checks: Check[] }[] = [];
const work = mkdtempSync(join(tmpdir(), "lfcp-conformance-"));
for (const producer of sides) {
  const dir = join(work, producer);
  mkdirSync(dir);
  adapter[producer]("produce", dir);
  adapter[producer]("produce-sections", dir);
  writeFileSync(
    join(dir, "schedules.json"),
    JSON.stringify(schedules(SCHEDULES, { steps: SCHEDULE_STEPS })),
  );
  copyFileSync(
    join(pkg, "regressions", "sections-regressions.json"),
    join(dir, "sections-regressions.json"),
  );
  adapter[producer]("produce-schedules", dir);
  for (const consumer of sides) {
    adapter[consumer]("consume", dir);
    adapter[consumer]("consume-sections", dir);
    adapter[consumer]("consume-schedules", dir);
    const read = (name: string) =>
      JSON.parse(readFileSync(join(dir, `${name}-${consumer}.json`), "utf8")).checks;
    runs.push({
      producer,
      consumer,
      checks: [...read("results"), ...read("sections-results"), ...read("schedules-results")],
    });
  }
  // Minimized failures (LFCP-02-024) go to the report, to become fixtures.
  if (existsSync(join(dir, "regressions"))) {
    mkdirSync(join(OUT, "regressions"), { recursive: true });
    for (const f of readdirSync(join(dir, "regressions")))
      copyFileSync(join(dir, "regressions", f), join(OUT, "regressions", `${producer}-${f}`));
  }
}

// Mode A: each SDK against the official vectors.
interface VectorRun {
  sdk: Side;
  suite: string;
  passed: number;
  total: number;
  source: string;
}
const vectors: VectorRun[] = [];
// The baselines sdk-ts's result files were written at (checked below).
const tsResultBaselines: string[] = [];
for (const suite of ["lfcp-test-vectors-01", "shared-objects-test-vectors-01"]) {
  const r = JSON.parse(readFileSync(join(SDK_TS, "conformance/.results", `${suite}.json`), "utf8"));
  tsResultBaselines.push(r.baseline);
  vectors.push({
    sdk: "ts",
    suite: r.suite,
    passed: r.passed,
    total: r.total,
    source: `sdk-ts conformance runner at ${r.baseline} (${r.checks.passed}/${r.checks.total} checks)`,
  });
}
if (!SKIP_VECTORS) {
  const out = run("cargo", [
    "test",
    "--all-features",
    "--manifest-path",
    join(SDK_RS, "Cargo.toml"),
  ]);
  let passed = 0;
  let failed = 0;
  for (const m of out.matchAll(/test result: \w+\. (\d+) passed; (\d+) failed/g)) {
    passed += Number(m[1]);
    failed += Number(m[2]);
  }
  vectors.push({
    sdk: "rust",
    suite: "LFCP-TEST-VECTORS-01, SHARED-OBJECTS-TEST-VECTORS-01, corpus, schema fixtures",
    passed,
    total: passed + failed,
    source: "sdk-rs cargo test --all-features (every test; vectors read at spec.lock)",
  });
}

// The matrix: one row per check, one column per direction.
const ids = [...new Set(runs.flatMap((r) => r.checks.map((c) => c.id)))];
const cell = (producer: Side, consumer: Side, id: string): { result: Result; note: string } => {
  const c = runs
    .find((r) => r.producer === producer && r.consumer === consumer)
    ?.checks.find((x) => x.id === id);
  if (c === undefined) return { result: "NOT_APPLICABLE", note: "the producer has no such case" };
  const known = isExpected(id, producer, consumer);
  return { result: c.result, note: known ? `known: ${known.reason}` : c.detail };
};
const rows = ids.map((id) => {
  const category = runs.flatMap((r) => r.checks).find((c) => c.id === id)?.category ?? "";
  return {
    id,
    category,
    exact_bytes: id.startsWith("message."),
    rust_to_ts: cell("rust", "ts", id),
    ts_to_rust: cell("ts", "rust", id),
    rust_to_rust: cell("rust", "rust", id),
    ts_to_ts: cell("ts", "ts", id),
  };
});

// Failures that block: unexpected FAILs, and expected FAILs that pass.
const problems: string[] = [];
for (const r of runs)
  for (const c of r.checks) {
    const known = isExpected(c.id, r.producer, r.consumer);
    if (c.result === "FAIL" && !known)
      problems.push(`${r.producer}→${r.consumer} ${c.id}: ${c.detail}`);
    if (c.result === "PASS" && known)
      problems.push(
        `${r.producer}→${r.consumer} ${c.id} now passes: remove it from expected-failures.json`,
      );
  }
for (const r of rows)
  if (
    [r.rust_to_ts, r.ts_to_rust, r.rust_to_rust, r.ts_to_ts].some(
      (c) => c.result === "NOT_APPLICABLE",
    ) &&
    gaps.rows[r.id] === undefined
  )
    problems.push(`${r.id} is N/A in some direction: explain it in known-gaps.json`);
for (const v of vectors)
  if (v.passed !== v.total) problems.push(`${v.sdk} vectors: ${v.passed}/${v.total}`);

// Reproducibility: both SDKs pin the same spec baseline, never the stale
// LFCP-WIRE-01.1, and (strict) are the pinned commits.
const specLocks = [SDK_RS, SDK_TS].map((root) => readFileSync(join(root, "spec.lock"), "utf8"));
const specs = specLocks.map((text) => JSON.parse(text));
if (specs[0].commit !== specs[1].commit)
  problems.push(`spec pins differ: sdk-rs ${specs[0].tag}, sdk-ts ${specs[1].tag}`);
for (const text of specLocks)
  if (/01\.1/.test(text)) problems.push(`a spec.lock names LFCP-WIRE-01.1: ${text}`);
// sdk-ts's vector results are files its last conformance run left behind:
// results from another baseline would put stale numbers in the matrix.
for (const baseline of tsResultBaselines)
  if (baseline !== specs[1].tag)
    problems.push(
      `sdk-ts vector results are from ${baseline}, not ${specs[1].tag}: run pnpm test:conformance in sdk-ts`,
    );
const pins = JSON.parse(readFileSync(join(pkg, "pins.json"), "utf8"));
for (const [name, root] of [
  ["sdk_rs", SDK_RS],
  ["sdk_ts", SDK_TS],
] as const) {
  const head = run("git", ["-C", root, "rev-parse", "HEAD"]).trim();
  if (head !== pins[name]) {
    const message = `${name} is at ${head.slice(0, 7)}, pins.json has ${String(pins[name]).slice(0, 7)}`;
    if (STRICT) problems.push(message);
    else process.stderr.write(`warning: ${message}\n`);
  }
}
if (pins.spec !== specs[0].commit)
  problems.push(`pins.json spec ${pins.spec} is not the SDKs' ${specs[0].commit}`);

mkdirSync(OUT, { recursive: true });
const report = {
  format: "lfcp-compatibility-report/1",
  generated: new Date().toISOString(),
  pins: {
    sdk_rs: run("git", ["-C", SDK_RS, "rev-parse", "HEAD"]).trim(),
    sdk_ts: run("git", ["-C", SDK_TS, "rev-parse", "HEAD"]).trim(),
    spec: JSON.parse(readFileSync(join(SDK_RS, "spec.lock"), "utf8")),
  },
  vectors,
  rows,
  problems,
};
writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);

const mark = (c: { result: Result; note: string }) =>
  c.result === "PASS"
    ? "PASS"
    : c.result === "NOT_APPLICABLE"
      ? "N/A"
      : `**FAIL**${c.note ? ` (${c.note})` : ""}`;
const lines = [
  "# OpenLFCP compatibility matrix",
  "",
  `Generated ${report.generated} by examples/conformance (LFCP-070).`,
  "",
  `- Spec baseline: ${report.pins.spec.tag} (spec ${report.pins.spec.commit}).`,
  `- sdk-rs: ${report.pins.sdk_rs}.`,
  `- sdk-ts: ${report.pins.sdk_ts}.`,
  `- pins.json: sdk-rs ${pins.sdk_rs.slice(0, 7)}, sdk-ts ${pins.sdk_ts.slice(0, 7)}, spec ${pins.spec.slice(0, 7)}${STRICT ? " (strict run: the SDKs are these commits)" : ""}.`,
  "",
  "## A. Official vectors (byte-exact where the vectors fix every input)",
  "",
  "| SDK | Suites | Result | Source |",
  "| --- | --- | --- | --- |",
  ...vectors.map(
    (v) =>
      `| ${v.sdk} | ${v.suite} | ${v.passed === v.total ? "PASS" : "**FAIL**"} ${v.passed}/${v.total} | ${v.source} |`,
  ),
  "",
  "## B and C. Cross-consumption, negatives and Shared Objects",
  "",
  "Fresh objects with production randomness, exchanged as protocol bytes. Exact bytes are",
  "required only for message re-encoding (deterministic codec); Automerge changes are compared",
  "by logical state and conflict sets, never by bytes.",
  "",
  "| Check | Category | Rust → TS | TS → Rust | Rust → Rust | TS → TS |",
  "| --- | --- | --- | --- | --- | --- |",
  ...rows.map(
    (r) =>
      `| ${r.id} | ${r.category} | ${mark(r.rust_to_ts)} | ${mark(r.ts_to_rust)} | ${mark(r.rust_to_rust)} | ${mark(r.ts_to_ts)} |`,
  ),
  "",
  "## Known gaps",
  "",
  ...Object.entries(gaps.rows).map(([id, why]) => `- \`${id}\` (N/A in some directions): ${why}`),
  ...gaps.general.map((g) => `- ${g}`),
  "",
  problems.length === 0
    ? "No blocking problems."
    : `## Blocking problems\n\n${problems.map((p) => `- ${p}`).join("\n")}`,
  "",
];
writeFileSync(join(OUT, "COMPATIBILITY.md"), lines.join("\n"));
if (WRITE_MATRIX !== undefined) {
  mkdirSync(dirname(WRITE_MATRIX), { recursive: true });
  writeFileSync(WRITE_MATRIX, lines.join("\n"));
}
process.stdout.write(
  `report: ${join(OUT, "report.json")}\n${problems.length} blocking problem(s)\n`,
);
if (problems.length > 0) {
  for (const p of problems) process.stderr.write(`${p}\n`);
  process.exitCode = 1;
}
