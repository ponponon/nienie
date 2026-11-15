#!/usr/bin/env node
/**
 * 把「最新的」GitHub Release 安装包镜像到 Cloudflare R2，供官网直接下载。
 *
 * 设计对齐 ponponon/openctrlc 的 script/publish-release-downloads.mjs：
 *   - R2 只保留当前版本，历史版本继续由 GitHub Release 提供（省存储费）
 *   - 每次同步后删除不属于当前版本的对象，并二次列目录确认删干净
 *   - 生成 download-manifest.json（retention = 1），官网/客户端据此解析下载地址
 *
 * 额外增加：latest/ 稳定别名。因为官网上的 APK 二维码是静态 SVG，
 * 版本化的 URL 一变二维码就失效；别名写死在最新一份字节上，二维码永久有效。
 *
 * 用法：
 *   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... \
 *     node scripts/publish-r2.mjs --repository ponponon/nienie
 *
 * 只同步 GitHub 上最新的正式 Release；--tag 与之不一致会直接报错，
 * 避免误把旧版本或草稿推到 R2。
 */

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const DEFAULT_R2_BUCKET = 'nienie-releases';
export const DEFAULT_R2_RELEASE_PREFIX = 'nienie/releases';
export const DEFAULT_R2_PUBLIC_BASE_URL = 'https://nienie-releases.quniv.cn/nienie/releases';
export const DOWNLOAD_MANIFEST_NAME = 'download-manifest.json';
// R2 的 REST 单次 PUT 上限 300 MB，超过就走 GitHub 直链
export const R2_REST_MAX_UPLOAD_BYTES = 300 * 1000 * 1000;

// 只镜像官网需要的安装包：DMG（macOS）与 APK（Android）。
// .aab 是上架 Google Play 用的，不能直接安装，镜像过来只是白花存储。
const MIRRORED_EXTENSIONS = ['.dmg', '.apk'];

// latest/ 别名：文件名固定，内容永远是最新一份，二维码与永久链接指向它
const LATEST_ALIASES = [
  { pattern: /\.dmg$/i, alias: 'Nienie-mac-arm64.dmg' },
  { pattern: /\.apk$/i, alias: 'Nienie-android.apk' },
];

const CLOUDFLARE_API_BASE_URL = 'https://api.cloudflare.com/client/v4';
const GITHUB_API_BASE_URL = 'https://api.github.com';

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, '');
}

