// LFCP-02-071: shared sections with lfcp-todo against the Rust reference
// server, live, driven only through CLI invocations, as the README shows:
//
// 1. Home A creates a section Resource with nested content (a task with a
//    paragraph and a subtask, and a list item), hosts it and syncs: every
//    batch is accepted.
// 2. A invites; B joins with the one-time link and sees the same tree.
// 3. Partition: both edit offline (Text, a status) and move the same node
//    under different parents. After syncing, both show the same
//    PLACEMENT_CONFLICT with both candidates; A resolves it, both end VALID.
// 4. Legacy coexistence: A also keeps a legacy Task list (Shared Objects) in
//    the same home and server; each Resource takes only its own commands.
// 5. A reference is not a capability: home C, with the section's reference
//    but no invitation, has no access; B, a member, does. The reference
//    carries no secret.
// 6. No section or task text reaches the server's files or log.
//
// Uses the sdk-ts interop harness (shared cargo target); skipped, saying
// why, when cargo or the server checkout is missing.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type RunningRustServer,
  startRustServer,
} from "../../../sdk-ts/conformance/interop/rust-server.mjs";
import { run } from "../src/commands.js";

declare const console: { warn(...a: unknown[]): void };

const TEXT = {
  title: "Launch plan 071",
  task: "Write the API 071",
  notes: "Notes on the API 071",
  subtask: "Review the API 071",
  item: "Book the room 071",
  edited: "Agreed API notes 071",
  legacy: "Legacy task 071",
};

let server: RunningRustServer | undefined;
let skip: string | undefined;
const root = mkdtempSync(join(tmpdir(), "lfcp-todo-sections-"));

beforeAll(async () => {
  const started = await startRustServer();
  if ("skip" in started) skip = started.skip;
  else server = started;
}, 600_000);

afterAll(async () => {
  await server?.stop();
  rmSync(root, { recursive: true, force: true });
});

/** One CLI home; every call is a separate invocation (open, act, close). */
function cli(name: string) {
  const home = join(root, name);
  const lines: { out: string[]; err: string[] } = { out: [], err: [] };
  return {
    home,
    lines,
    async run(...argv: string[]): Promise<string[]> {
      const out: string[] = [];
      const err: string[] = [];
      const code = await run(["--home", home, ...argv], {
        out: (l) => out.push(l),
        err: (l) => err.push(l),
      });
      lines.out.push(...out);
      lines.err.push(...err);
      if (code !== 0)
        throw new Error(`${name}: ${argv.join(" ")} exited ${code}: ${err.join(" / ")}`);
      return out;
    },
  };
}

const idOf = (line: string | undefined) => (line ?? "").split(" ").at(-1) as string;
const text = (lines: string[]) => lines.join("\n");

