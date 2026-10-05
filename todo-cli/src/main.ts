#!/usr/bin/env node
// lfcp-todo: the headless Todo CLI (LFCP-039). See ../README.md.
import { run } from "./commands.js";

const code = await run(
  process.argv.slice(2),
  {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  },
  process.env,
);
process.exitCode = code;