function normalizeVersion(tag) {
  const version = String(tag ?? '').replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid release tag: ${tag}`);
  }
  return version;
}

function encodePath(value) {
  return value.split('/').map((part) => encodeURIComponent(part)).join('/');
}

function githubHeaders(token) {
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function readJsonResponse(response, label) {
  const body = await response.text();
  let payload;
  try {
    payload = body ? JSON.parse(body) : undefined;
  } catch {
    throw new Error(`${label} returned invalid JSON (${response.status})`);
  }
  if (!response.ok || payload?.success === false) {
    const errors = payload?.errors?.map((item) => item.message).filter(Boolean).join('; ');
    throw new Error(`${label} failed (${response.status}): ${errors || body.slice(0, 300)}`);
  }
  return payload;
}

function r2ObjectUrl({ accountId, bucket, key }) {
  return `${CLOUDFLARE_API_BASE_URL}/accounts/${encodeURIComponent(accountId)}/r2/buckets/${encodeURIComponent(bucket)}/objects/${encodePath(key)}`;
}

function r2BucketUrl({ accountId, bucket }) {
  return `${CLOUDFLARE_API_BASE_URL}/accounts/${encodeURIComponent(accountId)}/r2/buckets/${encodeURIComponent(bucket)}`;
}

function r2ListUrl({ accountId, bucket, prefix, cursor }) {
  const params = new URLSearchParams({ prefix, per_page: '1000' });
  if (cursor) params.set('cursor', cursor);
  return `${CLOUDFLARE_API_BASE_URL}/accounts/${encodeURIComponent(accountId)}/r2/buckets/${encodeURIComponent(bucket)}/objects?${params}`;
}

// ---------- GitHub 侧 ----------
async function fetchLatestRelease({ repository, githubToken, tag }) {
  const endpoint = tag
    ? `${GITHUB_API_BASE_URL}/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`
    : `${GITHUB_API_BASE_URL}/repos/${repository}/releases/latest`;
  const response = await fetch(endpoint, { headers: githubHeaders(githubToken) });
  const payload = await readJsonResponse(response, tag ? `GitHub release ${tag}` : 'Latest GitHub release');
  if (payload.draft || payload.prerelease) {
    throw new Error(`Release ${payload.tag_name} is ${payload.draft ? 'a draft' : 'a prerelease'}; refusing to mirror it.`);
  }
  return payload;
}

async function fetchLatestPublishedTag({ repository, githubToken }) {
  const response = await fetch(`${GITHUB_API_BASE_URL}/repos/${repository}/releases/latest`, {
    headers: githubHeaders(githubToken),
  });
  const payload = await readJsonResponse(response, 'Latest GitHub release');
  return payload.tag_name;
}

function selectMirroredAssets(release) {
  const assets = (release.assets ?? []).filter((asset) => {
    const lower = String(asset.name ?? '').toLowerCase();
    return MIRRORED_EXTENSIONS.some((extension) => lower.endsWith(extension));
  });
  if (assets.length === 0) throw new Error(`No ${MIRRORED_EXTENSIONS.join('/')} assets on ${release.tag_name}.`);
  return assets;
}

async function downloadAsset(asset, destination, githubToken) {
  const response = await fetch(asset.browser_download_url, {
    headers: githubToken && new URL(asset.browser_download_url).hostname.endsWith('github.com')
      ? { Authorization: `Bearer ${githubToken}` }
      : undefined,
    redirect: 'follow',
  });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed (${response.status}) for ${asset.name}`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(destination)) hash.update(chunk);
  return hash.digest('hex');
}

// ---------- R2 侧 ----------
async function ensureBucket({ accountId, bucket, token }) {
  const response = await fetch(r2BucketUrl({ accountId, bucket }), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (response.ok) return;
  if (response.status !== 404) await readJsonResponse(response, `Cloudflare R2 head bucket ${bucket}`);
  const created = await fetch(`${CLOUDFLARE_API_BASE_URL}/accounts/${encodeURIComponent(accountId)}/r2/buckets`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: bucket }),
  });
  await readJsonResponse(created, `Cloudflare R2 create bucket ${bucket}`);
  console.log(`Created R2 bucket: ${bucket}`);
}

// 官网会用 HEAD 探测下载地址是否就绪，跨域读需要 R2 返回 CORS 头，
// 否则探测永远失败、官网只能一直回退到 GitHub。只放开只读方法。
async function ensureCors({ accountId, bucket, token }) {
  const response = await fetch(
    `${CLOUDFLARE_API_BASE_URL}/accounts/${encodeURIComponent(accountId)}/r2/buckets/${encodeURIComponent(bucket)}/cors`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rules: [
          {
            allowed: { origins: ['*'], methods: ['GET', 'HEAD'] },
            exposeHeaders: ['Content-Length', 'Content-Type', 'ETag'],
            maxAgeSeconds: 3600,
          },
        ],
      }),
    },
  );
  if (!response.ok) {
    // 不因为 CORS 失败而中断发布：资产已经传上去了，这里只是优化项
    console.warn(`R2 CORS setup skipped (${response.status}); 官网探测会自动回退到 GitHub。`);
    return;
  }
  console.log(`Applied read-only CORS policy to ${bucket}`);
}

async function listR2Objects({ accountId, bucket, prefix, token }) {  const objects = [];
  let cursor;
  do {
    const response = await fetch(r2ListUrl({ accountId, bucket, prefix, cursor }), {
      headers: { Authorization: `Bearer ${token}` },
    });
    const payload = await readJsonResponse(response, `Cloudflare R2 list ${prefix}`);
    if (!Array.isArray(payload.result)) {
      throw new Error(`Cloudflare R2 list ${prefix} returned an unexpected object list`);
    }
    objects.push(...payload.result);
    cursor = payload.result_info?.cursor || undefined;
  } while (cursor);
  return objects;
}

