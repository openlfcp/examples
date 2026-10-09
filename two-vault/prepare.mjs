#!/usr/bin/env node
// Prepares the shared sections two-vault demonstration (LFCP-02-072)
// outside every repository:
//
//   node two-vault/prepare.mjs [--dir <path>] [--port <n>] [--obsidian <checkout>]
//
// Default directory: ../openlfcp-sections-demo, next to this checkout. It
// creates
//   <dir>/vault-a, <dir>/vault-b   two vaults, each with the plugin built from
//                                  the Obsidian checkout and enabled, the
//                                  section preview on and the local server as
//                                  the default server, and the fixture notes;
//   <dir>/server/server.toml       a reference server config (state in <dir>/server/state);
//   <dir>/versions.txt             the commits of the checkouts used;
// and prints the next steps. Re-running refreshes the plugin and the
// settings and keeps existing notes. Walkthrough and reviewer checklist:
// docs/demos/two-vault-sections.md.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/** Text that must stay in its vault: the reviewer searches for it on the server and in the other vault. */
export const CANARIES = {
  aBefore: "CANARY-A-BEFORE-0721",
  aAfter: "CANARY-A-AFTER-0722",
  b: "CANARY-B-0723",
  legacy: "CANARY-A-LEGACY-0724",
};

/** The shared section's heading in Vault A. */
export const SECTION_TITLE = "Launch plan (200 tasks)";

/**
 * Vault A's note: a private introduction, the section to share (200 Tasks
 * in 10 phases, each phase a paragraph, 16 top-level Tasks with 4 subtasks
 * and 4 notes nested under them), and a private part after it.
 */
export function launchPlan() {
  const lines = [
    "# Launch",
    "",
    `Private introduction: this paragraph stays in Vault A. ${CANARIES.aBefore}`,
    "",
    `## ${SECTION_TITLE}`,
    "",
  ];
  let task = 0;
  for (let phase = 1; phase <= 10; phase++) {
    lines.push(`Phase ${phase}: what has to be done before the next phase starts.`, "");
    for (let k = 0; k < 16; k++) {
      task++;
      lines.push(`- [ ] Task ${task}: phase ${phase} step ${k + 1}`);
      // Every fourth Task carries a nested subtask and a nested note.
      if (k % 4 === 3) {
        task++;
        lines.push(`  - [ ] Task ${task}: check phase ${phase} step ${k + 1}`);
        lines.push(`  - Note on phase ${phase} step ${k + 1}`);
      }
    }
    lines.push("");
  }
  lines.push(
    "## Private notes",
    "",
    `This part is not under the shared heading and stays in Vault A. ${CANARIES.aAfter}`,
    "",
  );
  return lines.join("\n");
}

/** Vault A's legacy (0.1) Task list: shared Task by Task, beside the section. */
export function legacyTasks() {
  return [
    "# Legacy tasks",
    "",
    `These Tasks use the 0.1 Task sharing. ${CANARIES.legacy}`,
    "",
    "- [ ] Renew the domain",
    "- [ ] Send the invoice",
    "",
  ].join("\n");
}

/** Vault B's private note, where B inserts the shared section. */
export function meetingNotes() {
  return [
    "# Meeting notes",
    "",
    `Private to Vault B. ${CANARIES.b}`,
    "",
    "Insert the shared section below this paragraph.",
    "",
    "## Follow-ups (private)",
    "",
    "- [ ] Call the venue",
    "",
  ].join("\n");
}

/** The plugin settings of each vault (obsidian src/core/settings.ts). */
export function settings(url, refPlacement) {
  return { refPlacement, defaultServer: url, sectionsPreview: true, settingsVersion: 2 };
}

function commit(checkout) {
  try {
    return execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "(not a git checkout)";
  }
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const { values } = parseArgs({
    options: {
      dir: { type: "string" },
      port: { type: "string" },
      obsidian: { type: "string" },
    },
  });
  const dir = resolve(values.dir ?? join(root, "..", "openlfcp-sections-demo"));
  const obsidian = resolve(values.obsidian ?? join(root, "..", "obsidian"));
  const port = Number(values.port ?? 8787);
  const url = `ws://127.0.0.1:${port}/v1/ws`;
  for (const repo of [root, obsidian])
    if (dir === repo || dir.startsWith(`${repo}/`))
      throw new Error("the demo directory must be outside the repositories");
  if (!existsSync(join(obsidian, "scripts", "build.mjs")))
    throw new Error(`no Obsidian plugin checkout at ${obsidian} (pass --obsidian)`);

  const vaults = {
    "vault-a": {
      settings: settings(url, "child-line"),
      notes: { "Launch.md": launchPlan(), "Legacy tasks.md": legacyTasks() },
    },
    "vault-b": { settings: settings(url, "inline"), notes: { "Meeting notes.md": meetingNotes() } },
  };
  // Obsidian keys the plugin folder and community-plugins.json on the manifest ID.
  const { id, version } = JSON.parse(readFileSync(join(obsidian, "manifest.json"), "utf8"));
  for (const [vault, spec] of Object.entries(vaults)) {
    const plugin = join(dir, vault, ".obsidian", "plugins", id);
    mkdirSync(plugin, { recursive: true });
    execFileSync("node", ["scripts/build.mjs", "--outfile", join(plugin, "main.js")], {
      cwd: obsidian,
      stdio: "ignore",
    });
    for (const f of ["manifest.json", "styles.css"])
      writeFileSync(join(plugin, f), readFileSync(join(obsidian, f)));
    writeFileSync(
      join(dir, vault, ".obsidian", "community-plugins.json"),
      `${JSON.stringify([id])}\n`,
    );
    // The section preview is not in the settings tab: it is set here, over any stored settings.
    const data = join(plugin, "data.json");
    const stored = existsSync(data) ? JSON.parse(readFileSync(data, "utf8")) : {};
    writeFileSync(data, `${JSON.stringify({ ...stored, ...spec.settings }, null, 2)}\n`);
    for (const [name, text] of Object.entries(spec.notes)) {
      const path = join(dir, vault, name);
      if (!existsSync(path)) writeFileSync(path, text);
    }
  }

  const server = join(dir, "server");
  mkdirSync(server, { recursive: true });
  writeFileSync(
    join(server, "server.toml"),
    [
      `bind = "127.0.0.1:${port}"`,
      `state_dir = ${JSON.stringify(join(server, "state"))}`,
      `public_urls = [${JSON.stringify(url)}]`,
      "",
    ].join("\n"),
  );
  const serverCheckout = resolve(root, "..", "server");
  const sdk = resolve(root, "..", "sdk-ts");
  const versions = [
    `obsidian ${commit(obsidian)} (manifest ${version})`,
    `server   ${commit(serverCheckout)}`,
    `sdk-ts   ${commit(sdk)}`,
    `examples ${commit(root)}`,
    "",
  ].join("\n");
  writeFileSync(join(dir, "versions.txt"), versions);

  console.log(`Demo prepared in ${dir}

${versions}
1. Start the reference server (in its own terminal):

   cargo run --manifest-path ${join(serverCheckout, "Cargo.toml")} -- --config ${join(server, "server.toml")}

2. Open both vaults in Obsidian ("Open folder as vault"); in each, turn off
   Restricted mode once (Settings → Community plugins):

   ${join(dir, "vault-a")}
   ${join(dir, "vault-b")}

3. Follow docs/demos/two-vault-sections.md. The server is ${url}, already the
   default server in both vaults; the section preview is on.

To start over: quit Obsidian and delete ${dir}.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
