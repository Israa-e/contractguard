import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXIT, run } from '../src/cli/run.js';
import { parseSpec, SpecLoadError } from '../src/loader.js';
import type { Report } from '../src/types.js';

const V1 = 'examples/orders-v1.yaml';
const V2 = 'examples/orders-v2.yaml';

async function cli(...argv: string[]) {
  let stdout = '';
  let stderr = '';
  const code = await run(argv, {
    stdout: (t) => (stdout += t + '\n'),
    stderr: (t) => (stderr += t + '\n'),
    color: false,
  });
  return { code, stdout, stderr };
}

describe('contractguard check', () => {
  it('exits 1 and explains breaking changes', async () => {
    const { code, stdout } = await cli('check', V1, V2);
    expect(code).toBe(EXIT.INCOMPATIBLE);
    expect(stdout).toContain('Response property `total` removed (looks renamed to `amount`)');
    expect(stdout).toContain('Endpoint now requires authentication');
  });

  it('exits 0 when comparing a spec with itself', async () => {
    const { code, stdout } = await cli('check', V1, V1);
    expect(code).toBe(EXIT.OK);
    expect(stdout).toContain('No contract changes detected.');
  });

  it('produces the expected report for the example migration', async () => {
    const { stdout } = await cli('check', V1, V2, '--format', 'json');
    const report: Report = JSON.parse(stdout);
    expect(report.summary).toEqual({ breaking: 12, review: 4, safe: 6 });
    const breaking = new Set(report.changes.filter((c) => c.severity === 'breaking').map((c) => c.kind));
    expect(breaking).toEqual(
      new Set([
        'endpoint.removed',
        'security.tightened',
        'schema.constraint.tightened',
        'parameter.added',
        'schema.required.removed',
        'schema.property.removed',
        'schema.property.added',
        'schema.type.changed',
      ]),
    );
  });

  it('renders markdown for pull request comments', async () => {
    const { stdout } = await cli('check', V1, V2, '--format', 'markdown');
    expect(stdout).toContain('## ContractGuard report');
    expect(stdout).toContain('🔴 **This change breaks the API contract.**');
    expect(stdout).toContain('<details>');
  });

  it('honours --fail-on', async () => {
    expect((await cli('check', V1, V2, '--fail-on', 'never')).code).toBe(EXIT.OK);
    expect((await cli('check', V1, V2, '--fail-on', 'review')).code).toBe(EXIT.INCOMPATIBLE);
  });

  it('exits 2 on usage errors', async () => {
    expect((await cli('check', V1)).code).toBe(EXIT.ERROR);
    expect((await cli('compare', V1, V2)).code).toBe(EXIT.ERROR);
    expect((await cli('check', V1, V2, '--format', 'xml')).code).toBe(EXIT.ERROR);
    expect((await cli('check', V1, V2, '--bogus')).code).toBe(EXIT.ERROR);
  });

  it('exits 2 with a clear message for unreadable specs', async () => {
    const { code, stderr } = await cli('check', V1, 'does-not-exist.yaml');
    expect(code).toBe(EXIT.ERROR);
    expect(stderr).toContain('Cannot read does-not-exist.yaml');
  });

  it('accepts JSON specs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'contractguard-'));
    const file = join(dir, 'spec.json');
    await writeFile(file, JSON.stringify({ openapi: '3.1.0', info: { title: 't', version: '1' }, paths: {} }));
    expect((await cli('check', file, file)).code).toBe(EXIT.OK);
  });
});

describe('spec loading', () => {
  it('rejects Swagger 2.0 with guidance', () => {
    expect(() => parseSpec('swagger: "2.0"\npaths: {}')).toThrow(/Convert it to OpenAPI 3/);
  });

  it('rejects documents without an OpenAPI 3 version', () => {
    expect(() => parseSpec('openapi: 4.0.0\npaths: {}')).toThrow(SpecLoadError);
    expect(() => parseSpec('just a string')).toThrow(SpecLoadError);
  });

  it('rejects broken and external $refs up front', () => {
    const doc = (ref: string) => `openapi: 3.0.3\npaths: {}\ncomponents:\n  schemas:\n    A: { $ref: '${ref}' }`;
    expect(() => parseSpec(doc('#/components/schemas/Missing'))).toThrow(/Unresolvable \$ref/);
    expect(() => parseSpec(doc('other.yaml#/A'))).toThrow(/External \$ref/);
  });

  it('reports YAML syntax errors', () => {
    expect(() => parseSpec('openapi: [', 'bad.yaml')).toThrow(/bad.yaml: invalid YAML/);
  });
});
