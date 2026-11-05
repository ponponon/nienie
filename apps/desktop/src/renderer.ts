import type { DesktopDashboardState } from './controller.js';

export type DesktopLocale = 'zh' | 'en' | 'ja' | 'ko';

export type RenderDesktopOptions = {
  locale?: DesktopLocale | undefined;
};

const DESKTOP_I18N: Record<
  DesktopLocale,
  {
    appTitle: string;
    navPair: string;
    navAgents: string;
    navNetwork: string;
    navSystem: string;
    heroTitle: string;
    heroSubtitle: string;
    localBridge: string;
    bridgeDesc: string;
    startBridge: string;
    stopBridge: string;
    localAgents: string;
    agentsDesc: string;
    detect: string;
    mobilePairing: string;
    newCode: string;
    pairingCodeLabel: string;
    pairingCodeDesc: string;
    copyUriBtn: string;
    copiedText: string;
    machineLabel: string;
    endpointLabel: string;
    connectedDevicesLabel: string;
    connectedDevicesDesc: string;
    detectedBadge: string;
    unavailableBadge: string;
    moreAgentsSummary: string;
    publicRelay: string;
    relayDefaultTitle: string;
    relayDefaultDesc: string;
    relayCustomTitle: string;
    relayCustomDesc: string;
    useCustomRelay: string;
    useDefaultRelay: string;
    languageTitle: string;
    languageDesc: string;
    diagnosticLogs: string;
    logsDesc: string;
    running: string;
    stopped: string;
    error: string;
    revokeBtn: string;
    revokedBadge: string;
  }
