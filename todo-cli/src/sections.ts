import { batchStatuses, type StatusSnapshot } from "@openlfcp/client";
import {
  generateObjectId,
  type ObjectId,
  type ResourceId,
  toBase64url,
  toHex,
} from "@openlfcp/core";
import { createTask, setStatus, type TaskStatus } from "@openlfcp/shared-objects";
import {
  SECTIONS_PROFILE_ID,
  type SectionIntent,
  SharedSectionsDataProfile,
} from "@openlfcp/shared-objects/sections";
import { CliError, type Home, parseResourceId, showResource } from "./home.js";
import { createResource, openProfile, type Profile, Session, urlOf, type Who } from "./lfcp.js";

/**
 * Shared sections (SHARED-SECTIONS-PROFILE-01) through the SDK's section
 * API only: every write is one batch of section intents committed with
 * SyncClient.commit, which returns a durable receipt; the batch's Data
 * Units, outbound entries, checkpoint and receipt are stored together and
 * sent at the next `sync` (SDK-SECTIONS-INTEGRATION-01 §3).
 */

export const SECTION_USAGE = `  section create <title> --endpoint <url> [--coordinator <url>]
                                   a new shared section Resource (its own Resource and key)
  section show                     the section tree, its classification and every problem
  section add task <title> [--under <node>] [--after <node>]
  section add paragraph|item <text> [--under <node>] [--after <node>]
                                   a node under the section or a task/item (default: last)
  section edit <node> <text>       replace a paragraph's or item's Text (text.edit)
  section status <node> <status>   a task node's status (todo, in_progress, done, cancelled)
  section move <node> --under <node> [--after <node>]
  section resolve <node> --under <node> [--after <node>]
                                   resolve a placement conflict causally
  section delete <node>            delete a node (hidden with its subtree, history kept)
  section batches                  each committed batch and its status
  section ref                      the section's reference: an address, never access
  section lookup <ref>             what this home can do with a reference`;

/** The options the section commands read. */
export interface SectionOptions {
  readonly endpoint?: string[] | undefined;
  readonly coordinator?: string | undefined;
  readonly under?: string | undefined;
  readonly after?: string | undefined;
  readonly url?: string | undefined;
}

interface Io {
  out(line: string): void;
  err(line: string): void;
}

type Local = (home: Home, v: never) => Promise<{ R: ResourceId; who: Who; profile: Profile }>;

function need(p: readonly string[], index: number, what: string): string {
  const v = p[index];
  if (v === undefined || v === "") throw new CliError(`missing ${what}`);
  return v;
}

export async function section(
  home: Home,
  p: readonly string[],
  v: SectionOptions,
  io: Io,
  local: Local,
): Promise<void> {
  const command = p[1] ?? "";
  if (command === "create") return create(home, need(p, 2, "the section title"), v, io);
  if (command === "lookup") return lookup(home, need(p, 2, "the reference"), io);
  const { R, who, profile } = await local(home, v as never);
  if (!(profile instanceof SharedSectionsDataProfile))
    throw new CliError("the current Resource is a legacy Task list: use the task commands");
  const replica = profile.replica;
  const me = who.signer.descriptor.principalId;
  switch (command) {
    case "show":
      return show(profile, io);
    case "add": {
      const kind = need(p, 2, "what to add (task, paragraph or item)");
      const text = need(p, 3, kind === "task" ? "the Task title" : "the text");
      const parent = v.under === undefined ? sectionId(profile) : node(profile, v.under);
      const after = v.after === undefined ? lastChild(profile, parent) : node(profile, v.after);
      const id = generateObjectId();
      let intent: SectionIntent;
      if (kind === "task")
        intent = {
          intent: "task.create_in_section",
          task: createTask({ id: id as ObjectId, title: text, createdBy: me }).task,
          parent,
          after,
        };
      else if (kind === "paragraph" || kind === "item")
        intent = { intent: `${kind}.create`, id, text, createdBy: me, parent, after };
      else throw new CliError(`cannot add "${kind}": task, paragraph or item`);
      await commit(home, R, who, profile, [intent], io);
      io.out(`added ${kind} ${id}`);
      return;
    }
    case "edit": {
      const id = node(profile, need(p, 2, "the node"));
      const text = need(p, 3, "the new text");
      const current = replica.snapshot().nodes[id]?.text;
      if (current === undefined) throw new CliError(`${id} has no Text (a task: use status)`);
      await commit(
        home,
        R,
        who,
        profile,
        [
          {
            intent: "text.edit",
            id,
            base: replica.revision(),
            // Positions are Unicode scalars (§10), not UTF-16 code units.
            edits: [{ index: 0, deleteCount: [...current].length, insert: text }],
          },
        ],
        io,
      );
      io.out(`edited ${id}`);
      return;
    }
    case "status": {
      const id = node(profile, need(p, 2, "the task node"));
      const task = replica.task(id)?.task;
      if (task === undefined) throw new CliError(`${id} is not a usable Task`);
      const status = need(p, 3, "the status") as TaskStatus;
      await commit(home, R, who, profile, [setStatus(task, status).intent as SectionIntent], io);
      io.out(`status of ${id} is ${status}`);
      return;
    }
    case "move":
    case "resolve": {
      const id = node(profile, need(p, 2, "the node"));
      if (v.under === undefined) throw new CliError("missing --under <node or section>");
      const parent = v.under === "section" ? sectionId(profile) : node(profile, v.under);
      const after = v.after === undefined ? null : node(profile, v.after);
      const intent = command === "move" ? "node.move" : "node.resolve_placement";
      await commit(home, R, who, profile, [{ intent, id, parent, after }], io);
      io.out(`${command === "move" ? "moved" : "resolved"} ${id} under ${parent}`);
      return;
    }
    case "delete": {
      const id = node(profile, need(p, 2, "the node"));
      await commit(home, R, who, profile, [{ intent: "node.delete", id }], io);
      io.out(`deleted ${id}`);
      return;
    }
    case "batches": {
      const batches = await batchStatuses(home.storage, R, null);
      if (batches.length === 0) io.out("no batches");
      for (const b of batches)
        io.out(
          `${b.operationId}  ${b.status}  ${b.unitIds.length} unit(s)` +
            (b.rejection === undefined ? "" : `  rejected ${b.rejection.code}`),
        );
      return;
    }
    case "ref": {
      io.out(sectionRef(R, sectionId(profile)));
      io.err(
        "This reference names the section; it carries no key and grants nothing. " +
          "To give someone access, use `invite create`.",
      );
      return;
    }
    default:
      throw new CliError(`unknown command "${p.join(" ")}" (see --help)`);
  }
}

