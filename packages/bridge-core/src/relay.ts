import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  decryptRelayPayload,
  DEFAULT_MAX_MESSAGE_BYTES,
  DEFAULT_RELAY_URL,
  encryptRelayPayload,
  resolveRelayUrl,
  type BridgeResponse,
  type CanonicalAgentEvent,
  type RelayWireMessage,
} from '@nienie/protocol';
import type { BridgeServer } from './ws-server.js';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export type RelayServerOptions = {
  host?: string | undefined;
  port?: number | undefined;
  maxPayloadBytes?: number | undefined;
};

type RelayPeer = {
  connId: string;
  socket: Duplex;
  buffer: Buffer;
  role: 'bridge' | 'mobile' | undefined;
  machineId: string | undefined;
  clientId: string | undefined;
  closed: boolean;
};

export class RelayServer {
  private readonly host: string;
  private readonly requestedPort: number;
  private readonly maxPayloadBytes: number;
  private httpServer: Server | undefined;

  private readonly peers = new Map<string, RelayPeer>();
  private readonly bridgesByMachine = new Map<string, RelayPeer>();
  private readonly mobilesByMachine = new Map<string, Map<string, RelayPeer>>();

  constructor(options: RelayServerOptions = {}) {
    this.host = options.host ?? '127.0.0.1';
    this.requestedPort = options.port ?? 0;
    this.maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
  }

