import type { DesktopDashboardState } from './controller.js';

export type DesktopLocale = 'zh' | 'en' | 'ja' | 'ko';

export type RenderDesktopOptions = {
  locale?: DesktopLocale | undefined;
};

const DESKTOP_I18N: Record<
  DesktopLocale,
  {
    appTitle: string;
    localBridge: string;
    startBridge: string;
    stopBridge: string;
    localAgents: string;
    detect: string;
    mobilePairing: string;
    newCode: string;
    pairingCodeLabel: string;
    expiresPrefix: string;
    pairingUriLabel: string;
    machineLabel: string;
    endpointLabel: string;
    connectedDevicesLabel: string;
    detectedBadge: string;
    unavailableBadge: string;
    publicRelay: string;
    defaultRelayLabel: string;
    activeRelayLabel: string;
    useCustomRelay: string;
    useDefaultRelay: string;
    diagnosticLogs: string;
    running: string;
    stopped: string;
    error: string;
    revokeBtn: string;
    revokedBadge: string;
  }
> = {
  zh: {
    appTitle: 'Nienie Bridge 控制台',
    localBridge: '本地 Bridge',
    startBridge: '启动服务',
    stopBridge: '停止服务',
    localAgents: '本机 Agents',
    detect: '重新探测',
    mobilePairing: '手机扫码配对',
    newCode: '刷新配对码',
    pairingCodeLabel: '一次性配对码 (手机输入)',
    expiresPrefix: '有效期至',
    pairingUriLabel: '配对链接',
    machineLabel: '本机标识',
    endpointLabel: '监听地址',
    connectedDevicesLabel: '已连手机',
    detectedBadge: '可用',
    unavailableBadge: '未安装',
    publicRelay: '公网 Relay',
    defaultRelayLabel: '默认地址',
    activeRelayLabel: '当前生效',
    useCustomRelay: '应用自定义',
    useDefaultRelay: '恢复默认',
    diagnosticLogs: '运行日志 (次要信息)',
    running: '运行中',
    stopped: '已停止',
    error: '异常',
    revokeBtn: '移除',
    revokedBadge: '已撤销',
  },
  en: {
    appTitle: 'Nienie Console',
    localBridge: 'Local Bridge',
    startBridge: 'Start Bridge',
    stopBridge: 'Stop Bridge',
    localAgents: 'Local Agents',
    detect: 'Detect',
    mobilePairing: 'Mobile Pairing',
    newCode: 'New Code',
    pairingCodeLabel: 'One-Time Pairing Code',
    expiresPrefix: 'Expires',
    pairingUriLabel: 'Pairing URI',
    machineLabel: 'Machine',
    endpointLabel: 'Endpoint',
    connectedDevicesLabel: 'Devices',
    detectedBadge: 'Ready',
    unavailableBadge: 'Offline',
    publicRelay: 'Public Relay',
    defaultRelayLabel: 'Default',
    activeRelayLabel: 'Active',
    useCustomRelay: 'Use Custom',
    useDefaultRelay: 'Use Default',
    diagnosticLogs: 'Diagnostic Logs',
    running: 'Running',
    stopped: 'Stopped',
    error: 'Error',
    revokeBtn: 'Revoke',
    revokedBadge: 'Revoked',
  },
  ja: {
    appTitle: 'Nienie コンソール',
    localBridge: 'ローカル Bridge',
    startBridge: '起動',
    stopBridge: '停止',
    localAgents: 'ローカル Agents',
    detect: '再検出',
    mobilePairing: 'スマホ接続・ペアリング',
    newCode: 'コード更新',
    pairingCodeLabel: 'ワンタイムコード',
    expiresPrefix: '有効期限',
    pairingUriLabel: 'ペアリング URI',
    machineLabel: 'マシン ID',
    endpointLabel: '待受アドレス',
    connectedDevicesLabel: '接続台数',
    detectedBadge: '利用可能',
    unavailableBadge: '未検出',
    publicRelay: 'パブリック Relay',
    defaultRelayLabel: 'デフォルト',
    activeRelayLabel: '現在有効',
    useCustomRelay: 'カスタム適用',
    useDefaultRelay: 'デフォルト戻す',
    diagnosticLogs: '診断ログ',
    running: '実行中',
    stopped: '停止中',
    error: 'エラー',
    revokeBtn: '解除',
    revokedBadge: '解除済',
  },
  ko: {
    appTitle: 'Nienie 콘솔',
    localBridge: '로컬 Bridge',
    startBridge: '시작',
    stopBridge: '중지',
    localAgents: '로컬 Agents',
    detect: '다시 감지',
    mobilePairing: '모바일 페어링 (최우선)',
    newCode: '새 코드',
    pairingCodeLabel: '일회용 페어링 코드',
    expiresPrefix: '만료 시간',
    pairingUriLabel: '페어링 URI',
    machineLabel: '머신 ID',
    endpointLabel: '엔드포인트',
    connectedDevicesLabel: '연결 기기',
    detectedBadge: '사용 가능',
    unavailableBadge: '미감지',
    publicRelay: '퍼블릭 Relay',
    defaultRelayLabel: '기본 주소',
    activeRelayLabel: '현재 활성',
    useCustomRelay: '사용자 지정 적용',
    useDefaultRelay: '기본값 복원',
    diagnosticLogs: '진단 로그',
    running: '실행 중',
    stopped: '중지됨',
    error: '오류',
    revokeBtn: '해제',
    revokedBadge: '해제됨',
  },
};

