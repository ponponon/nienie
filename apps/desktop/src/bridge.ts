import { CodexAdapter } from '@nienie/adapter-codex';
import { OpenCodeAdapter } from '@nienie/adapter-opencode';
import { AgentRegistry } from '@nienie/bridge-core';

export function createBridgeRegistry(): AgentRegistry {
  const registry = new AgentRegistry();
  registry.register(new OpenCodeAdapter());
  registry.register(new CodexAdapter());
  return registry;
}
