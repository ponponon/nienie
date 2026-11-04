import type { AgentAdapter } from '@nienie/agent-events';
import {
  DEFAULT_RELAY_URL,
  resolveRelayUrl,
  type AgentInfo,
} from '@nienie/protocol';
import { AgentRegistry } from './index.js';
import { PairingManager } from './pairing.js';
import { BridgeRelayClient } from './relay.js';
import { BridgeServer } from './ws-server.js';

export type HeadlessBridgeDaemonOptions = {
  machineId?: string | undefined;
  host?: string | undefined;
  port?: number | undefined;
  adapters?: AgentAdapter[] | undefined;
  enableRelay?: boolean | undefined;
  relayUrl?: string | undefined;
  sharedSecret?: string | undefined;
};

export type HeadlessDaemonStatus = {
  machineId: string;
  wsUrl: string;
  relayUrl: string;
  pairingCode: string;
  expiresAt: string;
  qrUri: string;
  agents: AgentInfo[];
};

export class HeadlessBridgeDaemon {
  readonly machineId: string;
  readonly relayUrl: string;
  private readonly host: string;
  private readonly requestedPort: number;
  private readonly enableRelay: boolean;
  private readonly sharedSecret: string | undefined;

  readonly registry: AgentRegistry;
  readonly pairingManager: PairingManager;
  private bridgeServer: BridgeServer | undefined;
  private relayClient: BridgeRelayClient | undefined;

  constructor(options: HeadlessBridgeDaemonOptions = {}) {
    this.machineId = options.machineId ?? 'machine_headless';
    this.host = options.host ?? '127.0.0.1';
    this.requestedPort = options.port ?? 0;
    this.enableRelay = options.enableRelay ?? false;
    this.relayUrl = resolveRelayUrl(options.relayUrl ?? DEFAULT_RELAY_URL);
    this.sharedSecret = options.sharedSecret;

    this.registry = new AgentRegistry();
    for (const adapter of options.adapters ?? []) {
      this.registry.register(adapter);
    }

    this.pairingManager = new PairingManager({
      machineId: this.machineId,
      relayUrl: this.relayUrl,
    });
  }

  async start(): Promise<HeadlessDaemonStatus> {
    const server = new BridgeServer({
      registry: this.registry,
      pairingManager: this.pairingManager,
      host: this.host,
      port: this.requestedPort,
      machineId: this.machineId,
    });

    const address = await server.start();
    this.bridgeServer = server;

    if (this.enableRelay) {
      const relay = new BridgeRelayClient({
        machineId: this.machineId,
        bridgeServer: server,
        relayUrl: this.relayUrl,
        sharedSecret: this.sharedSecret,
      });
      await relay.connect();
      this.relayClient = relay;
    }

    const agents = await this.registry.detectAll();
    const challenge = this.pairingManager.createPairingCode({
      wsUrl: address.url,
      relayUrl: this.relayUrl,
    });

    return {
      machineId: this.machineId,
      wsUrl: address.url,
      relayUrl: this.relayUrl,
      pairingCode: challenge.pairingCode,
      expiresAt: challenge.expiresAt,
      qrUri: challenge.qrUri,
      agents,
    };
  }

  async stop(): Promise<void> {
    if (this.relayClient) {
      await this.relayClient.close();
      this.relayClient = undefined;
    }
    if (this.bridgeServer) {
      await this.bridgeServer.stop();
      this.bridgeServer = undefined;
    }
    await this.registry.dispose();
  }
}
