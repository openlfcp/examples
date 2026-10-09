# lfcp-todo

A headless Todo CLI over the real OpenLFCP SDK (LFCP-039). It shows that
Shared Objects, LFCP security and local persistence work without Obsidian.

> **MVP reference software.** Do not use it for data you need to protect.
> Private keys and Resource keys are stored **in plaintext on disk** (see
> [Storage](#storage)).

It is an application adapter only. Every Task change is a Shared Objects
intent (`task.create`, `task.complete`, `task.set_title`, `task.set_status`),
which becomes one Automerge change, framed (§11), encrypted and signed as an
LFCP Data Unit by `@openlfcp/client`, and committed with its outbound entry.
Networking is the SDK's `SyncClient` over a real LFCP WebSocket session;
invitations are the SDK's `createInvitation` / `acceptInvitation`. There is
no plaintext or mock sync mode.

## Build

The CLI consumes the sdk-ts packages from a checkout next to this
repository (`../sdk-ts`, through `link:` dependencies), so build sdk-ts
first:

```sh
(cd ../sdk-ts && pnpm install --frozen-lockfile && pnpm build)
pnpm install --frozen-lockfile
pnpm build
node todo-cli/dist/main.js --help
```

Requires Node.js 24 or later and pnpm 10.

## Local demo

```sh
alias lfcp-todo="node $PWD/todo-cli/dist/main.js"
lfcp-todo principal create
lfcp-todo resource create "Demo" --endpoint wss://sync.example.test/v1/ws
lfcp-todo task add "Prepare API contract"
lfcp-todo task list
lfcp-todo task complete 01a1          # any unique prefix of the Task id
lfcp-todo resource info
```

Everything above works offline: the Data Units wait in the outbound queue
(`resource info` shows the count) until `sync`.

## With a server

Against the Rust reference server (`openlfcp/server`):

```sh
# home A: create, host, add, sync, invite
lfcp-todo --home ./a principal create
lfcp-todo --home ./a resource create "Demo" --endpoint ws://127.0.0.1:8080/v1/ws
lfcp-todo --home ./a resource host
lfcp-todo --home ./a task add "Prepare API contract"
lfcp-todo --home ./a sync
lfcp-todo --home ./a invite create        # prints the link: a SECRET

# home B: join with the link, then work and sync
lfcp-todo --home ./b principal create
lfcp-todo --home ./b invite accept 'lfcp://join/…#secret=…'
lfcp-todo --home ./b task list
lfcp-todo --home ./b watch                # live changes until Ctrl-C
```

- `sync` connects, catches up (Control, keys, data), sends the queue, waits
  for the ACKs and exits; `watch` stays connected and prints changes.
- When the server refuses the Resource for good, `sync` and `watch` exit 1
  at once with the server, the Resource and the §62 code, for example
  `error: server wss://… does not host Resource <id> (RESOURCE_NOT_HOSTED)`
  (a purged Resource, a restored server, or a Resource never hosted there),
  or `… this Principal may not read it (AUTHORIZATION_FAILED)` after a
  revocation.
- `invite create` grants a fresh Invitation Principal a one-time claim
  (`claim_limit` 1) and seals the current key to it, waits until the server
  has both, and prints the `lfcp://join/…#secret=…` link. **The link is a
  bearer secret**: anyone holding it can join until it is claimed. Share it
  privately; it is printed once and never stored or logged.
- `invite accept` claims the invitation as this home's Principal through
  the Control Coordinator and syncs. A second claim of a used link is refused.
- Concurrent edits converge. A field edited concurrently shows as
  `CONFLICT <field>: "a" | "b"` under its Task in `task list` until a new
  edit resolves it.

## Shared sections

A shared section (SHARED-SECTIONS-PROFILE-01) is an ordered tree of tasks,
paragraphs and list items in its own Resource, with its own key. The
`section` commands use the SDK's section API only: each write is one batch
of section intents committed with `SyncClient.commit`, which returns a
durable receipt; the batch is stored with its Data Units and sent at the
next `sync`. The same home can hold section Resources and legacy Task lists
side by side; which commands apply is decided by the Resource's Genesis
profile (`org.openlfcp.shared-sections.v1` or
`org.openlfcp.shared-objects.v1`), not by a name.

```sh
# home A: a section with nested content, hosted and synced
lfcp-todo --home ./a section create "Launch plan" --endpoint ws://127.0.0.1:8080/v1/ws
lfcp-todo --home ./a section add task "Write the API"            # added task <T>
lfcp-todo --home ./a section add paragraph "Notes" --under <T>
lfcp-todo --home ./a section add task "Review the API" --under <T>
lfcp-todo --home ./a section add item "Book the room"            # added item <I>
lfcp-todo --home ./a resource host
lfcp-todo --home ./a sync
lfcp-todo --home ./a section show
lfcp-todo --home ./a invite create        # the link is a SECRET, as for Task lists

# home B: join, then both work offline and sync
lfcp-todo --home ./b invite accept 'lfcp://join/…#secret=…'
lfcp-todo --home ./a section move <I> --under <R>      # A: under "Review the API"
lfcp-todo --home ./b section move <I> --under <T>      # B: under "Write the API"
lfcp-todo --home ./a sync; lfcp-todo --home ./b sync; lfcp-todo --home ./a sync
lfcp-todo --home ./a section show
lfcp-todo --home ./a section resolve <I> --under <T>
lfcp-todo --home ./a sync; lfcp-todo --home ./b sync
```

What to expect:

- Every write prints `batch cli-…: N unit(s), durable; run sync to send` on
  stderr. `section batches` lists each batch as `pending` until a sync, and
  `sync` ends with `section VALID` (or the classification) and one
  `batch cli-… accepted` line per batch the server has durably accepted.
- `section show` prints the title and classification, then the visible
  tree, indented by depth:

  ```text
  Launch plan  VALID
    <T>  [todo] Write the API
      <P>  Notes
      <R>  [todo] Review the API
    <I>  - Book the room
  ```

- After the two offline moves, both homes show the same tree with
  `STRUCTURAL_ATTENTION` and a line
  `PLACEMENT_CONFLICT <I>: under <R> | <T>`: the node is blocked, with both
  candidate parents, and nothing is duplicated. `section resolve` writes a
  fresh placement that supersedes both; after syncing, both homes are
  `VALID` again. Field conflicts (`CONFLICT <id> title: …`), invalid nodes
  and edits kept under a deleted node are listed the same way: problems
  are shown, never hidden.
- `section edit` replaces a paragraph's or item's Text; positions are
  Unicode scalars, so any text works. `section delete` hides a node and its
  subtree; the history is kept.
- `task …` on a section, or `section …` on a Task list, exits 1 and names
  the right commands.

### A reference is not access

```sh
lfcp-todo --home ./a section ref      # lfcp1:<resource>#section:<id>
lfcp-todo --home ./c section lookup 'lfcp1:…#section:…'
# error: this home has no access to Resource …: a reference is not a capability. …
lfcp-todo --home ./b section lookup 'lfcp1:…#section:…'
# current Resource …: this home is a member; run section show
```

A section reference names the Resource and the section: it carries no key
and grants nothing, so it may be copied into notes. Access comes only from
a capability grant, which the one-time invitation link delivers with the
key. A home that holds only the reference can do nothing with it.

The shared title and content are encrypted Data Units; the local Resource
label of a section is the generic `section`, because labels are local
metadata that the storage keeps in the clear.

## Storage

`--home <dir>`, or `$LFCP_TODO_HOME`, or `~/.openlfcp-cli`:

| Path | Content |
| --- | --- |
| `lfcp.sqlite` | `SqliteLfcpStorage`: Control Chains, encrypted Data Units, Key Packages, the outbound queue, and the Shared Objects checkpoint (the **decrypted** Task state). Mode 0600. |
| `secrets/` | `FileSecretStore`: the Principal's private keys and the Resource keys, one **plaintext** file each (0600, directory 0700). |
| `config.json` | Public settings: the local Principal ID and the current Resource. |

Closing and reopening keeps the Resource, the Tasks, the Principal, the
actor sequence (it never repeats), the Control Head, the queued objects and
the CRDT state. No command prints a private key, a Resource key, an actor
key or an invitation secret; `invite create` prints its link once, on
purpose.

## Tests

```sh
pnpm test
```

`todo-cli/test/cli.test.ts` runs every command against fresh homes.
`todo-cli/test/sections.test.ts` runs the section commands offline.
`todo-cli/test/live.test.ts` drives two CLI homes against the Rust
reference server (built with cargo from `../server`, as the sdk-ts interop
tests do); `todo-cli/test/sections-live.test.ts` does the same with the
section walkthrough above, step by step. Both are skipped, saying why, when
cargo or the checkout is missing. They start the server with the sdk-ts harness
(`../sdk-ts/conformance/interop/rust-server.mjs`), so no server outlives
the test process, even when that process is SIGKILLed.
