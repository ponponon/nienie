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

document.addEventListener('DOMContentLoaded', () => {
  snapshotChinese();
  wireCopyButton();
  wireLanguageSwitcher();
});
