/**
 * QUIC-over-hole-punched-UDP P2P 隧道（Nienie Tier-2 传输层）。
 *
 * 对标 RustDesk 的 Tier-2：同一内网直连 → UDP 打洞 P2P（0 带宽）→ 失败才走服务器中继。
 * 本模块封装「打洞 + QUIC」为可复用生产实现，供连接竞速器在 P2P 优先策略下调用。
 *
 * 三条易错点（ChatGPT 2026-11-08 诊断，已由 `tests/quic-p2p.test.ts` 防回归锁定）：
 *  1. `crypto.ops.sign()` 必须返回 ArrayBuffer（非 Buffer），否则 `QUICConnectionId`
 *     （继承 Uint8Array）复制整个签名而非截取前 20 字节（MAX_CONN_ID_LEN），SCID 长度错、握手必挂。
 *  2. 服务端入站连接事件必须用 `events.EventQUICServerConnection.name`，不是字符串 `'connection'`。
 *  3. UDP 打洞必须用 QUICSocket 自身的 `send()`（与 QUIC 共享同一 NAT 映射），不能用独立 dgram socket。
 */
import {
  QUICSocket,
  QUICServer,
  QUICClient,
  events,
  type QUICConnection,
  type QUICStream,
} from '@matrixai/quic';
import { createHmac, randomBytes, randomFillSync, timingSafeEqual } from 'node:crypto';

/** 对端网络端点（打洞目标）。跨公网时应填信令服务器观测到的公网 IP:port，而非本地 bind 地址。 */
export type PeerEndpoint = {
  host: string;
  port: number;
};

