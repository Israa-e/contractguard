#!/usr/bin/env node
import { run } from './cli/run.js';

const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

run(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text + '\n'),
  stderr: (text) => process.stderr.write(text + '\n'),
  color,
}).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`contractguard: unexpected error: ${err?.stack ?? err}\n`);
    process.exitCode = 2;
  },
);
