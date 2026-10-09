import { parseArgs } from "node:util";
import {
  acceptInvitation,
  createInvitation,
  dekResolver,
  resourceSyncState,
  type StatusSnapshot,
} from "@openlfcp/client";
import { LfcpError, type ObjectId, type ResourceId, toBase64url, toHex } from "@openlfcp/core";
import {
  complete,
  createTask,
  principalRef,
  SharedObjectsDataProfile,
  setStatus,
  setTitle,
  type Task,
  type TaskStatus,
  type TaskView,
} from "@openlfcp/shared-objects";
import { SharedSectionsDataProfile } from "@openlfcp/shared-objects/sections";
import { CliError, defaultHome, Home, SECRETS_CAVEAT, showResource } from "./home.js";
import {
  chainOf,
  createResource,
  openProfile,
  PROFILES,
  type Profile,
  refusalMessage,
  registerResource,
  Session,
  urlOf,
  type Who,
  writeIntent,
} from "./lfcp.js";
import { nodeLine, SECTION_USAGE, section, sectionStatus } from "./sections.js";

/** Where the CLI writes: stdout and stderr lines (injectable for tests). */
export interface Io {
  out(line: string): void;
  err(line: string): void;
}

export const USAGE = `lfcp-todo: a headless Todo client over OpenLFCP (MVP reference software)

Usage: lfcp-todo [--home <dir>] [--resource <id>] <command> ...

  principal create                 create this home's Principal (keys stay local)
  principal show                   show the Principal ID and public keys

  resource create <name> --endpoint <url> [--endpoint <url>...] [--coordinator <url>]
                                   a new Resource with the Shared Objects profile
  resource list                    Resources in this home (* = current)
  resource use <id>                make a Resource current
  resource info                    non-secret diagnostics of the current Resource
  resource host [--url <url>]      ask the coordinator to host it (RESOURCE_HOST), then sync

  task add <title>                 task.create
  task list                        Tasks, with every unresolved conflict
  task complete <id>               task.complete
  task title <id> <title>          task.set_title
  task status <id> <status>        task.set_status (todo, in_progress, done, cancelled)

  sync [--url <url>] [--timeout <ms>]   connect, catch up, send the queue, exit
  watch [--url <url>] [--for <ms>]      stay connected and print changes (Ctrl-C stops)

  invite create [--endpoint <url>]      a one-time bearer link (a SECRET: share privately)
  invite accept <link> [--name <name>]  claim it as this home's Principal and sync

${SECTION_USAGE}

Options: --home <dir> (default ~/.openlfcp-cli or $LFCP_TODO_HOME), --resource <id>.
Task and node ids may be given as any unique prefix.`;

