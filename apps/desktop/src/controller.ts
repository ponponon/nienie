import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname, networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import qrcode from 'qrcode-generator';
import type { CodexAdapterOptions } from '@nienie/adapter-codex';
import type { OpenCodeAdapterOptions } from '@nienie/adapter-opencode';
import {
  BridgeServer,
  createPushSender,
  DEFAULT_RELAY_URL,
  PairingManager,
  PushNotificationRouter,
  redactLogText,
  resolveRelayUrl,
  type AgentInfo,
  type AgentRegistry,
  type PairedDevice,
  type PairingQrPayload,
} from '@nienie/bridge-core';
import { createBridgeRegistry } from './bridge.js';
import type { DesktopLocale } from './renderer.js';

export const NIENIE_IPC_CHANNELS = {
  GET_STATE: 'desktop:get-state',
  START_BRIDGE: 'desktop:start-bridge',
  STOP_BRIDGE: 'desktop:stop-bridge',
  REFRESH_AGENTS: 'desktop:refresh-agents',
  REFRESH_PAIRING: 'desktop:refresh-pairing',
  SET_RELAY: 'desktop:set-relay',
  SET_LOCALE: 'desktop:set-locale',
  SET_MACHINE_NAME: 'desktop:set-machine-name',
  SET_AUTO_UPDATE: 'desktop:set-auto-update',
  REVOKE_DEVICE: 'desktop:revoke-device',
  SET_NOTIFICATIONS: 'desktop:set-notifications',
  TEST_NOTIFICATION: 'desktop:test-notification',
} as const;

export type DesktopNotificationConfig = {
  enabled: boolean;
  webhookUrl: string;
  senderType: 'auto' | 'bark' | 'ntfy' | 'webhook';
  quietStart: string;
  quietEnd: string;
  mutedSessionIds: string[];
  detailed: boolean;
};

export type SetNotificationsInput = {
  enabled?: boolean | undefined;
  webhookUrl?: string | undefined;
  senderType?: 'auto' | 'bark' | 'ntfy' | 'webhook' | undefined;
  quietStart?: string | undefined;
  quietEnd?: string | undefined;
  mutedSessionIds?: string[] | undefined;
  detailed?: boolean | undefined;
};

export type DesktopLogEntry = {
  id: string;
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  message: string;
};

export type DesktopPairingView = {
  pairingCode: string;
  expiresAt: string;
  qrPayload: PairingQrPayload;
  qrUri: string;
  qrSvg: string;
};

export type DesktopRelayConfig = {
  mode: 'default' | 'custom';
  defaultRelayUrl: string;
  customRelayUrl: string;
  activeRelayUrl: string;
};

export type DesktopDashboardState = {
  locale: DesktopLocale;
  autoUpdate: boolean;
  bridge: {
    status: 'stopped' | 'running' | 'error';
    wsUrl?: string | undefined;
    host?: string | undefined;
    port?: number | undefined;
    connectedClients: number;
    machineId: string;
  };
  agents: AgentInfo[];
  pairing: DesktopPairingView | null;
  devices: PairedDevice[];
  relay: DesktopRelayConfig;
  notifications: DesktopNotificationConfig;
  logs: DesktopLogEntry[];
};

export type DesktopBridgeControllerOptions = {
  machineId?: string | undefined;
  host?: string | undefined;
  port?: number | undefined;
  locale?: DesktopLocale | undefined;
  preferencesFilePath?: string | undefined;
  customRelayUrl?: string | undefined;
  maxLogs?: number | undefined;
  includeExtendedAgents?: boolean | undefined;
  opencode?: OpenCodeAdapterOptions | undefined;
  codex?: CodexAdapterOptions | undefined;
};

export type SetRelayInput = {
  mode: 'default' | 'custom';
  customRelayUrl?: string | undefined;
};

export class DesktopBridgeController {
  private machineId: string;
  private readonly host: string;
  private readonly requestedPort: number;
  private readonly maxLogs: number;
  private readonly preferencesFilePath: string | undefined;
  private readonly registry: AgentRegistry;
  private readonly pairingManager: PairingManager;
  private unsubscribeEvents: (() => void) | undefined;

