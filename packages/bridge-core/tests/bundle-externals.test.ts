/**
 * 打包约束守卫测试（Bundle Externals Guard）—— 防止「原生 / ESM-only 模块被 esbuild 打包」类回归。
 *
 * 背景（2026-11-08 事故）：`@matrixai/quic` 是 ESM-only + 依赖自身 `prebuild/*.node` 原生绑定
 * （按 `import.meta.url` 相对定位）。esbuild 把它打包进 CJS 的 `electron-main.cjs` 后，
 * `import.meta.url` 变成 `var import_meta = {}`，导致 `createRequire(import_meta.url)` → `createRequire(undefined)`
 * → `pnpm start` 启动即崩（TypeError: The argument 'filename' must be ... Received undefined）。
 *
 * 约束（必须同时满足，缺一即回归）：
 *  1. esbuild 打包 Node 产物时，必须用 `--external:` 把 ESM-only / 原生模块标为外部（不内联）。
 *  2. 源码中引用此类包时，必须用 `import type`（编译期擦除）+ 运行时动态 `import()` 懒加载，
 *     严禁静态 `import { X } from '...'`（会被 esbuild 静态内联）。
 *
 * 本测试从配置层 + 源码层双重锁定，防止未来加原生/ESM-only 依赖时重蹈覆辙。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const testsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testsDir, '../../..');

/** 已知「ESM-only / 原生」不可内联打包的包（正则前缀）。可扩展。 */
const EXTERNALIZED_PACKAGES = ['@matrixai/'] as const;

function readRepoFile(rel: string): string {
  return readFileSync(resolve(repoRoot, rel), 'utf8');
}

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith('.ts') || full.endsWith('.tsx')) out.push(full);
    }
  };
  walk(resolve(repoRoot, dir));
  return out;
}

describe('打包约束守卫（原生 / ESM-only 模块严禁内联）', () => {
  it('scripts/start-mac.mjs 必须对 Node 打包命令 externalize 原生/ESM-only 包', () => {
    const script = readRepoFile('scripts/start-mac.mjs');
    for (const pkg of EXTERNALIZED_PACKAGES) {
      expect(script, `start-mac.mjs 缺少 --external:${pkg}* 打包约束`).toContain(
        `--external:${pkg}`,
      );
    }
  });

  it('quic-p2p.ts 必须用 import type + 动态 import() 懒加载 @matrixai/quic（禁止静态运行时导入）', () => {
    const src = readRepoFile('packages/bridge-core/src/quic-p2p.ts');

    // 1. 必须有 import type（编译期擦除，不进 bundle）
    expect(src).toMatch(/import\s+type\s+[^;]*from\s+['"]@matrixai\/quic['"]/);

    // 2. 必须有运行时动态 import() 懒加载
    expect(src).toMatch(/await\s+import\(\s*['"]@matrixai\/quic['"]\s*\)/);

    // 3. 严禁静态运行时导入（`import { ... } from` / `import X from` / `import * as X from`），
    //    但允许 `import type`。用正则剥离 import type 后再检测。
    const withoutTypeImports = src.replace(
      /import\s+type\s+[^;]*from\s+['"][^'"]+['"];?/g,
      '',
    );
    const staticRuntimeImport = withoutTypeImports.match(
      /import\s+(?:\{[^}]*\}|[\w*]+)\s+from\s+['"]@matrixai\//,
    );
    expect(
      staticRuntimeImport,
      'quic-p2p.ts 存在 @matrixai/* 的静态运行时导入，会被 esbuild 内联导致 CJS 崩溃',
    ).toBeNull();
  });

  it('bridge-core 源码不得对已 externalize 的包做静态运行时导入（统一走懒加载）', () => {
    const offenders: string[] = [];
    for (const file of listSourceFiles('packages/bridge-core/src')) {
      const src = readFileSync(file, 'utf8');
      // 剥离 import type 后检测静态运行时导入
      const withoutTypeImports = src.replace(
        /import\s+type\s+[^;]*from\s+['"][^'"]+['"];?/g,
        '',
      );
      for (const pkg of EXTERNALIZED_PACKAGES) {
        const staticImport = withoutTypeImports.match(
          new RegExp(`import\\s+(?:\\{[^}]*\\}|[\\w*]+)\\s+from\\s+['"]${pkg.replace(/[/\\]/g, '\\/')}`),
        );
        if (staticImport) {
          offenders.push(`${file}: ${staticImport[0]}`);
        }
      }
    }
    expect(
      offenders,
      '存在对已 externalize 包的静态运行时导入（应改用 import type + 动态 import 懒加载）',
    ).toEqual([]);
  });
});
