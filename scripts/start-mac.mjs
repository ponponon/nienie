import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const esbuildBin = resolve(
  rootDir,
  'node_modules/.pnpm/@esbuild+darwin-arm64@0.28.2/node_modules/@esbuild/darwin-arm64/bin/esbuild',
);

const isSmokeOrHeadless =
  process.argv.includes('--smoke') || process.argv.includes('--headless');

if (!process.argv.includes('--smoke')) {
  for (const pattern of [
    'apps/desktop/dist/nienie-desktop.mjs',
    'apps/desktop/dist/electron-main.cjs',
  ]) {
    try {
      execFileSync('pkill', ['-f', pattern], { stdio: 'ignore' });
    } catch {
      // No stale process
    }
  }
}

if (isSmokeOrHeadless) {
  const entryFile = resolve(rootDir, 'apps/desktop/src/cli.ts');
  const outFile = resolve(rootDir, 'apps/desktop/dist/nienie-desktop.mjs');

  execFileSync(
    esbuildBin,
    [
      entryFile,
      '--bundle',
      '--platform=node',
      '--format=esm',
      '--target=node22',
      `--outfile=${outFile}`,
    ],
    { cwd: rootDir, stdio: 'inherit' },
  );

  const child = spawn(process.execPath, [outFile, ...process.argv.slice(2)], {
    cwd: rootDir,
    stdio: 'inherit',
  });
  child.on('exit', (code) => process.exit(code ?? 0));
} else {
  const entryFile = resolve(rootDir, 'apps/desktop/src/electron-main.ts');
  const outFile = resolve(rootDir, 'apps/desktop/dist/electron-main.cjs');

  execFileSync(
    esbuildBin,
    [
      entryFile,
      '--bundle',
      '--platform=node',
      '--format=cjs',
      '--target=node22',
      '--external:electron',
      `--outfile=${outFile}`,
    ],
    { cwd: rootDir, stdio: 'inherit' },
  );

  const requireFromDesktop = createRequire(resolve(rootDir, 'apps/desktop/package.json'));
  const electronBinary = requireFromDesktop('electron');

  const child = spawn(String(electronBinary), [outFile, ...process.argv.slice(2)], {
    cwd: rootDir,
    stdio: 'inherit',
  });
  child.on('exit', (code) => process.exit(code ?? 0));
}
