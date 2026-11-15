#!/usr/bin/env node
/**
 * macOS DMG 生产打包脚本（签名 + 公证由 electron-builder 完成）。
 *
 * 流程：
 *   1. esbuild 生产构建 → apps/desktop/dist/{electron-main.cjs,desktop-client.js}
 *   2. staging（apps/desktop/dist-release/app）：
 *      - dist/、assets/ 真实拷贝
 *      - @matrixai/quic 运行时闭包（ESM-only + 原生 .node）真实拷贝
 *        （pnpm node_modules 是符号链接，electron-builder 收集时必须解引用）
 *   3. electron-builder --mac（读取 electron-builder.yml：签名 + notarize + DMG）
 *
 * 凭据来源（本地开发时自动回落到 ~/.nienie-signing/，CI 用 secrets 注入环境变量）：
 *   CSC_LINK / CSC_KEY_PASSWORD              — Developer ID Application .p12
 *   APPLE_API_KEY / APPLE_API_KEY_ID /
 *   APPLE_API_ISSUER / APPLE_TEAM_ID         — App Store Connect API Key（公证）
 */
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktopDir = join(rootDir, 'apps/desktop');
const distDir = join(desktopDir, 'dist');
const releaseDir = join(desktopDir, 'dist-release');
const stageDir = join(releaseDir, 'app');

// ---------------------------------------------------------------------------
// 0. 参数与凭据
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const archArg = args.find((a) => a.startsWith('--arch='))?.slice('--arch='.length);
const skipNotarize = args.includes('--skip-notarize');

const signingDir = join(process.env.HOME ?? '~', '.nienie-signing');
function cred(envName, fileNames) {
  if (process.env[envName]) return process.env[envName];
  for (const f of fileNames) {
    const p = join(signingDir, f);
    if (existsSync(p)) return p;
  }
  return undefined;
}
function credText(envName, fileName) {
  if (process.env[envName]) return process.env[envName];
  const p = join(signingDir, fileName);
  return existsSync(p) ? readFileSyncSafe(p) : undefined;
}
function readFileSyncSafe(p) {
  return readFileSync(p, 'utf8').trim();
}

// ---------------------------------------------------------------------------
// 1. esbuild 生产构建
// ---------------------------------------------------------------------------
function findEsbuildBin() {
  const pnpmDir = join(rootDir, 'node_modules/.pnpm');
  const candidates = readdirSync(pnpmDir).filter((d) => d.startsWith('@esbuild+darwin-arm64@'));
  candidates.sort();
  for (const c of candidates.reverse()) {
    const bin = join(pnpmDir, c, 'node_modules/@esbuild/darwin-arm64/bin/esbuild');
    if (existsSync(bin)) return bin;
  }
  throw new Error('esbuild binary not found in node_modules/.pnpm');
}

const esbuildBin = findEsbuildBin();
// 与 scripts/start-mac.mjs 保持一致：@matrixai/* 是 ESM-only + 原生 .node 绑定，严禁内联
const quicExternals = [
  '--external:@matrixai/quic',
  '--external:@matrixai/quic-*',
  '--external:@matrixai/*',
];

console.log('[1/4] esbuild 生产构建 …');
mkdirSync(distDir, { recursive: true });
execFileSync(
  esbuildBin,
  [
    join(desktopDir, 'src/ui/client.tsx'),
    '--bundle',
    '--platform=browser',
    '--format=esm',
    '--target=es2022',
    '--define:process.env.NODE_ENV="production"',
    `--outfile=${join(distDir, 'desktop-client.js')}`,
  ],
  { cwd: rootDir, stdio: 'inherit' },
);
execFileSync(
  esbuildBin,
  [
    join(desktopDir, 'src/electron-main.ts'),
    '--bundle',
    '--platform=node',
    '--format=cjs',
    '--target=node22',
    '--external:electron',
    ...quicExternals,
    '--define:process.env.NODE_ENV="production"',
    // CJS 产物里 import.meta 为空对象是预期行为（bundleDir 用 __dirname），降噪
    '--log-override:empty-import-meta=debug',
    `--outfile=${join(distDir, 'electron-main.cjs')}`,
  ],
  { cwd: rootDir, stdio: 'inherit' },
);

// ---------------------------------------------------------------------------
// 2. staging：dist / assets / @matrixai 运行时闭包（解引用符号链接）
// ---------------------------------------------------------------------------
console.log('[2/4] 组装 staging 目录 …');
rmSync(releaseDir, { recursive: true, force: true });
mkdirSync(join(stageDir, 'dist'), { recursive: true });
mkdirSync(join(stageDir, 'node_modules'), { recursive: true });