/** 易错点 #1：sign() 必须返回 ArrayBuffer（非 Buffer），否则 SCID 截断失效。 */
export function toArrayBuffer(input: Buffer | Uint8Array): ArrayBuffer {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/** 服务端 crypto：HMAC-SHA256 派生 SCID 与 Stateless Retry Token（必须返回 ArrayBuffer）。 */
export function createServerCrypto() {
  const key = toArrayBuffer(randomBytes(32));
  return {
    key,
    ops: {
      async sign(k: ArrayBuffer, data: ArrayBuffer): Promise<ArrayBuffer> {
        const result = createHmac('sha256', Buffer.from(k))
          .update(Buffer.from(data))
          .digest();
        return toArrayBuffer(result);
      },
      async verify(k: ArrayBuffer, data: ArrayBuffer, sig: ArrayBuffer): Promise<boolean> {
        const expected = createHmac('sha256', Buffer.from(k))
          .update(Buffer.from(data))
          .digest();
        const actual = Buffer.from(sig);
        return expected.length === actual.length && timingSafeEqual(expected, actual);
      },
    },
  };
}

/** 客户端 crypto：`data` 为 ArrayBuffer，用 Uint8Array 视图原地填充。 */
export const clientCrypto = {
  ops: {
    async randomBytes(data: ArrayBuffer): Promise<void> {
      randomFillSync(new Uint8Array(data));
    },
  },
};

export type QuicTlsConfig = {
  key: string | Buffer;
  cert: string | Buffer;
  applicationProtos?: string[];
  maxIdleTimeout?: number;
  verifyPeer?: boolean;
};

export function buildServerConfig(cfg: QuicTlsConfig) {
  return {
    key: cfg.key,
    cert: cfg.cert,
    applicationProtos: cfg.applicationProtos ?? ['nienie-p2p'],
    verifyPeer: cfg.verifyPeer ?? false,
    grease: false,
    maxIdleTimeout: cfg.maxIdleTimeout ?? 15000,
  };
}

export function buildClientConfig(cfg: Omit<QuicTlsConfig, 'key' | 'cert'> = {}) {
  return {
    applicationProtos: cfg.applicationProtos ?? ['nienie-p2p'],
    verifyPeer: cfg.verifyPeer ?? false,
    grease: false,
    maxIdleTimeout: cfg.maxIdleTimeout ?? 15000,
  };
}

export type QuicP2PNodeOptions = {
  host?: string;
  port?: number;
  tls: QuicTlsConfig;
  /** 复用同一 HMAC 密钥（多节点/重启需校验旧 Retry Token 时才需要外部注入）。 */
  serverCrypto?: ReturnType<typeof createServerCrypto>;
};

export type P2PMessageHandler = (text: string, stream: QUICStream) => void | Promise<void>;

/**
 * P2P QUIC 节点：持有一个 QUICSocket，可监听入站、可打洞后主动出站建连。
 * 手机与电脑各自运行一个节点；同一设备的 Server/Client 共享同一 QUICSocket。
 */
export class QuicP2PNode {
  private socket: QUICSocket | undefined;
  private server: QUICServer | undefined;
  private readonly serverCrypto: ReturnType<typeof createServerCrypto>;
  private readonly serverConfig: ReturnType<typeof buildServerConfig>;
  private readonly clientConfig: ReturnType<typeof buildClientConfig>;
  private readonly defaultHost: string;
  private readonly defaultPort: number;

  constructor(options: QuicP2PNodeOptions) {
    this.serverCrypto = options.serverCrypto ?? createServerCrypto();
    this.serverConfig = buildServerConfig(options.tls);
    this.clientConfig = buildClientConfig(options.tls);
    this.defaultHost = options.host ?? '0.0.0.0';
    this.defaultPort = options.port ?? 0;
  }

  /** 绑定底层 UDP socket（QUIC 与打洞复用同一 socket / NAT 映射）。 */
  async bind(host?: string, port?: number): Promise<PeerEndpoint> {
    const socket = new QUICSocket({
      resolveHostname: (h) => h,
    });
    await socket.start({ host: host ?? this.defaultHost, port: port ?? this.defaultPort });
    this.socket = socket;
    return { host: socket.host, port: socket.port };
  }

  get localEndpoint(): PeerEndpoint {
    if (!this.socket) throw new Error('QuicP2PNode not bound');
    return { host: this.socket.host, port: this.socket.port };
  }

  /**
   * 易错点 #3：打洞必须用 QUICSocket 自身的 send()。
   * 双向发包打开双方 NAT 映射；QUICSocket 收到非 QUIC 的打洞包会静默丢弃（正常）。
   */
  punch(peer: PeerEndpoint): void {
    if (!this.socket) throw new Error('QuicP2PNode not bound');
    const payload = Buffer.from('NIENIE_PUNCH');
    // 连发多次以提高穿透对称 NAT 的成功率
    for (let i = 0; i < 5; i++) {
      this.socket.send(payload, peer.port, peer.host);
    }
  }

  /** 易错点 #2：入站连接用 `events.EventQUICServerConnection.name` 监听。 */
  serve(onMessage: P2PMessageHandler): void {
    if (!this.socket) throw new Error('QuicP2PNode not bound');
    if (this.server) return;
    const server = new QUICServer({
      socket: this.socket,
      crypto: this.serverCrypto,
      config: this.serverConfig,
    });
    server.addEventListener(events.EventQUICServerConnection.name, (evt) => {
      const conn = (evt as unknown as { detail: QUICConnection }).detail;
      conn.addEventListener(events.EventQUICConnectionStream.name, (e2) => {
        const stream = (e2 as unknown as { detail: QUICStream }).detail;
        void this.readStream(stream).then((text) => onMessage(text, stream));
      });
    });
    this.server = server;
    void server.start();
  }

  /**
   * 打洞后在映射上建立 QUIC 连接（Tier-2 出站）。
   * 由连接竞速器并行调用，直连成功即胜出、中继挂起让位。
   */
  async connect(peer: PeerEndpoint, serverName = 'localhost'): Promise<QUICConnection> {
    if (!this.socket) throw new Error('QuicP2PNode not bound');
    this.punch(peer);
    const client = await (QUICClient as unknown as {
      createQUICClient(opts: unknown): Promise<{ connection: QUICConnection }>;
    }).createQUICClient({
      socket: this.socket,
      host: peer.host,
      port: peer.port,
      serverName,
      crypto: clientCrypto,
      config: this.clientConfig,
    });
    return client.connection;
  }

  /** 从流循环读取完整消息（健壮性：不能只 read 一次）。 */
  private async readStream(stream: QUICStream): Promise<string> {
    const chunks: Buffer[] = [];
    const reader = stream.readable.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value ?? []));
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  async close(): Promise<void> {
    if (this.server) {
      await (this.server as unknown as { stop(opts: { force: boolean }): Promise<void> })
        .stop({ force: true })
        .catch(() => {});
      this.server = undefined;
    }
    if (this.socket) {
      await (this.socket as unknown as { stop(opts: { force: boolean }): Promise<void> })
        .stop({ force: true })
        .catch(() => {});
      this.socket = undefined;
    }
  }
}
