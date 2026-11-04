import { execFileSync, spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const esbuildBin = resolve(
  rootDir,
  'node_modules/.pnpm/@esbuild+darwin-arm64@0.28.2/node_modules/@esbuild/darwin-arm64/bin/esbuild',
);
const entryFile = resolve(rootDir, 'apps/desktop/src/cli.ts');
const outFile = resolve(rootDir, 'apps/desktop/dist/nienie-desktop.mjs');

if (!process.argv.includes('--smoke')) {
  try {
    execFileSync('pkill', ['-f', 'apps/desktop/dist/nienie-desktop.mjs'], {
      stdio: 'ignore',
    });
  } catch {
    // No existing Nienie desktop process running
  }
}

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

child.on('exit', (code) => {
  process.exit(code ?? 0);
});