  private locale: DesktopLocale = 'zh';
  private autoUpdate = true;
  private bridgeServer: BridgeServer | undefined;
  private bridgeStatus: 'stopped' | 'running' | 'error' = 'stopped';
  private wsUrl: string | undefined;
  private boundPort: number | undefined;
  private agents: AgentInfo[] = [];
  private pairingView: DesktopPairingView | null = null;
  private relayMode: 'default' | 'custom' = 'default';
  private customRelayUrl = '';
  private notificationEnabled = true;
  private notificationWebhookUrl = '';
  private notificationSenderType: 'auto' | 'bark' | 'ntfy' | 'webhook' = 'auto';
  private notificationDetailed = false;
  private notificationQuietStart = '';
  private notificationQuietEnd = '';
  private notificationMutedSessionIds: string[] = [];
  private pushRouter: PushNotificationRouter | undefined;
  private readonly logs: DesktopLogEntry[] = [];
  private logSequence = 0;

  constructor(options: DesktopBridgeControllerOptions = {}) {
    const defaultHostName = hostname().replace(/\.local$/i, '').trim() || 'machine_local';
    this.machineId = options.machineId?.trim() || defaultHostName;
    this.host = options.host ?? '127.0.0.1';
    this.requestedPort = options.port ?? 0;
    this.maxLogs = options.maxLogs ?? 200;
    this.preferencesFilePath = options.preferencesFilePath;
    if (options.locale) {
      this.locale = options.locale;
    }
    if (options.customRelayUrl?.trim()) {
      this.customRelayUrl = options.customRelayUrl.trim();
      this.relayMode = 'custom';
    }
    this.loadPreferences();

    this.registry = createBridgeRegistry({
      opencode: options.opencode,
      codex: options.codex,
      includeExtendedAgents: options.includeExtendedAgents,
    });
    this.pairingManager = new PairingManager({
      machineId: this.machineId,
      relayUrl: this.getActiveRelayUrl(),
      ...(this.preferencesFilePath
        ? { persistenceFilePath: join(dirname(this.preferencesFilePath), 'paired-devices.json') }
        : {}),
    });

    this.pairingManager.onDevicePaired((device) => {
      this.appendLog('info', `Paired mobile device ${device.deviceName} (${device.deviceId})`);
      this.refreshPairingCode();
    });

    this.unsubscribeEvents = this.registry.onEvent((event) => {
      this.appendLog(
        event.type === 'error' ? 'error' : 'info',
        `[${event.agentId ?? 'agent'}:${event.sessionId}] event=${event.type} seq=${event.sequence}`,
      );
    });

    this.appendLog('info', `Desktop controller initialized for machine ${this.machineId}`);
  }

  getRegistry(): AgentRegistry {
    return this.registry;
  }

  getState(): DesktopDashboardState {
    if (
      this.bridgeStatus === 'running' &&
      this.pairingView &&
      Date.parse(this.pairingView.expiresAt) <= Date.now() + 5_000
    ) {
      this.refreshPairingCode();
    }
    return {
      locale: this.locale,
      autoUpdate: this.autoUpdate,
      bridge: {
        status: this.bridgeStatus,
        ...(this.wsUrl ? { wsUrl: this.wsUrl } : {}),
        ...(this.wsUrl ? { host: this.host } : {}),
        ...(this.boundPort !== undefined ? { port: this.boundPort } : {}),
        connectedClients: this.bridgeServer?.getConnectedClientCount() ?? 0,
        machineId: this.machineId,
      },
      agents: [...this.agents],
      pairing: this.pairingView,
      devices: this.pairingManager.listDevices(),
      relay: {
        mode: this.relayMode,
        defaultRelayUrl: DEFAULT_RELAY_URL,
        customRelayUrl: this.customRelayUrl,
        activeRelayUrl: this.getActiveRelayUrl(),
      },
      notifications: {
        enabled: this.notificationEnabled,
        webhookUrl: this.notificationWebhookUrl,
        senderType: this.notificationSenderType,
        quietStart: this.notificationQuietStart,
        quietEnd: this.notificationQuietEnd,
        mutedSessionIds: [...this.notificationMutedSessionIds],
        detailed: this.notificationDetailed,
      },
      logs: [...this.logs],
    };
  }