  async start(): Promise<{ host: string; port: number; url: string }> {
    const server = createServer((_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'nienie-relay' }));
    });
    server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.requestedPort, this.host, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });

    this.httpServer = server;
    const addr = server.address();
    if (!addr || typeof addr === 'string') {
      throw new Error('RelayServer is not bound to a TCP port');
    }
    return {
      host: this.host,
      port: addr.port,
      url: `ws://${this.host}:${addr.port}`,
    };
  }

  async stop(): Promise<void> {
    for (const peer of this.peers.values()) {
      peer.closed = true;
      peer.socket.destroy();
    }
    this.peers.clear();
    this.bridgesByMachine.clear();
    this.mobilesByMachine.clear();

    const server = this.httpServer;
    this.httpServer = undefined;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  disconnectBridge(machineId: string): void {
    const bridge = this.bridgesByMachine.get(machineId);
    if (bridge) {
      bridge.socket.destroy();
      this.cleanupPeer(bridge);
    }
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string' || !key.trim()) {
      socket.destroy();
      return;
    }

    const accept = createHash('sha1')
      .update(key.trim() + WS_GUID)
      .digest('base64');
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '\r\n',
      ].join('\r\n'),
    );

    const peer: RelayPeer = {
      connId: `rpeer_${randomUUID()}`,
      socket,
      buffer: head.length > 0 ? Buffer.from(head) : Buffer.alloc(0),
      role: undefined,
      machineId: undefined,
      clientId: undefined,
      closed: false,
    };
    this.peers.set(peer.connId, peer);

    socket.on('data', (chunk: Buffer) => {
      peer.buffer = Buffer.concat([peer.buffer, chunk]);
      this.processPeerBuffer(peer);
    });
    socket.on('close', () => this.cleanupPeer(peer));
    socket.on('error', () => this.cleanupPeer(peer));

    if (peer.buffer.length > 0) {
      this.processPeerBuffer(peer);
    }
  }

  private processPeerBuffer(peer: RelayPeer): void {
    while (!peer.closed && peer.buffer.length >= 2) {
      const byte0 = peer.buffer[0]!;
      const byte1 = peer.buffer[1]!;
      const opcode = byte0 & 0x0f;
      const masked = (byte1 & 0x80) !== 0;
      let len = byte1 & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (peer.buffer.length < offset + 2) return;
        len = peer.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (len === 127) {
        if (peer.buffer.length < offset + 8) return;
        len = Number(peer.buffer.readBigUInt64BE(offset));
        offset += 8;
      }

      if (len > this.maxPayloadBytes) {
        peer.socket.destroy();
        this.cleanupPeer(peer);
        return;
      }

      const maskLen = masked ? 4 : 0;
      if (peer.buffer.length < offset + maskLen + len) return;

      const mask = masked ? peer.buffer.subarray(offset, offset + 4) : undefined;
      offset += maskLen;

      const payload = Buffer.from(peer.buffer.subarray(offset, offset + len));
      peer.buffer = peer.buffer.subarray(offset + len);

      if (mask) {
        for (let i = 0; i < payload.length; i++) {
          payload[i] = payload[i]! ^ mask[i % 4]!;
        }
      }

      if (opcode === 0x8) {
        peer.socket.end();
        this.cleanupPeer(peer);
        return;
      }

      if (opcode === 0x1) {
        this.handleRelayMessage(peer, payload.toString('utf8'));
      }
    }
  }

  private handleRelayMessage(peer: RelayPeer, rawText: string): void {
    let msg: RelayWireMessage;
    try {
      msg = JSON.parse(rawText) as RelayWireMessage;
    } catch {
      return;
    }

    if (msg.type === 'relay.register') {
      peer.role = msg.role;
      peer.machineId = msg.machineId;
      peer.clientId = msg.clientId;

      if (msg.role === 'bridge') {
        this.bridgesByMachine.set(msg.machineId, peer);
        this.sendToPeer(peer, {
          type: 'relay.registered',
          role: 'bridge',
          machineId: msg.machineId,
          clientId: msg.clientId,
          bridgeOnline: true,
        });
        this.notifyMobilePresence(msg.machineId, true);
      } else {
        let group = this.mobilesByMachine.get(msg.machineId);
        if (!group) {
          group = new Map();
          this.mobilesByMachine.set(msg.machineId, group);
        }
        group.set(msg.clientId, peer);
        const bridgeOnline = this.bridgesByMachine.has(msg.machineId);
        this.sendToPeer(peer, {
          type: 'relay.registered',
          role: 'mobile',
          machineId: msg.machineId,
          clientId: msg.clientId,
          bridgeOnline,
        });
      }
      return;
    }

    if (msg.type === 'relay.forward') {
      if (peer.role === 'mobile') {
        const bridge = this.bridgesByMachine.get(msg.machineId);
        if (!bridge || bridge.closed) {
          this.sendToPeer(peer, {
            type: 'relay.error',
            code: 'BRIDGE_OFFLINE',
            machineId: msg.machineId,
            message: 'Target Bridge is offline',
          });
          return;
        }
        this.sendToPeer(bridge, msg);
      } else if (peer.role === 'bridge') {
        const group = this.mobilesByMachine.get(msg.machineId);
        if (!group) return;
        if (msg.toClientId) {
          const target = group.get(msg.toClientId);
          if (target) this.sendToPeer(target, msg);
        } else {
          for (const mobile of group.values()) {
            this.sendToPeer(mobile, msg);
          }
        }
      }
    }
  }

  private notifyMobilePresence(machineId: string, bridgeOnline: boolean): void {
    const group = this.mobilesByMachine.get(machineId);
    if (!group) return;
    const notice: RelayWireMessage = {
      type: 'relay.presence',
      machineId,
      bridgeOnline,
    };
    for (const mobile of group.values()) {
      this.sendToPeer(mobile, notice);
    }
  }

  private sendToPeer(peer: RelayPeer, message: RelayWireMessage): void {
    if (peer.closed) return;
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    const len = body.length;
    let header: Buffer;
    if (len < 126) {
      header = Buffer.from([0x81, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    try {
      peer.socket.write(Buffer.concat([header, body]));
    } catch {
      this.cleanupPeer(peer);
    }
  }

  private cleanupPeer(peer: RelayPeer): void {
    if (peer.closed) return;
    peer.closed = true;
    this.peers.delete(peer.connId);

    if (peer.role === 'bridge' && peer.machineId) {
      if (this.bridgesByMachine.get(peer.machineId) === peer) {
        this.bridgesByMachine.delete(peer.machineId);
        this.notifyMobilePresence(peer.machineId, false);
      }
    } else if (peer.role === 'mobile' && peer.machineId && peer.clientId) {
      const group = this.mobilesByMachine.get(peer.machineId);
      if (group?.get(peer.clientId) === peer) {
        group.delete(peer.clientId);
      }
    }
  }
}

export type BridgeRelayClientOptions = {
  machineId: string;
  bridgeServer: BridgeServer;
  relayUrl?: string | undefined;
  sharedSecret?: string | undefined;
  autoReconnect?: boolean | undefined;
  reconnectDelayMs?: number | undefined;
};

export class BridgeRelayClient {
  readonly machineId: string;
  readonly relayUrl: string;
  private readonly bridgeServer: BridgeServer;
  private readonly sharedSecret: string | undefined;
  private readonly autoReconnect: boolean;
  private readonly reconnectDelayMs: number;
  private readonly clientId: string;

  private ws: WebSocket | undefined;
  private unsubscribeEvents: (() => void) | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(options: BridgeRelayClientOptions) {
    this.machineId = options.machineId;
    this.bridgeServer = options.bridgeServer;
    this.relayUrl = resolveRelayUrl(options.relayUrl ?? DEFAULT_RELAY_URL);
    this.sharedSecret = options.sharedSecret;
    this.autoReconnect = options.autoReconnect ?? true;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 1000;
    this.clientId = `bridge_${randomUUID()}`;
  }

  async connect(): Promise<void> {
    this.disposed = false;
    if (!this.unsubscribeEvents) {
      this.unsubscribeEvents = this.bridgeServer.getRegistry().onEvent((event) => {
        this.forwardEventToMobile(event);
      });
    }
    await this.openSocket();
  }

  async close(): Promise<void> {
    this.disposed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.unsubscribeEvents) {
      this.unsubscribeEvents();
      this.unsubscribeEvents = undefined;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = undefined;
    }
  }

  private async openSocket(): Promise<void> {
    const ws = new WebSocket(this.relayUrl);
    this.ws = ws;

    ws.addEventListener('message', (ev) => {
      void this.handleMessage(String(ev.data));
    });

    ws.addEventListener('close', () => {
      if (!this.disposed && this.autoReconnect) {
        this.reconnectTimer = setTimeout(() => {
          void this.openSocket().catch(() => undefined);
        }, this.reconnectDelayMs);
      }
    });

    await new Promise<void>((resolve, reject) => {
      ws.addEventListener(
        'open',
        () => {
          const registerMsg: RelayWireMessage = {
            type: 'relay.register',
            role: 'bridge',
            machineId: this.machineId,
            clientId: this.clientId,
          };
          ws.send(JSON.stringify(registerMsg));
          resolve();
        },
        { once: true },
      );
      ws.addEventListener('error', (err) => reject(err), { once: true });
    });
  }

  private async handleMessage(rawText: string): Promise<void> {
    let msg: RelayWireMessage;
    try {
      msg = JSON.parse(rawText) as RelayWireMessage;
    } catch {
      return;
    }

    if (msg.type !== 'relay.forward') return;

    let innerRequestText: string | undefined;
    if (msg.encrypted && this.sharedSecret) {
      try {
        innerRequestText = decryptRelayPayload(msg.encrypted, this.sharedSecret);
      } catch {
        return;
      }
    } else if (typeof msg.payload === 'string') {
      innerRequestText = msg.payload;
    }

    if (!innerRequestText) return;

    const bridgeResponse = await this.bridgeServer.processExternalRequest(innerRequestText);
    this.sendForwardedResponse(bridgeResponse, msg.fromClientId);
  }

  private forwardEventToMobile(event: CanonicalAgentEvent): void {
    const response: BridgeResponse = {
      type: 'session.event',
      event,
    };
    this.sendForwardedResponse(response);
  }

  private sendForwardedResponse(response: BridgeResponse, toClientId?: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const serialized = JSON.stringify(response);

    const forwardMsg: RelayWireMessage = this.sharedSecret
      ? {
          type: 'relay.forward',
          machineId: this.machineId,
          fromClientId: this.clientId,
          ...(toClientId ? { toClientId } : {}),
          encrypted: encryptRelayPayload(serialized, this.sharedSecret),
        }
      : {
          type: 'relay.forward',
          machineId: this.machineId,
          fromClientId: this.clientId,
          ...(toClientId ? { toClientId } : {}),
          payload: serialized,
        };

    this.ws.send(JSON.stringify(forwardMsg));
  }
}
