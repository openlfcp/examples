# Shared sections: the two-vault demonstration (LFCP-02-072)

This is a script for a reviewer to follow in real Obsidian. Two vaults stand
for two people. Each vault has its own identity: a key pair kept on the
device, not an account.

Person A shares a section of a note: a heading with 200 Tasks and nested
content under it. Person B joins, inserts the section into a private note of
their own, and both edit it, online and offline. The steps then cover a
conflict, a restart, copying, removing access, and recovery.

The OpenLFCP reference server relays the encrypted, signed changes and can
read none of them.

Each step says what to do and what to see. The checklist at the end is where
the reviewer records the outcome of every check, together with any deviation
and the artifact versions.

> **Status.** This script follows the plugin's `main` branch, where shared
> sections are a development preview (plugin 0.4, unreleased). It needs the
> plugin at `e41625c` or later: from there, "Detach this section" exists and
> the status badge shows problems in a note.
>
> The headless counterpart of this run, on the same SDK and server, is the
> two-vault qualification (`qualification/`, LFCP-02-056). The section
> commands of `lfcp-todo` cover the same ground without Obsidian
> ([`todo-cli/README.md`](../../todo-cli/README.md), "Shared sections").

## 1. Prerequisites

Check out the repositories side by side:

```text
openlfcp/
  examples/   (this repository)
  obsidian/   the plugin, on main
  sdk-ts/     at the commit in obsidian/sdk-ts.lock
  server/     the reference server
```

You also need:

