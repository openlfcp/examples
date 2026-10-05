#!/usr/bin/env node
// The headless Todo demo (LFCP-072): two people share a list through the
// Rust reference server with lfcp-todo, as a readable transcript that also
// checks its outcome (it doubles as a test: todo-cli/test/demo.test.ts).
//
//   node todo-cli/demo/demo.mjs        (after `pnpm build`; needs cargo and ../server)
//
// Real SDK semantics only: every change is an encrypted, signed LFCP Data
// Unit, sync is a real LFCP WebSocket session, the invitation is a real
// one-time claim. The server is built into the shared cargo target and runs
// on a free port with a temporary state directory; the two CLI homes live in
// a temporary directory too. Everything is removed at the end. The
// invitation link is a bearer secret: the transcript shows it redacted.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startRustServer } from "../../../sdk-ts/conformance/interop/rust-server.mjs";
import { run } from "../dist/commands.js";

const redact = (line) => line.replace(/(lfcp:\/\/join\/)[^\s#]*(#secret=)\S+/g, "$1…$2[redacted]");

/**
 * Runs the demo. `say` receives every transcript line (already redacted).
 * Resolves to { transcript, failures } (failures empty when every check
 * passed), or { skipped } when the server cannot run here.
 */
export async function runDemo({ say = () => undefined } = {}) {
  const transcript = [];
  const failures = [];
  const emit = (line) => {
    const safe = redact(line);
    transcript.push(safe);
    say(safe);
  };
  const check = (ok, what) => {
    emit(ok ? `  ✓ ${what}` : `  ✗ ${what}`);
    if (!ok) failures.push(what);
  };

  const server = await startRustServer();
  if ("skip" in server) return { skipped: server.skip };
  const root = mkdtempSync(join(tmpdir(), "lfcp-todo-demo-"));
  const home = (who) => join(root, who);
  /** One lfcp-todo invocation, shown as the command a user would type. */
  const todo = async (who, ...argv) => {
    emit(
      `$ lfcp-todo --home ${who} ${argv.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`,
    );
    const out = [];
    const code = await run(["--home", home(who), ...argv], {
      out: (l) => out.push(l),
      err: (l) => emit(`  (stderr) ${l}`),
    });
    for (const l of out) emit(`  ${l}`);
    if (code !== 0) throw new Error(`lfcp-todo ${argv.join(" ")} exited ${code}`);
    return out;
  };
  const step = (title) => emit(`\n== ${title} ==`);
  const idOf = (line) => line.replace("added ", "");
  const list = async (who) => (await todo(who, "task", "list")).join("\n");

  try {
    emit(`Reference server at ${server.url} (temporary state directory)`);

    step("1. Alice creates her identity and a shared list, hosted on the server");
    await todo("alice", "principal", "create");
    await todo("alice", "resource", "create", "Groceries", "--endpoint", server.url);
    await todo("alice", "resource", "host");
    const milk = idOf((await todo("alice", "task", "add", "Buy oat milk"))[0]);
    const dentist = idOf((await todo("alice", "task", "add", "Book the dentist"))[0]);
    await todo("alice", "sync");

    step("2. Alice invites Bob (a one-time link: a secret, shown redacted here)");
    const link = (await todo("alice", "invite", "create")).at(-1);

    step("3. Bob creates his own identity and joins with the link");
    await todo("bob", "principal", "create");
    await todo("bob", "invite", "accept", link, "--name", "Shared groceries");
    const bobSees = await list("bob");
    check(
      bobSees.includes("Buy oat milk") && bobSees.includes("Book the dentist"),
      "Bob sees Alice's two items",
    );

    step("4. Bob completes an item; Alice syncs and sees it");
    await todo("bob", "task", "complete", milk.slice(0, 13));
    await todo("bob", "sync");
    await todo("alice", "sync");
    check(
      (await list("alice")).includes(`${milk}  [done]  Buy oat milk`),
      "Alice sees the item done",
    );

    step("5. Both work offline (no sync), then come back online");
    await todo("alice", "task", "add", "Water the plants");
    await todo("bob", "task", "add", "Pay the rent");
    await todo("bob", "task", "complete", dentist.slice(0, 13));
    emit("  (nothing has been sent yet: each change waits in its home's outbound queue)");
    await todo("alice", "sync");
    await todo("bob", "sync");
    await todo("alice", "sync");
    const a = await list("alice");
    const b = await list("bob");
    check(a === b, "Alice and Bob have the same list");
    check(
      ["Water the plants", "Pay the rent", `${dentist}  [done]  Book the dentist`].every((x) =>
        a.includes(x),
      ),
      "both offline edits arrived on both sides",
    );

    step("6. What the server stored is opaque");
    const plaintext = [
      "Buy oat milk",
      "Book the dentist",
      "Water the plants",
      "Pay the rent",
      "Groceries",
    ];
    const leaks = plaintext.filter(
      (t) =>
        server.files().some((f) => Buffer.from(f.bytes).includes(Buffer.from(t))) ||
        server.log().includes(t),
    );
    check(leaks.length === 0, "no item title or list name in any server file or the server log");
    const secret = link.slice(link.indexOf("#secret=") + 8);
    check(
      !transcript.some((l) => l.includes(secret)),
      "the invitation secret never appears in this transcript",
    );
  } finally {
    await server.stop();
    rmSync(root, { recursive: true, force: true });
  }
  emit(failures.length === 0 ? "\nDemo passed." : `\nDemo FAILED: ${failures.join("; ")}`);
  return { transcript, failures };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await runDemo({ say: (l) => console.log(l) });
  if ("skipped" in result) {
    console.error(`Demo skipped: ${result.skipped}`);
    process.exit(2);
  }
  process.exit(result.failures.length === 0 ? 0 : 1);
}
