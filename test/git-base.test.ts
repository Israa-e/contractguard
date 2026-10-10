import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXIT, run } from '../src/cli/run.js';

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

/** Git isolated from the developer's own configuration, so the fixture repo is reproducible. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
  });
}

let tempDir: string;
let repo: string;
let sha: string;
/** api/orders.yaml: committed as v1, modified to v2 in the working tree. */
let changed: string;
/** api/stable.yaml: committed as v1, unchanged. */
let stable: string;
/** api/broken.yaml: committed malformed, fixed in the working tree. */
let broken: string;
/** api/new.yaml: untracked, so it does not exist at any ref. */
let untracked: string;
/** api/link.yaml: committed as a symlink to stable.yaml. */
let link: string;
let statusBefore: string;

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'contractguard-git-'));
  repo = join(tempDir, 'repo');
  const api = join(repo, 'api');
  await mkdir(api, { recursive: true });
  changed = join(api, 'orders.yaml');
  stable = join(api, 'stable.yaml');
  broken = join(api, 'broken.yaml');
  untracked = join(api, 'new.yaml');
  link = join(api, 'link.yaml');

  git(tempDir, 'init', '--quiet', 'repo');
  await copyFile(V1, changed);
  await copyFile(V1, stable);
  await writeFile(broken, 'openapi: 3.0.3\ninfo: { title: t, version: "1" }\npaths:\n  /a:\n    get: oops\n');
  await symlink('stable.yaml', link);
  git(repo, 'add', '.');
  git(repo, 'commit', '--quiet', '--no-verify', '-m', 'v1');
  git(repo, 'tag', 'v1');
  git(repo, 'branch', 'base');
  sha = git(repo, 'rev-parse', 'HEAD').trim();

  await copyFile(V2, changed);
  await copyFile(V1, broken);
  await copyFile(V1, untracked);
  statusBefore = git(repo, 'status', '--porcelain', '--untracked-files=all');
});

afterAll(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

describe('check --base <git-ref> <spec>', () => {
  it('reports breaking changes against the committed version', async () => {
    const { code, stdout } = await cli('check', '--base', 'HEAD', changed);
    expect(code).toBe(EXIT.INCOMPATIBLE);
    expect(stdout).toContain('12 breaking · 4 need review · 6 safe');
  });

  it('produces the same report as comparing the two files directly', async () => {
    const viaGit = await cli('check', '--base', 'HEAD', changed, '--format', 'json');
    const viaFiles = await cli('check', V1, V2, '--format', 'json');
    expect(JSON.parse(viaGit.stdout)).toEqual(JSON.parse(viaFiles.stdout));
  });

  it('exits 0 when the spec is unchanged', async () => {
    const { code, stdout } = await cli('check', '--base', 'HEAD', stable);
    expect(code).toBe(EXIT.OK);
    expect(stdout).toContain('No contract changes detected.');
  });

  it('accepts a branch, a tag and a full commit SHA', async () => {
    for (const ref of ['base', 'v1', sha]) {
      expect((await cli('check', '--base', ref, changed)).code, ref).toBe(EXIT.INCOMPATIBLE);
    }
  });

  it('finds a spec in a subdirectory given a path relative to another working directory', async () => {
    // The CLI runs from the project root, nowhere near the fixture repo.
    const { code } = await cli('check', '--base', 'HEAD', relative(process.cwd(), changed));
    expect(code).toBe(EXIT.INCOMPATIBLE);
  });

  it('exits 2 for an unknown ref', async () => {
    const { code, stdout, stderr } = await cli('check', '--base', 'no-such-branch', changed);
    expect(code).toBe(EXIT.ERROR);
    expect(stdout).toBe('');
    expect(stderr).toContain('unknown git ref "no-such-branch"');
    expect(stderr).toContain('fetch-depth: 0');
  });

  it('exits 2 for a ref that names a file rather than a commit', async () => {
    const { code, stderr } = await cli('check', '--base', 'HEAD:api/orders.yaml', changed);
    expect(code).toBe(EXIT.ERROR);
    expect(stderr).toContain('unknown git ref "HEAD:api/orders.yaml"');
  });

  it('never lets a ref act as a git option', async () => {
    const target = join(tempDir, 'injected.txt');
    const { code, stderr } = await cli('check', `--base=--output=${target}`, changed);
    expect(code).toBe(EXIT.ERROR);
    expect(stderr).toContain('unknown git ref');
    expect(existsSync(target)).toBe(false);
  });

  it('exits 2 when the spec does not exist at the ref', async () => {
    const { code, stdout, stderr } = await cli('check', '--base', 'HEAD', untracked);
    expect(code).toBe(EXIT.ERROR);
    expect(stdout).toBe('');
    expect(stderr).toContain(`${untracked} does not exist at HEAD`);
  });

  it('exits 2 with the ref in the message when the spec at the ref is invalid', async () => {
    const { code, stderr } = await cli('check', '--base', 'HEAD', broken);
    expect(code).toBe(EXIT.ERROR);
    expect(stderr).toContain(`HEAD:${broken}: paths["/a"].get: expected an object`);
  });

  it('exits 2 with a clear error when the spec is a symlink at the ref', async () => {
    // Git stores a symlink's target path ("stable.yaml"), not the spec it points to.
    const { code, stdout, stderr } = await cli('check', '--base', 'HEAD', link);
    expect(code).toBe(EXIT.ERROR);
    expect(stdout).toBe('');
    expect(stderr).toContain(`${link} is a symlink at HEAD`);
    expect(stderr).toContain('does not support symlinked specs');
    expect(stderr).not.toContain('expected an OpenAPI document');
  });

  it('exits 2 outside a git repository', async () => {
    const outside = join(tempDir, 'outside.yaml');
    await copyFile(V1, outside);
    const { code, stderr } = await cli('check', '--base', 'HEAD', outside);
    expect(code).toBe(EXIT.ERROR);
    expect(stderr).toContain(`${outside} is not inside a git repository`);
  });

  it('exits 2 when git is not installed', async () => {
    const path = process.env.PATH;
    process.env.PATH = '';
    try {
      const { code, stderr } = await cli('check', '--base', 'HEAD', changed);
      expect(code).toBe(EXIT.ERROR);
      expect(stderr).toContain('git, which was not found on PATH');
    } finally {
      process.env.PATH = path;
    }
  });

  it('reports a problem with the working-tree file before touching git', async () => {
    const { code, stderr } = await cli('check', '--base', 'no-such-branch', join(repo, 'api', 'missing.yaml'));
    expect(code).toBe(EXIT.ERROR);
    expect(stderr).toContain('Cannot read');
  });

  it('leaves the working tree and index untouched', () => {
    expect(git(repo, 'status', '--porcelain', '--untracked-files=all')).toBe(statusBefore);
  });

  it('rejects ambiguous usage', async () => {
    expect((await cli('check', '--base', 'HEAD', changed, stable)).code).toBe(EXIT.ERROR);
    expect((await cli('check', '--base', 'HEAD')).code).toBe(EXIT.ERROR);
    expect((await cli('check', '--base', '', changed)).code).toBe(EXIT.ERROR);
    expect((await cli('check', changed, '--base')).code).toBe(EXIT.ERROR);
  });
});
