# conformance: sdk-ts ⇄ sdk-rs (LFCP-070)

Proves that the TypeScript and Rust SDKs are independent, interoperable
LFCP implementations, in the three modes of LFCP-070 and the shared sections
exchange of MVP 0.2:

- **A. Byte-exact.** Each SDK passes the official LFCP-TEST-VECTORS-01 and
  SHARED-OBJECTS-TEST-VECTORS-01 (and the Automerge corpus and profile
  schema fixtures) at the same `spec.lock` baseline. The run reads sdk-ts's
  machine-readable vector results and runs `cargo test --all-features` in
  sdk-rs.
- **B. Cross-consumption.** Each SDK produces fresh objects with production
  randomness, and the other one decodes, validates, verifies and decrypts
  them. The objects are Principal Descriptors, a Control Chain (Genesis,
  grants, an invitation and its claim, a revocation, a Key Epoch), Data
  Units, Key Packages, a Snapshot and twelve wire messages. The consumer
  must derive the same Control head, owner, abilities, epoch, DEK
  commitments and cutoff; recover each DEK from the Key Packages; recover
  each plaintext; re-encode every message to identical bytes; and verify
  AUTH.
- **C. Negatives and Shared Objects.**
  - Both SDKs must reach the same code on each produced negative:
    tampering, an unauthorized writer, a stale epoch, an unknown epoch, an
    AEAD failure, equivocation, an unauthorized grant, a used-up claim, a
    fork, an unauthorized key distributor or publisher, and a Snapshot
    beyond the cutoff.
  - A Shared Objects history by three writers is replayed through the §11
    actor check and loaded from its Snapshot. It covers a title conflict,
    tags added and removed, an edit under a tombstone, an unknown field
    and an unknown object type. The replay must give the same logical
    state and the same conflict sets, never the same bytes.
  - Profile negatives: a foreign change actor, a bad chunk checksum, a
    change chunk as a Snapshot, and per-field §74.1 diagnostics.

- **D. Shared sections** (LFCP-02-023, LFCP-02-024). The producer writes
  scenarios of SHARED-SECTIONS-TEST-VECTORS-01 with its own authoring API:
  a section tree, concurrent insertion, a placement conflict, a parent
  cycle, a delete against an edit, split and join, Unicode Text, and three
  refusals or isolations (a mutated children list with a change held
  behind it, an actor mismatch, a node ID collision). Each scenario carries
  its framed changes with their signers and the producer's summary after
  admission. The consumer replays them, in order and in reverse with
  duplicates, and must derive the same effective tree, facts, diagnostics,
  collisions, refusals, held changes, retained edits and texts. The bundle
  is `sections.json` (`lfcp-interop-sections/1`); the Rust adapter is
  `sdk-rs/crates/lfcp/examples/interop_sections.rs`; the TypeScript one is
  `src/sections-ts.ts`, on sdk-ts's SectionReplica.
- **Schedules** (LFCP-02-024). The run writes `schedules.json`
  (`lfcp-section-schedules/1`): seeds of a mulberry32 stream, each three
  authors on one section with intents (create, move, delete, restore,
  text, split, join, title) picked from the author's own view, syncs
  between authors and delivery orders. The producer runs each seed with
  its SDK and writes the history and its deliveries (shuffled, with
  duplicates, causal prefixes); the consumer replays every delivery and
  must reach the same tree, facts and refusals as in causal order. Both
  SDKs produce and consume, so all four directions run: the TypeScript side
  is `src/schedules-ts.ts`, the Rust side `interop_sections.rs`. A
  failing delivery is minimized (delta debugging) into a scenario under
  `report/regressions/`; kept ones go to `regressions/sections-regressions.json`
  and are replayed on every run. `--schedules N` sets the seed count
  (default 100); `--schedules-large` runs 1,000 seeds of 48 steps, for CI
  or a spare machine.

The exchange is protocol bytes in files (`bundle.json`, hex), across
processes. The Rust adapter is `sdk-rs/crates/lfcp/examples/interop.rs`;
the TypeScript one is `src/ts-adapter.ts`. Both use only their SDK's public
API, and the keys are synthetic, made for one run. Neither adapter writes
out a DEK: consumers recover DEKs from the Key Packages.

## Run

With `sdk-rs/`, `sdk-ts/` (built) and `spec/` next to `examples/`:

```sh
pnpm build
node conformance/dist/run.js            # report in conformance/report/
node conformance/dist/run.js --strict   # also: the SDKs are the commits in pins.json (CI)
node conformance/dist/run.js --strict --write-matrix ../.github/docs/conformance/compatibility-matrix.md
```

`--write-matrix <path>` also writes the matrix to `<path>`. That is how the
published snapshot in `.github` is made; never edit it by hand.

The run writes:

- `report/report.json`: per check and direction, PASS / FAIL /
  NOT_APPLICABLE;
- `report/COMPATIBILITY.md`: the human-readable matrix.

It exits non-zero on any of:

- a FAIL not listed in `expected-failures.json`, where each listed entry
  names its bug;
- a listed entry that now passes (remove it);
- vector failures;
- differing spec pins, or a stale LFCP-WIRE-01.1 pin;
- a row that is N/A in some direction but has no entry in
  `known-gaps.json`.

`known-gaps.json` explains each N/A row and lists the run's other accepted
coverage gaps. The matrix prints them under "Known gaps".

`pins.json` fixes the SDK commits and spec baseline of a release run.