  private buildPushRouter(): PushNotificationRouter {
    return new PushNotificationRouter({
      // R3：发送器每次发送时读取最新配置，改 URL 保存后立即生效
      webhookSender: async (message) => {
        const url = this.notificationWebhookUrl.trim();
        if (!url) return;
        const sender = createPushSender({ type: this.notificationSenderType, url });
        await sender.send(message);
      },
      resolveSessionTitle: undefined,
      preferences: this.notificationPreferences(),
      onDeliveryError: (error) => {
        this.appendLog('warn', `Push delivery failed: ${error instanceof Error ? error.message : String(error)}`);
      },
    });
  }

  private notificationPreferences() {
    return {
      enabled: this.notificationEnabled,
      mutedSessionIds: [...this.notificationMutedSessionIds],
      detailed: this.notificationDetailed,
      quietHours:
        this.notificationQuietStart && this.notificationQuietEnd
          ? { start: this.notificationQuietStart, end: this.notificationQuietEnd }
          : undefined,
    };
  }

  setNotifications(input: SetNotificationsInput): DesktopDashboardState {
    if (input.enabled !== undefined) this.notificationEnabled = input.enabled;
    if (input.webhookUrl !== undefined) this.notificationWebhookUrl = input.webhookUrl.trim();
    if (input.senderType !== undefined) this.notificationSenderType = input.senderType;
    if (input.detailed !== undefined) this.notificationDetailed = input.detailed;
    if (input.quietStart !== undefined) this.notificationQuietStart = input.quietStart.trim();
    if (input.quietEnd !== undefined) this.notificationQuietEnd = input.quietEnd.trim();
    if (input.mutedSessionIds !== undefined) {
      this.notificationMutedSessionIds = input.mutedSessionIds
        .map((id) => id.trim())
        .filter((id) => id.length > 0);
    }
    this.pushRouter?.setPreferences(this.notificationPreferences());
    this.savePreferences();
    return this.getState();
  }

  async sendTestNotification(input?: { webhookUrl?: string | undefined; senderType?: 'auto' | 'bark' | 'ntfy' | 'webhook' | undefined }): Promise<void> {
    // R10/R3-P2：测试当前输入框草稿并直接经 Sender 发送（不经 Router，绕过偏好闸；Router 缺失也绝不静默成功）
    const url = (input?.webhookUrl ?? this.notificationWebhookUrl).trim();
    if (!url) {
      throw new Error('请先填写通知 Webhook URL');
    }
    const sender = createPushSender({ type: input?.senderType ?? this.notificationSenderType, url });
    await sender.send({
      deviceId: 'test',
      platform: 'unknown',
      provider: 'webhook',
      pushToken: 'test',
      sessionId: 'test-session',
      title: 'Nienie 测试通知',
      body: 'Webhook 连接成功。',
      clickUrl: 'nienie://home',
      timestamp: Date.now(),
    });
    this.appendLog('info', 'Test notification sent');
  }

  async startBridge(): Promise<DesktopDashboardState> {
    if (this.bridgeServer && this.bridgeStatus === 'running') {
      return this.getState();
    }

    try {
      this.pushRouter = this.buildPushRouter();
      const server = new BridgeServer({
        registry: this.registry,
        pairingManager: this.pairingManager,
        host: this.host,
        port: this.requestedPort,
        machineId: this.machineId,
        pushRouter: this.pushRouter,
      });

      const address = await server.start();
      this.bridgeServer = server;
      this.bridgeStatus = 'running';
      const lanIp = this.host === '0.0.0.0' ? detectLanIpv4() : undefined;
      this.wsUrl = lanIp ? `ws://${lanIp}:${address.port}` : address.url;
      this.boundPort = address.port;

      this.appendLog('info', `Bridge started on ${address.url}`);
      await this.refreshAgents();
      this.refreshPairingCode();
      return this.getState();
    } catch (error) {
      this.bridgeStatus = 'error';
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.appendLog('error', `Failed to start Bridge: ${message}`);
      throw error;
    }
  }

