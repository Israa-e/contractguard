import { parseArgs } from 'node:util';
import { compareFiles } from '../index.js';
import { SpecLoadError } from '../loader.js';
import { FORMATS, formatReport, type Format } from '../report/format.js';
import type { Report } from '../types.js';
import { VERSION } from '../version.js';

export const EXIT = { OK: 0, INCOMPATIBLE: 1, ERROR: 2 } as const;

const FAIL_ON = ['breaking', 'review', 'never'] as const;
type FailOn = (typeof FAIL_ON)[number];

export interface IO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  color: boolean;
}

const HELP = `contractguard ${VERSION}
Detect breaking changes between two OpenAPI 3.x contracts.

Usage:
  contractguard check <old-spec> <new-spec> [options]

Options:
  -f, --format <text|markdown|json>   Output format (default: text)
      --fail-on <breaking|review|never>
                                      Exit with code 1 when changes at or above this
                                      severity are found (default: breaking)
      --hide-safe                     Leave safe changes out of text/markdown output
      --no-color                      Disable colored output
  -h, --help                          Show this help
  -v, --version                       Show version

Exit codes:
  0  compatible under the --fail-on policy
  1  incompatible changes found
  2  invalid usage or unreadable spec

Example:
  git show origin/main:openapi.yaml > /tmp/base.yaml
  contractguard check /tmp/base.yaml openapi.yaml --format markdown`;

export async function run(argv: string[], io: IO): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        format: { type: 'string', short: 'f', default: 'text' },
        'fail-on': { type: 'string', default: 'breaking' },
        'hide-safe': { type: 'boolean', default: false },
        'no-color': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
      },
    });
  } catch (err) {
    return usageError(io, (err as Error).message);
  }

  const { values, positionals } = parsed;
  if (values.version) {
    io.stdout(VERSION);
    return EXIT.OK;
  }
  if (values.help || positionals.length === 0) {
    io.stdout(HELP);
    return EXIT.OK;
  }

  const [command, oldFile, newFile, ...extra] = positionals;
  if (command !== 'check') return usageError(io, `Unknown command "${command}"`);
  if (!oldFile || !newFile || extra.length) return usageError(io, 'Expected exactly two spec files: <old-spec> <new-spec>');

  const format = values.format as Format;
  if (!FORMATS.includes(format)) return usageError(io, `--format must be one of: ${FORMATS.join(', ')}`);
  const failOn = values['fail-on'] as FailOn;
  if (!FAIL_ON.includes(failOn)) return usageError(io, `--fail-on must be one of: ${FAIL_ON.join(', ')}`);

  let report: Report;
  try {
    report = await compareFiles(oldFile, newFile);
  } catch (err) {
    if (err instanceof SpecLoadError) {
      io.stderr(`contractguard: ${err.message}`);
      return EXIT.ERROR;
    }
    throw err;
  }

  io.stdout(
    formatReport(report, format, {
      color: io.color && !values['no-color'] && format === 'text',
      showSafe: !values['hide-safe'],
    }),
  );

  return shouldFail(report, failOn) ? EXIT.INCOMPATIBLE : EXIT.OK;
}

export function shouldFail(report: Report, failOn: FailOn): boolean {
  if (failOn === 'never') return false;
  if (failOn === 'review') return report.summary.breaking + report.summary.review > 0;
  return report.summary.breaking > 0;
}

function usageError(io: IO, message: string): number {
  io.stderr(`contractguard: ${message}\nRun "contractguard --help" for usage.`);
  return EXIT.ERROR;
}
