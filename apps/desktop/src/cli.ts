import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { DesktopBridgeController, DesktopPreviewServer } from './bridge.js';

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

const isSmoke = process.argv.includes('--smoke');
const host = process.env.NIENIE_BRIDGE_HOST ?? '0.0.0.0';
const bridgePort = isSmoke ? 0 : Number(process.env.NIENIE_BRIDGE_PORT ?? 4100);
const previewPort = isSmoke ? 0 : Number(process.env.NIENIE_PREVIEW_PORT ?? 4101);

const controller = new DesktopBridgeController({
  ...(process.env.NIENIE_MACHINE_ID ? { machineId: process.env.NIENIE_MACHINE_ID } : {}),
  host,
  port: bridgePort,
  includeExtendedAgents: true,
  ...(isSmoke ? {} : { preferencesFilePath: resolve(process.cwd(), '.nienie/desktop-preferences.json') }),
});

const state = await controller.startBridge();
const registry = controller.getRegistry();
const existingSessions = await registry.listSessions();
for (const agentInfo of state.agents.filter((a) => a.available)) {
  const hasSession = existingSessions.some((s) => s.agentId === agentInfo.id);
  if (!hasSession) {
    const adapter = registry.get(agentInfo.id);
    if (adapter?.createSession) {
      try {
        await adapter.createSession({
          title: `${adapter.name} Workspace`,
          projectPath: process.cwd(),
        });
      } catch {
        // Ignore single adapter session init failure
      }
    }
  }
}

const preview = new DesktopPreviewServer({
  controller,
  host: '127.0.0.1',
  port: previewPort,
});
const previewAddr = await preview.start();
const lanIp = detectLanIp();
const boundPort = state.bridge.port ?? bridgePort;

process.stdout.write('\n========================================================\n');
process.stdout.write('  Nienie Mac Bridge & Desktop Console Started\n');
process.stdout.write('========================================================\n');
process.stdout.write(`  Desktop Console (Browser): ${previewAddr.url}\n`);
process.stdout.write(`  Bridge WS (USB/Local):     ws://127.0.0.1:${boundPort}\n`);
if (lanIp) {
  process.stdout.write(`  Bridge WS (Wi-Fi LAN):     ws://${lanIp}:${boundPort}\n`);
}
if (state.pairing) {
  process.stdout.write(`  One-Time Pairing Code:     ${state.pairing.pairingCode}\n`);
  process.stdout.write(`  Pairing QR URI:            ${state.pairing.qrUri}\n`);
}
process.stdout.write('========================================================\n\n');

if (isSmoke) {
  await preview.stop();
  await controller.dispose();
  process.exit(0);
}

const shutdown = async () => {
  await preview.stop();
  await controller.dispose();
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
