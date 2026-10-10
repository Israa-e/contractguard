import { execFile } from 'node:child_process';
import { basename, dirname, resolve } from 'node:path';
import { parseSpec, SpecLoadError, type LoadedSpec } from './loader.js';

/** Real-world specs can be several MB; execFile's default limit is 1 MB. */
const MAX_SPEC_BYTES = 64 * 1024 * 1024;

interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Runs git without a shell. Only process-level failures reject; a non-zero exit resolves. */
function git(args: string[], cwd: string): Promise<GitResult> {
  return new Promise((done, fail) => {
    const env = { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' };
    execFile('git', args, { cwd, env, encoding: 'utf8', maxBuffer: MAX_SPEC_BYTES }, (err, stdout, stderr) => {
      if (!err) return done({ status: 0, stdout, stderr });
      const code = (err as NodeJS.ErrnoException).code as string | number | undefined;
      if (code === 'ENOENT') return fail(new SpecLoadError('--base needs git, which was not found on PATH'));
      if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        const limit = `${MAX_SPEC_BYTES / 1024 / 1024} MB`;
        return fail(new SpecLoadError(`--base: the spec at the git ref is larger than ${limit}`));
      }
      done({ status: typeof code === 'number' ? code : -1, stdout, stderr });
    });
  });
}

const firstLine = (text: string) => text.trim().split('\n')[0] ?? '';

/**
 * Loads `file` as it is in the git commit `ref`, without touching the working tree or index.
 * The ref is resolved to a commit first, so user input never reaches git as an option or a
 * path, and the file is read relative to its own directory, wherever the CLI runs from.
 */
export async function loadSpecAtRef(ref: string, file: string): Promise<LoadedSpec> {
  const cwd = dirname(resolve(file));

  const commit = await git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], cwd);
  if (commit.status !== 0) {
    if (/not a git repository/i.test(commit.stderr)) {
      throw new SpecLoadError(`--base: ${file} is not inside a git repository`);
    }
    if (commit.stderr.trim()) throw new SpecLoadError(`--base: git failed: ${firstLine(commit.stderr)}`);
    throw new SpecLoadError(
      `--base: unknown git ref "${ref}". Use a commit, branch or tag that exists locally; ` +
        'in CI, fetch it first (e.g. actions/checkout with fetch-depth: 0).',
    );
  }

  // --filters gives the content a checkout would (line endings, Git LFS), not the raw blob.
  const blob = await git(['cat-file', '--filters', `${commit.stdout.trim()}:./${basename(file)}`], cwd);
  if (blob.status !== 0) {
    if (/does not exist|exists on disk, but not in/i.test(blob.stderr)) {
      throw new SpecLoadError(`--base: ${file} does not exist at ${ref}`);
    }
    throw new SpecLoadError(`--base: git failed: ${firstLine(blob.stderr)}`);
  }

  return parseSpec(blob.stdout, `${ref}:${file}`);
}