async function deleteR2Object({ accountId, bucket, key, token }) {
  const response = await fetch(r2ObjectUrl({ accountId, bucket, key }), {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  await readJsonResponse(response, `Cloudflare R2 delete ${key}`);
}

function assetContentType(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith('.dmg')) return 'application/x-apple-diskimage';
  if (lower.endsWith('.apk')) return 'application/vnd.android.package-archive';
  return 'application/octet-stream';
}

async function uploadR2File({ accountId, bucket, key, filePath, token, cacheControl, contentDisposition }) {
  const fileStat = await stat(filePath);
  const response = await fetch(r2ObjectUrl({ accountId, bucket, key }), {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Cache-Control': cacheControl,
      'Content-Disposition': contentDisposition,
      'Content-Length': String(fileStat.size),
      'Content-Type': assetContentType(key),
    },
    body: createReadStream(filePath),
    duplex: 'half',
  });
  await readJsonResponse(response, `Cloudflare R2 upload ${key}`);
}

async function uploadR2Json({ accountId, bucket, key, value, token, cacheControl }) {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  const response = await fetch(r2ObjectUrl({ accountId, bucket, key }), {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Cache-Control': cacheControl,
      'Content-Disposition': 'inline',
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(Buffer.byteLength(body)),
    },
    body,
  });
  await readJsonResponse(response, `Cloudflare R2 upload ${key}`);
}

function publicObjectUrl(baseUrl, key, releasePrefix, aliasKey) {
  if (aliasKey) return `${trimTrailingSlash(baseUrl)}/${encodePath(aliasKey.replace(`${releasePrefix}/`, ''))}`;
  return `${trimTrailingSlash(baseUrl)}/${encodePath(key.replace(`${releasePrefix}/`, ''))}`;
}

// ---------- 参数 ----------
function parseOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) continue;
    if (argument === '--tag') options.tag = value;
    if (argument === '--repository') options.repository = value;
    if (argument === '--bucket') options.bucket = value;
    if (argument === '--release-prefix') options.releasePrefix = value;
    if (argument === '--public-base-url') options.publicBaseUrl = value;
    index += 1;
  }
  return options;
}