/** MARKDOWN-SECTIONS-01 §2: `lfcp1:<resource>#section:<section-id>`. */
export const sectionRef = (R: ResourceId, id: string): string =>
  `lfcp1:${toBase64url(R)}#section:${id}`;

const REF = /^lfcp1:([A-Za-z0-9_-]{43})#section:([0-9a-f-]{36})$/;

/**
 * A reference is an address, not a capability (MARKDOWN-SECTIONS-01 §1,
 * §4.1): it opens nothing by itself. This home can read the section only if
 * it already holds the Resource, joined through an invitation; then the
 * Resource's Genesis, not the reference, says what it is.
 */
async function lookup(home: Home, ref: string, io: Io): Promise<void> {
  const m = REF.exec(ref);
  if (m === null) throw new CliError("not a section reference (lfcp1:<resource>#section:<id>)");
  const R = parseResourceId(m[1] as string);
  const records = await home.storage.control.records(R);
  if (records.length === 0)
    throw new CliError(
      `this home has no access to Resource ${showResource(R)}: a reference is not a ` +
        "capability. Ask a member for an invitation (invite accept <link>).",
    );
  const row = await home.storage.resources.get(R);
  if (row?.dataProfile !== SECTIONS_PROFILE_ID)
    throw new CliError(
      `Resource ${showResource(R)} is not a shared section (${row?.dataProfile ?? "unknown profile"})`,
    );
  home.update({ current: toHex(R) });
  io.out(`current Resource ${showResource(R)}: this home is a member; run section show`);
}

async function create(home: Home, title: string, v: SectionOptions, io: Io): Promise<void> {
  const endpoints = v.endpoint ?? [];
  if (endpoints.length === 0)
    throw new CliError("a Resource needs at least one --endpoint (wss://, or ws:// on loopback)");
  const who = await home.principal();
  // The title is shared, encrypted content; the local label stays generic.
  const R = await createResource(
    home,
    who,
    "section",
    endpoints,
    v.coordinator ?? (endpoints[0] as string),
    SECTIONS_PROFILE_ID,
  );
  home.update({ current: toHex(R) });
  const { profile } = await openSection(home, R, who);
  const id = generateObjectId();
  await commit(
    home,
    R,
    who,
    profile,
    [
      {
        intent: "section.create",
        sectionId: id,
        title,
        createdBy: who.signer.descriptor.principalId,
      },
    ],
    io,
  );
  io.out(`Resource ${showResource(R)} (${SECTIONS_PROFILE_ID}), section ${id}`);
}

