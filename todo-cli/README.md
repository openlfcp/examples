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
`todo-cli/test/live.test.ts` drives two CLI homes against the Rust
reference server (built with cargo from `../server`, as the sdk-ts interop
tests do); it is skipped, saying why, when cargo or the checkout is missing.
