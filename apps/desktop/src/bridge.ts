import { AcpAdapter, type AcpAdapterOptions } from '@nienie/adapter-acp';
import {
  ClaudeCodeAdapter,
  DshAdapter,
  DshEventNormalizer,
  type ClaudeCodeAdapterOptions,
  type DshAdapterOptions,
} from '@nienie/adapter-claude-code';
import { CodexAdapter, type CodexAdapterOptions } from '@nienie/adapter-codex';
import { OpenClawAdapter, type OpenClawAdapterOptions } from '@nienie/adapter-openclaw';
import {
  MiMoCodeAdapter,
  OpenCodeAdapter,
  type MiMoCodeAdapterOptions,
  type OpenCodeAdapterOptions,
} from '@nienie/adapter-opencode';
import { PiAdapter, type PiAdapterOptions } from '@nienie/adapter-pi';
import { PtyFallbackAdapter, type PtyFallbackAdapterOptions } from '@nienie/adapter-pty';
import { AgentRegistry, BridgeServer, type BridgeServerOptions } from '@nienie/bridge-core';

export { DshAdapter, DshEventNormalizer, type DshAdapterOptions };

export type BridgeRegistryOptions = {
  opencode?: OpenCodeAdapterOptions | undefined;
  codex?: CodexAdapterOptions | undefined;
  claudeCode?: ClaudeCodeAdapterOptions | undefined;
  mimo?: MiMoCodeAdapterOptions | undefined;
  dsh?: DshAdapterOptions | undefined;
  pi?: PiAdapterOptions | undefined;
  acp?: AcpAdapterOptions | undefined;
  openclaw?: OpenClawAdapterOptions | undefined;
  pty?: PtyFallbackAdapterOptions | undefined;
  includeExtendedAgents?: boolean | undefined;
  includeProtocolFallbacks?: boolean | undefined;
};

export type DesktopBridgeOptions = BridgeRegistryOptions &
  Omit<BridgeServerOptions, 'registry'>;

export function createBridgeRegistry(options: BridgeRegistryOptions = {}): AgentRegistry {
  const registry = new AgentRegistry();
  registry.register(new OpenCodeAdapter(options.opencode));
  registry.register(new CodexAdapter(options.codex));

  if (options.includeExtendedAgents) {
    registry.register(new ClaudeCodeAdapter(options.claudeCode));
    registry.register(new MiMoCodeAdapter(options.mimo));
    registry.register(new DshAdapter(options.dsh));
    registry.register(new PiAdapter(options.pi));
    registry.register(new OpenClawAdapter(options.openclaw));
    if (options.includeProtocolFallbacks || options.acp) {
      registry.register(new AcpAdapter(options.acp));
    }
    if (options.includeProtocolFallbacks || options.pty) {
      registry.register(new PtyFallbackAdapter(options.pty));
    }
  }

  return registry;
}

export function createDesktopBridgeServer(options: DesktopBridgeOptions = {}): BridgeServer {
  const registry = createBridgeRegistry({
    opencode: options.opencode,
    codex: options.codex,
  });
  return new BridgeServer({
    ...options,
    registry,
  });
}

export {
  createDesktopPreloadApi,
  createDesktopWindowOptions,
  DesktopBridgeController,
  NIENIE_IPC_CHANNELS,
  registerDesktopIpcHandlers,
  renderPairingQrSvg,
  type DesktopBridgeControllerOptions,
  type DesktopDashboardState,
  type DesktopLogEntry,
  type DesktopPairingView,
  type DesktopPreloadApi,
  type DesktopRelayConfig,
  type IpcMainLike,
  type IpcRendererLike,
  type SetRelayInput,
} from './controller.js';
export {
  decodePairingQrPayload,
  DEFAULT_RELAY_URL,
  encodePairingQrPayload,
  resolveRelayUrl,
  type BridgeRequest,
  type BridgeResponse,
  type CanonicalAgentEvent,
} from '@nienie/bridge-core';
export {
  renderDesktopAppHtml,
  type DesktopLocale,
  type RenderDesktopOptions,
} from './renderer.js';
export {
  DesktopPreviewServer,
  type DesktopPreviewServerOptions,
} from './preview-server.js';