  async stopBridge(): Promise<DesktopDashboardState> {
    if (this.bridgeServer) {
      await this.bridgeServer.stop();
      this.bridgeServer = undefined;
    }
    this.bridgeStatus = 'stopped';
    this.wsUrl = undefined;
    this.boundPort = undefined;
    this.pairingView = null;
    this.appendLog('info', 'Bridge stopped');
    return this.getState();
  }

  async refreshAgents(): Promise<DesktopDashboardState> {
    this.agents = await this.registry.detectAll();
    const summary = this.agents
      .map((agent) => `${agent.name}:${agent.available ? 'online' : 'offline'}`)
      .join(', ');
    this.appendLog('info', `Agent detection finished (${summary})`);
    return this.getState();
  }

  refreshPairingCode(): DesktopDashboardState {
    const wsUrl = this.wsUrl ?? `ws://${this.host}:${this.requestedPort || 4100}`;
    const challenge = this.pairingManager.createPairingCode({
      wsUrl,
      relayUrl: this.getActiveRelayUrl(),
    });
    this.pairingView = {
      pairingCode: challenge.pairingCode,
      expiresAt: challenge.expiresAt,
      qrPayload: challenge.qrPayload,
      qrUri: challenge.qrUri,
      qrSvg: renderPairingQrSvg(challenge.qrUri),
    };
    this.appendLog('info', `Generated one-time pairing code ${challenge.pairingCode}`);
    return this.getState();
  }

  setRelayConfig(input: SetRelayInput): DesktopDashboardState {
    if (input.mode === 'custom') {
      const trimmed = input.customRelayUrl?.trim() ?? '';
      if (!trimmed || (!trimmed.startsWith('wss://') && !trimmed.startsWith('ws://'))) {
        this.appendLog('warn', `Rejected invalid custom Relay URL: ${trimmed || '(empty)'}`);
        throw new Error('Custom Relay URL must start with wss:// or ws://');
      }
      this.relayMode = 'custom';
      this.customRelayUrl = trimmed;
      this.appendLog('info', `Switched Relay to custom endpoint ${trimmed}`);
    } else {
      this.relayMode = 'default';
      if (input.customRelayUrl !== undefined) {
        this.customRelayUrl = input.customRelayUrl.trim();
      }
      this.appendLog('info', `Switched Relay to default endpoint ${DEFAULT_RELAY_URL}`);
    }

    if (this.pairingView) {
      this.refreshPairingCode();
    }
    this.savePreferences();
    return this.getState();
  }

  setLocale(locale: DesktopLocale): DesktopDashboardState {
    if (locale === 'zh' || locale === 'en' || locale === 'ja' || locale === 'ko') {
      this.locale = locale;
      this.savePreferences();
      this.appendLog('info', `Switched UI language to ${locale}`);
    }
    return this.getState();
  }

  setMachineName(name: string): DesktopDashboardState {
    const trimmed = name.trim();
    if (!trimmed) {
      return this.getState();
    }
    this.machineId = trimmed;
    this.pairingManager.setMachineId(trimmed);
    this.savePreferences();
    this.appendLog('info', `Updated machine name to ${trimmed}`);
    if (this.pairingView) {
      this.refreshPairingCode();
    }
    return this.getState();
  }

  setAutoUpdate(enabled: boolean): DesktopDashboardState {
    this.autoUpdate = Boolean(enabled);
    this.savePreferences();
    this.appendLog('info', `Auto-update ${this.autoUpdate ? 'enabled' : 'disabled'}`);
    return this.getState();
  }

  revokeDevice(deviceId: string): DesktopDashboardState {
    this.pushRouter?.unregisterDevice(deviceId);
    const revoked = this.pairingManager.revokeDevice(deviceId);
    if (revoked) {
      this.appendLog('warn', `Revoked paired device ${deviceId}`);
    } else {
      this.appendLog('warn', `Attempted to revoke unknown or already revoked device ${deviceId}`);
    }
    return this.getState();
  }

  async dispose(): Promise<void> {
    if (this.unsubscribeEvents) {
      this.unsubscribeEvents();
      this.unsubscribeEvents = undefined;
    }
    await this.stopBridge();
    await this.registry.dispose();
  }

