// LFCP-02-072: the two-vault fixtures are what the demonstration says, and
// the Obsidian plugin's own share preview accepts the section as one share
// of 200 Tasks with nothing private inside it. The preview check runs when
// an Obsidian checkout is next to this repository (../obsidian), and says
// why it is skipped otherwise.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CANARIES,
  launchPlan,
  legacyTasks,
  meetingNotes,
  SECTION_TITLE,
  settings,
} from "../prepare.mjs";

declare const console: { warn(...a: unknown[]): void };

const OBSIDIAN = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "obsidian");
const SHARE = join(OBSIDIAN, "src", "core", "sections", "share.ts");

describe("two-vault fixtures", () => {
  it("has 200 Tasks under the section heading, nested content, and canaries outside it", () => {
    const note = launchPlan();
    const lines = note.split("\n");
    const start = lines.indexOf(`## ${SECTION_TITLE}`);
    const end = lines.indexOf("## Private notes");
    const inside = lines.slice(start + 1, end);
    expect(inside.filter((l) => /^ *- \[ \] /.test(l))).toHaveLength(200);
    expect(inside.filter((l) => l.startsWith("  - [ ] "))).toHaveLength(40);
    expect(inside.filter((l) => l.startsWith("  - Note"))).toHaveLength(40);
    expect(inside.filter((l) => l.startsWith("Phase "))).toHaveLength(10);
    expect(inside.join("\n")).not.toContain("CANARY");
    expect(lines.slice(0, start).join("\n")).toContain(CANARIES.aBefore);
    expect(lines.slice(end).join("\n")).toContain(CANARIES.aAfter);
    expect(meetingNotes()).toContain(CANARIES.b);
    expect(legacyTasks()).toContain(CANARIES.legacy);
    expect(settings("ws://127.0.0.1:8787/v1/ws", "inline")).toEqual({
      refPlacement: "inline",
      defaultServer: "ws://127.0.0.1:8787/v1/ws",
      sectionsPreview: true,
      settingsVersion: 2,
    });
  });

  it("is one clean share in the plugin's preview", async (ctx) => {
    if (!existsSync(SHARE)) {
      console.warn(`SKIPPED: the plugin's share preview (no Obsidian checkout at ${OBSIDIAN})`);
      ctx.skip();
      return;
    }
    const { preflight, proposeRange } = await import(SHARE);
    const note = launchPlan();
    const heading = note.split("\n").indexOf(`## ${SECTION_TITLE}`);
    const range = proposeRange(note, heading);
    const preview = preflight(note, range);
    expect(preview.problems).toEqual([]);
    expect(preview.title).toBe(SECTION_TITLE);
    expect(preview.counts).toMatchObject({ tasks: 200, items: 40, paragraphs: 10 });
    expect(preview.content).not.toContain("CANARY");
    expect(preview.privateTail).toBeNull();
  });
});