describe("lfcp-todo shared sections ↔ Rust reference server (live)", () => {
  it("creates nested content, shares it, resolves a partition conflict, and keeps refs apart from access", async (ctx) => {
    if (server === undefined) {
      console.warn(`SKIPPED: lfcp-todo sections live (${skip})`);
      ctx.skip();
      return;
    }
    const url = server.url;
    const a = cli("a");
    const b = cli("b");
    const c = cli("c");
    try {
      // 1. A section with nested content, hosted and synced.
      await a.run("principal", "create");
      await a.run("section", "create", TEXT.title, "--endpoint", url);
      const task = idOf((await a.run("section", "add", "task", TEXT.task))[0]);
      const notes = idOf(
        (await a.run("section", "add", "paragraph", TEXT.notes, "--under", task))[0],
      );
      const subtask = idOf(
        (await a.run("section", "add", "task", TEXT.subtask, "--under", task))[0],
      );
      const item = idOf((await a.run("section", "add", "item", TEXT.item))[0]);
      await a.run("resource", "host");
      const synced = text(await a.run("sync"));
      expect(synced).toContain("section VALID");
      expect(synced).not.toMatch(/batch \S+ (pending|rejected)/);
      expect(synced.match(/batch \S+ accepted/g)).toHaveLength(5);
      const shownA = text(await a.run("section", "show"));
      expect(shownA).toContain(`${TEXT.title}  VALID`);
      expect(shownA).toContain(`  ${task}  [todo] ${TEXT.task}`);
      expect(shownA).toContain(`    ${notes}  ${TEXT.notes}`);
      expect(shownA).toContain(`    ${subtask}  [todo] ${TEXT.subtask}`);
      expect(shownA).toContain(`  ${item}  - ${TEXT.item}`);

      // 2. One invitation; B joins and sees the same tree.
      const link = (await a.run("invite", "create")).at(-1) as string;
      await b.run("principal", "create");
      expect((await b.run("invite", "accept", link))[0]).toMatch(/^joined /);
      expect(text(await b.run("section", "show"))).toBe(shownA);

      // 3. Partition: offline edits, and one node moved under two parents.
      await a.run("section", "edit", notes.slice(0, 13), TEXT.edited);
      await a.run("section", "move", item, "--under", subtask);
      await b.run("section", "status", subtask, "in_progress");
      await b.run("section", "move", item, "--under", task);
      await a.run("sync");
      await b.run("sync");
      await a.run("sync");
      const conflictA = text(await a.run("section", "show"));
      expect(conflictA).toBe(text(await b.run("section", "show")));
      expect(conflictA).toContain("STRUCTURAL_ATTENTION");
      expect(conflictA).toContain(
        `PLACEMENT_CONFLICT ${item}: under ${[subtask, task].sort().join(" | ")}`,
      );
      expect(conflictA).toContain(`${notes}  ${TEXT.edited}`);
      expect(conflictA).toContain(`[in_progress] ${TEXT.subtask}`);

      // A resolves it causally; both end VALID with the item under the task.
      await a.run("section", "resolve", item, "--under", task);
      await a.run("sync");
      expect(text(await b.run("sync"))).toContain("section VALID");
      const resolved = text(await b.run("section", "show"));
      expect(resolved).toBe(text(await a.run("section", "show")));
      expect(resolved).not.toContain("PLACEMENT_CONFLICT");
      expect(resolved).toContain(`    ${item}  - ${TEXT.item}`);

      // 4. A legacy Task list beside the section, in the same home and server.
      const section = (await a.run("resource", "list"))
        .find((l) => l.startsWith("*"))
        ?.split(/\s+/)[1] as string;
      const legacy = (await a.run("resource", "create", "legacy", "--endpoint", url))[0]?.match(
        /^Resource (\S+)/,
      )?.[1] as string;
      await a.run("resource", "host");
      await a.run("task", "add", TEXT.legacy);
      await a.run("sync");
      expect(text(await a.run("task", "list"))).toContain(TEXT.legacy);
      await expect(a.run("section", "show")).rejects.toThrow(/legacy Task list/);
      await a.run("resource", "use", section);
      await expect(a.run("task", "list")).rejects.toThrow(/shared section/);
      expect(text(await a.run("section", "show"))).toBe(resolved);
      expect(text(await a.run("resource", "list"))).toContain(legacy);

      // 5. A reference is an address, not access.
      const ref = (await a.run("section", "ref"))[0] as string;
      expect(ref).toMatch(/^lfcp1:[A-Za-z0-9_-]{43}#section:[0-9a-f-]{36}$/);
      expect(ref).not.toContain(link.slice(link.indexOf("#secret=") + 8));
      await c.run("principal", "create");
      await expect(c.run("section", "lookup", ref)).rejects.toThrow(
        /no access .* a reference is not a capability/,
      );
      expect(text(await b.run("section", "lookup", ref))).toContain("this home is a member");

      // 6. The server holds no section or task text.
      const files = server.files();
      const log = server.log();
      const leaks = Object.values(TEXT).flatMap((t) => [
        ...files
          .filter((f) => Buffer.from(f.bytes).includes(Buffer.from(t)))
          .map((f) => `${t} in server file ${f.path}`),
        ...(log.includes(t) ? [`${t} in the server log`] : []),
      ]);
      expect(leaks).toEqual([]);
    } catch (e) {
      throw new Error(
        `${e instanceof Error ? e.message : String(e)}\n--- server log (tail) ---\n${server.log().slice(-3000)}`,
      );
    }
  }, 240_000);
});