const OPTIONS = {
  home: { type: "string" },
  resource: { type: "string" },
  url: { type: "string" },
  endpoint: { type: "string", multiple: true },
  coordinator: { type: "string" },
  name: { type: "string" },
  timeout: { type: "string" },
  for: { type: "string" },
  under: { type: "string" },
  after: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

/**
 * A Resource ID is shown as 43 characters of base64url, which start with
 * "-" one time in 64; parseArgs would read such an argument as an option.
 * An argument of exactly that shape is protected through parsing (no
 * option of this CLI has it) and restored afterwards.
 */
const DASHED_ID = /^-[A-Za-z0-9_-]{42}$/;
const PROTECT = "\u0000";
const unprotect = (text: string): string =>
  text.startsWith(PROTECT) ? text.slice(PROTECT.length) : text;

type Values = ReturnType<
  typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>
>["values"];

/** Runs one CLI invocation; returns the exit code. */
export async function run(
  argv: readonly string[],
  io: Io,
  env: Readonly<Record<string, string | undefined>> = {},
  signal?: { wait: Promise<unknown> },
): Promise<number> {
  let values: Values;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: argv.map((a) => (DASHED_ID.test(a) ? PROTECT + a : a)),
      options: OPTIONS,
      allowPositionals: true,
      strict: true,
    }));
    positionals = positionals.map(unprotect);
    for (const [key, value] of Object.entries(values))
      if (typeof value === "string") (values as Record<string, unknown>)[key] = unprotect(value);
  } catch (e) {
    io.err(`error: ${(e as Error).message}`);
    return 2;
  }
  if (values.help === true || positionals.length === 0) {
    io.out(USAGE);
    return values.help === true ? 0 : 2;
  }
  const home = Home.open(values.home ?? defaultHome(env));
  try {
    await dispatch(home, positionals, values, io, signal);
    return 0;
  } catch (e) {
    // Expected failures are one line. Messages never carry secrets: the SDK's
    // errors name rules and fields, and the CLI prints no key, DEK or link.
    if (e instanceof CliError || e instanceof LfcpError) {
      io.err(`error: ${e.message}`);
      return 1;
    }
    io.err(`error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  } finally {
    home.close();
  }
}

const ms = (text: string | undefined, fallback: number): number => {
  if (text === undefined) return fallback;
  const n = Number(text);
  if (!Number.isInteger(n) || n <= 0) throw new CliError(`not a duration in ms: ${text}`);
  return n;
};

function need(positionals: string[], index: number, what: string): string {
  const v = positionals[index];
  if (v === undefined || v === "") throw new CliError(`missing ${what}`);
  return v;
}

async function dispatch(
  home: Home,
  p: string[],
  v: Values,
  io: Io,
  signal: { wait: Promise<unknown> } | undefined,
): Promise<void> {
  const [group, command] = p;
  switch (`${group} ${command ?? ""}`.trim()) {
    case "principal create": {
      const id = await home.createPrincipal();
      io.out(`Principal ${principalRef(id)}`);
      io.err(SECRETS_CAVEAT);
      return;
    }
    case "principal show": {
      const who = await home.principal();
      const d = who.signer.descriptor;
      io.out(`Principal   ${principalRef(d.principalId)}`);
      io.out(`  ID (hex)  ${toHex(d.principalId)}`);
      io.out(`  Ed25519   ${toHex(d.ed25519PublicKey)}`);
      io.out(`  X25519    ${toHex(d.x25519PublicKey)}`);
      return;
    }
    case "resource create": {
      const name = need(p, 2, "the Resource name");
      const endpoints = v.endpoint ?? [];
      if (endpoints.length === 0)
        throw new CliError(
          "a Resource needs at least one --endpoint (wss://, or ws:// on loopback)",
        );
      const who = await home.principal();
      const R = await createResource(
        home,
        who,
        name,
        endpoints,
        v.coordinator ?? (endpoints[0] as string),
      );
      home.update({ current: toHex(R) });
      io.out(`Resource ${showResource(R)} "${name}" (org.openlfcp.shared-objects.v1)`);
      return;
    }
    case "resource list": {
      for (const row of await home.storage.resources.list())
        io.out(
          `${toHex(row.resourceId) === home.config.current ? "*" : " "} ${showResource(row.resourceId)}  ${row.labels.name ?? ""}`,
        );
      return;
    }
    case "resource use": {
      const R = home.resource(need(p, 2, "the Resource ID"));
      await chainOf(home, R);
      home.update({ current: toHex(R) });
      io.out(`current Resource ${showResource(R)}`);
      return;
    }
    case "resource info":
      return info(home, home.resource(v.resource), io);
    case "resource host": {
      const R = home.resource(v.resource);
      const who = await home.principal();
      const genesis = (await home.storage.control.records(R)).find((r) => r.controlSeq === 0n);
      if (genesis === undefined) throw new CliError("no Genesis stored for this Resource");
      const session = new Session(
        home,
        R,
        who,
        await openProfile(home, R, who),
        await urlOf(home, R, v.url),
        {
          reconnect: false,
        },
      );
      session.start();
      try {
        await session.ready(ms(v.timeout, 15_000));
        const durability = await session.client.host(genesis.bytes);
        io.out(`hosted ${showResource(R)} (durability ${durability})`);
        session.open();
        await session.synced(ms(v.timeout, 15_000));
        io.out("in sync");
      } finally {
        await session.stop();
      }
      return;
    }
    case "task add": {
      const title = need(p, 2, "the Task title");
      const { R, who, profile } = await tasks(home, v);
      const change = createTask({ title, createdBy: who.signer.descriptor.principalId });
      await writeIntent(home, R, who, profile, change.intent);
      io.out(`added ${change.task.id}`);
      return;
    }
    case "task list": {
      const { profile } = await tasks(home, v);
      listTasks(profile, io);
      return;
    }
    case "task complete": {
      const { R, who, profile } = await tasks(home, v);
      const view = pick(profile, need(p, 2, "the Task id"));
      await writeIntent(home, R, who, profile, complete(taskOf(view), today()).intent);
      io.out(`completed ${view.id}`);
      return;
    }
    case "task title": {
      const { R, who, profile } = await tasks(home, v);
      const view = pick(profile, need(p, 2, "the Task id"));
      await writeIntent(
        home,
        R,
        who,
        profile,
        setTitle(taskOf(view), need(p, 3, "the title")).intent,
      );
      io.out(`retitled ${view.id}`);
      return;
    }
    case "task status": {
      const { R, who, profile } = await tasks(home, v);
      const view = pick(profile, need(p, 2, "the Task id"));
      const status = need(p, 3, "the status") as TaskStatus;
      await writeIntent(home, R, who, profile, setStatus(taskOf(view), status).intent);
      io.out(`status of ${view.id} is ${status}`);
      return;
    }
    case "sync": {
      const { R, who, profile } = await local(home, v);
      await syncOnce(home, R, who, profile, v, io);
      return;
    }
    case "watch": {
      const { R, who, profile } = await local(home, v);
      await watch(home, R, who, profile, v, io, signal);
      return;
    }
    case "invite create": {
      const { R, who, profile } = await local(home, v);
      const chain = await chainOf(home, R);
      const dek = await dekResolver(home.storage, home.secrets, R)(chain.state.epoch.epoch);
      if (dek === undefined) throw new CliError("no key for the current Data Epoch");
      const endpoints = v.endpoint ?? chain.state.route.endpoints.map((e) => e.url);
      const created = await createInvitation({
        storage: home.storage,
        resourceId: R,
        inviter: who.signer,
        dek,
        endpoints,
      });
      // The grant and the Key Package must reach the coordinator before the link works.
      await syncOnce(home, R, who, profile, v, { out: () => undefined, err: io.err });
      io.err(
        "WARNING: this link is a SECRET (a bearer key for the Resource). Share it privately, " +
          "once; anyone holding it can join until it is claimed.",
      );
      io.out(created.link.reveal());
      return;
    }
    case "invite accept": {
      const link = need(p, 2, "the invitation link");
      const who = await home.principal();
      const result = await acceptInvitation({
        link,
        claimant: who,
        storage: home.storage,
        secrets: home.secrets,
        now: () => Date.now(),
        timeout: new Promise((r) => setTimeout(r, ms(v.timeout, 30_000)).unref()),
        // Only the profiles this CLI opens: another is refused before the claim, so the link stays usable.
        dataProfiles: [...PROFILES],
        ...(v.url === undefined ? {} : { url: v.url }),
      });
      if (result.kind === "profile-unsupported")
        throw new CliError(
          `the collaboration uses ${result.dataProfile}, which lfcp-todo cannot open; the invitation was not used`,
        );
      if (result.kind === "refused")
        throw new CliError(`the invitation was refused by the coordinator (${result.code})`);
      if (result.kind === "unavailable") throw new CliError(`could not claim: ${result.reason}`);
      const R = result.resourceId;
      const chain = await chainOf(home, R);
      await registerResource(home, R, who, v.name ?? "joined", chain.state.dataProfile);
      home.update({ current: toHex(R) });
      io.out(`joined ${showResource(R)} with grant ${toBase64url(result.grantId)}`);
      await syncOnce(home, R, who, await openProfile(home, R, who), v, io);
      return;
    }
    default:
      if (group === "section") return section(home, p, v, io, local);
      throw new CliError(`unknown command "${p.join(" ")}" (see --help)`);
  }
}

async function local(
  home: Home,
  v: Values,
): Promise<{ R: ResourceId; who: Who; profile: Profile }> {
  const R = home.resource(v.resource);
  await chainOf(home, R);
  const who = await home.principal();
  return { R, who, profile: await openProfile(home, R, who) };
}

/** The current Resource, which must be a legacy Task Resource (Shared Objects). */
async function tasks(
  home: Home,
  v: Values,
): Promise<{ R: ResourceId; who: Who; profile: SharedObjectsDataProfile }> {
  const { R, who, profile } = await local(home, v);
  if (!(profile instanceof SharedObjectsDataProfile))
    throw new CliError("the current Resource is a shared section: use the section commands");
  return { R, who, profile };
}

/** Today's local calendar date, YYYY-MM-DD (a Local Date, §35). */
function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A Task by its Object ID or a unique prefix of it. */
function pick(profile: SharedObjectsDataProfile, prefix: string): TaskView {
  const ids = profile.replica.objectIds().filter((id) => id.startsWith(prefix.toLowerCase()));
  if (ids.length === 0) throw new CliError(`no Task ${prefix}`);
  if (ids.length > 1)
    throw new CliError(`${prefix} matches ${ids.length} Tasks; give more of the id`);
  const view = profile.replica.task(ids[0] as ObjectId);
  if (view === undefined) throw new CliError(`${prefix} is not a Task`);
  return view;
}

function taskOf(view: TaskView): Task {
  if (view.task === undefined)
    throw new CliError(`${view.id} is ${view.status}; it cannot be edited until repaired`);
  return view.task;
}

/** Every Task, and every field with concurrent values: conflicts are shown, never hidden (§45, §99). */
export function listTasks(profile: SharedObjectsDataProfile, io: Io): void {
  const views = profile.replica
    .objectIds()
    .map((id) => profile.replica.task(id as ObjectId))
    .filter((t): t is TaskView => t !== undefined);
  if (views.length === 0) {
    io.out("no Tasks");
    return;
  }
  for (const view of views) {
    const t = view.task;
    const title = t?.title ?? String(view.fields.title.value ?? "");
    const status = t?.status ?? String(view.fields.status.value ?? "?");
    const extra = [
      t !== undefined && t.lifecycle !== "active" ? t.lifecycle : null,
      t?.due ? `due ${t.due}` : null,
      t?.completion_date ? `completed ${t.completion_date}` : null,
      view.status !== "ready" ? view.status.toUpperCase() : null,
    ].filter((x) => x !== null);
    io.out(`${view.id}  [${status}]  ${title}${extra.length > 0 ? `  (${extra.join(", ")})` : ""}`);
    for (const [field, scalar] of Object.entries(view.fields))
      if (scalar.conflicted)
        io.out(`    CONFLICT ${field}: ${scalar.values.map((x) => JSON.stringify(x)).join(" | ")}`);
    for (const problem of view.problems)
      io.out(`    PROFILE_INVALID ${problem.diagnostic} at ${problem.pointer}`);
  }
}

async function syncOnce(
  home: Home,
  R: ResourceId,
  who: Who,
  profile: Profile,
  v: Values,
  io: Io,
): Promise<void> {
  const timeout = ms(v.timeout, 30_000);
  const session = new Session(home, R, who, profile, await urlOf(home, R, v.url), {
    reconnect: false,
  });
  session.start();
  let status: StatusSnapshot | undefined;
  try {
    await session.ready(timeout);
    session.open();
    await session.synced(timeout);
    if (profile instanceof SharedSectionsDataProfile)
      status = await session.client.statusSnapshot(R);
  } finally {
    await session.stop();
  }
  const merged = session.events.filter(
    (e) => e.type === "unit" && e.outcome.kind === "applied",
  ).length;
  if (profile instanceof SharedSectionsDataProfile) {
    io.out(`in sync: ${merged} unit(s) merged, outbound queue empty`);
    sectionStatus(profile, status, io);
  } else {
    const conflicts = profile.replica.conflicts();
    io.out(
      `in sync: ${merged} unit(s) merged, outbound queue empty` +
        (Object.keys(conflicts).length > 0
          ? `; ${Object.keys(conflicts).length} Task(s) with conflicts`
          : ""),
    );
  }
  for (const e of session.events)
    if (e.type === "error" || e.type === "nack" || e.type === "key-blocked")
      io.err(`note: ${describe(e)}`);
}

async function watch(
  home: Home,
  R: ResourceId,
  who: Who,
  profile: Profile,
  v: Values,
  io: Io,
  signal: { wait: Promise<unknown> } | undefined,
): Promise<void> {
  const session = new Session(home, R, who, profile, await urlOf(home, R, v.url), {
    reconnect: true,
  });
  if (profile instanceof SharedSectionsDataProfile)
    profile.onNodesChanged((c) => {
      for (const id of c.nodeIds) io.out(`changed ${id}: ${nodeLine(profile, id)} (${c.origin})`);
    });
  else
    profile.onObjectChanged((c) => {
      const t = profile.replica.task(c.objectId as ObjectId);
      io.out(
        `changed ${c.objectId}: ${t?.task?.title ?? "?"} [${t?.task?.status ?? "?"}] (${c.origin})`,
      );
    });
  // A terminal refusal (POST-017) ends the watch with an error: there is
  // nothing to watch, and the session will not ask again.
  let refused: (error: CliError) => void = () => undefined;
  const refusal = new Promise<never>((_, reject) => {
    refused = reject;
  });
  session.client.on((e) => {
    if (e.type === "connection") io.err(`connection ${e.state}${e.reason ? `: ${e.reason}` : ""}`);
    if (e.type === "resource-state" && e.state === "LIVE") io.err("live");
    if (e.type === "resource-refused")
      refused(new CliError(refusalMessage(e.resourceId, e.refusal)));
  });
  session.start();
  session.open();
  const stop =
    v.for !== undefined
      ? new Promise((r) => setTimeout(r, ms(v.for, 1)))
      : (signal?.wait ?? new Promise((r) => process.once("SIGINT", r)));
  try {
    await Promise.race([stop, refusal]);
  } finally {
    await session.stop();
  }
}

function describe(e: { type: string } & Record<string, unknown>): string {
  if (e.type === "error") return `${e.code}: ${e.message}`;
  if (e.type === "nack") {
    const o = e.outcome as { kind?: unknown; code?: unknown };
    return `NACK ${String(o.kind)}${o.code === undefined ? "" : ` ${String(o.code)}`}`;
  }
  return e.type;
}

async function info(home: Home, R: ResourceId, io: Io): Promise<void> {
  const chain = await chainOf(home, R);
  const row = await home.storage.resources.get(R);
  const route = await home.storage.resources.route(R);
  const queue = await home.storage.outbound.list(R);
  const sync = await resourceSyncState(home.storage, R);
  const dek = await dekResolver(home.storage, home.secrets, R)(chain.state.epoch.epoch);
  io.out(`Resource      ${showResource(R)}  ${row?.labels.name ?? ""}`);
  io.out(`Profile       ${chain.state.dataProfile}`);
  io.out(`Owner         ${principalRef(chain.state.owner.principalId)}`);
  io.out(
    `Principal     ${row?.localPrincipal ? principalRef(row.localPrincipal.principalId) : "(none)"}`,
  );
  io.out(`Control Head  seq ${chain.state.seq}  ${toHex(chain.state.head)}`);
  io.out(
    `Data Epoch    ${chain.state.epoch.epoch}  (key ${dek === undefined ? "missing" : "held"})`,
  );
  io.out(`Coordinator   ${route?.coordinatorUrl ?? chain.state.route.coordinatorUrl}`);
  for (const e of route?.endpoints ?? chain.state.route.endpoints)
    io.out(`Endpoint      ${e.url}  (priority ${e.priority})`);
  if (sync.have.length === 0) io.out("Have          nothing");
  for (const [i, h] of sync.have.entries()) {
    const extras = h.extras.map(([a, b]) => ` +${a}..${b}`).join("");
    io.out(
      `${i === 0 ? "Have" : "    "}          ${principalRef(h.principalId)}  1..${h.contiguous}${extras}`,
    );
  }
  io.out(
    `Outbound      ${queue.length} pending${queue.some((q) => q.blocked !== null) ? ` (${queue.filter((q) => q.blocked !== null).length} blocked)` : ""}`,
  );
}
