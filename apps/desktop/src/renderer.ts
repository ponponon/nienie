import React from 'react';
import { renderToString } from 'react-dom/server';
import type { DesktopDashboardState } from './controller.js';
import { DESKTOP_I18N, type DesktopLocale } from './i18n.js';
import { DesktopApp } from './ui/DesktopApp.js';
import { DESKTOP_MODERN_CSS } from './ui/styles.js';

export type { DesktopLocale } from './i18n.js';

export type RenderDesktopOptions = {
  locale?: DesktopLocale | undefined;
};

export function renderDesktopAppHtml(
  state: DesktopDashboardState,
  options: RenderDesktopOptions = {},
): string {
  const locale: DesktopLocale = options.locale ?? state.locale ?? 'zh';
  const t = DESKTOP_I18N[locale] ?? DESKTOP_I18N.zh;
  const effectiveState: DesktopDashboardState = {
    ...state,
    locale,
  };

  const ssrMarkup = renderToString(
    React.createElement(DesktopApp, {
      initialState: effectiveState,
      initialLocale: locale,
    }),
  );

  const serializedState = JSON.stringify(effectiveState).replaceAll('<', '\\u003c');

  return `<!DOCTYPE html>
<html lang="${locale === 'zh' ? 'zh-CN' : locale}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:;" />
  <title>${escapeHtml(t.appTitle)}</title>
  <style>${DESKTOP_MODERN_CSS}</style>
</head>
<body>
  <div id="nienie-app-root">${ssrMarkup}</div>
  <script>
    window.__NIENIE_INITIAL_STATE__ = ${serializedState};
    if (!window.nienieDesktop) {
      window.nienieDesktop = undefined;
    }
  </script>
  <script type="module" src="/assets/desktop-client.js"></script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
