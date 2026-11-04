import type { DesktopDashboardState } from './controller.js';

export function renderDesktopAppHtml(state: DesktopDashboardState): string {
  const isRunning = state.bridge.status === 'running';
  const statusLabel = isRunning ? 'Running' : state.bridge.status === 'error' ? 'Error' : 'Stopped';
  const statusClass = isRunning ? 'badge-success' : state.bridge.status === 'error' ? 'badge-danger' : 'badge-muted';

  const agentsHtml = state.agents
    .map((agent) => {
      const onlineClass = agent.available ? 'badge-success' : 'badge-muted';
      const onlineText = agent.available ? 'Detected' : 'Unavailable';
      return `
        <div class="agent-row" data-agent-id="${escapeHtml(agent.id)}">
          <div class="agent-meta">
            <span class="agent-icon">${iconTerminalSvg()}</span>
            <div>
              <div class="agent-name">${escapeHtml(agent.name)} ${agent.version ? `<span class="agent-version">v${escapeHtml(agent.version)}</span>` : ''}</div>
              <div class="agent-caps">Streaming · Tool Calls · Session Resume · Cancel</div>
            </div>
          </div>
          <span class="badge ${onlineClass}">${onlineText}</span>
        </div>
      `;
    })
    .join('');

  const pairingHtml = state.pairing
    ? `
      <div class="pairing-content">
        <div class="qr-frame">${state.pairing.qrSvg}</div>
        <div class="pairing-details">
          <div class="field-label">One-Time Pairing Code</div>
          <div class="pairing-code" id="pairing-code">${escapeHtml(state.pairing.pairingCode)}</div>
          <div class="field-hint">Expires at ${escapeHtml(state.pairing.expiresAt)}</div>
          <div class="field-label" style="margin-top: var(--space-3);">Pairing URI</div>
          <code class="uri-box">${escapeHtml(state.pairing.qrUri)}</code>
        </div>
      </div>
    `
    : `<div class="empty-state">Start the local Bridge to generate a one-time pairing QR code.</div>`;

  const devicesHtml = state.devices
    .map((device) => {
      const revoked = Boolean(device.revokedAt);
      return `
        <div class="agent-row" data-device-id="${escapeHtml(device.deviceId)}">
          <div class="agent-meta">
            <div>
              <div class="agent-name">${escapeHtml(device.deviceName)} <span class="field-hint">(${escapeHtml(device.platform)})</span></div>
              <div class="field-hint">Last seen: ${escapeHtml(device.lastSeenAt)}</div>
            </div>
          </div>
          ${
            revoked
              ? `<span class="badge badge-danger">Revoked</span>`
              : `<button class="btn btn-secondary" data-revoke-device-id="${escapeHtml(device.deviceId)}">Revoke</button>`
          }
        </div>
      `;
    })
    .join('');

  const logsHtml = state.logs
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
  <title>Nienie Bridge Console</title>
  <style>
    :root {
      --color-bg-primary: #111111;
      --color-bg-secondary: #1A1A1A;
      --color-bg-elevated: #222222;
      --color-border: #2B2B2B;
      --color-text-primary: #F3F4F6;
      --color-text-secondary: #9CA3AF;
      --color-accent: #3B82F6;
      --color-accent-hover: #2563EB;
      --color-success: #10B981;
      --color-warning: #F59E0B;
      --color-danger: #EF4444;

      --space-1: 4px;
      --space-2: 8px;
      --space-3: 12px;
      --space-4: 16px;
      --space-5: 20px;
      --space-6: 24px;

      --radius-sm: 6px;
      --radius-md: 10px;
      --font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'SF Pro Text', sans-serif;
      --font-mono: 'SF Mono', 'JetBrains Mono', Menlo, monospace;
      --text-xs: 11px;
      --text-sm: 12px;
      --text-base: 13px;
      --text-lg: 15px;
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
      line-height: 1.5;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }

    .title-bar {
      height: 44px;
      padding-left: 78px;
      padding-right: var(--space-4);
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid var(--color-border);
      background: var(--color-bg-secondary);
      -webkit-app-region: drag;
      user-select: none;
    }

    .title-brand {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      font-weight: 600;
      font-size: var(--text-base);
    }

    .workspace-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: var(--space-4);
      padding: var(--space-4);
      flex: 1;
    }

    .card {
      background: var(--color-bg-secondary);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      padding: var(--space-4);
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
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
      gap: var(--space-2);
      font-size: var(--text-lg);
      font-weight: 600;
    }

    .btn {
      display: inline-flex;
      align-items: center;
      gap: var(--space-2);
      background: var(--color-accent);
      color: #FFFFFF;
      border: none;
      border-radius: var(--radius-sm);
      padding: var(--space-2) var(--space-3);
      font-size: var(--text-sm);
      font-weight: 500;
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

    .badge {
      display: inline-flex;
      align-items: center;
      padding: 2px var(--space-2);
      border-radius: 999px;
      font-size: var(--text-xs);
      font-weight: 600;
    }

    .badge-success {
      background: rgba(16, 185, 129, 0.16);
      color: var(--color-success);
    }

    .badge-danger {
      background: rgba(239, 68, 68, 0.16);
      color: var(--color-danger);
    }

    .badge-muted {
      background: var(--color-bg-elevated);
      color: var(--color-text-secondary);
    }

    .agent-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--space-2) var(--space-3);
      background: var(--color-bg-elevated);
      border-radius: var(--radius-sm);
    }

    .agent-meta {
      display: flex;
      align-items: center;
      gap: var(--space-3);
    }

    .agent-caps, .field-hint {
      font-size: var(--text-xs);
      color: var(--color-text-secondary);
    }

    .pairing-content {
      display: flex;
      align-items: center;
      gap: var(--space-4);
    }

    .pairing-code {
      font-family: var(--font-mono);
      font-size: 24px;
      font-weight: 700;
      letter-spacing: 3px;
      color: var(--color-accent);
    }

    .uri-box {
      display: block;
      font-family: var(--font-mono);
      font-size: var(--text-xs);
      padding: var(--space-2);
      background: var(--color-bg-primary);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      word-break: break-all;
    }

    .input {
      width: 100%;
      background: var(--color-bg-primary);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      color: var(--color-text-primary);
      padding: var(--space-2) var(--space-3);
      font-family: var(--font-mono);
      font-size: var(--text-sm);
    }

    .log-stream {
      background: var(--color-bg-primary);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      padding: var(--space-2);
      max-height: 180px;
      overflow-y: auto;
      font-family: var(--font-mono);
      font-size: var(--text-xs);
    }

    .log-row {
      display: flex;
      gap: var(--space-2);
      padding: 2px 0;
    }

    .log-time {
      color: var(--color-text-secondary);
    }
  </style>
