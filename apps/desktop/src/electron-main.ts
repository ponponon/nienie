import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow } from 'electron';
import {
  createDesktopWindowOptions,
  DesktopBridgeController,
  DesktopPreviewServer,
} from './bridge.js';

// bundle 产物目录（开发时 = apps/desktop/dist，打包后 = Nienie.app/Contents/Resources/app.asar/dist）。
// Finder 启动 .app 时 cwd 是 `/`，所有资源定位必须以 bundleDir 为锚点，不得依赖 process.cwd()。
// 注意：本入口被 esbuild 打成 CJS（import.meta 为空对象），必须优先用 __dirname；
// 仅在 ESM 直跑（vitest/tsx）时回落 import.meta.url。
const bundleDir =
  typeof __dirname !== 'undefined'
    ? __dirname
    : dirname(fileURLToPath(import.meta.url));

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
const appIconPath = resolve(bundleDir, '../assets/nienie-logo.png');

async function bootstrap() {
  const host = process.env.NIENIE_BRIDGE_HOST ?? '0.0.0.0';
  const bridgePort = Number(process.env.NIENIE_BRIDGE_PORT ?? 4100);
  const previewPort = Number(process.env.NIENIE_PREVIEW_PORT ?? 4101);

  // 打包后 cwd 是 `/`（不可写），偏好/配对数据落到用户数据目录；开发时保持仓库内 `.nienie/`。
  const dataDir = app.isPackaged ? join(app.getPath('userData'), '.nienie') : resolve(process.cwd(), '.nienie');
  // 初始工作区会话的项目路径：打包后同理不能用 cwd，退到用户主目录。
  const defaultProjectPath = app.isPackaged ? app.getPath('home') : process.cwd();

  controller = new DesktopBridgeController({
    ...(process.env.NIENIE_MACHINE_ID ? { machineId: process.env.NIENIE_MACHINE_ID } : {}),
    host,
    port: bridgePort,
    includeExtendedAgents: true,
    // Codex 桌面端看不到 Nienie 用 `codex exec` 建的会话（exec 来源被官方列表过滤），
    // 必须由 Bridge 自己落盘，否则重启后手机端的会话全丢。
    codex: {
      sessionStorePath:
        process.env.NIENIE_CODEX_SESSION_STORE ?? join(dataDir, 'codex-sessions.json'),
    },
    preferencesFilePath: join(dataDir, 'desktop-preferences.json'),
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
        projectPath: defaultProjectPath,
      });
    }
  }

  preview = new DesktopPreviewServer({
    controller,
    host: '127.0.0.1',
    port: previewPort,
    // 生产模式不启用热更新 watcher（renderer-live.mjs 是开发产物）
    liveRendererPath: app.isPackaged
      ? undefined
      : resolve(process.cwd(), 'apps/desktop/dist/renderer-live.mjs'),
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
    ...(existsSync(appIconPath) ? { icon: appIconPath } : {}),
    trafficLightPosition: { x: 24, y: 22 },
  });
  if (existsSync(appIconPath)) {
    app.dock?.setIcon(appIconPath);
  }
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
