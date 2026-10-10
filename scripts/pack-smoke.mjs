// Packs ContractGuard the way npm publishes it, installs the tarball into an empty project,
// runs the installed CLI and library, and typechecks an import of it. Catches what build +
// tests can't: files missing from the package, a broken `bin` link, or a bad `main`/`types` entry.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const v1 = join(root, 'examples/orders-v1.yaml');
const v2 = join(root, 'examples/orders-v2.yaml');
const dir = mkdtempSync(join(tmpdir(), 'contractguard-pack-'));

function check(label, condition, details = '') {
  if (!condition) throw new Error(`${label} failed${details ? `\n${details}` : ''}`);
  console.log(`ok  ${label}`);
}

try {
  // `npm pack` runs `prepare` (the build), exactly as publishing does. The tarball is found
  // by listing the directory rather than parsing pack's output, which build logs can pollute.
  execFileSync('npm', ['pack', '--pack-destination', dir], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
  const filename = readdirSync(dir).find((f) => f.endsWith('.tgz'));
  check('npm pack produces a tarball', filename !== undefined);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'pack-smoke', private: true, type: 'module' }));
  execFileSync('npm', ['install', '--no-audit', '--no-fund', join(dir, filename)], { cwd: dir, stdio: 'ignore' });
  check('installs from the packed tarball', true);

  const bin = join(dir, 'node_modules', '.bin', 'contractguard');
  const cli = (...args) => spawnSync(bin, args, { cwd: dir, encoding: 'utf8' });

  const help = cli('--help');
  check('contractguard --help', help.status === 0 && help.stdout.includes('Usage:'), help.stderr);

  const breaking = cli('check', v1, v2, '--format', 'json');
  const summary = breaking.stdout ? JSON.parse(breaking.stdout).summary : undefined;
  check('check exits 1 on breaking changes', breaking.status === 1 && summary?.breaking > 0, breaking.stderr);

  const same = cli('check', v1, v1);
  check('check exits 0 on identical specs', same.status === 0, same.stderr);

  const script = `import { compareFiles } from 'contractguard';
const r = await compareFiles(${JSON.stringify(v1)}, ${JSON.stringify(v2)});
if (!(r.summary.breaking > 0)) process.exit(1);`;
  const library = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: dir, encoding: 'utf8' });
  check('library import from the installed package', library.status === 0, library.stderr);

  // Strict NodeNext resolution, as a TypeScript consumer would compile against the `types` entry.
  writeFileSync(
    join(dir, 'consumer.mts'),
    `import { compareFiles, type Report, type Severity } from 'contractguard';
const report: Report = await compareFiles('old.yaml', 'new.yaml');
const severity: Severity | undefined = report.changes[0]?.severity;
export { severity };
`,
  );
  const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  const tscArgs = ['--noEmit', '--strict', '--module', 'nodenext', '--moduleResolution', 'nodenext'];
  const types = spawnSync(process.execPath, [tsc, ...tscArgs, '--target', 'es2022', 'consumer.mts'], {
    cwd: dir,
    encoding: 'utf8',
  });
  check('TypeScript types of the installed package', types.status === 0, types.stdout + types.stderr);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
