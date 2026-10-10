// Packs ContractGuard the way npm publishes it, installs the tarball into an empty project,
// and runs the installed CLI and library. Catches what build + tests can't: files missing
// from the package, a broken `bin` link, or a bad `main`/`types` entry.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  // Build first and pack without scripts, so `prepare` output can't mix into the JSON.
  execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'ignore' });
  const [{ filename }] = JSON.parse(
    execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', dir], {
      cwd: root,
      encoding: 'utf8',
    }),
  );
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
} finally {
  rmSync(dir, { recursive: true, force: true });
}
