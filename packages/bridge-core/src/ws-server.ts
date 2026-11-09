import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  DEFAULT_MAX_MESSAGE_BYTES,
  parseBridgeRequest,
  PROTOCOL_VERSION,
  type AgentSession,
  type BridgeRequest,
  type BridgeResponse,
  type CanonicalAgentEvent,
  type ScreenCaptureFrame,
} from '@nienie/protocol';
import { type AgentRegistry, SessionRouter } from './index.js';
import type { PairingManager } from './pairing.js';
import type { PushNotificationRouter } from './push.js';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_CLIENT_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_EVENTS_PER_SESSION = 500;

/** 诊断脱敏：把诊断里的目录 key 折叠为 basename，避免泄露完整本机路径。 */
function redactDiagnosticKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactDiagnosticKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === 'key' && typeof v === 'string') {
        const base = v.split('/').filter(Boolean).pop();
        out[k] = base ?? '(root)';
      } else {
        out[k] = redactDiagnosticKeys(v);
      }
    }
    return out;
  }
  return value;
}

export type ScreenCaptureProvider = (
  displayId?: string,
) => Promise<ScreenCaptureFrame>;

export type BridgeServerOptions = {
  registry: AgentRegistry;
  pairingManager?: PairingManager | undefined;
  pushRouter?: PushNotificationRouter | undefined;
  screenCaptureProvider?: ScreenCaptureProvider | undefined;
  host?: string | undefined;
  port?: number | undefined;
  machineId?: string | undefined;
  maxPayloadBytes?: number | undefined;
  heartbeatIntervalMs?: number | undefined;
  clientTimeoutMs?: number | undefined;
  maxEventsPerSession?: number | undefined;
};

export type BridgeServerAddress = {
  host: string;
  port: number;
  url: string;
};

type ClientConnection = {
  id: string;
  socket: Duplex;
  buffer: Buffer;
  fragments: Buffer[];
  fragmentedOpcode: number | undefined;
  lastSeenAt: number;
  authenticatedDeviceId: string | undefined;
  closed: boolean;
};

export class BridgeServer {
  private readonly registry: AgentRegistry;
  private readonly router: SessionRouter;
  private readonly pairingManager: PairingManager | undefined;
  private readonly pushRouter: PushNotificationRouter | undefined;
  private readonly screenCaptureProvider: ScreenCaptureProvider | undefined;
  private readonly host: string;
  private readonly requestedPort: number;
  private readonly machineId: string;
  private readonly maxPayloadBytes: number;
  private readonly heartbeatIntervalMs: number;
  private readonly clientTimeoutMs: number;
  private readonly maxEventsPerSession: number;

  private httpServer: Server | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private unsubscribeEvents: (() => void) | undefined;
  private unsubscribeRevoke: (() => void) | undefined;
  private readonly clients = new Map<string, ClientConnection>();
  private readonly sessionIndex = new Map<string, AgentSession>();
  private readonly eventHistoryBySession = new Map<string, CanonicalAgentEvent[]>();
  /** 每个会话当前事件流 epoch；epoch 变化即新事件流，旧缓存不与新事件混排。 */
  private readonly sessionEpoch = new Map<string, string>();

  constructor(options: BridgeServerOptions) {
    this.registry = options.registry;
    this.router = new SessionRouter(options.registry);
    this.pairingManager = options.pairingManager;
    this.pushRouter = options.pushRouter;
    this.screenCaptureProvider = options.screenCaptureProvider;
    this.host = options.host ?? DEFAULT_HOST;
    this.requestedPort = options.port ?? 0;
    this.machineId = options.machineId ?? options.pairingManager?.machineId ?? 'machine_local';
    this.maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.clientTimeoutMs = options.clientTimeoutMs ?? DEFAULT_CLIENT_TIMEOUT_MS;
    this.maxEventsPerSession = options.maxEventsPerSession ?? DEFAULT_MAX_EVENTS_PER_SESSION;
  }

  getConnectedClientCount(): number {
    return this.clients.size;
  }

