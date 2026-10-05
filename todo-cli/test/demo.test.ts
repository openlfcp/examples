// The headless demo (LFCP-072) is also a test: the same storyline a user
// runs with `node todo-cli/demo/demo.mjs`, with its checks asserted.
// Skipped without cargo or ../server, unless LFCP_REQUIRE_LIVE=1.

import { describe, expect, it } from "vitest";
import { runDemo } from "../demo/demo.mjs";

describe("headless Todo demo (LFCP-072)", () => {
  it("runs the two-person storyline against the reference server and passes every check", async (ctx) => {
    const result = await runDemo();
    if ("skipped" in result) {
      console.warn(`SKIPPED: headless demo (${result.skipped})`);
      ctx.skip();
      return;
    }
    expect(result.failures).toEqual([]);
    const text = result.transcript.join("\n");
    expect(text).toContain("Demo passed.");
    expect(text).toMatch(/lfcp:\/\/join\/…#secret=\[redacted\]/);
    expect(text).not.toMatch(/#secret=(?!\[redacted\])/);
  }, 300_000);
});
