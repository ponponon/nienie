import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_RELAY_URL, SessionRouter } from '@nienie/bridge-core';
import {
  createBridgeRegistry,
  createDesktopPreloadApi,
  createDesktopWindowOptions,
  DesktopBridgeController,
  DesktopPreviewServer,
  NIENIE_IPC_CHANNELS,
  registerDesktopIpcHandlers,
  renderDesktopAppHtml,
} from '../src/bridge.js';

describe('desktop bridge composition', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      if (cleanup) await cleanup();
    }
  });

  it('registers the MVP agents', async () => {
    const registry = createBridgeRegistry({
      opencode: { baseUrl: 'http://127.0.0.1:1' },
      codex: { detectVersion: async () => 'codex-cli 0.166.0' },
    });
    cleanups.push(() => registry.dispose());
    const agents = await registry.detectAll();
    expect(agents.map((agent) => agent.id)).toEqual(['opencode', 'codex']);

    const fullRegistry = createBridgeRegistry({
      includeExtendedAgents: true,
      opencode: { baseUrl: 'http://127.0.0.1:1' },
      codex: { detectVersion: async () => 'codex-cli 0.166.0' },
      claudeCode: { detectVersion: async () => '2.1.169' },
      mimo: { baseUrl: 'http://127.0.0.1:1' },
      dsh: { detectVersion: async () => '0.2.1-rc.5' },
      pi: { detectVersion: async () => '0.8.1' },
      openclaw: { baseUrl: 'http://127.0.0.1:1' },
    });
    cleanups.push(() => fullRegistry.dispose());
    const allAgents = await fullRegistry.detectAll();
    expect(allAgents.map((agent) => agent.id)).toEqual([
      'opencode',
      'codex',
      'claude-code',
      'mimo',
      'dsh',
      'pi',
      'openclaw',
    ]);
  });

  it('completes the OpenCode -> Bridge -> canonical events loop', async () => {
    const sseClients = new Set<ServerResponse>();

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');

      if (req.method === 'GET' && url.pathname === '/global/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ healthy: true, version: '0.15.2' }));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/session') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'ses_bridge_loop',
            directory: '/workspace/nienie',
            title: 'E2E Loop',
            time: { created: 1762216000000, updated: 1762216000000 },
          }),
        );
        return;
      }

      if (req.method === 'GET' && url.pathname === '/event') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        res.write(`data: ${JSON.stringify({ type: 'server.connected', properties: {} })}\n\n`);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/session/ses_bridge_loop/prompt_async') {
        res.writeHead(204);
        res.end();
        for (const client of sseClients) {
          client.write(
            `data: ${JSON.stringify({
              type: 'message.part.delta',
              properties: {
                sessionID: 'ses_bridge_loop',
                messageID: 'msg_1',
                partID: 'part_1',
                field: 'text',
                delta: 'Loop verified',
              },
            })}\n\n`,
          );
          client.write(
            `data: ${JSON.stringify({
              type: 'session.idle',
              properties: { sessionID: 'ses_bridge_loop' },
            })}\n\n`,
          );
        }
        return;
      }

      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          for (const client of sseClients) client.end();
          server.close(() => resolve());
        }),
    );

    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('Expected TCP address');

    const registry = createBridgeRegistry({
      opencode: { baseUrl: `http://127.0.0.1:${addr.port}`, machineId: 'desktop_1' },
    });
    cleanups.push(() => registry.dispose());

    const router = new SessionRouter(registry);
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    router.onEvent((event) => events.push({ type: event.type, payload: event.payload }));

    const session = await router.createSession('opencode', { title: 'E2E Loop' });
    await router.sendMessage(session, 'ping');

    const deadline = Date.now() + 2000;
    while (events.length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 15));
    }

    expect(events).toEqual([
      { type: 'text_delta', payload: { delta: 'Loop verified' } },
      { type: 'status', payload: { status: 'idle', detail: 'Session is idle' } },
    ]);
  });

  it('manages Bridge lifecycle, agent detection, QR pairing, default/custom Relay config, and logs via IPC', async () => {
    const controller = new DesktopBridgeController({
      machineId: 'mac_studio',
      opencode: { baseUrl: 'http://127.0.0.1:1' },
      codex: { detectVersion: async () => 'codex-cli 0.166.0' },
    });
    cleanups.push(() => controller.dispose());

    // Initial state before starting Bridge
    const initial = controller.getState();
    expect(initial.bridge.status).toBe('stopped');
    expect(initial.relay.mode).toBe('default');
    expect(initial.relay.defaultRelayUrl).toBe(DEFAULT_RELAY_URL);
    expect(initial.relay.activeRelayUrl).toBe(DEFAULT_RELAY_URL);

    // Wire up IPC handlers
    const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    registerDesktopIpcHandlers(
      {
        handle(channel, listener) {
          handlers.set(channel, (_event, ...args) => Promise.resolve(listener(_event, ...args)));
        },
      },
      controller,
    );

    // Start Bridge via IPC
    const startedState = (await handlers.get(NIENIE_IPC_CHANNELS.START_BRIDGE)?.({})) as ReturnType<
      DesktopBridgeController['getState']
    >;
    expect(startedState.bridge.status).toBe('running');
    expect(startedState.bridge.wsUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);
    expect(startedState.agents.map((a) => a.id)).toEqual(['opencode', 'codex']);
    expect(startedState.pairing).not.toBeNull();
    expect(startedState.pairing?.pairingCode).toMatch(/^\d{6}$/);
    expect(startedState.pairing?.qrUri).toContain('nienie://pair?data=');
    expect(startedState.pairing?.qrSvg).toContain('<svg');

    // Switch to custom Relay via IPC
    const customRelayState = (await handlers.get(NIENIE_IPC_CHANNELS.SET_RELAY)?.({}, {
      mode: 'custom',
      customRelayUrl: 'wss://relay.my-company.com',
    })) as ReturnType<DesktopBridgeController['getState']>;
    expect(customRelayState.relay.mode).toBe('custom');
    expect(customRelayState.relay.activeRelayUrl).toBe('wss://relay.my-company.com');
    expect(customRelayState.pairing?.qrPayload.relayUrl).toBe('wss://relay.my-company.com');

    // Switch back to default Relay
    const defaultRelayState = (await handlers.get(NIENIE_IPC_CHANNELS.SET_RELAY)?.({}, {
      mode: 'default',
    })) as ReturnType<DesktopBridgeController['getState']>;
    expect(defaultRelayState.relay.mode).toBe('default');
    expect(defaultRelayState.relay.activeRelayUrl).toBe(DEFAULT_RELAY_URL);

    // Logs should record lifecycle and configuration actions
    expect(defaultRelayState.logs.length).toBeGreaterThanOrEqual(3);
    expect(defaultRelayState.logs.some((log) => log.message.includes('Bridge started'))).toBe(true);
    expect(defaultRelayState.logs.some((log) => log.message.includes('wss://relay.my-company.com'))).toBe(true);

    // Stop Bridge via IPC
    const stoppedState = (await handlers.get(NIENIE_IPC_CHANNELS.STOP_BRIDGE)?.({})) as ReturnType<
      DesktopBridgeController['getState']
    >;
    expect(stoppedState.bridge.status).toBe('stopped');
  });

  it('renders a compliant Electron desktop UI with native traffic light spacing, design tokens, inline SVGs, and no emojis', async () => {
    const winOpts = createDesktopWindowOptions();
    expect(winOpts.titleBarStyle).toBe('hidden');
    expect(winOpts.trafficLightPosition).toEqual({ x: 12, y: 12 });

    const controller = new DesktopBridgeController({
      machineId: 'mac_studio',
      opencode: { baseUrl: 'http://127.0.0.1:1' },
      codex: { detectVersion: async () => 'codex-cli 0.166.0' },
    });
    cleanups.push(() => controller.dispose());
    await controller.startBridge();

    const html = renderDesktopAppHtml(controller.getState());
    expect(html).toContain('Content-Security-Policy');
    expect(html).toContain('--color-bg-primary: #F2F2F7');
    expect(html).toContain('padding-left: 78px');
    expect(html).toContain('overflow-x: hidden');
    expect(html).toContain('minmax(0,');
    expect(html).toContain(DEFAULT_RELAY_URL);
    expect(html).toContain('<svg');
    expect(html).toContain('window.nienieDesktop');
    // Must not use emoji characters as icons
    expect(html).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);

    // Preload API maps all Renderer actions to main-process IPC channels
    const invoked: Array<{ channel: string; args: unknown[] }> = [];
    const preloadApi = createDesktopPreloadApi({
      invoke(channel: string, ...args: unknown[]) {
        invoked.push({ channel, args });
        return Promise.resolve(controller.getState());
      },
    });

    await preloadApi.startBridge();
    await preloadApi.setRelay({ mode: 'custom', customRelayUrl: 'wss://relay.example.com' });
    await preloadApi.revokeDevice('dev_123');

    expect(invoked).toEqual([
      { channel: NIENIE_IPC_CHANNELS.START_BRIDGE, args: [] },
      {
        channel: NIENIE_IPC_CHANNELS.SET_RELAY,
        args: [{ mode: 'custom', customRelayUrl: 'wss://relay.example.com' }],
      },
      { channel: NIENIE_IPC_CHANNELS.REVOKE_DEVICE, args: ['dev_123'] },
    ]);

    // Supports zh, en, ja, ko localization in desktop console HTML
    expect(renderDesktopAppHtml(controller.getState(), { locale: 'zh' })).toContain('本地 Bridge');
    expect(renderDesktopAppHtml(controller.getState(), { locale: 'en' })).toContain('Local Bridge');
    expect(renderDesktopAppHtml(controller.getState(), { locale: 'ja' })).toContain('ローカル Bridge');
    expect(renderDesktopAppHtml(controller.getState(), { locale: 'ko' })).toContain('로컬 Bridge');

    // Persists user language preference across DesktopBridgeController restarts
    const tempDir = mkdtempSync(join(tmpdir(), 'nienie-desktop-pref-'));
    cleanups.push(async () => rmSync(tempDir, { recursive: true, force: true }));
    const prefFile = join(tempDir, 'preferences.json');

    const ctrl1 = new DesktopBridgeController({
      machineId: 'mac_pref',
      preferencesFilePath: prefFile,
      opencode: { baseUrl: 'http://127.0.0.1:1' },
      codex: { detectVersion: async () => 'codex-cli 0.166.0' },
    });
    cleanups.push(() => ctrl1.dispose());
    expect(ctrl1.getState().locale).toBe('zh');

    ctrl1.setLocale('ko');
    ctrl1.setMachineName('MacBook-Pro-M5-Office');
    ctrl1.setAutoUpdate(false);
    expect(ctrl1.getState().locale).toBe('ko');
    expect(ctrl1.getState().bridge.machineId).toBe('MacBook-Pro-M5-Office');
    expect(ctrl1.getState().autoUpdate).toBe(false);

    const ctrl2 = new DesktopBridgeController({
      machineId: 'mac_pref',
      preferencesFilePath: prefFile,
      opencode: { baseUrl: 'http://127.0.0.1:1' },
      codex: { detectVersion: async () => 'codex-cli 0.166.0' },
    });
    cleanups.push(() => ctrl2.dispose());
    expect(ctrl2.getState().locale).toBe('ko');
    expect(ctrl2.getState().bridge.machineId).toBe('MacBook-Pro-M5-Office');
    expect(ctrl2.getState().autoUpdate).toBe(false);

    const zhHtml = renderDesktopAppHtml(ctrl1.getState(), { locale: 'zh' });
    expect(zhHtml).toContain('升级和反馈');
    expect(zhHtml).toContain('有新版本时自动更新');
    expect(zhHtml).toContain('我要反馈');
  });

  it('serves an interactive desktop console over localhost via DesktopPreviewServer', async () => {
    const controller = new DesktopBridgeController({
      machineId: 'mac_preview',
      opencode: { baseUrl: 'http://127.0.0.1:1' },
      codex: { detectVersion: async () => 'codex-cli 0.166.0' },
    });
    cleanups.push(() => controller.dispose());

    const preview = new DesktopPreviewServer({ controller, port: 0 });
    const { url } = await preview.start();
    cleanups.push(() => preview.stop());

    // 1. GET / returns the rendered HTML with HTTP IPC shim
    const htmlRes = await fetch(url);
    expect(htmlRes.status).toBe(200);
    const htmlText = await htmlRes.text();
    expect(htmlText).toContain('Nienie Bridge');
    expect(htmlText).toContain('/api/ipc');

    // 2. POST /api/ipc triggers START_BRIDGE and returns updated state
    const startRes = await fetch(`${url}/api/ipc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        channel: NIENIE_IPC_CHANNELS.START_BRIDGE,
        args: [],
      }),
    });
    expect(startRes.status).toBe(200);
    const startedState = (await startRes.json()) as ReturnType<DesktopBridgeController['getState']>;
    expect(startedState.bridge.status).toBe('running');
    expect(startedState.pairing?.pairingCode).toMatch(/^\d{6}$/);

    // 3. POST /api/ipc supports reactive locale switching without full-page reload
    const localeRes = await fetch(`${url}/api/ipc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        channel: NIENIE_IPC_CHANNELS.SET_LOCALE,
        args: ['en'],
      }),
    });
    expect(localeRes.status).toBe(200);
    const localeState = (await localeRes.json()) as ReturnType<DesktopBridgeController['getState']>;
    expect(localeState.locale).toBe('en');
  });
});
