import { execFileSync, spawn } from 'node:child_process';
import { watch } from 'node:fs';
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

const rendererEntry = resolve(rootDir, 'apps/desktop/src/renderer.ts');
const rendererLiveOut = resolve(rootDir, 'apps/desktop/dist/renderer-live.mjs');
const clientEntry = resolve(rootDir, 'apps/desktop/src/ui/client.tsx');
const clientBundleOut = resolve(rootDir, 'apps/desktop/dist/desktop-client.js');

const esmRequireBanner =
  "--banner:js=import { createRequire as __nienieCreateRequire } from 'node:module'; const require = __nienieCreateRequire(import.meta.url);";

// @matrixai/quic 是 ESM-only + 原生 .node 绑定（按 import.meta.url 定位），严禁打包进 bundle。
const quicExternals = [
  '--external:@matrixai/quic',
  '--external:@matrixai/quic-*',
  '--external:@matrixai/*',
];

function bundleLiveRenderer() {
  execFileSync(
    esbuildBin,
    [
      clientEntry,
      '--bundle',
      '--platform=browser',
      '--format=esm',
      '--target=es2022',
      '--define:process.env.NODE_ENV="production"',
      `--outfile=${clientBundleOut}`,
      '--log-level=silent',
    ],
    { cwd: rootDir, stdio: 'ignore' },
  );
  execFileSync(
    esbuildBin,
    [
      rendererEntry,
      '--bundle',
      '--platform=node',
      '--format=esm',
      '--target=node22',
      esmRequireBanner,
      ...quicExternals,
      `--outfile=${rendererLiveOut}`,
      '--log-level=silent',
    ],
    { cwd: rootDir, stdio: 'ignore' },
  );
}

if (isSmokeOrHeadless) {
  bundleLiveRenderer();
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
      esmRequireBanner,
      ...quicExternals,
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

  bundleLiveRenderer();

  execFileSync(
    esbuildBin,
    [
      entryFile,
      '--bundle',
      '--platform=node',
      '--format=cjs',
      '--target=node22',
      '--external:electron',
      ...quicExternals,
      `--outfile=${outFile}`,
    ],
    { cwd: rootDir, stdio: 'inherit' },
  );

  const srcDir = resolve(rootDir, 'apps/desktop/src');
  let debounceTimer;
  const watcher = watch(srcDir, { recursive: true }, (_eventType, filename) => {
    if (!filename || (!filename.endsWith('.ts') && !filename.endsWith('.tsx'))) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      try {
        bundleLiveRenderer();
        process.stdout.write(`[Hot Reload] Rebuilt UI from ${filename}\n`);
      } catch (err) {
        process.stderr.write(`[Hot Reload] Build error: ${err.message}\n`);
      }
    }, 60);
  });

  const requireFromDesktop = createRequire(resolve(rootDir, 'apps/desktop/package.json'));
  const electronBinary = requireFromDesktop('electron');

  const child = spawn(String(electronBinary), [outFile, ...process.argv.slice(2)], {
    cwd: rootDir,
    stdio: 'inherit',
  });
  child.on('exit', (code) => {
    watcher.close();
    process.exit(code ?? 0);
  });
}
