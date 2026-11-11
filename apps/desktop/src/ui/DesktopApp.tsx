import React, { useEffect, useState } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import * as Switch from '@radix-ui/react-switch';
import * as Select from '@radix-ui/react-select';
import * as Collapsible from '@radix-ui/react-collapsible';
import * as Dialog from '@radix-ui/react-dialog';
import { Toaster, toast } from 'sonner';
import {
  Bell,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Globe,
  Laptop,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import type { DesktopDashboardState, DesktopPreloadApi } from '../controller.js';
import { DESKTOP_I18N, type DesktopLocale } from '../i18n.js';
import { renderAgentBrandLogo } from './AgentBrandIcons.js';

declare global {
  interface Window {
    nienieDesktop?: DesktopPreloadApi & {
      setLocale?: (locale: DesktopLocale) => Promise<DesktopDashboardState>;
    };
    __NIENIE_INITIAL_STATE__?: DesktopDashboardState;
    __NIENIE_REFRESH_STATE__?: () => Promise<void>;
  }
}

export type DesktopAppProps = {
  initialState: DesktopDashboardState;
  initialLocale?: DesktopLocale | undefined;
};

const LOCALE_LABELS: Record<DesktopLocale, string> = {
  zh: '中文 (简体)',
  en: 'English',
  ja: '日本語',
  ko: '한국어',
};

export function DesktopApp({ initialState, initialLocale }: DesktopAppProps) {
  const [state, setState] = useState<DesktopDashboardState>(() => ({
    ...initialState,
    locale: initialLocale ?? initialState.locale ?? 'zh',
  }));
  const [activeTab, setActiveTab] = useState<string>('pair');
  const [customRelayInput, setCustomRelayInput] = useState<string>(
    initialState.relay.customRelayUrl,
  );
  const [notifWebhookInput, setNotifWebhookInput] = useState<string>('');
  const [notifQuietStart, setNotifQuietStart] = useState<string>('');
  const [notifQuietEnd, setNotifQuietEnd] = useState<string>('');
  const [notifMutedInput, setNotifMutedInput] = useState<string>('');
  const [notifEnabled, setNotifEnabled] = useState<boolean>(true);
  const [notifType, setNotifType] = useState<'auto' | 'bark' | 'ntfy' | 'webhook'>('auto');
  const [notifDetailed, setNotifDetailed] = useState<boolean>(false);
  const [notifTestState, setNotifTestState] = useState<'idle' | 'sending' | 'ok' | 'fail'>('idle');
  const [machineNameInput, setMachineNameInput] = useState<string>(
    initialState.bridge.machineId,
  );
  const [isRefreshingAgents, setIsRefreshingAgents] = useState<boolean>(false);
  const [copiedTarget, setCopiedTarget] = useState<string | null>(null);
  const [offlineAgentsOpen, setOfflineAgentsOpen] = useState<boolean>(false);
  const [feedbackOpen, setFeedbackOpen] = useState<boolean>(false);
  const [appreciateOpen, setAppreciateOpen] = useState<boolean>(false);
  const [legalDialog, setLegalDialog] = useState<'terms' | 'privacy' | null>(null);

  const locale: DesktopLocale = state.locale ?? 'zh';
  const t = DESKTOP_I18N[locale] ?? DESKTOP_I18N.zh;
  const isRunning = state.bridge.status === 'running';
  const statusLabel = isRunning
    ? t.running
    : state.bridge.status === 'error'
      ? t.error
      : t.stopped;

  useEffect(() => {
    try {
      const savedTab = window.sessionStorage.getItem('nienie_active_tab');
      if (savedTab) {
        setActiveTab(savedTab);
      }
    } catch {
      // Ignore storage errors
    }

    window.__NIENIE_REFRESH_STATE__ = async () => {
      try {
        const res = await fetch('/api/state');
        if (res.ok) {
          const fresh = (await res.json()) as DesktopDashboardState;
          setState(fresh);
        }
      } catch {
        // Ignore network errors
      }
    };

    const pollTimer = window.setInterval(() => {
      void window.__NIENIE_REFRESH_STATE__?.();
    }, 2500);

    return () => {
      window.clearInterval(pollTimer);
    };
  }, []);

  const handleTabChange = (nextTab: string) => {
    setActiveTab(nextTab);
    try {
      window.sessionStorage.setItem('nienie_active_tab', nextTab);
    } catch {
      // Ignore storage errors
    }
  };

  const markCopied = (key: string, message: string) => {
    setCopiedTarget(key);
    toast.success(message);
    window.setTimeout(() => {
      setCopiedTarget((prev) => (prev === key ? null : prev));
    }, 1800);
  };

  const handleCopyText = async (key: string, text: string) => {
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(text);
      }
      markCopied(key, t.copiedText);
    } catch {
      toast.error('Copy failed');
    }
  };

  const handleToggleBridge = async () => {
    const api = window.nienieDesktop;
    if (!api) return;
    try {
      const next = isRunning ? await api.stopBridge() : await api.startBridge();
      if (next && next.bridge) {
        setState(next);
        toast.success(next.bridge.status === 'running' ? t.toastBridgeStarted : t.toastBridgeStopped);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Bridge operation failed');
    }
  };

  const handleRefreshPairing = async () => {
    const api = window.nienieDesktop;
    if (!api) return;
    try {
      const next = await api.refreshPairing();
      if (next && next.bridge) {
        setState(next);
        toast.success(t.toastCodeRefreshed);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to refresh pairing code');
    }
  };

  const handleRefreshAgents = async () => {
    const api = window.nienieDesktop;
    if (!api) return;
    setIsRefreshingAgents(true);
    try {
      const next = await api.refreshAgents();
      if (next && next.bridge) {
        setState(next);
        toast.success(t.toastAgentsRefreshed);
      }
    } finally {
      window.setTimeout(() => setIsRefreshingAgents(false), 320);
    }
  };

  const handleUseDefaultRelay = async () => {
    const api = window.nienieDesktop;
    if (!api) return;
    try {
      const next = await api.setRelay({ mode: 'default' });
      if (next && next.bridge) {
        setState(next);
        toast.success(t.toastSaved);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Relay update failed');
    }
  };

  const handleSaveCustomRelay = async () => {
    const api = window.nienieDesktop;
    if (!api) return;
    try {
      const next = await api.setRelay({
        mode: 'custom',
        customRelayUrl: customRelayInput.trim(),
      });
      if (next && next.bridge) {
        setState(next);
        toast.success(t.toastSaved);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Invalid Relay URL');
    }
  };

  React.useEffect(() => {
    const n = state.notifications;
    if (!n) return;
    setNotifWebhookInput(n.webhookUrl);
    setNotifQuietStart(n.quietStart);
    setNotifQuietEnd(n.quietEnd);
    setNotifMutedInput(n.mutedSessionIds.join(', '));
    setNotifEnabled(n.enabled);
    setNotifType(n.senderType ?? 'auto');
    setNotifDetailed(n.detailed ?? false);
  }, [state.notifications]);

  const handleSaveNotifications = async () => {
    const api = window.nienieDesktop;
    if (!api?.setNotifications) return;
    try {
      const next = await api.setNotifications({
        enabled: notifEnabled,
        webhookUrl: notifWebhookInput.trim(),
        senderType: notifType,
        detailed: notifDetailed,
        quietStart: notifQuietStart.trim(),
        quietEnd: notifQuietEnd.trim(),
        mutedSessionIds: notifMutedInput.split(',').map((id) => id.trim()).filter(Boolean),
      });
      if (next && next.bridge) {
        setState(next);
        toast.success(t.toastSaved);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t.notificationTestFail);
    }
  };

  const handleTestNotification = async () => {
    const api = window.nienieDesktop;
    if (!api?.testNotification) return;
    setNotifTestState('sending');
    try {
      await api.testNotification({ webhookUrl: notifWebhookInput.trim(), senderType: notifType });
      setNotifTestState('ok');
      toast.success(t.notificationTestOk);
    } catch (error) {
      setNotifTestState('fail');
      toast.error(error instanceof Error ? error.message : t.notificationTestFail);
    }
  };

  const handleLocaleChange = async (nextLocale: string) => {
    const validLocale = nextLocale as DesktopLocale;
    setState((prev) => ({ ...prev, locale: validLocale }));
    const nextT = DESKTOP_I18N[validLocale] ?? DESKTOP_I18N.zh;
    const api = window.nienieDesktop;
    if (api?.setLocale) {
      const next = await api.setLocale(validLocale);
      if (next && next.bridge) {
        setState(next);
      }
    }
    toast.success(nextT.toastSaved);
  };

  const handleSaveMachineName = async () => {
    const trimmed = machineNameInput.trim();
    if (!trimmed) return;
    const api = window.nienieDesktop;
    if (!api) return;
    try {
      const next = await api.setMachineName(trimmed);
      if (next && next.bridge) {
        setState(next);
        setMachineNameInput(next.bridge.machineId);
        toast.success(t.toastSaved);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update name');
    }
  };

  const handleToggleAutoUpdate = async (checked: boolean) => {
    setState((prev) => ({ ...prev, autoUpdate: checked }));
    const api = window.nienieDesktop;
    if (!api) return;
    try {
      const next = await api.setAutoUpdate(checked);
      if (next && next.bridge) {
        setState(next);
        toast.success(t.toastSaved);
      }
    } catch {
      // Ignore errors
    }
  };

  const handleRevokeDevice = async (deviceId: string) => {
    const api = window.nienieDesktop;
    if (!api) return;
    try {
      const next = await api.revokeDevice(deviceId);
      if (next && next.bridge) {
        setState(next);
        toast.success(t.toastDeviceRevoked);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Revoke failed');
    }
  };

  const handleCopyDiagnostics = () => {
    const diag = JSON.stringify(
      {
        version: '0.1.0(100)',
        machineId: state.bridge.machineId,
        bridgeStatus: state.bridge.status,
        wsUrl: state.bridge.wsUrl ?? null,
        relayMode: state.relay.mode,
        activeAgents: state.agents.filter((a) => a.available).map((a) => a.id),
      },
      null,
      2,
    );
    void handleCopyText('diag', diag);
  };

  const onlineAgents = state.agents.filter((a) => a.available);
  const offlineAgents = state.agents.filter((a) => !a.available);
  const formattedCode = state.pairing
    ? `${state.pairing.pairingCode.slice(0, 3)} ${state.pairing.pairingCode.slice(3)}`
    : '--- ---';
  const isDefaultRelay = state.relay.mode === 'default';

  const renderAgentRow = (agent: DesktopDashboardState['agents'][number]) => (
    <div className="wetype-row" key={agent.id} data-agent-id={agent.id}>
      <div className="row-left">
        <div className={`agent-brand-box ${agent.available ? 'available' : 'offline'}`}>
          {renderAgentBrandLogo(agent.id)}
        </div>
        <div>
          <div className="row-title">
            <span>{agent.name}</span>
            {agent.version ? <span className="row-sub-inline">v{agent.version}</span> : null}
          </div>
        </div>
      </div>
      <span className={`badge-pill ${agent.available ? 'ready' : ''}`}>
        <span className={`status-dot ${agent.available ? 'running' : ''}`} />
        <span>{agent.available ? t.detectedBadge : t.unavailableBadge}</span>
      </span>
    </div>
  );

  return (
    <>
      <Tabs.Root value={activeTab} onValueChange={handleTabChange} className="wetype-shell">
        {/* Left Floating Sidebar */}
        <aside className="wetype-sidebar">
          <Tabs.List className="nav-list" aria-label={t.appTitle}>
            <Tabs.Trigger value="pair" className="nav-item" data-tab-target="pair">
              <Smartphone size={17} strokeWidth={1.9} />
              <span>{t.navPair}</span>
            </Tabs.Trigger>
            <Tabs.Trigger value="agents" className="nav-item" data-tab-target="agents">
              <Bot size={17} strokeWidth={1.9} />
              <span>{t.navAgents}</span>
            </Tabs.Trigger>
            <Tabs.Trigger value="network" className="nav-item" data-tab-target="network">
              <Globe size={17} strokeWidth={1.9} />
              <span>{t.navNetwork}</span>
            </Tabs.Trigger>
            <Tabs.Trigger value="system" className="nav-item" data-tab-target="system">
              <SlidersHorizontal size={17} strokeWidth={1.9} />
              <span>{t.navSystem}</span>
            </Tabs.Trigger>
            <Tabs.Trigger value="about" className="nav-item" data-tab-target="about">
              <Sparkles size={17} strokeWidth={1.9} />
              <span>{t.navAbout}</span>
            </Tabs.Trigger>
          </Tabs.List>

          <div className="sidebar-footer">
            <span className="status-pill-mini" id="bridge-status-badge">
              <span
                className={`status-dot ${
                  isRunning ? 'running' : state.bridge.status === 'error' ? 'error' : ''
                }`}
              />
              <span>{statusLabel}</span>
            </span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11px' }}>v0.1.0</span>
          </div>
        </aside>

        {/* Right Content Canvas */}
        <main className="wetype-main">
          {/* Tab 1: Phone Pairing */}
          <Tabs.Content value="pair" forceMount className="tab-pane" data-pane="pair">
            <header className="pane-header">
              <h1 className="pane-title">{t.mobilePairing}</h1>
            </header>

            {state.pairing ? (
              <div className="wetype-group">
                <div className="wetype-row" style={{ padding: '20px 0' }}>
                  <div className="qr-row-left">
                    <div
                      className="qr-box"
                      dangerouslySetInnerHTML={{ __html: state.pairing.qrSvg }}
                    />
                    <div>
                      <div className="row-title" style={{ fontSize: '15px', fontWeight: 600 }}>
                        {t.heroTitle}
                      </div>
                      <div className="row-desc" style={{ marginTop: '4px' }}>
                        {t.heroSubtitle}
                      </div>
                      <div style={{ marginTop: '12px', display: 'flex', gap: '8px' }}>
                        <button
                          className="wetype-btn"
                          id="btn-refresh-pairing"
                          type="button"
                          onClick={handleRefreshPairing}
                        >
                          <RefreshCw size={13} strokeWidth={2} />
                          <span>{t.newCode}</span>
                        </button>
                        <button
                          className="wetype-btn"
                          id="btn-copy-uri"
                          type="button"
                          onClick={() =>
                            state.pairing && handleCopyText('uri', state.pairing.qrUri)
                          }
                        >
                          {copiedTarget === 'uri' ? (
                            <Check size={13} strokeWidth={2.2} color="#17B378" />
                          ) : (
                            <Copy size={13} strokeWidth={2} />
                          )}
                          <span>{copiedTarget === 'uri' ? t.copiedText : t.copyUriBtn}</span>
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="wetype-row">
                  <div>
                    <div className="row-title">{t.pairingCodeLabel}</div>
                    <div className="row-desc">{t.pairingCodeDesc}</div>
                  </div>
                  <div className="code-display-wrap">
                    <div
                      className="code-display"
                      id="pairing-code"
                      title={t.copyUriBtn}
                      onClick={() =>
                        state.pairing && handleCopyText('code', state.pairing.pairingCode)
                      }
                    >
                      {formattedCode}
                    </div>
                    <code className="sr-only" id="pairing-uri-code">
                      {state.pairing.qrUri}
                    </code>
                  </div>
                </div>
              </div>
            ) : (
              <div className="wetype-group">
                <div className="wetype-row">
                  <div className="row-desc">{t.bridgeDesc}</div>
                </div>
              </div>
            )}

            <div className="wetype-group">
              <div className="wetype-row">
                <div className="row-left">
                  <div className={`agent-icon-box ${isRunning ? 'available' : ''}`}>
                    <ShieldCheck size={16} strokeWidth={1.85} />
                  </div>
                  <div>
                    <div className="row-title">{t.localBridge}</div>
                    <div className="row-desc">
                      {t.bridgeDesc} · <code>{state.bridge.wsUrl ?? '-'}</code>
                    </div>
                  </div>
                </div>
                <Switch.Root
                  className={`wetype-switch ${isRunning ? 'on' : ''}`}
                  id="btn-toggle-bridge"
                  checked={isRunning}
                  onCheckedChange={handleToggleBridge}
                  aria-label={isRunning ? t.stopBridge : t.startBridge}
                >
                  <Switch.Thumb className="wetype-switch-thumb" />
                </Switch.Root>
              </div>

              {state.devices.map((device) => {
                const revoked = Boolean(device.revokedAt);
                return (
                  <div
                    className="wetype-row"
                    key={device.deviceId}
                    data-device-id={device.deviceId}
                  >
                    <div className="row-left">
                      <div className={`agent-icon-box ${!revoked ? 'available' : ''}`}>
                        <Smartphone size={15} strokeWidth={1.85} />
                      </div>
                      <div>
                        <div className="row-title">{device.deviceName}</div>
                        <div className="row-desc">
                          {device.platform.toUpperCase()} · {device.lastSeenAt.slice(11, 19)}
                        </div>
                      </div>
                    </div>
                    {revoked ? (
                      <span className="badge-pill">{t.revokedBadge}</span>
                    ) : (
                      <button
                        className="wetype-btn danger-ghost"
                        data-revoke-device-id={device.deviceId}
                        type="button"
                        onClick={() => handleRevokeDevice(device.deviceId)}
                      >
                        <Trash2 size={12.5} strokeWidth={2} />
                        <span>{t.revokeBtn}</span>
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </Tabs.Content>

          {/* Tab 2: Local AI Agents */}
          <Tabs.Content value="agents" forceMount className="tab-pane" data-pane="agents">
            <header className="pane-header">
              <h1 className="pane-title">{t.localAgents}</h1>
              <button
                className="wetype-btn"
                id="btn-refresh-agents"
                type="button"
                disabled={isRefreshingAgents}
                onClick={handleRefreshAgents}
              >
                <RefreshCw
                  size={13}
                  strokeWidth={2}
                  className={isRefreshingAgents ? 'spin-anim' : ''}
                />
                <span>{isRefreshingAgents ? t.detecting : t.detect}</span>
              </button>
            </header>

            <div className="wetype-group">
              {onlineAgents.length > 0 ? (
                onlineAgents.map(renderAgentRow)
              ) : (
                <div className="wetype-row">
                  <div className="row-desc">{t.agentsDesc}</div>
                </div>
              )}

              {offlineAgents.length > 0 ? (
                <Collapsible.Root open={offlineAgentsOpen} onOpenChange={setOfflineAgentsOpen}>
                  <Collapsible.Trigger className="collapsible-trigger-row" type="button">
                    <span>
                      {t.moreAgentsSummary} ({offlineAgents.length})
                    </span>
                    <ChevronRight
                      size={15}
                      strokeWidth={2}
                      className={`chevron-rotate ${offlineAgentsOpen ? 'open' : ''}`}
                    />
                  </Collapsible.Trigger>
                  <Collapsible.Content>{offlineAgents.map(renderAgentRow)}</Collapsible.Content>
                </Collapsible.Root>
              ) : null}
            </div>
          </Tabs.Content>

          {/* Tab 3: Cross-Device Network & Relay */}
          <Tabs.Content value="network" forceMount className="tab-pane" data-pane="network">
            <header className="pane-header">
              <h1 className="pane-title">{t.publicRelay}</h1>
            </header>

            <div className="wetype-group">
              <div
                className="wetype-row interactive"
                id="row-use-default-relay"
                onClick={handleUseDefaultRelay}
              >
                <div className="row-left">
                  <span className={`wetype-radio ${isDefaultRelay ? 'checked' : ''}`} />
                  <div>
                    <div className="row-title">{t.relayDefaultTitle}</div>
                    <div className="row-desc">
                      {t.relayDefaultDesc} · <code>{state.relay.defaultRelayUrl}</code>
                    </div>
                  </div>
                </div>
                <button
                  className="wetype-btn"
                  id="btn-use-default-relay"
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleUseDefaultRelay();
                  }}
                >
                  {t.useDefaultRelay}
                </button>
              </div>

              <div
                className="wetype-row"
                style={{ flexDirection: 'column', alignItems: 'stretch', gap: '11px' }}
              >
                <div className="row-left">
                  <span className={`wetype-radio ${!isDefaultRelay ? 'checked' : ''}`} />
                  <div>
                    <div className="row-title">{t.relayCustomTitle}</div>
                    <div className="row-desc">{t.relayCustomDesc}</div>
                  </div>
                </div>
                <div
                  style={{
                    display: 'flex',
                    gap: '8px',
                    alignItems: 'center',
                    paddingLeft: '30px',
                  }}
                >
                  <input
                    className="wetype-input"
                    id="input-custom-relay"
                    style={{ flex: 1, width: 'auto' }}
                    type="text"
                    placeholder="wss://relay.example.com"
                    value={customRelayInput}
                    onChange={(e) => setCustomRelayInput(e.target.value)}
                  />
                  <button
                    className="wetype-btn primary"
                    id="btn-save-custom-relay"
                    type="button"
                    onClick={handleSaveCustomRelay}
                  >
                    {t.useCustomRelay}
                  </button>
                </div>
              </div>
              <span className="sr-only" id="active-relay-url">
                {state.relay.activeRelayUrl}
              </span>
            </div>
          </Tabs.Content>

          {/* Tab 4: Preferences & Diagnostic Logs */}
          <Tabs.Content value="system" forceMount className="tab-pane" data-pane="system">
            <header className="pane-header">
              <h1 className="pane-title">{t.navSystem}</h1>
            </header>

            <div className="wetype-group">
              <div className="wetype-row">
                <div className="row-left">
                  <div className="agent-icon-box">
                    <Globe size={15} strokeWidth={1.85} />
                  </div>
                  <div>
                    <div className="row-title">{t.languageTitle}</div>
                    <div className="row-desc">{t.languageDesc}</div>
                  </div>
                </div>

                {/* Radix Select Dropdown */}
                <Select.Root value={locale} onValueChange={handleLocaleChange}>
                  <Select.Trigger
                    className="radix-select-trigger"
                    id="select-locale"
                    aria-label={t.languageTitle}
                  >
                    <Select.Value>{LOCALE_LABELS[locale]}</Select.Value>
                    <Select.Icon>
                      <ChevronDown size={14} strokeWidth={2} color="#6E7178" />
                    </Select.Icon>
                  </Select.Trigger>
                  <Select.Portal>
                    <Select.Content
                      className="radix-select-content"
                      position="popper"
                      sideOffset={6}
                      align="end"
                    >
                      <Select.Viewport>
                        {(['zh', 'en', 'ja', 'ko'] as const).map((langKey) => (
                          <Select.Item
                            key={langKey}
                            value={langKey}
                            className="radix-select-item"
                          >
                            <Select.ItemText>{LOCALE_LABELS[langKey]}</Select.ItemText>
                            <Select.ItemIndicator>
                              <Check size={14} strokeWidth={2.3} color="#17B378" />
                            </Select.ItemIndicator>
                          </Select.Item>
                        ))}
                      </Select.Viewport>
                    </Select.Content>
                  </Select.Portal>
                </Select.Root>
              </div>

              <div
                className="wetype-row"
                style={{ flexDirection: 'column', alignItems: 'stretch', gap: '11px' }}
              >
                <div className="row-left">
                  <div className="agent-icon-box">
                    <Laptop size={15} strokeWidth={1.85} />
                  </div>
                  <div>
                    <div className="row-title">{t.machineLabel}</div>
                    <div className="row-desc">
                      {t.machineDesc} · <code>{state.bridge.wsUrl ?? '-'}</code>
                    </div>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center', paddingLeft: '44px' }}>
                  <input
                    className="wetype-input"
                    id="input-machine-name"
                    style={{ flex: 1, width: 'auto' }}
                    type="text"
                    value={machineNameInput}
                    onChange={(e) => setMachineNameInput(e.target.value)}
                  />
                  <button
                    className="wetype-btn primary"
                    id="btn-save-machine-name"
                    type="button"
                    onClick={handleSaveMachineName}
                  >
                    {t.saveMachineBtn}
                  </button>
                </div>
              </div>
            </div>

            <div className="wetype-group">
              <div className="wetype-row">
                <div className="row-left">
                  <div className="agent-icon-box">
                    <Bell size={15} strokeWidth={1.85} />
                  </div>
                  <div>
                    <div className="row-title">{t.notificationTitle}</div>
                    <div className="row-desc">{t.notificationDesc}</div>
                  </div>
                </div>
                <input
                  type="checkbox"
                  id="toggle-notif-enabled"
                  checked={notifEnabled}
                  onChange={(e) => setNotifEnabled(e.target.checked)}
                />
              </div>
              <div
                className="wetype-row"
                style={{ flexDirection: 'column', alignItems: 'stretch', gap: '11px' }}
              >
                <div>
                  <div className="row-title">{t.notificationWebhookLabel}</div>
                  <div className="row-desc">{t.notificationWebhookPlaceholder}</div>
                </div>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <input
                    className="wetype-input"
                    id="input-notif-webhook"
                    style={{ flex: 1, width: 'auto' }}
                    type="text"
                    placeholder={t.notificationWebhookPlaceholder}
                    value={notifWebhookInput}
                    onChange={(e) => setNotifWebhookInput(e.target.value)}
                  />
                  <button
                    className="wetype-btn"
                    id="btn-test-notification"
                    type="button"
                    disabled={notifTestState === 'sending'}
                    onClick={handleTestNotification}
                  >
                    {t.notificationTestBtn}
                  </button>
                  <button
                    className="wetype-btn primary"
                    id="btn-save-notifications"
                    type="button"
                    onClick={handleSaveNotifications}
                  >
                    {t.saveMachineBtn}
                  </button>
                </div>
              </div>
              <div
                className="wetype-row"
                style={{ flexDirection: 'column', alignItems: 'stretch', gap: '11px' }}
              >
                <div>
                  <div className="row-title">{t.notificationTypeLabel}</div>
                </div>
                <select
                  className="wetype-input"
                  id="select-notif-type"
                  value={notifType}
                  onChange={(e) => setNotifType(e.target.value as 'auto' | 'bark' | 'ntfy' | 'webhook')}
                >
                  <option value="auto">{t.notificationTypeAuto}</option>
                  <option value="bark">{t.notificationTypeBark}</option>
                  <option value="ntfy">{t.notificationTypeNtfy}</option>
                  <option value="webhook">{t.notificationTypeWebhook}</option>
                </select>
              </div>
              <div className="wetype-row">
                <div className="row-left">
                  <div>
                    <div className="row-title">{t.notificationDetailedLabel}</div>
                    <div className="row-desc">{t.notificationDetailedDesc}</div>
                  </div>
                </div>
                <input
                  type="checkbox"
                  id="toggle-notif-detailed"
                  checked={notifDetailed}
                  onChange={(e) => setNotifDetailed(e.target.checked)}
                />
              </div>
              <div className="wetype-row">
                <div>
                  <div className="row-desc" id="notif-privacy-notice">{t.notificationPrivacyNotice}</div>
                </div>
              </div>
              <div
                className="wetype-row"
                style={{ flexDirection: 'column', alignItems: 'stretch', gap: '11px' }}
              >
                <div>
                  <div className="row-title">{t.notificationQuietLabel}</div>
                  <div className="row-desc">{t.notificationQuietDesc}</div>
                </div>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <input
                    className="wetype-input"
                    id="input-notif-quiet-start"
                    type="text"
                    placeholder="22:00"
                    style={{ width: '96px' }}
                    value={notifQuietStart}
                    onChange={(e) => setNotifQuietStart(e.target.value)}
                  />
                  <span>→</span>
                  <input
                    className="wetype-input"
                    id="input-notif-quiet-end"
                    type="text"
                    placeholder="08:00"
                    style={{ width: '96px' }}
                    value={notifQuietEnd}
                    onChange={(e) => setNotifQuietEnd(e.target.value)}
                  />
                </div>
              </div>
              <div
                className="wetype-row"
                style={{ flexDirection: 'column', alignItems: 'stretch', gap: '11px' }}
              >
                <div>
                  <div className="row-title">{t.notificationMutedLabel}</div>
                  <div className="row-desc">{t.notificationMutedDesc}</div>
                </div>
                <input
                  className="wetype-input"
                  id="input-notif-muted"
                  type="text"
                  value={notifMutedInput}
                  onChange={(e) => setNotifMutedInput(e.target.value)}
                />
              </div>
            </div>

            <div className="wetype-group">
              <div className="wetype-row">
                <div>
                  <div className="row-title">{t.diagnosticLogs}</div>
                  <div className="row-desc">{t.logsDesc}</div>
                </div>
                <span className="badge-pill">{state.logs.length}</span>
              </div>
              <div className="log-stream" id="log-stream">
                {state.logs
                  .slice(-25)
                  .reverse()
                  .map((entry) => (
                    <div className="log-row" key={entry.id}>
                      <span className="log-time">{entry.timestamp.slice(11, 19)}</span>
                      <span className={`log-level ${entry.level}`}>{entry.level}</span>
                      <span className="log-msg">{entry.message}</span>
                    </div>
                  ))}
              </div>
            </div>
          </Tabs.Content>

          {/* Tab 5: Upgrade & Feedback */}
          <Tabs.Content value="about" forceMount className="tab-pane" data-pane="about">
            <div className="about-pane-inner">
              <div className="about-hero">
                <div className="about-app-icon">
                  <img src="/assets/nienie-logo.png" width="76" height="76" alt="" />
                </div>
                <div className="about-app-name">Nienie</div>
                <div className="about-app-version">0.1.0 (100)</div>
              </div>

              <div className="wetype-group">
                <div className="wetype-row">
                  <div>
                    <div className="row-title">{t.autoUpdateTitle}</div>
                    <div className="row-desc">{t.autoUpdateDesc}</div>
                  </div>
                  <Switch.Root
                    className={`wetype-switch ${state.autoUpdate !== false ? 'on' : ''}`}
                    id="btn-toggle-auto-update"
                    checked={state.autoUpdate !== false}
                    onCheckedChange={handleToggleAutoUpdate}
                    aria-label={t.autoUpdateTitle}
                  >
                    <Switch.Thumb className="wetype-switch-thumb" />
                  </Switch.Root>
                </div>

                {/* Collapsible: Send Feedback */}
                <Collapsible.Root open={feedbackOpen} onOpenChange={setFeedbackOpen}>
                  <Collapsible.Trigger
                    className="wetype-row interactive"
                    id="row-toggle-feedback"
                    style={{ width: '100%', background: 'none', borderTop: 'none', borderLeft: 'none', borderRight: 'none' }}
                    type="button"
                  >
                    <div className="row-title">{t.feedbackTitle}</div>
                    <ChevronRight
                      size={16}
                      strokeWidth={2}
                      className={`chevron-rotate ${feedbackOpen ? 'open' : ''}`}
                    />
                  </Collapsible.Trigger>
                  <Collapsible.Content className="expand-drawer" id="drawer-feedback">
                    <div className="row-desc" style={{ marginBottom: '10px' }}>
                      {t.feedbackDesc}
                    </div>
                    <button
                      className="wetype-btn"
                      id="btn-copy-diagnostics"
                      type="button"
                      onClick={handleCopyDiagnostics}
                    >
                      {copiedTarget === 'diag' ? (
                        <Check size={13} strokeWidth={2.2} color="#17B378" />
                      ) : (
                        <Copy size={13} strokeWidth={2} />
                      )}
                      <span>{copiedTarget === 'diag' ? t.copiedText : t.copyDiagBtn}</span>
                    </button>
                  </Collapsible.Content>
                </Collapsible.Root>

                {/* Collapsible: Appreciate & Support */}
                <Collapsible.Root open={appreciateOpen} onOpenChange={setAppreciateOpen}>
                  <Collapsible.Trigger
                    className="wetype-row interactive"
                    id="row-toggle-appreciate"
                    style={{
                      width: '100%',
                      background: 'none',
                      border: 'none',
                    }}
                    type="button"
                  >
                    <div className="row-title">{t.appreciateTitle}</div>
                    <ChevronRight
                      size={16}
                      strokeWidth={2}
                      className={`chevron-rotate ${appreciateOpen ? 'open' : ''}`}
                    />
                  </Collapsible.Trigger>
                  <Collapsible.Content
                    className="expand-drawer"
                    id="drawer-appreciate"
                    style={{ borderBottom: 'none', textAlign: 'center' }}
                  >
                    <div className="row-desc" style={{ marginBottom: '12px' }}>
                      {t.appreciateDesc}
                    </div>
                    <img
                      src="/assets/wechat-appreciate.jpg"
                      alt="WeChat Appreciate QR"
                      style={{
                        maxWidth: '180px',
                        borderRadius: '12px',
                        border: '1px solid rgba(0, 0, 0, 0.08)',
                        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.06)',
                      }}
                    />
                  </Collapsible.Content>
                </Collapsible.Root>
              </div>

              <footer className="about-footer">
                <div>{t.copyrightOwner}</div>
                <div>Copyright © 2026 ponponon. All rights reserved.</div>
                <div className="about-links">
                  <button
                    className="about-link"
                    id="btn-show-terms"
                    type="button"
                    onClick={() => setLegalDialog('terms')}
                  >
                    {t.termsLink}
                  </button>
                  <span>·</span>
                  <button
                    className="about-link"
                    id="btn-show-privacy"
                    type="button"
                    onClick={() => setLegalDialog('privacy')}
                  >
                    {t.privacyLink}
                  </button>
                </div>
              </footer>
            </div>
          </Tabs.Content>
        </main>
      </Tabs.Root>

      {/* Radix Legal Modal Dialog */}
      <Dialog.Root
        open={legalDialog !== null}
        onOpenChange={(open) => {
          if (!open) setLegalDialog(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="radix-dialog-overlay" />
          <Dialog.Content className="radix-dialog-content">
            <div className="radix-dialog-header">
              <Dialog.Title className="radix-dialog-title">
                {legalDialog === 'terms' ? t.termsLink : t.privacyLink}
              </Dialog.Title>
              <Dialog.Close asChild>
                <button className="wetype-btn" style={{ padding: '4px 6px' }} type="button">
                  <X size={14} strokeWidth={2} />
                </button>
              </Dialog.Close>
            </div>
            <Dialog.Description className="radix-dialog-body">
              {legalDialog === 'terms' ? t.termsContent : t.privacyContent}
            </Dialog.Description>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <Dialog.Close asChild>
                <button className="wetype-btn primary" type="button">
                  {t.closeBtn}
                </button>
              </Dialog.Close>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* Sonner Toast Notifications */}
      <Toaster
        position="bottom-right"
        toastOptions={{
          style: {
            borderRadius: '10px',
            fontSize: '12.5px',
            fontWeight: 500,
            padding: '10px 14px',
            boxShadow: '0 8px 24px -4px rgba(0, 0, 0, 0.12)',
          },
        }}
      />
    </>
  );
}
