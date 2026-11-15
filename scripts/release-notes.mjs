#!/usr/bin/env node
/**
 * 生成 GitHub Release 说明，格式对齐 ponponon/openctrlc：
 *
 *   <手写亮点，来自 docs/release-notes/<tag>.md>
 *
 *   ## Downloads
 *
 *   ### Desktop
 *
 *   #### macOS
 *
 *   - [Apple Silicon DMG](url) | [Apple Silicon ZIP](url)
 *
 *   ### Android
 *
 *   - [ARM64 APK](url)
 *
 *   ## Full Changelog
 *
 *   [Compare changes](compare-url)
 *
 * 用法：
 *   node scripts/release-notes.mjs --tag v0.1.0 --dir release-assets [--out notes.md]
 *
 * --dir 里的文件按扩展名归组；若目录里没有某平台的产物，该分组整段省略。
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = 'ponponon/nienie';

// ---------- 参数 ----------
function parseArgs(argv) {
  const out = { tag: '', dir: '', out: '' };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i += 1) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(rest[i]);
    if (!m) continue;
    const [, key, inlineValue] = m;
    // 同时支持 --tag=v0.1.0 与 --tag v0.1.0
    const value = inlineValue ?? rest[i + 1] ?? '';
    if (inlineValue === undefined && value && !value.startsWith('--')) i += 1;
    if (key === 'tag') out.tag = value;
    else if (key === 'dir') out.dir = value;
    else if (key === 'out') out.out = value;
  }
  return out;
}

// ---------- 产物归类 ----------
// 返回 { groupKey, groupTitle, platformTitle, label, order }
function classify(fileName) {
  const lower = fileName.toLowerCase();

  if (lower.endsWith('.dmg')) {
    const label = lower.includes('arm64')
      ? 'Apple Silicon DMG'
      : lower.includes('x64')
        ? 'Intel DMG'
        : 'DMG';
    return { group: 'desktop', groupTitle: 'Desktop', platform: 'macOS', label, order: 10 };
  }
  if (lower.endsWith('.zip') && lower.includes('mac')) {
    const label = lower.includes('arm64')
      ? 'Apple Silicon ZIP'
      : lower.includes('x64')
        ? 'Intel ZIP'
        : 'ZIP';
    return { group: 'desktop', groupTitle: 'Desktop', platform: 'macOS', label, order: 11 };
  }
  if (lower.endsWith('.exe')) {
    return { group: 'desktop', groupTitle: 'Desktop', platform: 'Windows', label: 'Installer', order: 12 };
  }
  if (lower.endsWith('.appimage')) {
    return { group: 'desktop', groupTitle: 'Desktop', platform: 'Linux', label: 'AppImage', order: 13 };
  }
  if (lower.endsWith('.deb')) {
    return { group: 'desktop', groupTitle: 'Desktop', platform: 'Linux', label: 'DEB', order: 14 };
  }
  if (lower.endsWith('.apk')) {
    const label = lower.includes('arm64') || lower.includes('android') ? 'ARM64 APK' : 'APK';
    return { group: 'android', groupTitle: 'Android', platform: null, label, order: 20 };
  }
  if (lower.endsWith('.aab')) {
    return { group: 'android', groupTitle: 'Android', platform: null, label: 'AAB', order: 21 };
  }
  // 校验和等辅助文件不进 Downloads
  return null;
}

// ---------- Downloads 区块 ----------
function renderDownloads(files, tag) {
  const base = `https://github.com/${REPO}/releases/download/${tag}`;
  const groups = new Map();

  for (const { name, size } of files) {
    const meta = classify(name);
    if (!meta) continue;
    const groupKey = meta.group;
    if (!groups.has(groupKey)) {
      groups.set(groupKey, { title: meta.groupTitle, order: meta.order, platforms: new Map() });
    }
    const group = groups.get(groupKey);
    const platformKey = meta.platform ?? '';
    if (!group.platforms.has(platformKey)) {
      group.platforms.set(platformKey, { title: meta.platform, order: meta.order, items: [] });
    }
    group.platforms.get(platformKey).items.push({
      label: meta.label,
      order: meta.order,
      size,
      url: `${base}/${encodeURIComponent(name)}`,
    });
  }

  if (groups.size === 0) return '';

  const lines = ['## Downloads', ''];

  for (const group of [...groups.values()].sort((a, b) => a.order - b.order)) {
    lines.push(`### ${group.title}`, '');
    for (const platform of [...group.platforms.values()].sort((a, b) => a.order - b.order)) {
      if (platform.title) lines.push(`#### ${platform.title}`, '');
      const links = platform.items
        .sort((a, b) => a.order - b.order)
        .map((item) => {
          const size = item.size ? ` (${formatSize(item.size)})` : '';
          return `[${item.label}](${item.url})${size}`;
        });
      lines.push(`- ${links.join(' | ')}`, '');
    }
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
  return ['## Full Changelog', '', `[Compare changes](${url})`].join('\n');
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
  console.error('缺少 --tag，例如 --tag v0.1.0');
  process.exit(1);
}

// 1. 手写亮点（docs/release-notes/<tag>.md，随 tag 一起提交）
const headPath = join('docs', 'release-notes', `${args.tag}.md`);
const head = existsSync(headPath) ? readFileSync(headPath, 'utf8').trim() : '';

// 2. 产物清单：Release 上已有的资产 ∪ 本次构建产物
const files = collectAssets(args.tag, args.dir);

const sections = [head, renderDownloads(files, args.tag), renderChangelog(args.tag)].filter(Boolean);
const body = `${sections.join('\n\n')}\n`;

if (args.out) {
  writeFileSync(args.out, body, 'utf8');
  console.error(`已写入 ${args.out}（${body.split('\n').length} 行）`);
} else {
  process.stdout.write(body);
}