// ---------- 主流程 ----------
export async function publishReleaseDownloads(options = {}) {
  const tag = options.tag ?? process.env.RELEASE_TAG;
  const repository = options.repository ?? process.env.GITHUB_REPOSITORY;
  const accountId = options.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = options.token ?? process.env.CLOUDFLARE_API_TOKEN;
  const githubToken = options.githubToken ?? process.env.GITHUB_TOKEN;
  const bucket = options.bucket ?? process.env.R2_BUCKET ?? DEFAULT_R2_BUCKET;
  const releasePrefix = options.releasePrefix ?? process.env.R2_RELEASE_PREFIX ?? DEFAULT_R2_RELEASE_PREFIX;
  const publicBaseUrl = options.publicBaseUrl ?? process.env.R2_PUBLIC_BASE_URL ?? DEFAULT_R2_PUBLIC_BASE_URL;

  if (!repository || !/^[^/]+\/[^/]+$/.test(repository)) {
    throw new Error('GITHUB_REPOSITORY or --repository must be owner/name');
  }
  if (!accountId || !token) throw new Error('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required');

  const release = await fetchLatestRelease({ repository, githubToken, tag });
  const version = normalizeVersion(release.tag_name);
  if (tag && tag !== release.tag_name) {
    throw new Error(`Requested tag ${tag} does not match release ${release.tag_name}`);
  }

  // R2 只放最新版本，所以明确拒绝非最新 tag
  const latestTag = await fetchLatestPublishedTag({ repository, githubToken });
  if (latestTag !== release.tag_name) {
    throw new Error(
      `Only the latest GitHub release can live in R2; latest is ${latestTag}, requested ${release.tag_name}.`,
    );
  }

  const assets = selectMirroredAssets(release);
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'nienie-releases-'));
  const releaseRoot = `${releasePrefix}/${version}`;
  const latestRoot = `${releasePrefix}/latest`;

  try {
    await ensureBucket({ accountId, bucket, token });
    await ensureCors({ accountId, bucket, token }).catch((error) => {
      console.warn(`R2 CORS setup failed: ${error instanceof Error ? error.message : error}`);
    });

    const publishedAssets = {};
    const uploadedPaths = [];

    for (const asset of assets) {
      const metadata = {
        name: asset.name,
        sizeBytes: asset.size,
        sha256: String(asset.digest ?? '').replace(/^sha256:/, '') || undefined,
        url: publicObjectUrl(publicBaseUrl, `${releaseRoot}/${asset.name}`, releasePrefix),
      };

      if (asset.size > R2_REST_MAX_UPLOAD_BYTES) {
        metadata.url = asset.browser_download_url;
        publishedAssets[asset.name] = metadata;
        console.log(`Using GitHub fallback for oversized asset: ${asset.name}`);
        continue;
      }

      const filePath = join(temporaryDirectory, basename(asset.name));
      const sha256 = await downloadAsset(asset, filePath, githubToken);
      if (asset.digest && sha256 !== String(asset.digest).replace(/^sha256:/, '')) {
        throw new Error(`SHA-256 mismatch for ${asset.name}`);
      }
      metadata.sha256 = sha256;

      const versionedKey = `${releaseRoot}/${asset.name}`;
      await uploadR2File({
        accountId,
        bucket,
        key: versionedKey,
        filePath,
        token,
        cacheControl: 'public, max-age=31536000, immutable',
        contentDisposition: `attachment; filename="${asset.name.replaceAll('"', '')}"`,
      });
      uploadedPaths.push(versionedKey);
      console.log(`Published ${release.tag_name}: ${versionedKey}`);

      // 稳定别名：文件名固定，内容跟着最新版走，缓存时间压到 5 分钟
      const alias = LATEST_ALIASES.find((item) => item.pattern.test(asset.name));
      if (alias) {
        const aliasKey = `${latestRoot}/${alias.alias}`;
        await uploadR2File({
          accountId,
          bucket,
          key: aliasKey,
          filePath,
          token,
          cacheControl: 'public, max-age=300, must-revalidate',
          contentDisposition: `attachment; filename="${alias.alias}"`,
        });
        uploadedPaths.push(aliasKey);
        metadata.latestUrl = publicObjectUrl(publicBaseUrl, aliasKey, releasePrefix);
        console.log(`Published ${release.tag_name}: ${aliasKey} (stable alias)`);
      }

      publishedAssets[asset.name] = metadata;
    }

    const manifestKey = `${releasePrefix}/${DOWNLOAD_MANIFEST_NAME}`;
    const releases = [
      {
        tag: release.tag_name,
        version,
        githubUrl: release.html_url,
        publishedAt: release.published_at,
        assets: publishedAssets,
      },
    ];
    const manifest = {
      schemaVersion: 1,
      repository,
      generatedAt: new Date().toISOString(),
      retention: 1,
      releases,
    };
    await uploadR2Json({
      accountId,
      bucket,
      key: manifestKey,
      value: manifest,
      token,
      cacheControl: 'public, max-age=300, must-revalidate',
    });

    // 清理：只保留本次上传的对象 + manifest，历史版本一律删掉
    const keepKeys = new Set([...uploadedPaths, manifestKey]);
    const objects = await listR2Objects({ accountId, bucket, prefix: `${releasePrefix}/`, token });
    const obsoleteKeys = objects.map((object) => object.key).filter((key) => !keepKeys.has(key));
    await Promise.all(obsoleteKeys.map((key) => deleteR2Object({ accountId, bucket, key, token })));

    const remaining = await listR2Objects({ accountId, bucket, prefix: `${releasePrefix}/`, token });
    const remainingObsolete = remaining.map((object) => object.key).filter((key) => !keepKeys.has(key));
    if (remainingObsolete.length) {
      throw new Error(
        `R2 cleanup left ${remainingObsolete.length} obsolete object(s): ${remainingObsolete.slice(0, 5).join(', ')}`,
      );
    }

    console.log(`Removed ${obsoleteKeys.length} obsolete R2 object(s)`);
    console.log(`Published ${releases.length} release(s) to ${trimTrailingSlash(publicBaseUrl)}`);
    return manifest;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parseOptions(process.argv.slice(2));
  publishReleaseDownloads(options).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
