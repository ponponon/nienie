import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { app, BrowserWindow } from 'electron';
import {
  createDesktopWindowOptions,
  DesktopBridgeController,
  DesktopPreviewServer,
} from './bridge.js';

function detectLanIp(): string | undefined {
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

let controller: DesktopBridgeController | undefined;
let preview: DesktopPreviewServer | undefined;

async function bootstrap() {
  const host = process.env.NIENIE_BRIDGE_HOST ?? '0.0.0.0';
  const bridgePort = Number(process.env.NIENIE_BRIDGE_PORT ?? 4100);
  const previewPort = Number(process.env.NIENIE_PREVIEW_PORT ?? 4101);

  controller = new DesktopBridgeController({
    ...(process.env.NIENIE_MACHINE_ID ? { machineId: process.env.NIENIE_MACHINE_ID } : {}),
    host,
    port: bridgePort,
    includeExtendedAgents: true,
    preferencesFilePath: resolve(process.cwd(), '.nienie/desktop-preferences.json'),
  });

  const state = await controller.startBridge();
  const registry = controller.getRegistry();
  const existingSessions = await registry.listSessions();
  if (existingSessions.length === 0) {
    const onlineAgent = state.agents.find((a) => a.available);
    const adapter = onlineAgent ? registry.get(onlineAgent.id) : registry.get('codex');
    if (adapter?.createSession) {
      await adapter.createSession({
        title: `${adapter.name} Workspace`,
        projectPath: process.cwd(),
      });
    }
  }

  preview = new DesktopPreviewServer({
    controller,
    host: '127.0.0.1',
    port: previewPort,
    liveRendererPath: resolve(process.cwd(), 'apps/desktop/dist/renderer-live.mjs'),
  });
  const previewAddr = await preview.start();
  const lanIp = detectLanIp();
  const boundPort = state.bridge.port ?? bridgePort;

  process.stdout.write('\n========================================================\n');
  process.stdout.write('  Nienie Electron Desktop GUI & Bridge Started\n');
  process.stdout.write('========================================================\n');
  process.stdout.write(`  Desktop Console:           ${previewAddr.url}\n`);
  process.stdout.write(`  Bridge WS (USB/Local):     ws://127.0.0.1:${boundPort}\n`);
  if (lanIp) {
    process.stdout.write(`  Bridge WS (Wi-Fi LAN):     ws://${lanIp}:${boundPort}\n`);
  }
  if (state.pairing) {
    process.stdout.write(`  One-Time Pairing Code:     ${state.pairing.pairingCode}\n`);
    process.stdout.write(`  Pairing QR URI:            ${state.pairing.qrUri}\n`);
  }
  process.stdout.write('========================================================\n\n');

  const mainWindow = new BrowserWindow({
    ...createDesktopWindowOptions(),
    trafficLightPosition: { x: 24, y: 22 },
  });
  await mainWindow.loadURL(previewAddr.url);
  mainWindow.show();
  mainWindow.focus();
}

app.whenReady().then(() => {
  void bootstrap();
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('will-quit', () => {
  void preview?.stop();
  void controller?.dispose();
});