  getRegistry(): AgentRegistry {
    return this.registry;
  }

  async processExternalRequest(rawText: string): Promise<BridgeResponse> {
    const parsed = parseBridgeRequest(rawText, this.maxPayloadBytes);
    if (!parsed.ok) {
      return {
        type: 'response',
        requestId: parsed.requestId,
        ok: false,
        error: parsed.error,
      };
    }

    const virtualClient: ClientConnection = {
      id: 'relay_virtual_client',
      socket: null as unknown as Duplex,
      buffer: Buffer.alloc(0),
      fragments: [],
      fragmentedOpcode: undefined,
      lastSeenAt: Date.now(),
      authenticatedDeviceId: undefined,
      closed: false,
    };

    try {
      const data = await this.executeRequest(virtualClient, parsed.request, true);
      return {
        type: 'response',
        requestId: parsed.request.requestId,
        ok: true,
        data,
      };
    } catch (error) {
      const code =
        error instanceof BridgeCommandError ? error.code : 'COMMAND_EXECUTION_FAILED';
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        type: 'response',
        requestId: parsed.request.requestId,
        ok: false,
        error: { code, message },
      };
    }
  }

  async start(): Promise<BridgeServerAddress> {
    if (this.httpServer) {
      return this.getAddress();
    }

    const server = createServer((req, res) => this.handleHttpRequest(req, res));
    server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.requestedPort, this.host, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });

    this.httpServer = server;
    this.unsubscribeEvents = this.registry.onEvent((event) => {
      this.broadcastEvent(event);
    });
    if (this.pairingManager) {
      this.unsubscribeRevoke = this.pairingManager.onDeviceRevoked((deviceId) => {
        for (const client of this.clients.values()) {
          if (client.authenticatedDeviceId === deviceId) {
            client.authenticatedDeviceId = undefined;
          }
        }
      });
    }

    this.heartbeatTimer = setInterval(() => {
      this.checkHeartbeats();
    }, this.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();

    return this.getAddress();
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }

    if (this.unsubscribeEvents) {
      this.unsubscribeEvents();
      this.unsubscribeEvents = undefined;
    }

    if (this.unsubscribeRevoke) {
      this.unsubscribeRevoke();
      this.unsubscribeRevoke = undefined;
    }

    for (const client of this.clients.values()) {
      this.closeClient(client, 1001);
    }
    this.clients.clear();

    const server = this.httpServer;
    this.httpServer = undefined;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  private getAddress(): BridgeServerAddress {
    const address = this.httpServer?.address();
    if (!address || typeof address === 'string') {
      throw new Error('BridgeServer is not listening on a TCP port');
    }
    const connectHost = this.host === '0.0.0.0' ? '127.0.0.1' : this.host;
    return {
      host: connectHost,
      port: address.port,
      url: `ws://${connectHost}:${address.port}`,
    };
  }

  private handleHttpRequest(req: IncomingMessage, res: ServerResponse): void {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          protocolVersion: PROTOCOL_VERSION,
          machineId: this.machineId,
          connectedClients: this.clients.size,
        }),
      );
      return;
    }

    if (req.method === 'GET' && req.url === '/diagnostics') {
      // 仅允许本机访问，避免暴露项目路径 / Session ID 等环境信息
      const remote = req.socket.remoteAddress ?? '';
      const isLocal = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
      if (!isLocal) {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Forbidden' }));
        return;
      }
      const sessionEventCounts: Record<string, number> = {};
      for (const [sessionId, events] of this.eventHistoryBySession) {
        sessionEventCounts[sessionId] = events.length;
      }
      res.writeHead(200, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      });
      res.end(
        JSON.stringify({
          ok: true,
          protocolVersion: PROTOCOL_VERSION,
          machineId: this.machineId,
          connectedClients: this.clients.size,
          eventHistory: {
            sessions: this.eventHistoryBySession.size,
            maxEventsPerSession: this.maxEventsPerSession,
            counts: sessionEventCounts,
          },
          adapters: redactDiagnosticKeys(this.registry.getDiagnostics()),
        }),
      );
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Not Found' }));
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const upgradeHeader = req.headers.upgrade;
    const keyHeader = req.headers['sec-websocket-key'];
    if (
      typeof upgradeHeader !== 'string' ||
      upgradeHeader.toLowerCase() !== 'websocket' ||
      typeof keyHeader !== 'string' ||
      !keyHeader.trim()
    ) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    const accept = createHash('sha1')
      .update(keyHeader.trim() + WS_GUID)
      .digest('base64');

    const responseHeaders = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '\r\n',
    ].join('\r\n');

    socket.write(responseHeaders);

    const client: ClientConnection = {
      id: `client_${randomUUID()}`,
      socket,
      buffer: head.length > 0 ? Buffer.from(head) : Buffer.alloc(0),
      fragments: [],
      fragmentedOpcode: undefined,
      lastSeenAt: Date.now(),
      authenticatedDeviceId: undefined,
      closed: false,
    };

    this.clients.set(client.id, client);

    socket.on('data', (chunk: Buffer) => {
      client.lastSeenAt = Date.now();
      client.buffer = Buffer.concat([client.buffer, chunk]);
      this.processClientBuffer(client);
    });

    socket.on('close', () => {
      this.removeClient(client);
    });

    socket.on('error', () => {
      this.removeClient(client);
    });

    if (client.buffer.length > 0) {
      this.processClientBuffer(client);
    }
  }

  private processClientBuffer(client: ClientConnection): void {
    while (!client.closed && client.buffer.length >= 2) {
      const byte0 = client.buffer[0]!;
      const byte1 = client.buffer[1]!;
      const fin = (byte0 & 0x80) !== 0;
      const opcode = byte0 & 0x0f;
      const masked = (byte1 & 0x80) !== 0;
      let payloadLength = byte1 & 0x7f;
      let offset = 2;

      if (payloadLength === 126) {
        if (client.buffer.length < offset + 2) return;
        payloadLength = client.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (payloadLength === 127) {
        if (client.buffer.length < offset + 8) return;
        const bigLen = client.buffer.readBigUInt64BE(offset);
        if (bigLen > BigInt(this.maxPayloadBytes)) {
          this.closeClient(client, 1009);
          return;
        }
        payloadLength = Number(bigLen);
        offset += 8;
      }

      if (payloadLength > this.maxPayloadBytes) {
        this.closeClient(client, 1009);
        return;
      }

      const maskLength = masked ? 4 : 0;
      if (client.buffer.length < offset + maskLength + payloadLength) {
        return;
      }

      const maskKey = masked ? client.buffer.subarray(offset, offset + 4) : undefined;
      offset += maskLength;

      const payload = Buffer.from(client.buffer.subarray(offset, offset + payloadLength));
      client.buffer = client.buffer.subarray(offset + payloadLength);

      if (maskKey) {
        for (let i = 0; i < payload.length; i++) {
          payload[i] = payload[i]! ^ maskKey[i % 4]!;
        }
      }

      this.handleFrame(client, fin, opcode, payload);
    }
  }

  private handleFrame(
    client: ClientConnection,
    fin: boolean,
    opcode: number,
    payload: Buffer,
  ): void {
    // Close frame
    if (opcode === 0x8) {
      this.closeClient(client, 1000);
      return;
    }

    // Ping frame
    if (opcode === 0x9) {
      this.sendRawFrame(client, 0x0a, payload);
      return;
    }

    // Pong frame
    if (opcode === 0x0a) {
      client.lastSeenAt = Date.now();
      return;
    }

    // Text or continuation frame
    if (opcode === 0x1 || opcode === 0x0) {
      if (opcode === 0x1) {
        client.fragments = [payload];
        client.fragmentedOpcode = 0x1;
      } else if (client.fragmentedOpcode === 0x1) {
        client.fragments.push(payload);
      } else {
        this.closeClient(client, 1002);
        return;
      }

      const totalLength = client.fragments.reduce((sum, buf) => sum + buf.length, 0);
      if (totalLength > this.maxPayloadBytes) {
        this.closeClient(client, 1009);
        return;
      }

      if (fin) {
        const messageText = Buffer.concat(client.fragments).toString('utf8');
        client.fragments = [];
        client.fragmentedOpcode = undefined;
        void this.handleClientMessage(client, messageText);
      }
    }
  }

  private async handleClientMessage(client: ClientConnection, rawText: string): Promise<void> {
    const parsed = parseBridgeRequest(rawText, this.maxPayloadBytes);
    if (!parsed.ok) {
      this.sendMessage(client, {
        type: 'response',
        requestId: parsed.requestId,
        ok: false,
        error: parsed.error,
      });
      return;
    }

    const request = parsed.request;
    try {
      const data = await this.executeRequest(client, request);
      this.sendMessage(client, {
        type: 'response',
        requestId: request.requestId,
        ok: true,
        data,
      });
    } catch (error) {
      const code =
        error instanceof BridgeCommandError ? error.code : 'COMMAND_EXECUTION_FAILED';
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.sendMessage(client, {
        type: 'response',
        requestId: request.requestId,
        ok: false,
        error: { code, message },
      });
    }
  }

  private async executeRequest(
    client: ClientConnection,
    request: BridgeRequest,
    bypassAuth = false,
  ): Promise<unknown> {
    switch (request.type) {
      case 'hello': {
        if (request.deviceToken && this.pairingManager) {
          const device = this.pairingManager.verifyToken(request.deviceToken);
          if (!device) {
            throw new BridgeCommandError('UNAUTHORIZED', 'Invalid or revoked device token');
          }
          client.authenticatedDeviceId = device.deviceId;
          return {
            protocolVersion: PROTOCOL_VERSION,
            machineId: this.machineId,
            authenticated: true,
            deviceId: device.deviceId,
          };
        }
        return {
          protocolVersion: PROTOCOL_VERSION,
          machineId: this.machineId,
        };
      }

      case 'ping':
        return {
          pong: true,
          timestamp: new Date().toISOString(),
        };

      case 'pair.confirm': {
        if (!this.pairingManager) {
          throw new BridgeCommandError('PAIRING_UNAVAILABLE', 'Pairing manager is not configured');
        }
        const confirmed = this.pairingManager.confirmPairing({
          pairingCode: request.pairingCode,
          deviceName: request.deviceName,
          platform: request.platform,
        });
        if (!confirmed) {
          throw new BridgeCommandError(
            'INVALID_PAIRING_CODE',
            'Pairing code is invalid or expired',
          );
        }
        client.authenticatedDeviceId = confirmed.deviceId;
        return {
          deviceId: confirmed.deviceId,
          deviceToken: confirmed.deviceToken,
          machineId: confirmed.machineId,
          pairedAt: confirmed.pairedAt,
        };
      }

      case 'push.register': {
        if (!bypassAuth) this.requireAuthenticated(client);
        const deviceId = client.authenticatedDeviceId ?? client.id;
        this.pushRouter?.registerDevice({
          deviceId,
          platform: request.platform,
          provider: request.provider,
          pushToken: request.pushToken,
        });
        return {
          registered: true,
          deviceId,
          provider: request.provider,
        };
      }

      case 'agents.list': {
        if (!bypassAuth) this.requireAuthenticated(client);
        const agents = await this.registry.detectAll();
        return { agents };
      }

      case 'models.list': {
        if (!bypassAuth) this.requireAuthenticated(client);
        const models = await this.registry.listModels(request.agentId);
        return { agentId: request.agentId, models };
      }

      case 'machine.get': {
        if (!bypassAuth) this.requireAuthenticated(client);
        const [agents, sessions] = await Promise.all([
          this.registry.detectAll(),
          this.registry.listSessions(),
        ]);
        for (const session of sessions) {
          this.sessionIndex.set(session.id, session);
        }
        return {
          machineId: this.machineId,
          protocolVersion: PROTOCOL_VERSION,
          agents,
          sessions,
          connectedClients: this.clients.size,
        };
      }

      case 'sessions.list': {
        if (!bypassAuth) this.requireAuthenticated(client);
        const sessions = await this.registry.listSessions();
        for (const session of sessions) {
          this.sessionIndex.set(session.id, session);
        }
        return { sessions };
      }

      case 'session.create': {
        if (!bypassAuth) this.requireAuthenticated(client);
        const session = await this.router.createSession(request.agentId, request.input);
        this.sessionIndex.set(session.id, session);
        return { session };
      }

      case 'session.load': {
        if (!bypassAuth) this.requireAuthenticated(client);
        const session = await this.router.loadSession(request.agentId, request.sessionId);
        this.sessionIndex.set(session.id, session);
        return { session };
      }

      case 'session.state': {
        if (!bypassAuth) this.requireAuthenticated(client);
        const session = await this.resolveSession(request.sessionId, request.agentId);
        const buffered = this.eventHistoryBySession.get(session.id) ?? [];
        const latestSequence = buffered.length > 0 ? buffered[buffered.length - 1]!.sequence : 0;
        return {
          session,
          latestSequence,
          bufferedEventCount: buffered.length,
        };
      }

      case 'session.diff': {
        if (!bypassAuth) this.requireAuthenticated(client);
        const session = await this.resolveSession(request.sessionId, request.agentId);
        const diffs = await this.router.getSessionDiff(session);
        return {
          sessionId: session.id,
          diffs,
        };
      }

      case 'session.send': {
        if (!bypassAuth) this.requireAuthenticated(client);
        const session = await this.resolveSession(request.sessionId, request.agentId);
        await this.router.sendMessage(session, request.message, request.modelId);
        return { accepted: true, sessionId: session.id };
      }

      case 'session.cancel': {
        if (!bypassAuth) this.requireAuthenticated(client);
        const session = await this.resolveSession(request.sessionId);
        await this.router.cancel(session);
        return { cancelled: true, sessionId: session.id };
      }

      case 'permission.reply': {
        if (!bypassAuth) this.requireAuthenticated(client);
        const session = await this.resolveSession(request.sessionId, request.agentId);
        await this.router.replyPermission(session, request.permissionId, request.decision);
        return {
          replied: true,
          sessionId: session.id,
          permissionId: request.permissionId,
          decision: request.decision,
        };
      }

      case 'events.replay': {
        if (!bypassAuth) this.requireAuthenticated(client);
        const sessionId = request.sessionId;
        const currentEpoch = this.sessionEpoch.get(sessionId) ?? '';
        const buffered = this.eventHistoryBySession.get(sessionId) ?? [];
        const earliestSequence = buffered.length > 0 ? buffered[0]!.sequence : 0;
        const latestSequence = buffered.length > 0 ? buffered[buffered.length - 1]!.sequence : 0;

        // 客户端请求的 epoch 与服务端当前 epoch 不一致：旧事件流已结束，需快照重建
        const epochMismatch =
          request.streamEpoch !== undefined && request.streamEpoch !== currentEpoch;

        // 缓存截断：afterSequence 落在缓存窗口之前，之前的事件已缺失
        const truncated = buffered.length > 0 && request.afterSequence + 1 < earliestSequence;

        const events =
          epochMismatch || truncated
            ? []
            : buffered.filter((evt) => evt.sequence > request.afterSequence);

        return {
          sessionId,
          streamEpoch: currentEpoch,
          earliestSequence,
          latestSequence,
          truncated: truncated && !epochMismatch,
          resetRequired: epochMismatch,
          events,
        };
      }

      case 'screen.capture': {
        if (!bypassAuth) this.requireAuthenticated(client);
        if (!this.screenCaptureProvider) {
          throw new BridgeCommandError(
            'SCREEN_CAPTURE_UNAVAILABLE',
            'Remote desktop fallback capture is not configured on this machine',
          );
        }
        const frame = await this.screenCaptureProvider(request.displayId);
        return { frame };
      }
    }
  }

  private isClientAuthorized(client: ClientConnection): boolean {
    if (!this.pairingManager) {
      return true;
    }
    if (!client.authenticatedDeviceId) {
      return false;
    }
    return this.pairingManager.isDeviceActive(client.authenticatedDeviceId);
  }

  private requireAuthenticated(client: ClientConnection): void {
    if (!this.isClientAuthorized(client)) {
      throw new BridgeCommandError('UNAUTHORIZED', 'Device authentication required');
    }
  }

  private async resolveSession(
    sessionId: string,
    agentId?: AgentSession['agentId'],
  ): Promise<AgentSession> {
    const cached = this.sessionIndex.get(sessionId);
    if (cached) return cached;

    const listed = await this.registry.listSessions();
    for (const session of listed) {
      this.sessionIndex.set(session.id, session);
    }
    const found = this.sessionIndex.get(sessionId);
    if (found) return found;

    if (agentId) {
      try {
        const loaded = await this.router.loadSession(agentId, sessionId);
        this.sessionIndex.set(loaded.id, loaded);
        return loaded;
      } catch {
        // Fall through to SESSION_NOT_FOUND
      }
    }

    throw new BridgeCommandError('SESSION_NOT_FOUND', `Session not found: ${sessionId}`);
  }

  private broadcastEvent(event: CanonicalAgentEvent): void {
    // epoch 变化＝新事件流实例：清空旧缓存，避免新旧 epoch 事件混排导致 replay 语义错乱
    const prevEpoch = this.sessionEpoch.get(event.sessionId);
    if (prevEpoch !== event.streamEpoch) {
      this.sessionEpoch.set(event.sessionId, event.streamEpoch);
      this.eventHistoryBySession.delete(event.sessionId);
    }
    let history = this.eventHistoryBySession.get(event.sessionId);
    if (!history) {
      history = [];
      this.eventHistoryBySession.set(event.sessionId, history);
    }
    history.push(event);
    if (history.length > this.maxEventsPerSession) {
      history.splice(0, history.length - this.maxEventsPerSession);
    }

    const response: BridgeResponse = {
      type: 'session.event',
      event,
    };
    let deliveredCount = 0;
    for (const client of this.clients.values()) {
      if (this.isClientAuthorized(client)) {
        this.sendMessage(client, response);
        deliveredCount++;
      }
    }
    if (deliveredCount === 0 && this.pushRouter) {
      void this.pushRouter.notifyEvent(event);
    }
  }

  private sendMessage(client: ClientConnection, message: BridgeResponse): void {
    if (client.closed) return;
    const payload = Buffer.from(JSON.stringify(message), 'utf8');
    this.sendRawFrame(client, 0x01, payload);
  }

  private sendRawFrame(client: ClientConnection, opcode: number, payload: Buffer): void {
    if (client.closed) return;
    const length = payload.length;
    let header: Buffer;

    if (length < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x80 | (opcode & 0x0f);
      header[1] = length;
    } else if (length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | (opcode & 0x0f);
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | (opcode & 0x0f);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }

    try {
      client.socket.write(Buffer.concat([header, payload]));
    } catch {
      this.removeClient(client);
    }
  }

  private checkHeartbeats(): void {
    const now = Date.now();
    for (const client of this.clients.values()) {
      if (now - client.lastSeenAt > this.clientTimeoutMs) {
        this.closeClient(client, 1001);
        continue;
      }
      this.sendRawFrame(client, 0x09, Buffer.alloc(0));
    }
  }

  private closeClient(client: ClientConnection, code: number): void {
    if (client.closed) return;
    const codeBuf = Buffer.alloc(2);
    codeBuf.writeUInt16BE(code, 0);
    this.sendRawFrame(client, 0x08, codeBuf);
    this.removeClient(client);
    client.socket.end();
    client.socket.destroy();
  }

  private removeClient(client: ClientConnection): void {
    client.closed = true;
    this.clients.delete(client.id);
  }
}

class BridgeCommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
