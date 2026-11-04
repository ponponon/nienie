import { CodexAdapter } from '@nienie/adapter-codex';
import { OpenCodeAdapter, type OpenCodeAdapterOptions } from '@nienie/adapter-opencode';
import { AgentRegistry } from '@nienie/bridge-core';

export type BridgeRegistryOptions = {
  opencode?: OpenCodeAdapterOptions | undefined;
};

export function createBridgeRegistry(options: BridgeRegistryOptions = {}): AgentRegistry {
  const registry = new AgentRegistry();
  registry.register(new OpenCodeAdapter(options.opencode));
  registry.register(new CodexAdapter());
  return registry;
}
