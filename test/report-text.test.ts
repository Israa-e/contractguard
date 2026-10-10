import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXIT, run } from '../src/cli/run.js';
import type { OpenAPIObject, Report } from '../src/types.js';
import { spec } from './helpers.js';

const V1 = 'examples/orders-v1.yaml';
const V2 = 'examples/orders-v2.yaml';
const FORMATS = ['text', 'markdown', 'json'] as const;

/**
 * Words that have been reported joined together. They came from copying report
 * text out of word-wrapped views, not from the source, and must never appear.
 */
const MALFORMED = [
  'everyclient',
  'releasinga',
  'mayfail',
  'atransition',
  'defaultbehaviour',
  'maytreat',
  'cannotparse',
  'UnsupportedMedia',
];

async function cli(...argv: string[]) {
  let stdout = '';
  const code = await run(argv, { stdout: (t) => (stdout += t + '\n'), stderr: () => {}, color: false });
  return { code, stdout };
}

interface OpOptions {
  limitRequired: boolean;
  sortParam: boolean;
  statuses: string[];
  countType: string;
  mediaTypes: string[];
}

/** Old/new specs that trigger rules the example migration does not reach. */
function extraRulesSpecs(): [OpenAPIObject, OpenAPIObject] {
  const op = (o: OpOptions) => {
    const response = { type: 'object', properties: { count: { type: o.countType } } };
    return {
      parameters: [
        { name: 'limit', in: 'query', required: o.limitRequired, schema: { type: 'integer' } },
        ...(o.sortParam ? [{ name: 'sort', in: 'query', schema: { type: 'string' } }] : []),
      ],
      requestBody: { content: Object.fromEntries(o.mediaTypes.map((m) => [m, { schema: { type: 'object' } }])) },
      responses: Object.fromEntries(
        o.statuses.map((s) => [s, { description: 'ok', content: { 'application/json': { schema: response } } }]),
      ),
    };
  };
  const before = op({
    limitRequired: false,
    sortParam: true,
    statuses: ['200'],
    countType: 'integer',
    mediaTypes: ['application/json', 'application/xml'],
  });
  const after = op({
    limitRequired: true,
    sortParam: false,
    statuses: ['200', '201'],
    countType: 'number',
    mediaTypes: ['application/json'],
  });
  return [spec({ '/things': { post: before } }), spec({ '/things': { post: after } })];
}

/** [old, new] spec paths: the example migration and the extra-rules fixture. */
const PAIRS: [string, string][] = [[V1, V2]];
let tempDir: string;
let extraOld: string;
let extraNew: string;

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'contractguard-'));
  const [oldDoc, newDoc] = extraRulesSpecs();
  extraOld = join(tempDir, 'old.json');
  extraNew = join(tempDir, 'new.json');
  await writeFile(extraOld, JSON.stringify(oldDoc));
  await writeFile(extraNew, JSON.stringify(newDoc));
  PAIRS.push([extraOld, extraNew]);
});

