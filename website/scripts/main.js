import { applyI18n } from './i18n.js';

// Capture original Chinese text so the "zh" option can restore it
function snapshotChinese() {
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    if (!el.hasAttribute('data-i18n-zh')) {
      el.setAttribute('data-i18n-zh', el.textContent);
    }
  });
}

// Copy CLI quickstart command
function wireCopyButton() {
  const btn = document.getElementById('btn-copy-cli');
  const code = document.getElementById('cli-cmd-text');
  if (!btn || !code) return;
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(code.textContent.trim());
    } catch {
      // Clipboard may be unavailable on non-secure origins
    }
    const prev = btn.textContent;
    btn.textContent = '✓ ' + (document.documentElement.lang === 'zh-CN' ? '已复制' : 'Copied');
    setTimeout(() => {
      btn.textContent = prev;
    }, 1600);
  });
}

// Language switcher
function wireLanguageSwitcher() {
  const select = document.getElementById('lang-switcher');
  if (!select) return;
  select.addEventListener('change', (ev) => {
    applyI18n(ev.target.value);
    try {
      localStorage.setItem('nienie-lang', ev.target.value);
    } catch {
      // ignore
    }
  });
  try {
    const saved = localStorage.getItem('nienie-lang');
    if (saved) {
      select.value = saved;
      applyI18n(saved);
    }
  } catch {
    // ignore
  }
}

// 下载地址指向 R2 的 latest/ 稳定别名。镜像还没就绪（或 R2 未配置 CORS）时，
// 退回 GitHub Release 页——宁可多一次跳转，也不给用户一个 404。
const GITHUB_LATEST_RELEASE = 'https://github.com/ponponon/nienie/releases/latest';
const DOWNLOAD_MANIFEST_URL = 'https://nienie-releases.quniv.cn/nienie/releases/download-manifest.json';

// 版本号与体积跟着清单走，避免每次发版都得手改 HTML
async function syncDownloadMeta() {
  const targets = [...document.querySelectorAll('[data-download-meta]')];
  if (!targets.length) return;

  const manifest = await fetch(DOWNLOAD_MANIFEST_URL, { cache: 'no-store' })
    .then((response) => (response.ok ? response.json() : undefined))
    .catch(() => undefined);

  const release = manifest?.releases?.[0];
  const assets = release?.assets;
  if (!release || !assets || typeof assets !== 'object') return;

  const pick = (extension) =>
    Object.values(assets).find((asset) => typeof asset?.name === 'string' && asset.name.endsWith(extension));

  for (const target of targets) {
    const asset = pick(target.dataset.downloadMeta === 'apk' ? '.apk' : '.dmg');
    if (!asset?.name || typeof asset.sizeBytes !== 'number') continue;
    target.textContent = `${asset.name} · ${(asset.sizeBytes / 1_000_000).toFixed(1)} MB`;
  }
}

async function resolveDownloadMirror() {
  const links = [...document.querySelectorAll('a[data-download]')];
  if (!links.length) return;

  const reachable = new Map();
  const probe = (url) => {
    if (!reachable.has(url)) {
      reachable.set(
        url,
        fetch(url, { method: 'HEAD', cache: 'no-store' })
          .then((response) => response.ok)
          .catch(() => false),
      );
    }
    return reachable.get(url);
  };

  await Promise.all(
    links.map(async (link) => {
      const url = link.getAttribute('href');
      if (!url) return;
      if (await probe(url)) return;
      link.setAttribute('href', GITHUB_LATEST_RELEASE);
      link.removeAttribute('download');
      link.dataset.mirror = 'github-fallback';
    }),
  );
}

document.addEventListener('DOMContentLoaded', () => {
  snapshotChinese();
  wireCopyButton();
  wireLanguageSwitcher();
  void resolveDownloadMirror();
  void syncDownloadMeta();
});