export function renderDesktopAppHtml(
  state: DesktopDashboardState,
  options: RenderDesktopOptions = {},
): string {
  const locale: DesktopLocale = options.locale ?? state.locale ?? 'zh';
  const t = DESKTOP_I18N[locale] ?? DESKTOP_I18N.zh;
  const isRunning = state.bridge.status === 'running';
  const statusLabel = isRunning ? t.running : state.bridge.status === 'error' ? t.error : t.stopped;
  const statusClass = isRunning ? 'badge-success' : state.bridge.status === 'error' ? 'badge-danger' : 'badge-muted';

  // Sort agents so detected/available agents appear first
  const sortedAgents = [...state.agents].sort(
    (a, b) => Number(b.available) - Number(a.available),
  );

  const agentsHtml = sortedAgents
    .map((agent) => {
      const onlineClass = agent.available ? 'badge-success' : 'badge-muted';
      const onlineText = agent.available ? t.detectedBadge : t.unavailableBadge;
      return `
        <div class="agent-row ${agent.available ? 'agent-online' : 'agent-offline'}" data-agent-id="${escapeHtml(agent.id)}">
          <div class="agent-meta">
            <span class="agent-icon">${iconTerminalSvg()}</span>
            <span class="agent-name">${escapeHtml(agent.name)}${agent.version ? ` <span class="agent-version">v${escapeHtml(agent.version)}</span>` : ''}</span>
          </div>
          <span class="badge ${onlineClass}">${escapeHtml(onlineText)}</span>
        </div>
      `;
    })
    .join('');

  const pairingHtml = state.pairing
    ? `
      <div class="pairing-content">
        <div class="qr-frame">${state.pairing.qrSvg}</div>
        <div class="pairing-details">
          <div class="field-hint">${escapeHtml(t.pairingCodeLabel)}</div>
          <div class="pairing-code" id="pairing-code">${escapeHtml(state.pairing.pairingCode)}</div>
          <div class="field-hint">${escapeHtml(t.expiresPrefix)} ${escapeHtml(state.pairing.expiresAt.slice(11, 19))}</div>
          <div class="field-hint" style="margin-top: 6px;">${escapeHtml(t.pairingUriLabel)}</div>
          <code class="uri-box" title="${escapeHtml(state.pairing.qrUri)}">${escapeHtml(state.pairing.qrUri)}</code>
        </div>
      </div>
    `
    : `<div class="empty-state">Start the local Bridge to generate a one-time pairing QR code.</div>`;

  const devicesHtml = state.devices
    .map((device) => {
      const revoked = Boolean(device.revokedAt);
      return `
        <div class="device-chip" data-device-id="${escapeHtml(device.deviceId)}">
          <span>${escapeHtml(device.deviceName)} (${escapeHtml(device.platform)})</span>
          ${
            revoked
              ? `<span class="badge badge-danger">${escapeHtml(t.revokedBadge)}</span>`
              : `<button class="btn-mini" data-revoke-device-id="${escapeHtml(device.deviceId)}">${escapeHtml(t.revokeBtn)}</button>`
          }
        </div>
      `;
    })
    .join('');

  const logsHtml = state.logs
    .slice(-30)
    .reverse()
    .map(
      (entry) => `
        <div class="log-row log-${escapeHtml(entry.level)}">
          <span class="log-time">${escapeHtml(entry.timestamp.slice(11, 19))}</span>
          <span class="log-level">${escapeHtml(entry.level.toUpperCase())}</span>
          <span class="log-msg">${escapeHtml(entry.message)}</span>
        </div>
      `,
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:;" />
  <title>${escapeHtml(t.appTitle)}</title>
  <style>
    :root {
      --color-bg-primary: #F2F2F7;
      --color-bg-secondary: #FFFFFF;
      --color-bg-elevated: #F7F7FA;
      --color-border: #E5E5EA;
      --color-text-primary: #1C1C1E;
      --color-text-secondary: #6C6C70;
      --color-accent: #07C160;
      --color-accent-hover: #06AD56;
      --color-ios-blue: #007AFF;
      --color-success: #07C160;
      --color-warning: #FF9500;
      --color-danger: #FF3B30;

      --space-1: 4px;
      --space-2: 8px;
      --space-3: 10px;
      --space-4: 12px;

      --radius-sm: 8px;
      --radius-md: 12px;
      --font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', sans-serif;
      --font-mono: 'SF Mono', 'JetBrains Mono', Menlo, monospace;
      --text-xs: 11px;
      --text-sm: 12px;
      --text-base: 13px;
      --text-lg: 14px;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      background: var(--color-bg-primary);
      color: var(--color-text-primary);
      font-family: var(--font-family);
      font-size: var(--text-base);
      line-height: 1.4;
      height: 100vh;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      -webkit-font-smoothing: antialiased;
    }

    .title-bar {
      height: 40px;
      padding-left: 78px;
      padding-right: var(--space-4);
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid var(--color-border);
      background: rgba(255, 255, 255, 0.88);
      backdrop-filter: blur(16px);
      -webkit-app-region: drag;
      user-select: none;
      flex-shrink: 0;
    }

    .title-brand {
      display: flex;
      align-items: center;
      gap: 6px;
      font-weight: 600;
      font-size: var(--text-base);
      color: var(--color-text-primary);
    }

    .workspace-grid {
      display: grid;
      grid-template-columns: 1.15fr 0.85fr;
      gap: 10px;
      padding: 10px 12px;
      max-width: 1280px;
      width: 100%;
      margin: 0 auto;
    }

    .card {
      background: var(--color-bg-secondary);
      border: 1px solid rgba(0, 0, 0, 0.05);
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.03);
      border-radius: var(--radius-md);
      padding: 10px 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .card-full {
      grid-column: 1 / -1;
    }

    .card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .card-title {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: var(--text-lg);
      font-weight: 600;
      color: var(--color-text-primary);
    }

    .btn {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      background: var(--color-accent);
      color: #FFFFFF;
      border: none;
      border-radius: var(--radius-sm);
      padding: 5px 10px;
      font-size: var(--text-xs);
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s ease;
    }

    .btn:hover {
      background: var(--color-accent-hover);
    }

    .btn-secondary {
      background: var(--color-bg-elevated);
      border: 1px solid var(--color-border);
      color: var(--color-text-primary);
    }

    .btn-secondary:hover {
      background: #EEEEF2;
    }

    .btn-mini {
      background: #FFF0F0;
      color: var(--color-danger);
      border: 1px solid rgba(255, 59, 48, 0.2);
      border-radius: 6px;
      padding: 1px 6px;
      font-size: 10px;
      cursor: pointer;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 10px;
      font-weight: 600;
    }

    .badge-success {
      background: rgba(7, 193, 96, 0.12);
      color: #06AD56;
    }

    .badge-danger {
      background: rgba(255, 59, 48, 0.12);
      color: var(--color-danger);
    }

    .badge-muted {
      background: var(--color-bg-elevated);
      color: var(--color-text-secondary);
    }

    .pairing-content {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .qr-frame svg {
      width: 112px;
      height: 112px;
      display: block;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      padding: 2px;
      background: #FFFFFF;
    }

    .pairing-details {
      flex: 1;
      min-width: 0;
    }

    .pairing-code {
      font-family: var(--font-mono);
      font-size: 26px;
      font-weight: 700;
      letter-spacing: 3px;
      color: var(--color-accent);
      line-height: 1.2;
      margin: 2px 0;
    }

    .uri-box {
      display: block;
      font-family: var(--font-mono);
      font-size: 10px;
      padding: 4px 6px;
      background: var(--color-bg-elevated);
      border: 1px solid var(--color-border);
      border-radius: 6px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      color: var(--color-text-secondary);
    }

    .stat-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 6px;
    }

    .stat-box {
      background: var(--color-bg-elevated);
      border-radius: var(--radius-sm);
      padding: 6px 8px;
      min-width: 0;
    }

    .stat-value {
      font-family: var(--font-mono);
      font-size: var(--text-xs);
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      margin-top: 2px;
    }

    .agents-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 6px;
    }

    .agent-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 5px 8px;
      background: var(--color-bg-elevated);
      border-radius: var(--radius-sm);
      font-size: var(--text-xs);
    }

    .agent-online {
      border: 1px solid rgba(7, 193, 96, 0.3);
      background: rgba(7, 193, 96, 0.04);
    }

    .agent-meta {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
    }

    .agent-name {
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .agent-version, .field-hint {
      font-size: 11px;
      color: var(--color-text-secondary);
    }

    .device-chip {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 4px 8px;
      background: var(--color-bg-elevated);
      border-radius: 6px;
      font-size: 11px;
    }

    .input {
      width: 100%;
      background: var(--color-bg-elevated);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      color: var(--color-text-primary);
      padding: 5px 8px;
      font-family: var(--font-mono);
      font-size: var(--text-xs);
    }

    .log-stream {
      background: var(--color-bg-elevated);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      padding: 6px 8px;
      max-height: 92px;
      overflow-y: auto;
      font-family: var(--font-mono);
      font-size: 10px;
    }

    .log-row {
      display: flex;
      gap: 6px;
      padding: 1px 0;
    }

    .log-time {
      color: var(--color-text-secondary);
      flex-shrink: 0;
    }
  </style>
</head>
<body>
  <header class="title-bar">
    <div class="title-brand">
      ${iconBridgeSvg()}
      <span>${escapeHtml(t.appTitle)}</span>
    </div>
    <div style="display: flex; align-items: center; gap: var(--space-2); -webkit-app-region: no-drag;">
      <select class="input" id="select-locale" style="width: auto; padding: 2px 8px;">
        <option value="zh" ${locale === 'zh' ? 'selected' : ''}>中文</option>
        <option value="en" ${locale === 'en' ? 'selected' : ''}>English</option>
        <option value="ja" ${locale === 'ja' ? 'selected' : ''}>日本語</option>
        <option value="ko" ${locale === 'ko' ? 'selected' : ''}>한국어</option>
      </select>
      <span class="badge ${statusClass}" id="bridge-status-badge">${escapeHtml(statusLabel)}</span>
    </div>
  </header>

  <main class="workspace-grid">
    <!-- Row 1 Left (Most Important): Mobile QR & One-Time Code Pairing -->
    <section class="card">
      <div class="card-header">
        <h2 class="card-title">${iconQrSvg()} ${escapeHtml(t.mobilePairing)}</h2>
        <button class="btn btn-secondary" id="btn-refresh-pairing">${iconRefreshSvg()} ${escapeHtml(t.newCode)}</button>
      </div>
      ${pairingHtml}
    </section>

    <!-- Row 1 Right: Local Bridge Status & Paired Mobile Devices -->
    <section class="card">
      <div class="card-header">
        <h2 class="card-title">${iconBridgeSvg()} ${escapeHtml(t.localBridge)}</h2>
        <button class="btn" id="btn-toggle-bridge">${escapeHtml(isRunning ? t.stopBridge : t.startBridge)}</button>
      </div>
      <div class="stat-grid">
        <div class="stat-box">
          <div class="field-hint">${escapeHtml(t.machineLabel)}</div>
          <div class="stat-value" title="${escapeHtml(state.bridge.machineId)}">${escapeHtml(state.bridge.machineId)}</div>
        </div>
        <div class="stat-box">
          <div class="field-hint">${escapeHtml(t.endpointLabel)}</div>
          <div class="stat-value" title="${escapeHtml(state.bridge.wsUrl ?? '-')}">${escapeHtml(state.bridge.wsUrl ?? '-')}</div>
        </div>
        <div class="stat-box">
          <div class="field-hint">${escapeHtml(t.connectedDevicesLabel)}</div>
          <div class="stat-value">${state.bridge.connectedClients}</div>
        </div>
      </div>
      ${devicesHtml}
    </section>

    <!-- Row 2 Left: Compact 2-Column Local Agents Grid (Detected First) -->
    <section class="card">
      <div class="card-header">
        <h2 class="card-title">${iconTerminalSvg()} ${escapeHtml(t.localAgents)}</h2>
        <button class="btn btn-secondary" id="btn-refresh-agents">${iconRefreshSvg()} ${escapeHtml(t.detect)}</button>
      </div>
      <div class="agents-grid">
        ${agentsHtml || '<div class="field-hint">No agents detected yet.</div>'}
      </div>
    </section>

    <!-- Row 2 Right: Compact Public Relay Configuration -->
    <section class="card">
      <div class="card-header">
        <h2 class="card-title">${iconGlobeSvg()} ${escapeHtml(t.publicRelay)}</h2>
        <span class="badge badge-muted">${state.relay.mode === 'custom' ? 'Custom' : 'Default'}</span>
      </div>
      <div class="field-hint">${escapeHtml(t.defaultRelayLabel)}: <code>${escapeHtml(state.relay.defaultRelayUrl)}</code></div>
      <div class="field-hint">${escapeHtml(t.activeRelayLabel)}: <code id="active-relay-url">${escapeHtml(state.relay.activeRelayUrl)}</code></div>
      <div style="display: flex; gap: 6px; align-items: center;">
        <input class="input" id="input-custom-relay" type="text" placeholder="wss://relay.example.com" value="${escapeHtml(state.relay.customRelayUrl)}" />
        <button class="btn" id="btn-save-custom-relay" style="flex-shrink: 0;">${escapeHtml(t.useCustomRelay)}</button>
        <button class="btn btn-secondary" id="btn-use-default-relay" style="flex-shrink: 0;">${escapeHtml(t.useDefaultRelay)}</button>
      </div>
    </section>

    <!-- Row 3 Bottom (Secondary Info): Compact Diagnostic Logs -->
    <section class="card card-full">
      <div class="card-header">
        <h2 class="card-title">${iconLogSvg()} ${escapeHtml(t.diagnosticLogs)}</h2>
      </div>
      <div class="log-stream" id="log-stream">
        ${logsHtml}
      </div>
    </section>
  </main>
  <script>
    window.addEventListener('DOMContentLoaded', () => {
      document.getElementById('select-locale')?.addEventListener('change', (ev) => {
        const nextLang = ev.target.value;
        const url = new URL(window.location.href);
        url.searchParams.set('lang', nextLang);
        window.location.href = url.toString();
      });
      const api = window.nienieDesktop;
      if (!api) return;
      document.getElementById('btn-toggle-bridge')?.addEventListener('click', () => {
        ${isRunning ? 'api.stopBridge()' : 'api.startBridge()'};
      });
      document.getElementById('btn-refresh-agents')?.addEventListener('click', () => {
        api.refreshAgents();
      });
      document.getElementById('btn-refresh-pairing')?.addEventListener('click', () => {
        api.refreshPairing();
      });
      document.getElementById('btn-save-custom-relay')?.addEventListener('click', () => {
        const input = document.getElementById('input-custom-relay');
        api.setRelay({ mode: 'custom', customRelayUrl: input ? input.value : '' });
      });
      document.getElementById('btn-use-default-relay')?.addEventListener('click', () => {
        api.setRelay({ mode: 'default' });
      });
      document.querySelectorAll('[data-revoke-device-id]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const id = btn.getAttribute('data-revoke-device-id');
          if (id) api.revokeDevice(id);
        });
      });
    });
  </script>
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

function iconBridgeSvg(): string {
  return `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#07C160" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10a8 8 0 0 1 16 0"/><path d="M2 14h20"/><path d="M6 14v6"/><path d="M18 14v6"/></svg>`;
}

function iconTerminalSvg(): string {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>`;
}

function iconQrSvg(): string {
  return `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#07C160" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><path d="M14 14h7v7h-7z"/></svg>`;
}

function iconGlobeSvg(): string {
  return `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#007AFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`;
}

function iconRefreshSvg(): string {
  return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>`;
}

function iconLogSvg(): string {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/></svg>`;
}
