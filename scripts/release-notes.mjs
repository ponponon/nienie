#!/usr/bin/env node
/**
 * 生成 GitHub Release 说明，英文正文，结构对齐 ponponon/openctrlc 与 ponponon/aivplayer：
 *
 *   ## Features / ## Known Limitations   ← 手写，来自 docs/release-notes/<tag>.md
 *
 *   ## Downloads
 *
 *   ### macOS
 *
 *   - [Apple Silicon DMG](url) (137.2 MB)
 *
 *   ### Android
 *
 *   - [ARM64 APK](url) (14.7 MB)
 *
 *   **Full Changelog**: <compare-url>
 *
 * 用法：
 *   node scripts/release-notes.mjs --tag v0.1.0 [--dir release-assets] [--download-base <url>] [--out notes.md]
 *
 * --download-base 省略时用 GitHub Release 资产链接；传 R2 公共基址则改指向镜像。
 * 正文出现中日韩字符会直接失败（与 aivplayer 的 check-release-notes-language 同一条规则）。
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = 'ponponon/nienie';
const DEFAULT_R2_DOWNLOAD_BASE = 'https://nienie-releases.quniv.cn/nienie/releases';

// 中日韩统一表意文字 + 假名 + 谚文，用于拒绝非英文正文
const CJK_PATTERN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;

// ---------- 参数 ----------
function parseArgs(argv) {
  const out = { tag: '', dir: '', out: '', downloadBase: '', r2: false };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i += 1) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(rest[i]);
    if (!m) continue;
    const [, key, inlineValue] = m;
    if (key === 'r2') {
      out.r2 = true;
      continue;
    }
    // 同时支持 --tag=v0.1.0 与 --tag v0.1.0
    const value = inlineValue ?? rest[i + 1] ?? '';
    if (inlineValue === undefined && value && !value.startsWith('--')) i += 1;
    if (key === 'tag') out.tag = value;
    else if (key === 'dir') out.dir = value;
    else if (key === 'out') out.out = value;
    else if (key === 'download-base') out.downloadBase = value;
  }
  return out;
}

// ---------- 产物归类 ----------
// 返回 { platform, label, order }
function classify(fileName) {
  const lower = fileName.toLowerCase();

  if (lower.endsWith('.dmg') || (lower.endsWith('.zip') && lower.includes('mac'))) {
    const isZip = lower.endsWith('.zip');
    const label = lower.includes('arm64')
      ? `Apple Silicon ${isZip ? 'ZIP' : 'DMG'}`
      : lower.includes('x64')
        ? `Intel ${isZip ? 'ZIP' : 'DMG'}`
        : isZip
          ? 'ZIP'
          : 'DMG';
    return { platform: 'macOS', label, order: isZip ? 11 : 10 };
  }
  if (lower.endsWith('.exe')) {
    const label = lower.includes('arm64') ? 'ARM64 Installer' : 'x64 Installer';
    return { platform: 'Windows', label, order: 20 };
  }
  if (lower.endsWith('.deb') || lower.endsWith('.appimage') || lower.endsWith('.rpm')) {
    return { platform: 'Linux', label: fileName, order: 30 };
  }
  if (lower.endsWith('.apk')) {
    const label = lower.includes('arm64') || lower.includes('android') ? 'ARM64 APK' : 'APK';
    return { platform: 'Android', label, order: 40 };
  }
  // .aab / .sha256 / SHA256SUMS 等不进 Downloads：AAB 不供直接安装，校验和不是下载项
  return null;
}

// ---------- Downloads 区块 ----------
function renderDownloads(files, tag, downloadBase) {
  const githubBase = `https://github.com/${REPO}/releases/download/${tag}`;
  const version = tag.replace(/^v/, '');
  const base = downloadBase ? `${downloadBase.replace(/\/+$/, '')}/${version}` : githubBase;

  const platforms = new Map();
  for (const { name, size } of files) {
    const meta = classify(name);
    if (!meta) continue;
    if (!platforms.has(meta.platform)) platforms.set(meta.platform, { order: meta.order, items: [] });
    platforms.get(meta.platform).items.push({
      label: meta.label,
      order: meta.order,
      size,
      url: `${base}/${encodeURIComponent(name)}`,
    });
  }

  if (platforms.size === 0) return '';

  const lines = ['## Downloads', ''];
  for (const [platform, group] of [...platforms.entries()].sort((a, b) => a[1].order - b[1].order)) {
    lines.push(`### ${platform}`, '');
    const links = group.items
      .sort((a, b) => a.order - b.order)
      .map((item) => `[${item.label}](${item.url})${item.size ? ` (${formatSize(item.size)})` : ''}`);
    lines.push(`- ${links.join(' | ')}`, '');
  }
  return lines.join('\n').trimEnd();
}

// 用十进制 MB，和 GitHub 资产列表显示的口径一致（1 MB = 1000^2 B）
function formatSize(bytes) {
  const mb = bytes / 1_000_000;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${(bytes / 1000).toFixed(0)} KB`;
}

// ---------- Full Changelog ----------
function previousTag(current) {
  try {
    const tags = execFileSync('git', ['tag', '--sort=-v:refname'], { encoding: 'utf8' })
      .split('\n')
      .map((t) => t.trim())
      .filter(Boolean);
    return tags.find((t) => t !== current) ?? null;
  } catch {
    return null;
  }
}

function renderChangelog(tag) {
  const prev = previousTag(tag);
  const url = prev
    ? `https://github.com/${REPO}/compare/${prev}...${tag}`
    : `https://github.com/${REPO}/commits/${tag}`;
  return `**Full Changelog**: ${url}`;
}

// ---------- 产物来源 ----------
// 1) 已发布 Release 上的真实资产列表（权威，重跑单端也不会漏）
function fetchReleaseAssets(tag) {
  try {
    const raw = execFileSync('gh', ['api', `repos/${REPO}/releases/tags/${tag}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const data = JSON.parse(raw);
    return (data.assets ?? []).map((asset) => ({ name: asset.name, size: Number(asset.size) }));
  } catch {
    return [];
  }
}

// 2) 本地目录（离线渲染 / CI 里的构建产物）
function scanDir(dir) {
  const files = [];
  if (!dir || !existsSync(dir)) return files;
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push({ name: entry.name, size: statSync(full).size });
    }
  };
  walk(dir);
  return files;
}

// 合并去重：同名以本地为准（刚构建的体积最准）
function collectAssets(tag, dir) {
  const merged = new Map();
  for (const item of fetchReleaseAssets(tag)) merged.set(item.name, item);
  for (const item of scanDir(dir)) merged.set(item.name, item);
  return [...merged.values()];
}

// ---------- 主流程 ----------
const args = parseArgs(process.argv);

if (!args.tag) {
  console.error('missing --tag, e.g. --tag v0.1.0');
  process.exit(1);
}

// 1. 手写亮点（docs/release-notes/<tag>.md，随 tag 一起提交）
const headPath = join('docs', 'release-notes', `${args.tag}.md`);
const head = existsSync(headPath) ? readFileSync(headPath, 'utf8').trim() : '';

if (head && CJK_PATTERN.test(head)) {
  console.error(
    `release notes must be English only; found CJK characters in ${headPath}.\n` +
      'Move localized copy to README or the website instead of the GitHub Release body.',
  );
  process.exit(1);
}

// 2. 产物清单：Release 上已有的资产 ∪ 本次构建产物
const files = collectAssets(args.tag, args.dir);

const downloadBase = args.downloadBase || (args.r2 ? DEFAULT_R2_DOWNLOAD_BASE : '');
const sections = [head, renderDownloads(files, args.tag, downloadBase), renderChangelog(args.tag)].filter(Boolean);
const body = `${sections.join('\n\n')}\n`;

if (args.out) {
  writeFileSync(args.out, body, 'utf8');
  console.error(`wrote ${args.out} (${body.split('\n').length} lines)`);
} else {
  process.stdout.write(body);
}