cpSync(join(distDir, 'electron-main.cjs'), join(stageDir, 'dist/electron-main.cjs'));
cpSync(join(distDir, 'desktop-client.js'), join(stageDir, 'dist/desktop-client.js'));

const assetsSrc = join(desktopDir, 'assets');
mkdirSync(join(stageDir, 'assets'), { recursive: true });
cpSync(join(assetsSrc, 'nienie-logo.png'), join(stageDir, 'assets/nienie-logo.png'));
cpSync(join(assetsSrc, 'wechat-appreciate.jpg'), join(stageDir, 'assets/wechat-appreciate.jpg'));

// @matrixai/quic 闭包（pnpm 虚拟目录里的完整依赖树）
const pnpmDir = join(rootDir, 'node_modules/.pnpm');
const quicClosureDirs = readdirSync(pnpmDir).filter((d) => d.startsWith('@matrixai+quic@'));
if (quicClosureDirs.length === 0) throw new Error('@matrixai/quic closure not found in .pnpm');
const quicClosure = join(pnpmDir, quicClosureDirs[0], 'node_modules');
cpSync(quicClosure, join(stageDir, 'node_modules'), {
  recursive: true,
  dereference: true, // pnpm 符号链接 → 真实文件（原生 .node 必须实体存在）
  force: true,
});
// @matrixai/errors → ts-custom-error（pnpm 闭包外的传递依赖）
const tscDirs = readdirSync(pnpmDir).filter((d) => d.startsWith('ts-custom-error@'));
if (tscDirs.length > 0) {
  cpSync(
    join(pnpmDir, tscDirs[0], 'node_modules/ts-custom-error'),
    join(stageDir, 'node_modules/ts-custom-error'),
    { recursive: true, dereference: true, force: true },
  );
}

const desktopPkg = JSON.parse(
  readFileSync(join(desktopDir, 'package.json'), 'utf8'),
);
// electron-builder 需要精确版本号（semver range 会解析失败）
const electronPkgPath = join(desktopDir, 'node_modules/electron/package.json');
const electronVersion = existsSync(electronPkgPath)
  ? JSON.parse(readFileSync(electronPkgPath, 'utf8')).version
  : desktopPkg.devDependencies.electron;
console.log(`      electron ${electronVersion}`);
const stagedPkg = {
  name: 'nienie-desktop',
  productName: 'Nienie',
  version: desktopPkg.version,
  main: 'dist/electron-main.cjs',
  dependencies: {
    '@matrixai/quic': '^2.0.9',
  },
  devDependencies: {
    electron: electronVersion,
  },
};
writeFileSync(join(stageDir, 'package.json'), `${JSON.stringify(stagedPkg, null, 2)}\n`);

// ---------------------------------------------------------------------------
// 3. electron-builder：签名 + 公证 + DMG
// ---------------------------------------------------------------------------
console.log('[3/4] electron-builder 打包（签名 + 公证）…');
const env = {
  ...process.env,
  // 国内网络：electron 发行包走 npmmirror（CI 上同样可达）
  ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/',
  CSC_LINK: cred('CSC_LINK', ['nienie-developer-id.p12']),
  CSC_KEY_PASSWORD: credText('CSC_KEY_PASSWORD', 'p12-password.txt'),
  APPLE_API_KEY: cred('APPLE_API_KEY', ['AuthKey_8ZBV7KZM96.p8']),
  APPLE_API_KEY_ID: process.env.APPLE_API_KEY_ID || '8ZBV7KZM96',
  APPLE_API_ISSUER: credText('APPLE_API_ISSUER', 'issuer-id.txt'),
  APPLE_TEAM_ID: credText('APPLE_TEAM_ID', 'team-id.txt'),
};

const builderArgs = ['--mac', '--config', 'electron-builder.yml'];
if (archArg) builderArgs.push(`--${archArg}`);
if (skipNotarize) {
  builderArgs.push('-c.mac.notarize=false');
  delete env.APPLE_API_KEY;
}

execFileSync(join(rootDir, 'node_modules/.bin/electron-builder'), builderArgs, {
  cwd: desktopDir,
  env,
  stdio: 'inherit',
});

// ---------------------------------------------------------------------------
// 4. 完成
// ---------------------------------------------------------------------------
console.log('[4/4] 完成。产物：');
const outMac = join(releaseDir, 'out');
for (const f of readdirSync(outMac)) {
  if (f.endsWith('.dmg') || f.endsWith('.app')) {
    console.log(`  ${join(outMac, f)}`);
  }
}