- Obsidian 1.13.4 or later (the plugin's `minAppVersion`);
- Node.js 24 or later and pnpm 10;
- cargo, with the toolchain of `server/rust-toolchain.toml`.

Build the SDK at the plugin's lock, then the plugin:

```sh
git -C ../sdk-ts checkout "$(jq -r .commit ../obsidian/sdk-ts.lock)"
(cd ../sdk-ts && pnpm install --frozen-lockfile && pnpm build)
(cd ../obsidian && pnpm install --frozen-lockfile && pnpm run build)
```

Limits worth knowing:

- A section has no fixed size limit. A large share is sent in several parts:
  each change carries at most 8192 Text operations and 256 nodes, and the
  share preview says how many parts it will use.
- The 0.1 Task commands ("Share selected tasks", "Insert all tasks from
  collaboration") take at most 200 Tasks at a time.
- The plugin's manifest still says 0.3.2 on `main`. The version is set only
  in the release commit, so record the commits instead (step 0).

## 2. Prepare the fixture vaults

```sh
node two-vault/prepare.mjs            # or: --dir <path> --port <n> --obsidian <checkout>
```

This writes to `../openlfcp-sections-demo`, outside every repository. Running
it again refreshes the plugin and its settings, and keeps any existing notes.

| Path | What it holds |
| --- | --- |
| `vault-a/` | The plugin, built and enabled. Its settings: section preview on, the local server as Default server, Ref placement "Child line". The notes `Launch.md` and `Legacy tasks.md`. |
| `vault-b/` | The same plugin and settings, with Ref placement "Inline". The note `Meeting notes.md`. |
| `server/server.toml` | A reference server on `ws://127.0.0.1:8787/v1/ws`, with its state in `server/state`. |
| `versions.txt` | The commits of the obsidian, server, sdk-ts and examples checkouts. |

The section preview (`sectionsPreview: true` in the plugin's `data.json`)
is not in the settings tab: the script sets it. Without it, no section
command exists.

`Launch.md` in Vault A is laid out like this:

```text
# Launch
Private introduction … CANARY-A-BEFORE-0721      ← stays in Vault A

## Launch plan (200 tasks)                       ← the section to share
Phase 1: …                                       (10 phase paragraphs)
- [ ] Task 1: phase 1 step 1                     (160 top-level Tasks)
- [ ] Task 4: phase 1 step 4
  - [ ] Task 5: check phase 1 step 4             (40 nested subtasks)
  - Note on phase 1 step 4                       (40 nested notes)
…
## Private notes
… CANARY-A-AFTER-0722                            ← stays in Vault A
```

The other two notes:

- `Meeting notes.md` in Vault B holds `CANARY-B-0723`, which must never leave
  Vault B.
- `Legacy tasks.md` in Vault A holds two 0.1 Tasks and `CANARY-A-LEGACY-0724`.

`two-vault/test/prepare.test.ts` checks that the plugin's own share preview
reads the section as 200 Tasks, 40 list items and 10 paragraphs, with no
problem and no private text in it.

Start the server and open the vaults as the script prints:

```sh
cargo run --manifest-path ../server/Cargo.toml -- --config ../openlfcp-sections-demo/server/server.toml
```

Open each folder in Obsidian with "Open folder as vault", and turn off
Restricted mode once per vault (Settings → Community plugins).

## 3. The walkthrough

Commands are run from the command palette. The plugin's notices begin with
"Shared Tasks:".

### 0. Record the versions

Copy `versions.txt` into the checklist, along with your Obsidian version and
OS.

### 1. Two identities

In each vault, open Settings → Shared Tasks → "Identity on this device". It
reads "Ready. This vault has its own identity on this device: a key pair,
not an account…". The two vaults share nothing: no key or state is copied
between them.

### 2. A shares the section

1. In Vault A, open `Launch.md` and put the cursor on the line
   `## Launch plan (200 tasks)`.
2. Run **Share section…**. The preview shows:
   - the title `Share section "Launch plan (200 tasks)"`;
   - "Everything inside this section, including future additions, will be
     shared.";
   - the counts: 200 tasks, 10 paragraphs and 40 list items, followed by
     "sent in K parts" when the share is split;
   - the exact content.

   Neither canary is in the content. A selection is ignored: the section
   always runs from the heading to the next heading of the same level.
3. Press **Share**. The notice reads
   `section "Launch plan (200 tasks)" is shared.`

The heading now carries a double tick (✓✓), which turns green once the
section is current.

- In Live Preview, the binding lines are hidden.
- In Source mode, they show:
  - `<!-- lfcp-section: lfcp1:…#section:… -->` after the heading;
  - a node marker before each paragraph, and after each list item;
  - an `lfcp-ref` comment under each Task;
  - `<!-- /lfcp-section: … -->` at the end.

If the server is not running, the notice says instead that the section was
created on this device and the invitation is not ready yet. Start the
server, then use "Resource status" → "Host on the server now".

### 3. A invites B

1. In Vault A, run **Invite collaborator**.
2. Choose the collaboration named after the section, then
   **Read + write**.
3. The dialog `Invitation (Read + write)` says "The server has the
   invitation: the link works now." The link sits in a hidden field.
4. Press **Copy link**, then **Done**.

The link is a one-time bearer secret: hand it over privately, and never
paste it into a note.

Inviting is refused while the section is still being created or is not on
the server yet. The dialog says why.

### 4. B joins and inserts the section into a private note

1. In Vault B, run **Join collaboration** and paste the link.
2. Name the collaboration. Progress runs through "Connecting to the
   collaboration's server…", "Checking the invitation…", "Receiving the
   collaboration's key…", "Claiming access…", "Synchronizing…" and "Loading
   the shared section…".
3. The notice reads `joined the shared section "<name>" (read and write).
   Use "Insert shared section…" to place it in a note.`
4. Open `Meeting notes.md` and put the cursor on the paragraph "Insert the
   shared section below this paragraph."
5. Run **Insert shared section…** and pick the section. The preview,
   `Insert section "Launch plan (200 tasks)"`, says "These lines go into this
   note after the paragraph at the cursor. Nothing is sent."
6. Press **Insert**.

B's note now has the 200 Tasks with their nesting. B's private text and
`## Follow-ups (private)` stay where they were, outside the section.

### 5. Both edit; each sees the other's work

1. In Vault B, add a Task inside the section, under Phase 2:
   `- [ ] Task added by B`.
2. In Vault A, check `Task 1`, and edit the paragraph "Phase 3: …".
3. Within seconds, each vault shows the other's changes.

While changes are being sent, a sync icon shows next to the double tick.
Hover it for its meaning (see "What the marks mean" below). When all is
sent and accepted, the icon disappears and the double tick is green.

### 6. Offline, a conflict, and a restart with pending work

1. Stop the server (Ctrl-C). Both badges show the offline icon, "Offline;
   local updates will wait".
2. Switch both vaults to Source mode, so the hidden binding lines are
   visible. A Task is moved together with its `lfcp-ref` line and its
   nested lines: cut them all, then paste them indented as a child.
   - In Vault A, move `Task 9` under `Task 4`.
   - In Vault B, move the same Task under `Task 8`.
3. Both also edit text: A edits "Phase 5: …", and B edits "Phase 6: …".
4. Quit Obsidian for Vault B, and reopen it. B's edits are still there; the
   badge shows "Saved locally; waiting to sync".
5. Start the server again. Both vaults sync. The text edits merge on both
   sides.
6. The moved Task needs a choice on both sides: the badge shows "Needs your
   attention", and the row carries the "Needs attention" cue.
7. Run **Go to next shared section problem**. It moves the cursor to a
   problem and says once: `Problem N of M, in shared section Launch plan
   (200 tasks), line L. Open its details to resolve it.` Record in the
   checklist whether it finds the moved Task.

### 7. Resolve the conflict

1. In Vault A, run **Open shared section details** (or click the badge).
2. Press **Review conflicts…**. The dialog `Conflicts in "Launch plan (200
   tasks)"` asks: "This item's location needs a choice: Task 9 … was moved
   to two places."
3. Pick one place and press **Apply**.

Both vaults end with the Task in the chosen place, once only, and the
attention clears. Nothing was lost: B's text edit and A's text edit are both
present.

### 8. Copying

1. Put the cursor in the section and run **Copy readable text (without
   sharing metadata)**. The notice reads "copied without sharing metadata."
   Pasted into a new note, the text has no `<!-- lfcp-` line.
2. Run **Copy shared section**. The notice reads "shared section copied.
   Pasted into another note, it is another copy of the same section; it
   gives nobody access."
3. In Vault A, paste it into a new note, `Second copy.md`. It shows the same
   section with its badge, and edits in either copy reach the other. Step 11
   detaches this copy.

A copied section, or its `lfcp1:…#section:…` reference, is an address. Only
an invitation gives access.

### 9. The legacy Task list beside the section

1. In Vault A, open `Legacy tasks.md`.
2. Put the cursor on `Renew the domain` and run **Share task under cursor**.
   Choose "Create a new collaboration…" and name it.

The Task is shared the 0.1 way, with its own Resource and its own ref.

Inside the section, **Share task under cursor** refuses: "this task is in a
shared section: everything inside it is shared, including new tasks."

### 10. Remove B's access

1. In Vault A, open the section details. Under "Identities with access", run
   **Remove access…** on B's row.
2. Confirm: "Remove future access to this shared section? Copies already
   received cannot be erased." The card then reads "Removing access:
   waiting for the server. It is not done yet."
3. In Vault B, edit the section.

Vault B shows "Needs your attention", and its card reads "Your access to
this section was removed. Your local copy stays; new edits are kept on this
device only." Vault A never receives B's new edit.

### 11. Recovery

- Run **Repair shared sections in this note**. In a healthy note, it reads
  "Nothing in this note needs repair."
- To see a repair, in Source mode delete the `<!-- /lfcp-section: … -->`
  line in Vault A.
  - The badge turns to "Needs your attention". The details card names the
    damaged copy, for example "One copy of this section has a damaged
    boundary or binding line."
  - Run the repair command again. It offers candidate lines for the
    boundary: pick one and press **Apply**. The attention clears.
- **Restore note before section import** applies only to a section made by
  importing 0.1 Tasks. Here it reads "no section import to restore in this
  note."
- To stop sharing the section in one note, use the second copy from step 8.
  In Vault A, open `Second copy.md`, put the
  cursor in it, and run **Detach this section**.
  - The confirmation, `Detach "Launch plan (200 tasks)" in this note`,
    says: "Its text stays in this note as your own and no longer updates.
    The shared section, your other notes and your collaborators are not
    changed."
  - Press **Detach**. The notice reads `"Launch plan (200 tasks)" is no
    longer shared in this note. The shared section itself is unchanged.`
  - The markers are gone from that note, and the text stays. The section in
    `Launch.md` and its badge are unchanged. A later edit in `Launch.md` no
    longer reaches the detached note.

### 12. Opacity

With the server stopped, search its state and the other vault:

```sh
D=../openlfcp-sections-demo
grep -rlE "CANARY|Task 17: phase|Phase 3:|Task added by B" "$D/server/state"   # prints nothing
grep -rl "CANARY-A" "$D/vault-b"                                                # prints nothing
grep -rl "CANARY-B" "$D/vault-a"                                                # prints nothing
```

The server stores ciphertext and protocol metadata only. Neither vault
holds the other's private text.

## What the marks mean

The double tick (✓✓) after a shared heading means **shared**. It stays in
every state, and it is green when the section is current. Sync progress is a
separate icon beside it. This follows the owner's decision M8 (2026-10-08),
which replaces the one-tick/two-tick progression of OBSIDIAN-SYNC-INDICATORS-01
§6.

| Icon | Tooltip | Meaning |
| --- | --- | --- |
| (none) | "No pending local changes; current as last checked" | All sent and accepted |
| loading | "Loading shared section" | Opening or catching up |
| editing | "Local changes are being processed" | Your edit is being turned into a change |
| pending | "Saved locally; waiting to sync" | Durable here, not sent yet |
| pending | "Sending local updates" | On its way to the server |
| receiving | "Local updates accepted; receiving changes" | Yours accepted, others' arriving |
| offline | "Offline; local updates will wait" | No server; edits are kept |
| unknown | "Server confirmation unavailable" | Sent, but acceptance cannot be confirmed |
| attention | "Needs your attention" | A conflict, a refusal, or removed access: open the details |
| error | "Changes are not safely saved for sync" | A local save failed; the card says "Some local changes are not safely saved for sync. Keep the note open and try again; nothing was sent for them." |
| (none) | "Shared section · read-only" | A reader's current section |

Rows inside a section are quiet when healthy. A row with waiting work or a
problem shows "Local update waiting" or "Needs attention".

## Reviewer checklist

Record each result as **pass**, **fail** or **blocked**. Write any
difference from the expected outcome under "Deviation", even when the step
still works.

| # | Check | Expected | Result | Deviation |
| --- | --- | --- | --- | --- |
| C00 | Versions recorded | `versions.txt`, Obsidian version and OS copied here | | |
| C01 | Independent identities | Each vault shows its own "Identity on this device" | | |
| C02 | Share preview | 200 tasks, 10 paragraphs, 40 list items; no canary in the content | | |
| C03 | Shared and hosted | Notice "section … is shared."; ✓✓ on the heading | | |
| C04 | Invitation | Read + write link; "the link works now"; link hidden until "Show link" | | Preset text says "shared tasks" for a section |
| C05 | Join | All join stages shown; "joined the shared section …" | | |
| C06 | Insert | Inserted after the paragraph at the cursor; B's private text untouched | | |
| C07 | Edits both ways | Each vault shows the other's Task, check and text within seconds | | |
| C08 | Offline queue | Offline icon; edits kept; sent after the server returns | | |
| C09 | Restart with pending work | B's offline edits survive a restart; "Saved locally; waiting to sync" | | |
| C10 | Conflict visible | "Needs your attention" on both; one problem found by "Go to next…" | | |
| C11 | Causal resolution | One choice applied; Task once, in the chosen place, on both sides | | |
| C12 | Readable copy | No `lfcp-` line in the pasted text | | |
| C13 | Copy shared section | Notice says it gives nobody access | | |
| C14 | Detach a section | "Detach this section" on the second copy in Vault A: the confirmation, then the notice "… is no longer shared in this note. The shared section itself is unchanged."; markers gone, text kept; `Launch.md` unchanged | | |
| C15 | Legacy Task beside the section | 0.1 sharing works; refused inside the section | | |
| C16 | Remove access | A: "waiting for the server"; B: "Your access to this section was removed…"; A never gets B's later edit | | |
| C17 | Note problems on the badge | A deleted end marker sets "Needs your attention"; the card names the damaged copy (record which "One copy of this section …" line it shows); Repair clears it | | |
| C18 | Repair | A deleted end marker is offered back and applied | | |
| C19 | Server opacity | No canary, title or text in `server/state` | | |
| C20 | Vault isolation | No A canary in Vault B, no B canary in Vault A | | |

## Tested and deferred

These are covered elsewhere, against the same SDK and server:

- the qualification run, headless (LFCP-02-056);
- `lfcp-todo`'s section tests;
- the plugin's headless two-vault test, `test/core/collab/live-sections.test.ts`.

A native two-vault run in Obsidian is LFCP-02-066, which is not done yet.

Deferred, and not in this script:

- "Join shared section…" as its own command (joining goes through "Join
  collaboration");
- "Show shared boundary", "Insert Task projection…" and "Duplicate as new";
- sharing a selected range instead of a heading's section;
- threaded comments. Only the "Comments in shared sections" setting exists:
  keep local or share.

> MVP reference software: not for data you need to protect.