</head>
<body>
  <header class="title-bar">
    <div class="title-brand">
      ${iconBridgeSvg()}
      <span>Nienie Bridge Console</span>
    </div>
    <span class="badge ${statusClass}" id="bridge-status-badge">${statusLabel}</span>
  </header>

  <main class="workspace-grid">
    <section class="card">
      <div class="card-header">
        <h2 class="card-title">${iconBridgeSvg()} Local Bridge</h2>
        <button class="btn" id="btn-toggle-bridge">${isRunning ? 'Stop Bridge' : 'Start Bridge'}</button>
      </div>
      <div class="field-hint">Machine ID: ${escapeHtml(state.bridge.machineId)}</div>
      <div class="field-hint">Endpoint: ${escapeHtml(state.bridge.wsUrl ?? 'Not listening')}</div>
      <div class="field-hint">Connected Mobile Devices: ${state.bridge.connectedClients}</div>
    </section>

    <section class="card">
      <div class="card-header">
        <h2 class="card-title">${iconTerminalSvg()} Local Agents</h2>
        <button class="btn btn-secondary" id="btn-refresh-agents">${iconRefreshSvg()} Detect</button>
      </div>
      ${agentsHtml || '<div class="field-hint">No agents detected yet.</div>'}
    </section>

    <section class="card">
      <div class="card-header">
        <h2 class="card-title">${iconQrSvg()} Mobile Pairing</h2>
        <button class="btn btn-secondary" id="btn-refresh-pairing">${iconRefreshSvg()} New Code</button>
      </div>
      ${pairingHtml}
      ${devicesHtml}
    </section>

    <section class="card">
      <div class="card-header">
        <h2 class="card-title">${iconGlobeSvg()} Public Relay</h2>
        <span class="badge badge-muted">${state.relay.mode === 'custom' ? 'Custom' : 'Default'}</span>
      </div>
      <div class="field-hint">Default Relay: <code>${escapeHtml(state.relay.defaultRelayUrl)}</code></div>
      <div class="field-hint">Active Relay: <code id="active-relay-url">${escapeHtml(state.relay.activeRelayUrl)}</code></div>
      <input class="input" id="input-custom-relay" type="text" placeholder="wss://relay.example.com" value="${escapeHtml(state.relay.customRelayUrl)}" />
      <div style="display: flex; gap: var(--space-2);">
        <button class="btn" id="btn-save-custom-relay">Use Custom Relay</button>
        <button class="btn btn-secondary" id="btn-use-default-relay">Use Default Relay</button>
      </div>
    </section>

    <section class="card card-full">
      <div class="card-header">
        <h2 class="card-title">${iconLogSvg()} Diagnostic Logs</h2>
      </div>
      <div class="log-stream" id="log-stream">
        ${logsHtml}
      </div>
    </section>
  </main>
  <script>
    window.addEventListener('DOMContentLoaded', () => {
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
  return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10a8 8 0 0 1 16 0"/><path d="M2 14h20"/><path d="M6 14v6"/><path d="M18 14v6"/></svg>`;
}

function iconTerminalSvg(): string {
  return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>`;
}

function iconQrSvg(): string {
  return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><path d="M14 14h7v7h-7z"/></svg>`;
}

function iconGlobeSvg(): string {
  return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`;
}

function iconRefreshSvg(): string {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>`;
}

function iconLogSvg(): string {
  return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/></svg>`;
}
