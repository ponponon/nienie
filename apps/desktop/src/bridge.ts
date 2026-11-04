import { CodexAdapter } from '@nienie/adapter-codex';
import { OpenCodeAdapter, type OpenCodeAdapterOptions } from '@nienie/adapter-opencode';
import { AgentRegistry, BridgeServer, type BridgeServerOptions } from '@nienie/bridge-core';

export type BridgeRegistryOptions = {
  opencode?: OpenCodeAdapterOptions | undefined;
};

export type DesktopBridgeOptions = BridgeRegistryOptions &
  Omit<BridgeServerOptions, 'registry'>;

export function createBridgeRegistry(options: BridgeRegistryOptions = {}): AgentRegistry {
  const registry = new AgentRegistry();
  registry.register(new OpenCodeAdapter(options.opencode));
  registry.register(new CodexAdapter());
  return registry;
}

export function createDesktopBridgeServer(options: DesktopBridgeOptions = {}): BridgeServer {
  const registry = createBridgeRegistry({ opencode: options.opencode });
  return new BridgeServer({
    ...options,
    registry,
  });
}
