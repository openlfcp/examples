# Headless Todo demo (LFCP-072)

Two people share a Todo list through the OpenLFCP reference server with the
`lfcp-todo` CLI. There is no Obsidian and no mock network. Every change is an
encrypted, signed LFCP Data Unit; sync is a real LFCP WebSocket session; the
invitation is a real one-time claim.

One command runs the whole storyline, prints a readable transcript and checks
the outcome. The same script is a test (`todo-cli/test/demo.test.ts`).

## Prerequisites

Check out the repositories side by side:

```text
openlfcp/
  examples/   (this repository)
  sdk-ts/
  server/
```

You also need:
- Node.js 24 or later and pnpm 10;
- cargo, the Rust toolchain of `server/rust-toolchain.toml`.

## Run it

```sh
(cd ../sdk-ts && pnpm install --frozen-lockfile && pnpm build)
pnpm install --frozen-lockfile
pnpm build
node todo-cli/demo/demo.mjs
```

The first run builds the server, in `$TMPDIR/openlfcp-sdk-ts-server-target`,
shared with the sdk-ts tests; later runs reuse it. The demo then takes about
two seconds.
- Exit status 0: every check passed.
- Exit status 1: a check failed; the transcript says which.
- Exit status 2: cargo or the server checkout is missing.

The demo uses temporary directories only: the server's state and the two CLI
homes, `alice` and `bob`. It removes them at the end and leaves no file in
any repository.

## The storyline

1. Alice creates her identity (a key pair on her machine, not an account),
   creates the list "Groceries", hosts it on the server, adds two items and
   syncs.
2. Alice creates a one-time invitation link. **The link is a bearer
   secret**, so the transcript shows it as
   `lfcp://join/…#secret=[redacted]`.
3. Bob creates his own identity and joins with the link: the claim is
   checked by the server and the list's key is sealed to Bob. Bob sees both
   items. ✓
4. Bob completes an item and syncs; Alice syncs and sees it done. ✓
5. Both work offline. Alice adds an item; Bob adds one and completes
   another. Nothing is sent until they sync again. After syncing, both lists
   are identical and contain both sets of offline edits. ✓
6. The server's files and log contain no item title and no list name: it
   stores only ciphertext and protocol metadata. The invitation secret
   appears nowhere in the transcript. ✓

## A transcript (abridged)

```text
== 1. Alice creates her identity and a shared list, hosted on the server ==
$ lfcp-todo --home alice principal create
  Principal p:385lCbA1V5Q5ewTPfH2UN5UDgwpSpE8vDmIGuo3ahdQ
$ lfcp-todo --home alice resource create Groceries --endpoint ws://127.0.0.1:50439/v1/ws
  Resource 0bCkQtqSy4YpIqF8KhUOR2_UyZDtz1_iA84smncQDj4 "Groceries" (org.openlfcp.shared-objects.v1)
$ lfcp-todo --home alice resource host
  hosted 0bCkQtqSy4YpIqF8KhUOR2_UyZDtz1_iA84smncQDj4 (durability 2)
…
== 2. Alice invites Bob (a one-time link: a secret, shown redacted here) ==
$ lfcp-todo --home alice invite create
  lfcp://join/…#secret=[redacted]
…
== 5. Both work offline (no sync), then come back online ==
…
$ lfcp-todo --home bob task list
  01a10e30-1a96-…  [done]  Buy oat milk  (completed 2026-10-06)
  01a10e30-1aa8-…  [done]  Book the dentist  (completed 2026-10-06)
  01a10e30-1d61-…  [todo]  Water the plants
  01a10e30-1d73-…  [todo]  Pay the rent
  ✓ Alice and Bob have the same list
  ✓ both offline edits arrived on both sides

== 6. What the server stored is opaque ==
  ✓ no item title or list name in any server file or the server log
  ✓ the invitation secret never appears in this transcript

Demo passed.
```

Identifiers, ports and dates differ on every run.

## By hand

The same commands work one at a time: see
[`todo-cli/README.md`](../../todo-cli/README.md), section "With a server".

> MVP reference software. `lfcp-todo` keeps private keys and Resource keys in
> plaintext files under its home directory (0600). Don't use it for data you
> need to protect.
