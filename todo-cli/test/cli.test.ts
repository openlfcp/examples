// LFCP-039 unit tests: every command in-process against a fresh home, each
// call a separate invocation (open, act, close), so state that survives
// between calls survives a process restart.

import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dataEpoch, principalId, resourceId, toBase64url, toHex } from "@openlfcp/core";
import { decryptDataUnit, deriveActorDataKey, importResourceDEK } from "@openlfcp/crypto";
import {
  createTask,
  type LocalChange,
  PROFILE_ID,
  SharedObjectsDataProfile,
  SharedObjectsReplica,
  setTitle,
  type Task,
  unframeChange,
} from "@openlfcp/shared-objects";
import { dekSecretRef } from "@openlfcp/storage";
import { FileSecretStore, SqliteLfcpStorage } from "@openlfcp/storage-node";
import { dataUnitAad, parseDataUnit } from "@openlfcp/wire";
import { afterAll, describe, expect, it } from "vitest";
import { listTasks, run } from "../src/commands.js";
import { parseResourceId } from "../src/home.js";

const root = mkdtempSync(join(tmpdir(), "lfcp-todo-unit-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;

function cli() {
  const home = join(root, `h${n++}`);
  const printed: string[] = [];
  const call = async (...argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await run(["--home", home, ...argv], {
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    });
    printed.push(...out, ...err);
    return { code, out, err };
  };
  const ok = async (...argv: string[]) => {
    const r = await call(...argv);
    if (r.code !== 0) throw new Error(`${argv.join(" ")} exited ${r.code}: ${r.err.join(" / ")}`);
    return r.out;
  };
  return { home, printed, call, ok };
}

const URL = "ws://127.0.0.1:9/v1/ws";

async function withTask() {
  const c = cli();
  await c.ok("principal", "create");
  await c.ok("resource", "create", "Demo", "--endpoint", URL);
  const [added] = await c.ok("task", "add", "Prepare API contract");
  return { ...c, id: (added as string).replace("added ", "") };
}

/** Opens a home's storage directly (the CLI process is gone). */
function inspect(home: string) {
  const storage = SqliteLfcpStorage.open(join(home, "lfcp.sqlite"));
  const secrets = new FileSecretStore(join(home, "secrets"));
  const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as {
    principal: string;
    current: string;
  };
  return { storage, secrets, config };
}

describe("principal", () => {
  it("creates one Principal per home, shows only public values, and warns once about plaintext keys", async () => {
    const c = cli();
    const created = await c.call("principal", "create");
    expect(created.out[0]).toMatch(/^Principal p:[A-Za-z0-9_-]{43}$/);
    expect(created.err.join(" ")).toContain("PLAINTEXT on disk");
    expect((await c.call("principal", "create")).code).toBe(1);
    const shown = await c.ok("principal", "show");
    expect(shown[0]).toBe(created.out[0]?.replace("Principal ", "Principal   "));
    expect(statSync(join(c.home, "secrets")).mode & 0o777).toBe(0o700);
    for (const f of readdirSync(join(c.home, "secrets"))) {
      expect(statSync(join(c.home, "secrets", f)).mode & 0o777).toBe(0o600);
      expect(c.printed.join("\n")).not.toContain(
        readFileSync(join(c.home, "secrets", f)).toString("hex"),
      );
    }
  });

  it("refuses commands that need a Principal before one exists", async () => {
    const c = cli();
    const r = await c.call("resource", "create", "X", "--endpoint", URL);
    expect([r.code, r.err[0]]).toEqual([
      1,
      "error: no Principal yet: run `principal create` first",
    ]);
  });
});

describe("resource", () => {
  it("creates a Shared Objects Resource with a Genesis, an epoch-0 DEK and the initial document", async () => {
    const c = cli();
    await c.ok("principal", "create");
    const [line] = await c.ok("resource", "create", "Demo", "--endpoint", URL);
    expect(line).toMatch(
      /^Resource [A-Za-z0-9_-]{43} "Demo" \(org\.openlfcp\.shared-objects\.v1\)$/,
    );
    const { storage, secrets, config } = inspect(c.home);
    const R = resourceId(parseResourceId(config.current));
    expect((await storage.resources.get(R))?.dataProfile).toBe(PROFILE_ID);
    expect((await storage.control.head(R))?.controlSeq).toBe(0n);
    expect(await secrets.get(dekSecretRef(R, dataEpoch(0n)))).toHaveLength(32);
    expect(await storage.outbound.list(R)).toHaveLength(1); // the initial document
    storage.close();
  });

  it("requires an endpoint, and one a writer may use (§16)", async () => {
    const c = cli();
    await c.ok("principal", "create");
    expect((await c.call("resource", "create", "X")).code).toBe(1);
    const http = await c.call("resource", "create", "X", "--endpoint", "https://sync.example.test");
    expect(http.code).toBe(1);
    const remoteWs = await c.call(
      "resource",
      "create",
      "X",
      "--endpoint",
      "ws://sync.example.test",
    );
    expect(remoteWs.code).toBe(1);
  });

  it("info shows diagnostics and no secret", async () => {
    const c = await withTask();
    const info = (await c.ok("resource", "info")).join("\n");
    for (const label of [
      "Resource",
      "Profile",
      "Principal",
      "Control Head",
      "Data Epoch",
      "Have",
      "Outbound",
      "Coordinator",
    ])
      expect(info).toContain(label);
    expect(info).toContain("Outbound      2 pending");
    const { secrets, config } = inspect(c.home);
    const dek = await secrets.get(dekSecretRef(parseResourceId(config.current), dataEpoch(0n)));
    for (const form of [toHex(dek as Uint8Array), toBase64url(dek as Uint8Array)])
      expect(c.printed.join("\n")).not.toContain(form);
    for (const f of readdirSync(join(c.home, "secrets")))
      expect(c.printed.join("\n")).not.toContain(
        readFileSync(join(c.home, "secrets", f)).toString("hex"),
      );
  });

  it("lists and switches Resources", async () => {
    const c = cli();
    await c.ok("principal", "create");
    const [first] = await c.ok("resource", "create", "One", "--endpoint", URL);
    await c.ok("resource", "create", "Two", "--endpoint", URL);
    const firstId = (first as string).split(" ")[1] as string;
    expect((await c.ok("resource", "list")).filter((l) => l.startsWith("*"))).toHaveLength(1);
    await c.ok("resource", "use", firstId);
    expect((await c.ok("resource", "list")).find((l) => l.startsWith("*"))).toContain("One");
  });
});

describe("task", () => {
  it("adds, persists across invocations, and completes with task.complete", async () => {
    const c = await withTask();
    expect(await c.ok("task", "list")).toEqual([`${c.id}  [todo]  Prepare API contract`]);
    await c.ok("task", "complete", c.id.slice(0, 13));
    const listed = await c.ok("task", "list");
    expect(listed[0]).toMatch(
      new RegExp(
        `^${c.id}  \\[done\\]  Prepare API contract  \\(completed \\d{4}-\\d{2}-\\d{2}\\)$`,
      ),
    );
    await c.ok("task", "title", c.id.slice(0, 8), "API contract");
    await c.ok("task", "status", c.id.slice(0, 8), "in_progress");
    expect((await c.ok("task", "list"))[0]).toMatch(/\[in_progress\] {2}API contract/);
  });

  it("writes every mutation as a real encrypted, signed Data Unit with a safe actor sequence", async () => {
    const c = await withTask();
    await c.ok("task", "complete", c.id.slice(0, 8));
    await c.ok("task", "title", c.id.slice(0, 8), "Secret title 7f3a");
    const { storage, secrets, config } = inspect(c.home);
    const R = parseResourceId(config.current);
    const me = principalId(Uint8Array.from(Buffer.from(config.principal, "hex")));
    const units = await storage.dataUnits.range(R, me, 1n as never, (2n ** 64n - 1n) as never);
    expect(units.map((u) => u.actorSeq)).toEqual([1n, 2n, 3n, 4n]); // init, add, complete, title
    const queued = await storage.outbound.list(R);
    expect(queued.map((q) => q.kind)).toEqual(["data-unit", "data-unit", "data-unit", "data-unit"]);
    const dek = importResourceDEK(
      (await secrets.get(dekSecretRef(R, dataEpoch(0n)))) as Uint8Array,
    );
    for (const u of units) {
      const parsed = parseDataUnit(u.bytes);
      expect(toHex(parsed.signed.kid)).toBe(config.principal);
      expect(Buffer.from(u.bytes).includes(Buffer.from("Secret title 7f3a"))).toBe(false);
      expect(Buffer.from(u.bytes).includes(Buffer.from("Prepare API contract"))).toBe(false);
      const p = parsed.payload;
      const key = deriveActorDataKey(dek, p.resourceId, p.dataEpoch, p.actor);
      unframeChange(decryptDataUnit(key, p.actorSeq, dataUnitAad(p), p.ciphertext)); // a real §11 change
    }
    storage.close();
    // Later invocations continue the sequence, never reuse it.
    await c.ok("task", "add", "Second");
    const again = inspect(c.home);
    const more = await again.storage.dataUnits.range(R, me, 1n as never, (2n ** 64n - 1n) as never);
    expect(more.map((u) => u.actorSeq)).toEqual([1n, 2n, 3n, 4n, 5n]);
    again.storage.close();
  });

  it("refuses unknown and ambiguous Task ids", async () => {
    const c = await withTask();
    expect((await c.call("task", "complete", "ffff")).err[0]).toBe("error: no Task ffff");
    await c.ok("task", "add", "Second");
    expect((await c.call("task", "complete", "0")).err[0]).toMatch(/matches 2 Tasks/);
  });

  it("never hides a scalar conflict (§45, §99)", () => {
    const R = resourceId(new Uint8Array(32).fill(7));
    const alice = principalId(new Uint8Array(32).fill(1));
    const bob = principalId(new Uint8Array(32).fill(2));
    const { replica: a } = SharedObjectsReplica.create({ resource: R, principal: alice });
    const created = createTask({ title: "Base", createdBy: alice });
    a.apply(created.intent);
    const b = SharedObjectsReplica.fromChanges(a.changes(), {
      resource: R,
      principal: bob,
    }).replica;
    const ta = a.task(created.task.id)?.task as Task;
    const tb = b.task(created.task.id)?.task as Task;
    const fromA = a.apply(setTitle(ta, "From A").intent) as LocalChange;
    const fromB = b.apply(setTitle(tb, "From B").intent) as LocalChange;
    a.receiveChange(fromB.change);
    b.receiveChange(fromA.change);
    const out: string[] = [];
    listTasks(new SharedObjectsDataProfile(a), { out: (l) => out.push(l), err: () => undefined });
    expect(out).toContain('    CONFLICT title: "From A" | "From B"');
  });
});

describe("network and invitations without a server", () => {
  it("sync fails clearly when the server is unreachable and keeps the queue", async () => {
    const c = await withTask();
    const r = await c.call("sync", "--timeout", "3000");
    expect(r.code).toBe(1);
    expect(r.err[0]).toMatch(/^error: (the connection closed|timed out)/);
    expect(await c.ok("resource", "info")).toContain("Outbound      2 pending");
  });

  it("refuses a malformed link without echoing it", async () => {
    const c = cli();
    await c.ok("principal", "create");
    const link = "lfcp://join/abc?grant=x#secret=c2VjcmV0LXZhbHVl";
    const r = await c.call("invite", "accept", link);
    expect(r.code).toBe(1);
    expect(r.err[0]).toMatch(/^error: invalid invitation/);
    expect(c.printed.join("\n")).not.toContain("c2VjcmV0LXZhbHVl");
  });

  it("prints usage and rejects unknown commands", async () => {
    const c = cli();
    expect((await c.call("--help")).code).toBe(0);
    expect((await c.call("frobnicate")).code).toBe(1);
    expect((await c.call("--bogus")).code).toBe(2);
  });
});