afterAll(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

describe('report text', () => {
  it('contains correctly spaced sentences for the example migration', async () => {
    const { stdout } = await cli('check', V1, V2);
    expect(stdout).toContain('still breaks every client that has not migrated yet');
    expect(stdout).toContain('unless you are intentionally releasing a new SDK major version.');
    expect(stdout).toContain('will get undefined/null and may fail.');
    expect(stdout).toContain('during a transition period (mark `total` `deprecated: true`)');
  });

  it('contains correctly spaced sentences for rules the example does not trigger', async () => {
    const json = await cli('check', extraOld, extraNew, '--format', 'json');
    const report: Report = JSON.parse(json.stdout);
    expect(report.changes.map((c) => `${c.severity} ${c.kind}`)).toEqual([
      'breaking parameter.required.added',
      'breaking request.mediaType.removed',
      'breaking schema.type.widened',
      'review parameter.removed',
      'review response.status.added',
    ]);

    const { stdout } = await cli('check', extraOld, extraNew);
    expect(stdout).toContain('Keep accepting the parameter (marked deprecated) for a transition period.');
    expect(stdout).toContain('Keep it optional and fall back to the previous default behaviour.');
    expect(stdout).toContain('Clients sending this content type will get 415 Unsupported Media Type.');
    expect(stdout).toContain('may treat HTTP 201 as an error.');
    expect(stdout).toContain('Clients may now receive values of a type they cannot parse.');
  });

  it('never contains known malformed strings in any format', async () => {
    for (const [oldFile, newFile] of PAIRS) {
      for (const format of FORMATS) {
        const { code, stdout } = await cli('check', oldFile, newFile, '--format', format);
        expect(code, `${format}: ${newFile}`).toBe(EXIT.INCOMPATIBLE);
        for (const bad of MALFORMED) expect(stdout, `${format}: ${newFile}`).not.toContain(bad);
      }
    }
  });

  it('keeps every message, reason and suggestion on one cleanly spaced line', async () => {
    for (const [oldFile, newFile] of PAIRS) {
      const report: Report = JSON.parse((await cli('check', oldFile, newFile, '--format', 'json')).stdout);
      const strings = report.changes.flatMap((c) => [c.message, c.reason, c.suggestion ?? '']).filter(Boolean);
      for (const s of strings) {
        expect(s, s).toBe(s.trim());
        expect(s, s).not.toMatch(/\s{2,}|\n/);
        expect(s, s).not.toMatch(/ [,.;:]/);
      }
    }
  });
});

describe('report formats', () => {
  it('reports the same counts and exit code in every format', async () => {
    const [text, markdown, json] = await Promise.all(FORMATS.map((f) => cli('check', V1, V2, '--format', f)));

    for (const { code } of [text, markdown, json]) expect(code).toBe(EXIT.INCOMPATIBLE);
    expect(text.stdout).toContain('12 breaking · 4 need review · 6 safe');
    expect(markdown.stdout).toContain('| 12 | 4 | 6 |');
    expect(JSON.parse(json.stdout).summary).toEqual({ breaking: 12, review: 4, safe: 6 });
  });

  it('renders each non-safe change with its labelled lines', async () => {
    const { stdout: text } = await cli('check', V1, V2);
    expect(text).toContain(
      [
        '✖ BREAKING GET /orders/{id}',
        '  Response property `total` removed (looks renamed to `amount`)',
        '  at:   response 200 (application/json) → total',
        '  why:  Clients that read this property will get undefined/null and may fail.',
        '  fix:  Return both `total` and `amount` during a transition period',
      ].join('\n'),
    );

    const { stdout: markdown } = await cli('check', V1, V2, '--format', 'markdown');
    expect(markdown).toContain(
      '#### `GET /orders/{id}`: Response property `total` removed (looks renamed to `amount`)',
    );
    expect(markdown).toContain('- **Why:** Clients that read this property will get undefined/null and may fail.');
    expect(markdown).toContain('- **Suggested fix:** Return both `total` and `amount` during a transition period');
  });

  it('emits valid JSON with the full report structure', async () => {
    const { stdout } = await cli('check', V1, V2, '--format', 'json');
    const report: Report = JSON.parse(stdout);
    expect(Object.keys(report).sort()).toEqual(['changes', 'summary']);
    for (const c of report.changes) {
      expect(c).toEqual(
        expect.objectContaining({
          kind: expect.any(String),
          severity: expect.stringMatching(/^(breaking|review|safe)$/),
          endpoint: expect.any(String),
          location: expect.any(String),
          message: expect.any(String),
          reason: expect.any(String),
        }),
      );
    }
    const counted = { breaking: 0, review: 0, safe: 0 };
    for (const c of report.changes) counted[c.severity]++;
    expect(counted).toEqual(report.summary);
  });
});