  private getActiveRelayUrl(): string {
    return this.relayMode === 'custom'
      ? resolveRelayUrl(this.customRelayUrl)
      : DEFAULT_RELAY_URL;
  }

  private appendLog(level: DesktopLogEntry['level'], message: string): void {
    this.logs.push({
      id: `log_${++this.logSequence}`,
      timestamp: new Date().toISOString(),
      level,
      message: redactLogText(message),
    });
    if (this.logs.length > this.maxLogs) {
      this.logs.splice(0, this.logs.length - this.maxLogs);
    }
  }

  private loadPreferences(): void {
    if (!this.preferencesFilePath || !existsSync(this.preferencesFilePath)) {
      return;
    }
    try {
      const raw = JSON.parse(readFileSync(this.preferencesFilePath, 'utf8')) as {
        machineId?: string;
        locale?: DesktopLocale;
        autoUpdate?: boolean;
        relayMode?: 'default' | 'custom';
        customRelayUrl?: string;
        notificationEnabled?: boolean;
        notificationWebhookUrl?: string;
        notificationSenderType?: 'auto' | 'bark' | 'ntfy' | 'webhook';
        notificationDetailed?: boolean;
        notificationQuietStart?: string;
        notificationQuietEnd?: string;
        notificationMutedSessionIds?: string[];
      };
      if (typeof raw.machineId === 'string' && raw.machineId.trim()) {
        this.machineId = raw.machineId.trim();
      }
      if (typeof raw.autoUpdate === 'boolean') {
        this.autoUpdate = raw.autoUpdate;
      }
      if (
        raw.locale === 'zh' ||
        raw.locale === 'en' ||
        raw.locale === 'ja' ||
        raw.locale === 'ko'
      ) {
        this.locale = raw.locale;
      }
      if (raw.relayMode === 'default' || raw.relayMode === 'custom') {
        this.relayMode = raw.relayMode;
      }
      if (typeof raw.customRelayUrl === 'string') {
        this.customRelayUrl = raw.customRelayUrl;
      }
      if (typeof raw.notificationEnabled === 'boolean') {
        this.notificationEnabled = raw.notificationEnabled;
      }
      if (
        raw.notificationSenderType === 'auto' ||
        raw.notificationSenderType === 'bark' ||
        raw.notificationSenderType === 'ntfy' ||
        raw.notificationSenderType === 'webhook'
      ) {
        this.notificationSenderType = raw.notificationSenderType;
      }
      if (typeof raw.notificationDetailed === 'boolean') {
        this.notificationDetailed = raw.notificationDetailed;
      }
      if (typeof raw.notificationWebhookUrl === 'string') {
        this.notificationWebhookUrl = raw.notificationWebhookUrl;
      }
      if (typeof raw.notificationQuietStart === 'string') {
        this.notificationQuietStart = raw.notificationQuietStart;
      }
      if (typeof raw.notificationQuietEnd === 'string') {
        this.notificationQuietEnd = raw.notificationQuietEnd;
      }
      if (Array.isArray(raw.notificationMutedSessionIds)) {
        this.notificationMutedSessionIds = raw.notificationMutedSessionIds
          .filter((id): id is string => typeof id === 'string')
          .map((id) => id.trim())
          .filter((id) => id.length > 0);
      }
    } catch {
      // Ignore corrupted preferences file
    }
  }

  private savePreferences(): void {
    if (!this.preferencesFilePath) return;
    mkdirSync(dirname(this.preferencesFilePath), { recursive: true });
    writeFileSync(
      this.preferencesFilePath,
      JSON.stringify(
        {
          machineId: this.machineId,
          locale: this.locale,
          autoUpdate: this.autoUpdate,
          relayMode: this.relayMode,
          customRelayUrl: this.customRelayUrl,
          notificationEnabled: this.notificationEnabled,
          notificationWebhookUrl: this.notificationWebhookUrl,
          notificationSenderType: this.notificationSenderType,
          notificationDetailed: this.notificationDetailed,
          notificationQuietStart: this.notificationQuietStart,
          notificationQuietEnd: this.notificationQuietEnd,
          notificationMutedSessionIds: this.notificationMutedSessionIds,
        },
        null,
        2,
      ),
      'utf8',
    );
    try {
      chmodSync(this.preferencesFilePath, 0o600);
    } catch {
      // 平台不支持时忽略；凭据文件尽力限制为仅本用户可读写
    }
  }
}