async function openSection(home: Home, R: ResourceId, who: Who) {
  const profile = await openProfile(home, R, who);
  if (!(profile instanceof SharedSectionsDataProfile)) throw new CliError("not a section");
  return { profile };
}

/**
 * One batch, committed offline: the receipt says it is durable here; the
 * next `sync` sends it, and `section batches` shows what became of it.
 */
async function commit(
  home: Home,
  R: ResourceId,
  who: Who,
  profile: SharedSectionsDataProfile,
  intents: readonly SectionIntent[],
  io: Io,
): Promise<void> {
  const session = new Session(home, R, who, profile, await urlOf(home, R, undefined), {
    reconnect: false,
  });
  session.open();
  try {
    // Time first, so `section batches` lists batches in the order they were made.
    const operationId = `cli-${Date.now().toString(36)}-${toHex(crypto.getRandomValues(new Uint8Array(4)))}`;
    const receipt = await session.client.commit(R, intents, { operationId });
    io.err(
      `batch ${receipt.operationId}: ${receipt.unitIds.length} unit(s), durable; run sync to send`,
    );
  } finally {
    await session.stop();
  }
}

function sectionId(profile: SharedSectionsDataProfile): string {
  const id = profile.replica.validate().sectionId;
  if (id === undefined) throw new CliError("the section is not created yet: run sync");
  return id;
}

/** The last visible child of `parent`: new nodes go at the end by default. */
function lastChild(profile: SharedSectionsDataProfile, parent: string): string | null {
  return (
    profile.replica
      .snapshot()
      .order.filter((e) => e.parent === parent)
      .at(-1)?.id ?? null
  );
}

/** A node by its ID or a unique prefix of it. */
function node(profile: SharedSectionsDataProfile, prefix: string): string {
  const ids = Object.keys(profile.replica.snapshot().nodes).filter((id) =>
    id.startsWith(prefix.toLowerCase()),
  );
  if (ids.length === 0) throw new CliError(`no node ${prefix}`);
  if (ids.length > 1)
    throw new CliError(`${prefix} matches ${ids.length} nodes; give more of the id`);
  return ids[0] as string;
}

/** One node as a line: a task with its status, or its text. */
export function nodeLine(profile: SharedSectionsDataProfile, id: string): string {
  const n = profile.replica.snapshot().nodes[id];
  if (n === undefined) return "?";
  if (n.kind === "task") {
    const t = profile.replica.task(id)?.task;
    return `[${t?.status ?? "?"}] ${t?.title ?? "?"}`;
  }
  return `${n.kind === "item" ? "- " : ""}${n.text ?? ""}`;
}

/**
 * The section as the SDK derives it: the visible tree in projection order,
 * then every problem a user must see (SHARED-SECTIONS-PROFILE-01 §7–§9,
 * §14): placement conflicts with their candidates, invalid nodes, scalar
 * conflicts and edits retained under a deletion. Nothing is hidden.
 */
function show(profile: SharedSectionsDataProfile, io: Io): void {
  const view = profile.replica.snapshot();
  const tree = profile.replica.tree();
  io.out(`${view.title.value ?? "(untitled)"}  ${view.classification}`);
  for (const t of view.title.conflicts) io.out(`    CONFLICT title: ${JSON.stringify(t)}`);
  for (const e of view.order)
    io.out(`${"  ".repeat(e.depth + 1)}${e.id}  ${nodeLine(profile, e.id)}`);
  for (const r of view.problems.recovery) {
    const parents = (tree.candidates.get(r.id) ?? []).map((c) => c.parent).sort();
    io.out(`  ${r.code} ${r.id}${parents.length > 0 ? `: under ${parents.join(" | ")}` : ""}`);
  }
  for (const i of view.problems.invalid) io.out(`  INVALID ${i.id}: ${i.diagnostic}`);
  for (const c of view.problems.collisions) io.out(`  COLLISION ${c}`);
  for (const c of view.problems.scalarConflicts)
    io.out(`  CONFLICT ${c.id} ${c.field}: ${c.values.map((x) => JSON.stringify(x)).join(" | ")}`);
  for (const id of view.problems.retainedConcurrentEdits)
    io.out(`  EDIT_UNDER_DELETED_ANCESTOR ${id}`);
}

/** After a sync: the section's classification and each batch's status. */
export function sectionStatus(
  profile: SharedSectionsDataProfile,
  status: StatusSnapshot | undefined,
  io: Io,
): void {
  io.out(`section ${profile.replica.snapshot().classification}`);
  for (const b of status?.batches ?? [])
    io.out(
      `batch ${b.operationId} ${b.status}` +
        (b.rejection === undefined ? "" : ` (${b.rejection.code})`),
    );
}
