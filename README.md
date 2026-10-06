# openlfcp/examples

Small, understandable LFCP protocol examples and interoperability
demonstrations, built on the real `openlfcp/sdk-ts` packages.

| Example | What it shows |
| --- | --- |
| [`todo-cli`](todo-cli/README.md) | `lfcp-todo`, a headless Todo client: Shared Objects Tasks as encrypted, signed LFCP Data Units, local persistence, sync and invitations against an LFCP server (LFCP-039) |

Demo: [docs/demos/headless-todo.md](docs/demos/headless-todo.md). One
command runs a two-person storyline against the reference server, prints the
transcript and checks the outcome.

> MVP reference software: not for data you need to protect.

## Scope

The examples run on sdk-ts and sdk-rs at their pinned commits.
They use only the OpenLFCP MVP 0.1 subset of LFCP-WIRE-01 at
`mvp-0.1-baseline.8`.

## Build from a clean checkout

The examples use the sdk-ts packages from a checkout next to this
repository (`../sdk-ts`), which must be built first:

```sh
(cd ../sdk-ts && pnpm install --frozen-lockfile && pnpm build)
pnpm install --frozen-lockfile
pnpm build
pnpm lint
pnpm typecheck
pnpm test
```

Requires Node.js 24 or later and pnpm 10. The live tests also need cargo and
an `openlfcp/server` checkout at `../server`; without them they are skipped.

## License

Apache License 2.0. See [LICENSE](LICENSE).