export type IpcMainLike = {
  handle(
    channel: string,
    listener: (event: unknown, ...args: unknown[]) => unknown | Promise<unknown>,
  ): void;
};

export function registerDesktopIpcHandlers(
  ipcMain: IpcMainLike,
  controller: DesktopBridgeController,
): void {
  ipcMain.handle(NIENIE_IPC_CHANNELS.GET_STATE, () => controller.getState());
  ipcMain.handle(NIENIE_IPC_CHANNELS.START_BRIDGE, () => controller.startBridge());
  ipcMain.handle(NIENIE_IPC_CHANNELS.STOP_BRIDGE, () => controller.stopBridge());
  ipcMain.handle(NIENIE_IPC_CHANNELS.REFRESH_AGENTS, () => controller.refreshAgents());
  ipcMain.handle(NIENIE_IPC_CHANNELS.REFRESH_PAIRING, () => controller.refreshPairingCode());
  ipcMain.handle(NIENIE_IPC_CHANNELS.SET_RELAY, (_event, input) =>
    controller.setRelayConfig(input as SetRelayInput),
  );
  ipcMain.handle(NIENIE_IPC_CHANNELS.SET_LOCALE, (_event, locale) =>
    controller.setLocale(locale as DesktopLocale),
  );
  ipcMain.handle(NIENIE_IPC_CHANNELS.SET_MACHINE_NAME, (_event, name) =>
    controller.setMachineName(String(name ?? '')),
  );
  ipcMain.handle(NIENIE_IPC_CHANNELS.SET_AUTO_UPDATE, (_event, enabled) =>
    controller.setAutoUpdate(Boolean(enabled)),
  );
  ipcMain.handle(NIENIE_IPC_CHANNELS.SET_NOTIFICATIONS, (_event, input) =>
    controller.setNotifications((input ?? {}) as SetNotificationsInput),
  );
  ipcMain.handle(NIENIE_IPC_CHANNELS.TEST_NOTIFICATION, (_event, input) =>
    controller.sendTestNotification((input ?? {}) as { webhookUrl?: string; senderType?: 'auto' | 'bark' | 'ntfy' | 'webhook' }),
  );
  ipcMain.handle(NIENIE_IPC_CHANNELS.REVOKE_DEVICE, (_event, deviceId) =>
    controller.revokeDevice(String(deviceId)),
  );
}

export type IpcRendererLike = {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
};

/** preload 方法 → IPC 通道的唯一映射源（preview-server 注入层同步使用，防两处手维护漏更新）。 */
export const DESKTOP_PRELOAD_METHODS = {
  getState: NIENIE_IPC_CHANNELS.GET_STATE,
  startBridge: NIENIE_IPC_CHANNELS.START_BRIDGE,
  stopBridge: NIENIE_IPC_CHANNELS.STOP_BRIDGE,
  refreshAgents: NIENIE_IPC_CHANNELS.REFRESH_AGENTS,
  refreshPairing: NIENIE_IPC_CHANNELS.REFRESH_PAIRING,
  setRelay: NIENIE_IPC_CHANNELS.SET_RELAY,
  setLocale: NIENIE_IPC_CHANNELS.SET_LOCALE,
  setMachineName: NIENIE_IPC_CHANNELS.SET_MACHINE_NAME,
  setAutoUpdate: NIENIE_IPC_CHANNELS.SET_AUTO_UPDATE,
  revokeDevice: NIENIE_IPC_CHANNELS.REVOKE_DEVICE,
  setNotifications: NIENIE_IPC_CHANNELS.SET_NOTIFICATIONS,
  testNotification: NIENIE_IPC_CHANNELS.TEST_NOTIFICATION,
} as const;

