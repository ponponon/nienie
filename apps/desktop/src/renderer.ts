import type { DesktopDashboardState } from './controller.js';

export type DesktopLocale = 'zh' | 'en' | 'ja' | 'ko';

export type RenderDesktopOptions = {
  locale?: DesktopLocale | undefined;
};

const DESKTOP_I18N: Record<
  DesktopLocale,
  {
    appTitle: string;
    heroTitle: string;
    heroSubtitle: string;
    localBridge: string;
    startBridge: string;
    stopBridge: string;
    localAgents: string;
    detect: string;
    mobilePairing: string;
    newCode: string;
    pairingCodeLabel: string;
    copyUriBtn: string;
    copiedText: string;
    machineLabel: string;
    endpointLabel: string;
    connectedDevicesLabel: string;
    detectedBadge: string;
    unavailableBadge: string;
    moreAgentsSummary: string;
    advancedSummary: string;
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
    heroTitle: '用手机连接这台 Mac',
    heroSubtitle: '打开手机 Nienie 扫描二维码，或输入下方 6 位配对码',
    localBridge: '本地 Bridge',
    startBridge: '启动服务',
    stopBridge: '停止服务',
    localAgents: '可用 AI 助手',
    detect: '重新检测',
    mobilePairing: '手机扫码配对',
    newCode: '更换配对码',
    pairingCodeLabel: '配对码',
    copyUriBtn: '复制连接口令',
    copiedText: '已复制',
    machineLabel: '电脑名称',
    endpointLabel: '本地地址',
    connectedDevicesLabel: '已连接手机',
    detectedBadge: '已就绪',
    unavailableBadge: '未安装',
    moreAgentsSummary: '查看其他未安装的助手',
    advancedSummary: '高级设置与诊断日志',
    publicRelay: '公网中继 (Relay)',
    defaultRelayLabel: '默认地址',
    activeRelayLabel: '当前生效',
    useCustomRelay: '保存自定义地址',
    useDefaultRelay: '恢复默认',
    diagnosticLogs: '运行日志',
    running: '服务已就绪',
    stopped: '已停止',
    error: '异常',
    revokeBtn: '断开',
    revokedBadge: '已移除',
  },
  en: {
    appTitle: 'Nienie Bridge Console',
    heroTitle: 'Connect from Your Phone',
    heroSubtitle: 'Scan the QR code with Nienie on your phone, or enter the 6-digit code',
    localBridge: 'Local Bridge',
    startBridge: 'Start Bridge',
    stopBridge: 'Stop Bridge',
    localAgents: 'Ready AI Agents',
    detect: 'Refresh',
    mobilePairing: 'Mobile Pairing',
    newCode: 'Refresh Code',
    pairingCodeLabel: 'Pairing Code',
    copyUriBtn: 'Copy Link',
    copiedText: 'Copied',
    machineLabel: 'Computer',
    endpointLabel: 'Address',
    connectedDevicesLabel: 'Connected Phones',
    detectedBadge: 'Ready',
    unavailableBadge: 'Not Installed',
    moreAgentsSummary: 'Other supported agents',
    advancedSummary: 'Advanced Settings & Logs',
    publicRelay: 'Public Relay',
    defaultRelayLabel: 'Default',
    activeRelayLabel: 'Active',
    useCustomRelay: 'Use Custom Relay',
    useDefaultRelay: 'Reset Default',
    diagnosticLogs: 'Diagnostic Logs',
    running: 'Ready',
    stopped: 'Stopped',
    error: 'Error',
    revokeBtn: 'Revoke',
    revokedBadge: 'Revoked',
  },
  ja: {
    appTitle: 'Nienie Bridge コンソール',
    heroTitle: 'スマホからこの Mac に接続',
    heroSubtitle: 'スマホの Nienie で QR コードを読み取るか、6桁のコードを入力してください',
    localBridge: 'ローカル Bridge',
    startBridge: '起動',
    stopBridge: '停止',
    localAgents: '利用可能な AI',
    detect: '再検出',
    mobilePairing: 'モバイルペアリング',
    newCode: 'コード更新',
    pairingCodeLabel: 'ペアリングコード',
    copyUriBtn: 'リンクをコピー',
    copiedText: 'コピー完了',
    machineLabel: 'Mac 名',
    endpointLabel: 'アドレス',
    connectedDevicesLabel: '接続中のスマホ',
    detectedBadge: '準備完了',
    unavailableBadge: '未検出',
    moreAgentsSummary: 'その他の対応エージェントを表示',
    advancedSummary: '詳細設定と診断ログ',
    publicRelay: 'パブリック Relay',
    defaultRelayLabel: 'デフォルト',
    activeRelayLabel: '現在有効',
    useCustomRelay: 'カスタム適用',
    useDefaultRelay: 'デフォルトに戻す',
    diagnosticLogs: '診断ログ',
    running: '準備完了',
    stopped: '停止中',
    error: 'エラー',
    revokeBtn: '解除',
    revokedBadge: '解除済',
  },
  ko: {
    appTitle: 'Nienie Bridge 콘솔',
    heroTitle: '휴대폰으로 이 Mac에 연결',
    heroSubtitle: '휴대폰 Nienie 앱으로 QR 코드를 스캔하거나 아래 6자리 코드를 입력하세요',
    localBridge: '로컬 Bridge',
    startBridge: '시작',
    stopBridge: '중지',
    localAgents: '준비된 AI 에이전트',
    detect: '새로고침',
    mobilePairing: '모바일 페어링',
    newCode: '코드 변경',
    pairingCodeLabel: '페어링 코드',
    copyUriBtn: '연결 링크 복사',
    copiedText: '복사됨',
    machineLabel: '컴퓨터',
    endpointLabel: '주소',
    connectedDevicesLabel: '연결된 휴대폰',
    detectedBadge: '준비됨',
    unavailableBadge: '미설치',
    moreAgentsSummary: '설치되지 않은 다른 에이전트 보기',
    advancedSummary: '고급 설정 및 진단 로그',
    publicRelay: '퍼블릭 Relay',
    defaultRelayLabel: '기본 주소',
    activeRelayLabel: '현재 활성',
    useCustomRelay: '사용자 지정 적용',
    useDefaultRelay: '기본값 복원',
    diagnosticLogs: '진단 로그',
    running: '준비됨',
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

  const onlineAgents = state.agents.filter((a) => a.available);
  const offlineAgents = state.agents.filter((a) => !a.available);

  const renderAgentItem = (agent: DesktopDashboardState['agents'][number]) => {
    const onlineClass = agent.available ? 'badge-success' : 'badge-muted';
    const onlineText = agent.available ? t.detectedBadge : t.unavailableBadge;
    return `
      <div class="agent-row ${agent.available ? 'agent-online' : 'agent-offline'}" data-agent-id="${escapeHtml(agent.id)}">
        <div class="agent-meta">
          <span class="agent-dot ${agent.available ? 'dot-online' : 'dot-offline'}"></span>
          <span class="agent-name">${escapeHtml(agent.name)}${agent.version ? ` <span class="agent-version">v${escapeHtml(agent.version)}</span>` : ''}</span>
        </div>
        <span class="badge ${onlineClass}">${escapeHtml(onlineText)}</span>
      </div>
    `;
  };

  const onlineAgentsHtml = onlineAgents.map(renderAgentItem).join('');
  const offlineAgentsHtml = offlineAgents.map(renderAgentItem).join('');

  const formattedCode = state.pairing
    ? `${state.pairing.pairingCode.slice(0, 3)} ${state.pairing.pairingCode.slice(3)}`
    : '--- ---';

  const pairingHtml = state.pairing
    ? `
      <div class="hero-pairing">
        <div class="qr-frame">${state.pairing.qrSvg}</div>
        <div class="hero-info">
          <h1 class="hero-title">${escapeHtml(t.heroTitle)}</h1>
          <p class="hero-subtitle">${escapeHtml(t.heroSubtitle)}</p>
          <div class="code-pill" id="pairing-code" data-raw-code="${escapeHtml(state.pairing.pairingCode)}">${escapeHtml(formattedCode)}</div>
          <code class="sr-only" id="pairing-uri-code">${escapeHtml(state.pairing.qrUri)}</code>
          <div class="hero-actions">
            <button class="btn btn-secondary" id="btn-refresh-pairing" type="button">${iconRefreshSvg()} ${escapeHtml(t.newCode)}</button>
            <button class="btn btn-secondary" id="btn-copy-uri" type="button">${escapeHtml(t.copyUriBtn)}</button>
          </div>
        </div>
      </div>
    `
    : `<div class="empty-state">Start the local Bridge to generate a pairing code.</div>`;

  const devicesHtml = state.devices
    .map((device) => {
      const revoked = Boolean(device.revokedAt);
      return `
        <div class="kv-row" data-device-id="${escapeHtml(device.deviceId)}">
          <span class="kv-label">${escapeHtml(device.deviceName)} (${escapeHtml(device.platform)})</span>
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
    .slice(-25)
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
      --color-text-primary: #1D1D1F;
      --color-text-secondary: #6E6E73;
      --color-accent: #07C160;
      --color-accent-hover: #06AD56;
      --color-danger: #FF3B30;

      --radius-sm: 8px;
      --radius-md: 14px;
      --font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', sans-serif;
      --font-mono: 'SF Mono', 'JetBrains Mono', Menlo, monospace;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    html, body {
      width: 100%;
      max-width: 100vw;
      overflow-x: hidden;
      background: var(--color-bg-primary);
      color: var(--color-text-primary);
      font-family: var(--font-family);
      font-size: 13px;
      line-height: 1.45;
      -webkit-font-smoothing: antialiased;
    }

    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
    }

    .title-bar {
      position: sticky;
      top: 0;
      z-index: 100;
      width: 100%;
      height: 44px;
      padding-left: 78px;
      padding-right: 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid rgba(0, 0, 0, 0.06);
      background: rgba(242, 242, 247, 0.88);
      backdrop-filter: blur(20px);
      -webkit-app-region: drag;
      user-select: none;
    }

    .title-brand {
      display: flex;
      align-items: center;
      gap: 6px;
      font-weight: 600;
      font-size: 13px;
      color: var(--color-text-primary);
    }

    .container {
      max-width: 600px;
      width: 100%;
      margin: 0 auto;
      padding: 20px 20px 28px;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }

    .workspace-grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 12px;
    }

    .card {
      min-width: 0;
      overflow: hidden;
      background: var(--color-bg-secondary);
      border: 1px solid rgba(0, 0, 0, 0.06);
      border-radius: var(--radius-md);
      padding: 18px 20px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .hero-pairing {
      display: flex;
      align-items: center;
      gap: 22px;
    }

    .qr-frame {
      flex-shrink: 0;
      background: #FFFFFF;
      border: 1px solid var(--color-border);
      border-radius: 12px;
      padding: 6px;
    }

    .qr-frame svg {
      width: 132px;
      height: 132px;
      display: block;
    }

    .hero-info {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 6px;
    }

    .hero-title {
      font-size: 17px;
      font-weight: 600;
      letter-spacing: -0.01em;
      color: var(--color-text-primary);
    }

    .hero-subtitle {
      font-size: 12px;
      color: var(--color-text-secondary);
    }

    .code-pill {
      font-family: var(--font-mono);
      font-size: 28px;
      font-weight: 700;
      letter-spacing: 3px;
      color: var(--color-accent);
      background: rgba(7, 193, 96, 0.08);
      padding: 4px 14px;
      border-radius: 10px;
      margin: 2px 0;
      user-select: all;
    }

    .hero-actions {
      display: flex;
      gap: 8px;
      margin-top: 2px;
    }

    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .section-title {
      font-size: 13px;
      font-weight: 600;
      color: var(--color-text-secondary);
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .agent-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .agent-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 12px;
      background: var(--color-bg-elevated);
      border-radius: var(--radius-sm);
      font-size: 13px;
    }

    .agent-meta {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .agent-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
    }

    .dot-online {
      background: var(--color-accent);
    }

    .dot-offline {
      background: #C7C7CC;
    }

    .agent-name {
      font-weight: 500;
    }

    .agent-version {
      font-size: 11px;
      color: var(--color-text-secondary);
      font-weight: 400;
    }

    details.subtle-collapse {
      font-size: 12px;
      color: var(--color-text-secondary);
    }

    details.subtle-collapse summary {
      cursor: pointer;
      user-select: none;
      padding: 4px 0;
      color: var(--color-text-secondary);
      list-style: none;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }

    details.subtle-collapse summary::-webkit-details-marker {
      display: none;
    }

    details.subtle-collapse summary::after {
      content: '▾';
      font-size: 11px;
    }

    details.subtle-collapse[open] summary::after {
      content: '▴';
    }

    .offline-grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 6px;
      margin-top: 8px;
    }

    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
      background: var(--color-accent);
      color: #FFFFFF;
      border: none;
      border-radius: var(--radius-sm);
      padding: 6px 12px;
      font-size: 12px;
      font-weight: 500;
      white-space: nowrap;
      cursor: pointer;
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
      background: #EAEAEF;
    }

    .btn-mini {
      background: rgba(255, 59, 48, 0.1);
      color: var(--color-danger);
      border: none;
      border-radius: 6px;
      padding: 3px 8px;
      font-size: 11px;
      cursor: pointer;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      padding: 2px 9px;
      border-radius: 999px;
      font-size: 11px;
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
      background: #EEEEF2;
      color: var(--color-text-secondary);
    }

    .kv-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 7px 10px;
      background: var(--color-bg-elevated);
      border-radius: var(--radius-sm);
      font-size: 12px;
    }

    .kv-label {
      color: var(--color-text-secondary);
    }

    .kv-value {
      font-family: var(--font-mono);
      font-weight: 500;
    }

    .input {
      width: 100%;
      background: var(--color-bg-elevated);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      color: var(--color-text-primary);
      padding: 6px 10px;
      font-size: 12px;
    }

    .log-stream {
      background: var(--color-bg-elevated);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      padding: 8px 10px;
      max-height: 110px;
      overflow-y: auto;
      font-family: var(--font-mono);
      font-size: 11px;
    }

    .log-row {
      display: flex;
      gap: 8px;
      padding: 1px 0;
    }

    .log-time {
      color: var(--color-text-secondary);
      flex-shrink: 0;
    }

    .log-msg {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  </style>
</head>
<body>
  <header class="title-bar">
    <div class="title-brand">
      ${iconBridgeSvg()}
      <span>${escapeHtml(t.appTitle)}</span>
    </div>
    <div style="display: flex; align-items: center; gap: 8px; -webkit-app-region: no-drag;">
      <select class="input" id="select-locale" style="width: auto; padding: 3px 8px;">
        <option value="zh" ${locale === 'zh' ? 'selected' : ''}>中文</option>
        <option value="en" ${locale === 'en' ? 'selected' : ''}>English</option>
        <option value="ja" ${locale === 'ja' ? 'selected' : ''}>日本語</option>
        <option value="ko" ${locale === 'ko' ? 'selected' : ''}>한국어</option>
      </select>
      <span class="badge ${statusClass}" id="bridge-status-badge">${escapeHtml(statusLabel)}</span>
    </div>
  </header>

  <main class="container workspace-grid">
    <!-- 1. Hero Card: Clean Scan QR & 6-Digit Code -->
    <section class="card">
      ${pairingHtml}
      ${devicesHtml ? `<div style="display: flex; flex-direction: column; gap: 6px; padding-top: 6px; border-top: 1px solid var(--color-border);">${devicesHtml}</div>` : ''}
    </section>

    <!-- 2. Ready AI Agents Card (Only installed shown prominently; uninstalled tucked away) -->
    <section class="card">
      <div class="section-header">
        <span class="section-title">${iconTerminalSvg()} ${escapeHtml(t.localAgents)}</span>
        <button class="btn btn-secondary" id="btn-refresh-agents" type="button">${iconRefreshSvg()} ${escapeHtml(t.detect)}</button>
      </div>
      <div class="agent-list">
        ${onlineAgentsHtml || `<div class="kv-row"><span class="kv-label">No online agent detected</span></div>`}
      </div>
      ${
        offlineAgents.length > 0
          ? `<details class="subtle-collapse">
              <summary>${escapeHtml(t.moreAgentsSummary)} (${offlineAgents.length})</summary>
              <div class="offline-grid">${offlineAgentsHtml}</div>
            </details>`
          : ''
      }
    </section>

    <!-- 3. Progressive Disclosure: Advanced Network, Relay & Logs tucked cleanly at the bottom -->
    <details class="subtle-collapse">
      <summary style="justify-content: center; width: 100%; padding: 6px 0;">${escapeHtml(t.advancedSummary)}</summary>
      <div style="display: flex; flex-direction: column; gap: 10px; margin-top: 8px;">
        <section class="card">
          <div class="section-header">
            <span class="section-title">${escapeHtml(t.localBridge)}</span>
            <button class="btn btn-secondary" id="btn-toggle-bridge" type="button">${escapeHtml(isRunning ? t.stopBridge : t.startBridge)}</button>
          </div>
          <div class="kv-row">
            <span class="kv-label">${escapeHtml(t.machineLabel)}</span>
            <span class="kv-value">${escapeHtml(state.bridge.machineId)}</span>
          </div>
          <div class="kv-row">
            <span class="kv-label">${escapeHtml(t.endpointLabel)}</span>
            <span class="kv-value">${escapeHtml(state.bridge.wsUrl ?? '-')}</span>
          </div>
        </section>

        <section class="card">
          <div class="section-header">
            <span class="section-title">${iconGlobeSvg()} ${escapeHtml(t.publicRelay)}</span>
            <span class="badge badge-muted">${state.relay.mode === 'custom' ? 'Custom' : 'Default'}</span>
          </div>
          <div class="kv-row">
            <span class="kv-label">${escapeHtml(t.activeRelayLabel)}</span>
            <code class="kv-value" id="active-relay-url">${escapeHtml(state.relay.activeRelayUrl)}</code>
          </div>
          <span class="sr-only">${escapeHtml(state.relay.defaultRelayUrl)}</span>
          <div style="display: flex; gap: 8px;">
            <input class="input" id="input-custom-relay" type="text" placeholder="wss://relay.example.com" value="${escapeHtml(state.relay.customRelayUrl)}" />
            <button class="btn" id="btn-save-custom-relay" type="button">${escapeHtml(t.useCustomRelay)}</button>
            <button class="btn btn-secondary" id="btn-use-default-relay" type="button">${escapeHtml(t.useDefaultRelay)}</button>
          </div>
        </section>

        <section class="card">
          <div class="section-header">
            <span class="section-title">${iconLogSvg()} ${escapeHtml(t.diagnosticLogs)}</span>
          </div>
          <div class="log-stream" id="log-stream">
            ${logsHtml}
          </div>
        </section>
      </div>
    </details>
  </main>
  <script>
    window.addEventListener('DOMContentLoaded', () => {
      document.getElementById('select-locale')?.addEventListener('change', (ev) => {
        const nextLang = ev.target.value;
        const url = new URL(window.location.href);
        url.searchParams.set('lang', nextLang);
        window.location.href = url.toString();
      });
      document.getElementById('btn-copy-uri')?.addEventListener('click', (ev) => {
        const uri = document.getElementById('pairing-uri-code')?.textContent;
        const btn = ev.currentTarget;
        if (uri && navigator.clipboard) {
          navigator.clipboard.writeText(uri);
          if (btn) btn.textContent = '${escapeHtml(t.copiedText)}';
        }
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

function iconGlobeSvg(): string {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#007AFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`;
}

function iconRefreshSvg(): string {
  return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>`;
}

function iconLogSvg(): string {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/></svg>`;
}
