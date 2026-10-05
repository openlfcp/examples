// LFCP-039: the CLI against the Rust reference server, live, driven only
// through CLI invocations (the headless counterpart of LFCP-056):
//
// 1. Home A creates a Principal and a Resource, hosts it, adds a Task and
//    syncs; A creates a one-time invitation link.
// 2. Home B creates its own Principal, accepts the link (claim, sync) and
//    lists A's Task.
// 3. Both retitle the Task offline; both sync; they converge, and the
//    concurrent titles show as a CONFLICT in `task list` on both sides.
// 4. B completes the Task; after syncing, A sees it done.
// 5. B watches live while A adds a Task, and prints the change.
//
// Uses the sdk-ts interop harness (shared cargo target); skipped, saying
// why, when cargo or the server checkout is missing.

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type RunningRustServer,
  startRustServer,
} from "../../../sdk-ts/conformance/interop/rust-server.mjs";
import { run } from "../src/commands.js";

let server: RunningRustServer | undefined;
let skip: string | undefined;
const root = mkdtempSync(join(tmpdir(), "lfcp-todo-live-"));

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

describe("lfcp-todo ↔ Rust reference server (live)", () => {
  it("creates, hosts, invites, joins, edits offline, syncs, converges and shows the conflict", async (ctx) => {
    if (server === undefined) {
      console.warn(`SKIPPED: lfcp-todo live (${skip})`);
      ctx.skip();
      return;
    }
    const url = server.url;
    const a = cli("a");
    const b = cli("b");
    try {
      await a.run("principal", "create");
      await a.run("resource", "create", "Demo", "--endpoint", url);
      await a.run("resource", "host");
      const [added] = await a.run("task", "add", "Prepare API contract");
      const id = (added as string).replace("added ", "");
      await a.run("sync");
      expect((await a.run("resource", "info")).join("\n")).toContain("Outbound      0 pending");

      const invite = await a.run("invite", "create");
      const link = invite.at(-1) as string;
      expect(link.startsWith("lfcp://join/")).toBe(true);
      expect(a.lines.err.some((l) => l.includes("SECRET"))).toBe(true);

      await b.run("principal", "create");
      const joined = await b.run("invite", "accept", link, "--name", "Demo (B)");
      expect(joined[0]).toMatch(/^joined /);
      expect((await b.run("task", "list")).join("\n")).toContain(
        `${id}  [todo]  Prepare API contract`,
      );

      // A second home cannot reuse the one-time link.
      const c = cli("c");
      await c.run("principal", "create");
      await expect(c.run("invite", "accept", link)).rejects.toThrow(/AUTHORIZATION_FAILED/);

      // Offline: both retitle the same Task.
      await a.run("task", "title", id.slice(0, 13), "API contract v2 (A)");
      await b.run("task", "title", id.slice(0, 13), "API contract v2 (B)");
      await a.run("sync");
      await b.run("sync");
      await a.run("sync");
      const listA = (await a.run("task", "list")).join("\n");
      const listB = (await b.run("task", "list")).join("\n");
      expect(listA).toBe(listB);
      expect(listA).toContain('CONFLICT title: "API contract v2 (A)" | "API contract v2 (B)"');

      // B resolves by completing and retitling; A sees it.
      await b.run("task", "title", id.slice(0, 13), "API contract v2");
      await b.run("task", "complete", id.slice(0, 13));
      await b.run("sync");
      await a.run("sync");
      const after = (await a.run("task", "list")).join("\n");
      expect(after).toContain(`${id}  [done]  API contract v2`);
      expect(after).not.toContain("CONFLICT");

      // B watches live while A adds a Task.
      const watching = b.run("watch", "--for", "6000");
      await new Promise((r) => setTimeout(r, 1500));
      const [live] = await a.run("task", "add", "Live push");
      await a.run("sync");
      await watching;
      expect(
        b.lines.out.some((l) =>
          l.startsWith(`changed ${(live as string).replace("added ", "")}: Live push`),
        ),
      ).toBe(true);

      // Secrets never reach the server log or any CLI output except the one link line.
      const log = server.log();
      const secret = link.slice(link.indexOf("#secret=") + 8);
      expect(log).not.toContain(secret);
      const printed = [...a.lines.out, ...a.lines.err, ...b.lines.out, ...b.lines.err];
      expect(printed.filter((l) => l.includes(secret))).toEqual([link]);
      for (const home of [a.home, b.home])
        for (const f of readdirSync(join(home, "secrets"))) {
          const hex = readFileSync(join(home, "secrets", f)).toString("hex");
          expect(printed.join("\n")).not.toContain(hex);
        }
    } catch (e) {
      throw new Error(
        `${e instanceof Error ? e.message : String(e)}\n--- server log (tail) ---\n${server.log().slice(-3000)}`,
      );
    }
  }, 180_000);
});