export type DesktopPreloadApi = {
  getState(): Promise<DesktopDashboardState>;
  startBridge(): Promise<DesktopDashboardState>;
  stopBridge(): Promise<DesktopDashboardState>;
  refreshAgents(): Promise<DesktopDashboardState>;
  refreshPairing(): Promise<DesktopDashboardState>;
  setRelay(input: SetRelayInput): Promise<DesktopDashboardState>;
  setLocale(locale: DesktopLocale): Promise<DesktopDashboardState>;
  setMachineName(name: string): Promise<DesktopDashboardState>;
  setAutoUpdate(enabled: boolean): Promise<DesktopDashboardState>;
  revokeDevice(deviceId: string): Promise<DesktopDashboardState>;
  setNotifications(input: SetNotificationsInput): Promise<DesktopDashboardState>;
  testNotification(input?: { webhookUrl?: string | undefined; senderType?: 'auto' | 'bark' | 'ntfy' | 'webhook' | undefined }): Promise<void>;
};

export function createDesktopPreloadApi(ipcRenderer: IpcRendererLike): DesktopPreloadApi {
  const channel = (method: keyof typeof DESKTOP_PRELOAD_METHODS) => DESKTOP_PRELOAD_METHODS[method];
  return {
    getState: () => ipcRenderer.invoke(channel('getState')) as Promise<DesktopDashboardState>,
    startBridge: () => ipcRenderer.invoke(channel('startBridge')) as Promise<DesktopDashboardState>,
    stopBridge: () => ipcRenderer.invoke(channel('stopBridge')) as Promise<DesktopDashboardState>,
    refreshAgents: () => ipcRenderer.invoke(channel('refreshAgents')) as Promise<DesktopDashboardState>,
    refreshPairing: () => ipcRenderer.invoke(channel('refreshPairing')) as Promise<DesktopDashboardState>,
    setRelay: (input: SetRelayInput) =>
      ipcRenderer.invoke(channel('setRelay'), input) as Promise<DesktopDashboardState>,
    setLocale: (locale: DesktopLocale) =>
      ipcRenderer.invoke(channel('setLocale'), locale) as Promise<DesktopDashboardState>,
    setMachineName: (name: string) =>
      ipcRenderer.invoke(channel('setMachineName'), name) as Promise<DesktopDashboardState>,
    setAutoUpdate: (enabled: boolean) =>
      ipcRenderer.invoke(channel('setAutoUpdate'), enabled) as Promise<DesktopDashboardState>,
    revokeDevice: (deviceId: string) =>
      ipcRenderer.invoke(channel('revokeDevice'), deviceId) as Promise<DesktopDashboardState>,
    setNotifications: (input: SetNotificationsInput) =>
      ipcRenderer.invoke(channel('setNotifications'), input) as Promise<DesktopDashboardState>,
    testNotification: (input?: { webhookUrl?: string; senderType?: 'auto' | 'bark' | 'ntfy' | 'webhook' }) =>
      ipcRenderer.invoke(channel('testNotification'), input) as Promise<void>,
  };
}

export function createDesktopWindowOptions(preloadPath?: string) {
  return {
    width: 780,
    height: 540,
    minWidth: 680,
    minHeight: 460,
    backgroundColor: '#F0F0F2',
    titleBarStyle: 'hidden' as const,
    trafficLightPosition: { x: 12, y: 12 },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      ...(preloadPath ? { preload: preloadPath } : {}),
    },
  };
}

export function renderPairingQrSvg(data: string): string {
  const qr = qrcode(0, 'L');
  qr.addData(data);
  qr.make();
  const size = qr.getModuleCount();
  const margin = 2;
  const total = size + margin * 2;
  const cells: string[] = [];

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (qr.isDark(r, c)) {
        cells.push(`<rect x="${c + margin}" y="${r + margin}" width="1" height="1" />`);
      }
    }
  }

  return [
    `<svg class="qr-svg" width="140" height="140" viewBox="0 0 ${total} ${total}" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Nienie Pairing QR Code">`,
    `<rect width="${total}" height="${total}" rx="2" fill="#FFFFFF"/>`,
    `<g fill="#111111">${cells.join('')}</g>`,
    `</svg>`,
  ].join('');
}

function detectLanIpv4(): string | undefined {
  const nets = networkInterfaces();
  for (const entries of Object.values(nets)) {
    for (const net of entries ?? []) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return undefined;
}