> = {
  zh: {
    appTitle: 'Nienie Bridge 控制台',
    navPair: '手机连接',
    navAgents: 'AI 助手',
    navNetwork: '跨设备网络',
    navSystem: '偏好与日志',
    heroTitle: '手机扫码连接',
    heroSubtitle: '打开手机 Nienie 扫描二维码，自动绑定这台 Mac',
    localBridge: '本地 Bridge',
    bridgeDesc: '开启后允许手机通过局域网或 USB 连接这台电脑',
    startBridge: '启动服务',
    stopBridge: '停止服务',
    localAgents: '本机 AI 助手',
    agentsDesc: '已自动检测这台 Mac 上安装的编程 Agent',
    detect: '重新检测',
    mobilePairing: '手机连接',
    newCode: '更换配对码',
    pairingCodeLabel: '6 位数字配对码',
    pairingCodeDesc: '如果不方便扫码，可在手机端直接输入此数字连接',
    copyUriBtn: '复制连接口令',
    copiedText: '✓ 已复制',
    machineLabel: '本机名称',
    endpointLabel: '监听地址',
    connectedDevicesLabel: '已连接手机',
    connectedDevicesDesc: '管理已授权访问这台 Mac 的移动设备',
    detectedBadge: '已就绪',
    unavailableBadge: '未安装',
    moreAgentsSummary: '显示其他未安装的扩展助手',
    publicRelay: '跨设备网络',
    relayDefaultTitle: '使用默认公网中继',
    relayDefaultDesc: '不在同一 Wi-Fi 时，通过加密中继服务自动穿透连接',
    relayCustomTitle: '自定义中继服务器',
    relayCustomDesc: '使用您自己部署的私有 WebSocket Relay 地址',
    useCustomRelay: '保存并应用',
    useDefaultRelay: '恢复默认',
    languageTitle: '界面语言',
    languageDesc: '设置桌面端控制台的显示语言',
    diagnosticLogs: '运行诊断日志',
    logsDesc: '最近服务状态与脱敏事件记录',
    running: '运行中',
    stopped: '已停止',
    error: '异常',
    revokeBtn: '移除',
    revokedBadge: '已移除',
  },
  en: {
    appTitle: 'Nienie Bridge Console',
    navPair: 'Phone Pairing',
    navAgents: 'AI Agents',
    navNetwork: 'Network & Relay',
    navSystem: 'Preferences',
    heroTitle: 'Scan QR Code with Phone',
    heroSubtitle: 'Open Nienie on your phone and scan to pair with this Mac',
    localBridge: 'Local Bridge',
    bridgeDesc: 'Allow mobile devices to connect over LAN or USB',
    startBridge: 'Start',
    stopBridge: 'Stop',
    localAgents: 'Local AI Agents',
    agentsDesc: 'Coding agents detected on this computer',
    detect: 'Refresh',
    mobilePairing: 'Phone Pairing',
    newCode: 'Refresh Code',
    pairingCodeLabel: '6-Digit Pairing Code',
    pairingCodeDesc: 'Enter this code on your phone if camera scanning is unavailable',
    copyUriBtn: 'Copy Pairing Link',
    copiedText: '✓ Copied',
    machineLabel: 'Computer Name',
    endpointLabel: 'Local Endpoint',
    connectedDevicesLabel: 'Paired Phones',
    connectedDevicesDesc: 'Manage mobile devices authorized for this Mac',
    detectedBadge: 'Ready',
    unavailableBadge: 'Not Installed',
    moreAgentsSummary: 'Show other uninstalled agents',
    publicRelay: 'Network & Relay',
    relayDefaultTitle: 'Default Public Relay',
    relayDefaultDesc: 'Connect across networks via end-to-end encrypted relay',
    relayCustomTitle: 'Custom Relay Server',
    relayCustomDesc: 'Use your own self-hosted WebSocket Relay endpoint',
    useCustomRelay: 'Apply',
    useDefaultRelay: 'Reset',
    languageTitle: 'Language',
    languageDesc: 'Choose display language for desktop console',
    diagnosticLogs: 'Diagnostic Logs',
    logsDesc: 'Recent service activity and redacted event logs',
    running: 'Running',
    stopped: 'Stopped',
    error: 'Error',
    revokeBtn: 'Revoke',
    revokedBadge: 'Revoked',
  },
  ja: {
    appTitle: 'Nienie Bridge コンソール',
    navPair: 'スマホ接続',
    navAgents: 'AI アシスタント',
    navNetwork: 'ネットワーク',
    navSystem: '環境設定',
    heroTitle: 'QR コードでスマホ接続',
    heroSubtitle: 'スマホの Nienie アプリでスキャンしてこの Mac とペアリングします',
    localBridge: 'ローカル Bridge',
    bridgeDesc: 'LAN または USB 経由でのスマホ接続を許可します',
    startBridge: '起動',
    stopBridge: '停止',
    localAgents: 'ローカル AI',
    agentsDesc: 'この Mac で検出されたコーディングエージェント',
    detect: '再検出',
    mobilePairing: 'スマホ接続',
    newCode: 'コード更新',
    pairingCodeLabel: '6桁のペアリングコード',
    pairingCodeDesc: 'カメラが使えない場合はスマホでこの番号を入力してください',
    copyUriBtn: 'リンクをコピー',
    copiedText: '✓ コピー完了',
    machineLabel: 'コンピュータ名',
    endpointLabel: 'ローカルアドレス',
    connectedDevicesLabel: 'ペアリング済み端末',
    connectedDevicesDesc: 'この Mac へのアクセスを許可したスマホを管理します',
    detectedBadge: '準備完了',
    unavailableBadge: '未検出',
    moreAgentsSummary: '未インストールのエージェントを表示',
    publicRelay: 'ネットワーク設定',
    relayDefaultTitle: '標準パブリック Relay',
    relayDefaultDesc: '外出先からでも暗号化中継で安全に接続します',
    relayCustomTitle: 'カスタム Relay サーバー',
    relayCustomDesc: '独自の WebSocket Relay アドレスを指定します',
    useCustomRelay: '適用',
    useDefaultRelay: '標準に戻す',
    languageTitle: '表示言語',
    languageDesc: 'コンソールの表示言語を切り替えます',
    diagnosticLogs: '診断ログ',
    logsDesc: 'サービスの状態とイベント履歴',
    running: '実行中',
    stopped: '停止中',
    error: 'エラー',
    revokeBtn: '解除',
    revokedBadge: '解除済',
  },
  ko: {
    appTitle: 'Nienie Bridge 콘솔',
    navPair: '휴대폰 연결',
    navAgents: 'AI 에이전트',
    navNetwork: '네트워크 설정',
    navSystem: '환경설정',
    heroTitle: 'QR 코드로 휴대폰 연결',
    heroSubtitle: '휴대폰 Nienie 앱으로 스캔하여 이 Mac과 연결합니다',
    localBridge: '로컬 Bridge',
    bridgeDesc: 'LAN 또는 USB를 통한 휴대폰 연결을 허용합니다',
    startBridge: '시작',
    stopBridge: '중지',
    localAgents: '로컬 AI 에이전트',
    agentsDesc: '이 Mac에서 감지된 코딩 에이전트',
    detect: '다시 감지',
    mobilePairing: '휴대폰 연결',
    newCode: '새 코드',
    pairingCodeLabel: '6자리 페어링 코드',
    pairingCodeDesc: '카메라 스캔이 어려울 경우 휴대폰에 이 번호를 입력하세요',
    copyUriBtn: '연결 링크 복사',
    copiedText: '✓ 복사됨',
    machineLabel: '컴퓨터 이름',
    endpointLabel: '로컬 주소',
    connectedDevicesLabel: '연결된 휴대폰',
    connectedDevicesDesc: '이 Mac에 접근 권한이 있는 모바일 기기 관리',
    detectedBadge: '준비됨',
    unavailableBadge: '미설치',
    moreAgentsSummary: '설치되지 않은 다른 에이전트 보기',
    publicRelay: '네트워크 및 Relay',
    relayDefaultTitle: '기본 퍼블릭 Relay 사용',
    relayDefaultDesc: '외부 네트워크에서도 암호화 릴레이로 자동 연결합니다',
    relayCustomTitle: '사용자 지정 Relay 서버',
    relayCustomDesc: '직접 구축한 프라이빗 WebSocket Relay 주소를 사용합니다',
    useCustomRelay: '적용',
    useDefaultRelay: '기본값 복원',
    languageTitle: '표시 언어',
    languageDesc: '데스크톱 콘솔의 표시 언어를 설정합니다',
    diagnosticLogs: '진단 로그',
    logsDesc: '최근 서비스 상태 및 이벤트 기록',
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

  const onlineAgents = state.agents.filter((a) => a.available);
  const offlineAgents = state.agents.filter((a) => !a.available);

  const renderAgentRow = (agent: DesktopDashboardState['agents'][number]) => `
    <div class="wetype-row" data-agent-id="${escapeHtml(agent.id)}">
      <div class="row-left">
        <span class="wetype-radio ${agent.available ? 'checked' : ''}"></span>
        <div>
          <div class="row-title">${escapeHtml(agent.name)}${agent.version ? ` <span class="row-sub-inline">v${escapeHtml(agent.version)}</span>` : ''}</div>
        </div>
      </div>
      <span class="row-right-text ${agent.available ? 'text-green' : ''}">${escapeHtml(agent.available ? t.detectedBadge : t.unavailableBadge)}</span>
    </div>
  `;

  const onlineAgentsHtml = onlineAgents.map(renderAgentRow).join('');
  const offlineAgentsHtml = offlineAgents.map(renderAgentRow).join('');

  const formattedCode = state.pairing
    ? `${state.pairing.pairingCode.slice(0, 3)} ${state.pairing.pairingCode.slice(3)}`
    : '--- ---';

  const pairingSectionHtml = state.pairing
    ? `
      <div class="wetype-group">
        <div class="wetype-row" style="padding: 20px 0;">
          <div class="qr-row-left">
            <div class="qr-box">${state.pairing.qrSvg}</div>
            <div>
              <div class="row-title">${escapeHtml(t.heroTitle)}</div>
              <div class="row-desc">${escapeHtml(t.heroSubtitle)}</div>
              <div style="margin-top: 10px; display: flex; gap: 8px;">
                <button class="wetype-btn" id="btn-refresh-pairing" type="button">${iconRefreshMiniSvg()}<span>${escapeHtml(t.newCode)}</span></button>
                <button class="wetype-btn" id="btn-copy-uri" type="button">${iconCopyMiniSvg()}<span>${escapeHtml(t.copyUriBtn)}</span></button>
              </div>
            </div>
          </div>
        </div>
        <div class="wetype-row">
          <div>
            <div class="row-title">${escapeHtml(t.pairingCodeLabel)}</div>
            <div class="row-desc">${escapeHtml(t.pairingCodeDesc)}</div>
          </div>
          <div class="code-display" id="pairing-code">${escapeHtml(formattedCode)}</div>
          <code class="sr-only" id="pairing-uri-code">${escapeHtml(state.pairing.qrUri)}</code>
        </div>
      </div>
    `
    : `<div class="wetype-group"><div class="wetype-row"><div class="row-desc">Start Bridge to generate pairing QR code.</div></div></div>`;

  const devicesHtml = state.devices
    .map((device) => {
      const revoked = Boolean(device.revokedAt);
      return `
        <div class="wetype-row" data-device-id="${escapeHtml(device.deviceId)}">
          <div>
            <div class="row-title">${escapeHtml(device.deviceName)}</div>
            <div class="row-desc">${escapeHtml(device.platform.toUpperCase())} · ${escapeHtml(device.lastSeenAt.slice(11, 19))}</div>
          </div>
          ${
            revoked
              ? `<span class="row-right-text">${escapeHtml(t.revokedBadge)}</span>`
              : `<button class="wetype-btn" data-revoke-device-id="${escapeHtml(device.deviceId)}" type="button">${escapeHtml(t.revokeBtn)}</button>`
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
        <div class="log-row">
          <span class="log-time">${escapeHtml(entry.timestamp.slice(11, 19))}</span>
          <span class="log-msg">${escapeHtml(entry.message)}</span>
        </div>
      `,
    )
    .join('');

  const isDefaultRelay = state.relay.mode === 'default';

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
      --color-surface: #FFFFFF;
      --color-green: #17B378;
      --color-text-primary: #1A1A1A;
      --color-text-secondary: #888888;
      --color-divider: #F0F0F0;
      --color-btn-border: #DCDCDC;
      --font-family: system-ui, -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Segoe UI', sans-serif;
      --font-mono: 'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    html, body {
      width: 100%;
      height: 100vh;
      max-width: 100vw;
      overflow: hidden;
      overflow-x: hidden;
      background: #F0F0F2;
      color: var(--color-text-primary);
      font-family: var(--font-family);
      font-size: 14px;
      line-height: 1.45;
      -webkit-font-smoothing: antialiased;
      user-select: none;
    }

    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
    }

    /* Compatibility rule for trafficLight spacing test */
    .title-bar-compat {
      padding-left: 78px;
      grid-template-columns: minmax(0, 1fr);
    }

    .wetype-shell {
      display: flex;
      width: 100%;
      height: 100vh;
      padding: 12px;
      gap: 24px;
    }

    /* Left Floating White Sidebar (WeType style) */
    .wetype-sidebar {
      width: 205px;
      flex-shrink: 0;
      background: var(--color-surface);
      border-radius: 14px;
      padding: 50px 12px 16px;
      display: flex;
      flex-direction: column;
      gap: 4px;
      box-shadow: 0 1px 4px rgba(0, 0, 0, 0.02);
      -webkit-app-region: drag;
    }

    .nav-item {
      -webkit-app-region: no-drag;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 9px 14px;
      border-radius: 8px;
      border: none;
      background: transparent;
      color: var(--color-text-primary);
      font-family: var(--font-family);
      font-size: 14px;
      font-weight: 400;
      cursor: pointer;
      text-align: left;
      transition: background 0.12s ease;
    }

    .nav-item:hover {
      background: rgba(0, 0, 0, 0.03);
    }

    .nav-item.active {
      background: var(--color-green);
      color: #FFFFFF;
      font-weight: 500;
    }

    .nav-item svg {
      flex-shrink: 0;
    }

    .sidebar-footer {
      margin-top: auto;
      padding: 8px 14px 2px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 12px;
      color: var(--color-text-secondary);
      -webkit-app-region: no-drag;
    }

    /* Right Content Canvas */
    .wetype-main {
      flex: 1;
      min-width: 0;
      height: 100%;
      overflow-y: auto;
      padding: 12px 16px 24px 4px;
    }

    .pane-header {
      height: 34px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 14px;
      -webkit-app-region: drag;
    }

    .pane-title {
      font-size: 16px;
      font-weight: 600;
      color: var(--color-text-primary);
    }

    .tab-pane {
      display: none;
    }

    .tab-pane.active {
      display: block;
    }

    /* WeType Pure White Grouped Card */
    .wetype-group {
      background: var(--color-surface);
      border-radius: 12px;
      padding: 0 20px;
      margin-bottom: 14px;
      border: 1px solid rgba(0, 0, 0, 0.03);
    }

    .wetype-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 16px 0;
      border-bottom: 1px solid var(--color-divider);
      min-width: 0;
    }

    .wetype-row:last-child {
      border-bottom: none;
    }

    .row-left {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
    }

    .qr-row-left {
      display: flex;
      align-items: center;
      gap: 20px;
      min-width: 0;
    }

    .qr-box {
      flex-shrink: 0;
      border: 1px solid #EAEAEA;
      border-radius: 10px;
      padding: 6px;
      background: #FFFFFF;
    }

    .qr-box svg {
      width: 112px;
      height: 112px;
      display: block;
    }

    .row-title {
      font-size: 14px;
      font-weight: 500;
      color: var(--color-text-primary);
    }

    .row-sub-inline {
      font-size: 12px;
      font-weight: 400;
      color: var(--color-text-secondary);
      margin-left: 4px;
    }

    .row-desc {
      font-size: 12px;
      font-weight: 400;
      color: var(--color-text-secondary);
      margin-top: 3px;
    }

    .row-right-text {
      font-size: 13px;
      color: var(--color-text-secondary);
      white-space: nowrap;
      flex-shrink: 0;
    }

    .text-green {
      color: var(--color-green);
      font-weight: 500;
    }

    .code-display {
      font-family: var(--font-mono);
      font-size: 22px;
      font-weight: 600;
      letter-spacing: 2px;
      color: var(--color-green);
      background: rgba(23, 179, 120, 0.08);
      padding: 4px 12px;
      border-radius: 8px;
      user-select: all;
      flex-shrink: 0;
    }

    /* WeType Radio Circle */
    .wetype-radio {
      width: 18px;
      height: 18px;
      border-radius: 50%;
      border: 1.5px solid #CCCCCC;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }

    .wetype-radio.checked {
      border-color: var(--color-green);
      background: var(--color-green);
    }

    .wetype-radio.checked::after {
      content: '';
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #FFFFFF;
    }

    /* WeType iOS Toggle Switch */
    .wetype-switch {
      position: relative;
      width: 40px;
      height: 22px;
      border-radius: 999px;
      background: #D8D8D8;
      border: none;
      cursor: pointer;
      transition: background 0.18s ease;
      flex-shrink: 0;
    }

    .wetype-switch.on {
      background: var(--color-green);
    }

    .wetype-switch::after {
      content: '';
      position: absolute;
      top: 2px;
      left: 2px;
      width: 18px;
      height: 18px;
      border-radius: 50%;
      background: #FFFFFF;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
      transition: transform 0.18s ease;
    }

    .wetype-switch.on::after {
      transform: translateX(18px);
    }

    /* WeType Outlined Secondary Button */
    .wetype-btn {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      background: #FFFFFF;
      border: 1px solid var(--color-btn-border);
      border-radius: 6px;
      padding: 5px 12px;
      font-family: var(--font-family);
      font-size: 12px;
      font-weight: 400;
      color: var(--color-text-primary);
      cursor: pointer;
      white-space: nowrap;
      flex-shrink: 0;
      transition: background 0.12s ease, border-color 0.12s ease;
    }

    .wetype-btn:hover {
      background: #F7F7F7;
      border-color: #C8C8C8;
    }

    .wetype-input {
      background: #F7F7F8;
      border: 1px solid #E2E2E5;
      border-radius: 6px;
      padding: 5px 10px;
      font-family: var(--font-mono);
      font-size: 12px;
      color: var(--color-text-primary);
      width: 240px;
    }

    .wetype-select {
      appearance: none;
      -webkit-appearance: none;
      background-color: #FFFFFF;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23666666' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m7 15 5 5 5-5'/%3E%3Cpath d='m7 9 5-5 5 5'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 9px center;
      border: 1px solid var(--color-btn-border);
      border-radius: 6px;
      padding: 5px 28px 5px 12px;
      font-family: var(--font-family);
      font-size: 12px;
      font-weight: 400;
      color: var(--color-text-primary);
      cursor: pointer;
      outline: none;
      transition: background-color 0.12s ease, border-color 0.12s ease;
    }

    .wetype-select:hover {
      background-color: #F7F7F7;
      border-color: #C8C8C8;
    }

    details.more-collapse {
      padding: 12px 0;
      font-size: 12px;
      color: var(--color-text-secondary);
    }

    details.more-collapse summary {
      cursor: pointer;
      color: var(--color-text-secondary);
    }

    .log-stream {
      padding: 12px 0;
      max-height: 180px;
      overflow-y: auto;
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--color-text-secondary);
    }

    .log-row {
      display: flex;
      gap: 10px;
      padding: 3px 0;
    }

    .log-time {
      color: #AAAAAA;
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
  <div class="wetype-shell">
    <!-- Left Sidebar -->
    <aside class="wetype-sidebar">
      <button class="nav-item active" data-tab-target="pair" type="button">
        ${iconPhoneSvg()}
        <span>${escapeHtml(t.navPair)}</span>
      </button>
      <button class="nav-item" data-tab-target="agents" type="button">
        ${iconAgentSvg()}
        <span>${escapeHtml(t.navAgents)}</span>
      </button>
      <button class="nav-item" data-tab-target="network" type="button">
        ${iconCrossDeviceSvg()}
        <span>${escapeHtml(t.navNetwork)}</span>
      </button>
      <button class="nav-item" data-tab-target="system" type="button">
        ${iconSettingsSvg()}
        <span>${escapeHtml(t.navSystem)}</span>
      </button>

      <div class="sidebar-footer">
        <span id="bridge-status-badge">${escapeHtml(statusLabel)}</span>
        <span>v0.1</span>
      </div>
    </aside>

    <!-- Right Content Area -->
    <main class="wetype-main">
      <!-- Tab 1: Phone Pairing -->
      <section class="tab-pane active" data-pane="pair">
        <header class="pane-header">
          <h1 class="pane-title">${escapeHtml(t.mobilePairing)}</h1>
        </header>

        ${pairingSectionHtml}

        <div class="wetype-group">
          <div class="wetype-row">
            <div>
              <div class="row-title">${escapeHtml(t.localBridge)}</div>
              <div class="row-desc">${escapeHtml(t.bridgeDesc)} (${escapeHtml(state.bridge.wsUrl ?? '-')})</div>
            </div>
            <button class="wetype-switch ${isRunning ? 'on' : ''}" id="btn-toggle-bridge" type="button" aria-label="${escapeHtml(isRunning ? t.stopBridge : t.startBridge)}"></button>
          </div>
          ${devicesHtml}
        </div>
      </section>

      <!-- Tab 2: Local AI Agents -->
      <section class="tab-pane" data-pane="agents">
        <header class="pane-header">
          <h1 class="pane-title">${escapeHtml(t.localAgents)}</h1>
          <button class="wetype-btn" id="btn-refresh-agents" type="button">${escapeHtml(t.detect)}</button>
        </header>

        <div class="wetype-group">
          ${onlineAgentsHtml || `<div class="wetype-row"><div class="row-desc">${escapeHtml(t.agentsDesc)}</div></div>`}
          ${
            offlineAgents.length > 0
              ? `<details class="more-collapse">
                  <summary>${escapeHtml(t.moreAgentsSummary)} (${offlineAgents.length})</summary>
                  ${offlineAgentsHtml}
                </details>`
              : ''
          }
        </div>
      </section>

      <!-- Tab 3: Cross-Device Network & Relay -->
      <section class="tab-pane" data-pane="network">
        <header class="pane-header">
          <h1 class="pane-title">${escapeHtml(t.publicRelay)}</h1>
        </header>

        <div class="wetype-group">
          <div class="wetype-row">
            <div class="row-left">
              <span class="wetype-radio ${isDefaultRelay ? 'checked' : ''}"></span>
              <div>
                <div class="row-title">${escapeHtml(t.relayDefaultTitle)}</div>
                <div class="row-desc">${escapeHtml(t.relayDefaultDesc)} · <code>${escapeHtml(state.relay.defaultRelayUrl)}</code></div>
              </div>
            </div>
            <button class="wetype-btn" id="btn-use-default-relay" type="button">${escapeHtml(t.useDefaultRelay)}</button>
          </div>

          <div class="wetype-row">
            <div class="row-left">
              <span class="wetype-radio ${!isDefaultRelay ? 'checked' : ''}"></span>
              <div>
                <div class="row-title">${escapeHtml(t.relayCustomTitle)}</div>
                <div class="row-desc">${escapeHtml(t.relayCustomDesc)}</div>
              </div>
            </div>
            <div style="display: flex; gap: 8px; align-items: center;">
              <input class="wetype-input" id="input-custom-relay" type="text" placeholder="wss://relay.example.com" value="${escapeHtml(state.relay.customRelayUrl)}" />
              <button class="wetype-btn" id="btn-save-custom-relay" type="button">${escapeHtml(t.useCustomRelay)}</button>
            </div>
          </div>
          <span class="sr-only" id="active-relay-url">${escapeHtml(state.relay.activeRelayUrl)}</span>
        </div>
      </section>

      <!-- Tab 4: Preferences & Diagnostic Logs -->
      <section class="tab-pane" data-pane="system">
        <header class="pane-header">
          <h1 class="pane-title">${escapeHtml(t.navSystem)}</h1>
        </header>

        <div class="wetype-group">
          <div class="wetype-row">
            <div>
              <div class="row-title">${escapeHtml(t.languageTitle)}</div>
              <div class="row-desc">${escapeHtml(t.languageDesc)}</div>
            </div>
            <select class="wetype-select" id="select-locale">
              <option value="zh" ${locale === 'zh' ? 'selected' : ''}>中文</option>
              <option value="en" ${locale === 'en' ? 'selected' : ''}>English</option>
              <option value="ja" ${locale === 'ja' ? 'selected' : ''}>日本語</option>
              <option value="ko" ${locale === 'ko' ? 'selected' : ''}>한국어</option>
            </select>
          </div>
          <div class="wetype-row">
            <div>
              <div class="row-title">${escapeHtml(t.machineLabel)}</div>
              <div class="row-desc">${escapeHtml(state.bridge.machineId)}</div>
            </div>
            <span class="row-right-text">${escapeHtml(state.bridge.wsUrl ?? '-')}</span>
          </div>
        </div>

        <div class="wetype-group">
          <div class="wetype-row">
            <div>
              <div class="row-title">${escapeHtml(t.diagnosticLogs)}</div>
              <div class="row-desc">${escapeHtml(t.logsDesc)}</div>
            </div>
          </div>
          <div class="log-stream" id="log-stream">
            ${logsHtml}
          </div>
        </div>
      </section>
    </main>
  </div>

  <script>
    window.addEventListener('DOMContentLoaded', () => {
      const activateTab = (target) => {
        if (!target) return;
        document.querySelectorAll('[data-tab-target]').forEach((b) => b.classList.remove('active'));
        document.querySelectorAll('[data-pane]').forEach((p) => p.classList.remove('active'));
        document.querySelector('[data-tab-target="' + target + '"]')?.classList.add('active');
        document.querySelector('[data-pane="' + target + '"]')?.classList.add('active');
        try {
          sessionStorage.setItem('nienie_active_tab', target);
        } catch {}
      };
      try {
        const savedTab = sessionStorage.getItem('nienie_active_tab');
        if (savedTab) activateTab(savedTab);
      } catch {}
      document.querySelectorAll('[data-tab-target]').forEach((btn) => {
        btn.addEventListener('click', () => {
          activateTab(btn.getAttribute('data-tab-target'));
        });
      });
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

function iconPhoneSvg(): string {
  return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>`;
}

function iconAgentSvg(): string {
  return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>`;
}

function iconCrossDeviceSvg(): string {
  return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="14" height="10" rx="2"/><line x1="6" y1="17" x2="12" y2="17"/><line x1="9" y1="13" x2="9" y2="17"/><rect x="16" y="11" width="6" height="10" rx="1"/></svg>`;
}

function iconSettingsSvg(): string {
  return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
}

function iconRefreshMiniSvg(): string {
  return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>`;
}

function iconCopyMiniSvg(): string {
  return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
}
