import { HeadlessBridgeDaemon, type HeadlessDaemonStatus } from './daemon.js';
import { RelayServer } from './relay.js';

export type RelayCliHandle = {
  host: string;
  port: number;
  url: string;
  stop: () => Promise<void>;
};

export type DaemonCliHandle = {
  status: HeadlessDaemonStatus;
  stop: () => Promise<void>;
};

export async function runRelayCli(args: readonly string[] = []): Promise<RelayCliHandle> {
  const flags = parseCliFlags(args);
  const host = flags.get('host') ?? process.env.NIENIE_RELAY_HOST ?? '127.0.0.1';
  const port = Number(flags.get('port') ?? process.env.NIENIE_RELAY_PORT ?? 4200);

  const server = new RelayServer({ host, port });
  const addr = await server.start();
  return {
    ...addr,
    stop: () => server.stop(),
  };
}

export async function runDaemonCli(args: readonly string[] = []): Promise<DaemonCliHandle> {
  const flags = parseCliFlags(args);
  const machineId = flags.get('machine-id') ?? process.env.NIENIE_MACHINE_ID ?? 'machine_headless';
  const host = flags.get('host') ?? process.env.NIENIE_BRIDGE_HOST ?? '127.0.0.1';
  const port = Number(flags.get('port') ?? process.env.NIENIE_BRIDGE_PORT ?? 4100);
  const relayUrl = flags.get('relay-url') ?? process.env.NIENIE_RELAY_URL;
  const enableRelay = Boolean(relayUrl || flags.has('enable-relay'));

  const daemon = new HeadlessBridgeDaemon({
    machineId,
    host,
    port,
    enableRelay,
    ...(relayUrl ? { relayUrl } : {}),
  });

  const status = await daemon.start();
  return {
    status,
    stop: () => daemon.stop(),
  };
}

function parseCliFlags(args: readonly string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const arg of args) {
    if (!arg.startsWith('--')) continue;
    const eqIdx = arg.indexOf('=');
    if (eqIdx === -1) {
      map.set(arg.slice(2), 'true');
    } else {
      map.set(arg.slice(2, eqIdx), arg.slice(eqIdx + 1));
    }
  }
  return map;
}
