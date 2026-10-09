// LFCP-02-071 unit tests: the section commands in-process against fresh
// homes, offline, each call a separate invocation (open, act, close), so
// what survives between calls survives a process restart.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { run } from "../src/commands.js";

const root = mkdtempSync(join(tmpdir(), "lfcp-todo-sections-unit-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const ENDPOINT = "ws://127.0.0.1:9/v1/ws";

function cli() {
  const home = join(root, `h${n++}`);
  const call = async (...argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await run(["--home", home, ...argv], {
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    });
    return { code, out, err };
  };
  const ok = async (...argv: string[]) => {
    const r = await call(...argv);
    if (r.code !== 0) throw new Error(`${argv.join(" ")} exited ${r.code}: ${r.err.join(" / ")}`);
    return r.out;
  };
  return { call, ok };
}

const idOf = (lines: string[]) => (lines[0] ?? "").split(" ").at(-1) as string;

describe("lfcp-todo section commands (offline)", () => {
  it("creates a section with nested content and edits it, each batch durable and pending", async () => {
    const c = cli();
    await c.ok("principal", "create");
    const created = await c.ok("section", "create", "Plan", "--endpoint", ENDPOINT);
    expect(created[0]).toMatch(
      /^Resource \S+ \(org\.openlfcp\.shared-sections\.v1\), section [0-9a-f-]{36}$/,
    );
    const task = idOf(await c.ok("section", "add", "task", "Ship"));
    const para = idOf(await c.ok("section", "add", "paragraph", "café 🚀 notes", "--under", task));
    const sub = idOf(await c.ok("section", "add", "task", "Test", "--under", task));
    // Text positions are Unicode scalars: replacing a text with an emoji works.
    await c.ok("section", "edit", para, "new 🚀 notes");
    await c.ok("section", "status", sub.slice(0, 20), "done");
    expect(await c.ok("section", "show")).toEqual([
      "Plan  VALID",
      `  ${task}  [todo] Ship`,
      `    ${para}  new 🚀 notes`,
      `    ${sub}  [done] Test`,
    ]);
    await c.ok("section", "delete", sub);
    expect((await c.ok("section", "show")).join("\n")).not.toContain(sub);
    const batches = await c.ok("section", "batches");
    expect(batches).toHaveLength(7);
    for (const line of batches) expect(line).toMatch(/^cli-\S+ {2}pending {2}1 unit\(s\)$/);
    // The shared title is content; the local label stays generic.
    expect((await c.ok("resource", "list"))[0]).toMatch(/ {2}section$/);
  });

  it("dispatches by the Resource's profile", async () => {
    const c = cli();
    await c.ok("principal", "create");
    await c.ok("resource", "create", "Tasks", "--endpoint", ENDPOINT);
    const onLegacy = await c.call("section", "show");
    expect(onLegacy.code).toBe(1);
    expect(onLegacy.err[0]).toMatch(/legacy Task list: use the task commands/);
    await c.ok("section", "create", "Plan", "--endpoint", ENDPOINT);
    const onSection = await c.call("task", "add", "x");
    expect(onSection.code).toBe(1);
    expect(onSection.err[0]).toMatch(/shared section: use the section commands/);
    const kind = await c.call("section", "add", "heading", "x");
    expect(kind.err[0]).toBe('error: cannot add "heading": task, paragraph or item');
  });

  it("treats a reference as an address: no access without an invitation", async () => {
    const a = cli();
    await a.ok("principal", "create");
    await a.ok("section", "create", "Plan", "--endpoint", ENDPOINT);
    const ref = await a.call("section", "ref");
    expect(ref.out[0]).toMatch(/^lfcp1:[A-Za-z0-9_-]{43}#section:[0-9a-f-]{36}$/);
    expect(ref.err[0]).toMatch(/carries no key and grants nothing/);
    expect((await a.ok("section", "lookup", ref.out[0] as string))[0]).toMatch(
      /this home is a member/,
    );
    const b = cli();
    await b.ok("principal", "create");
    const denied = await b.call("section", "lookup", ref.out[0] as string);
    expect(denied.code).toBe(1);
    expect(denied.err[0]).toMatch(/no access .* a reference is not a capability/);
    const malformed = await b.call("section", "lookup", "lfcp1:abc#task:x");
    expect(malformed.err[0]).toMatch(/not a section reference/);
  });
});
