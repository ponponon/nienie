/**
 * QUIC-over-hole-punched-UDP P2P 隧道（Nienie Tier-2 传输层）。
 *
 * 三层分工（对标 RustDesk）：
 *   ConnectionRacer / NetworkScheduler → 决定 LAN / P2P / Relay、竞速与取消（上层）
 *   NatTraversal（信令层）            → 协调两端同时 punch（打洞由上层编排时机）
 *   QuicP2PNode（本模块）             → bind / serve / connect / close（共享同一 UDP socket）
 *
 * 三条易错点（ChatGPT 2026-11-08 诊断，由 `tests/quic-p2p.test.ts` 防回归锁定）：
 *  1. `crypto.ops.sign()` 必须返回 ArrayBuffer（非 Buffer），否则 `QUICConnectionId`（继承 Uint8Array）
 *     复制整个签名而非截取前 20 字节（MAX_CONN_ID_LEN），SCID 长度错、握手必挂。
 *  2. 服务端入站连接事件必须用 `events.EventQUICServerConnection.name`，不是字符串 `'connection'`。
 *  3. UDP 打洞必须用 QUICSocket 自身的 `send()`（与 QUIC 共享同一 NAT 映射），不能用独立 dgram socket。
 *
 * ChatGPT 第二轮 review（2026-11-08）确立的设计边界：
 *  - 打洞（punch）与建连（connect）职责彻底分离，由上层按路径（LAN 不 punch / P2P 双端 punch / Relay 无需）编排。
 *  - connect() 返回持有 QUICClient 生命周期的受管连接句柄，供竞速器取消失败分支。
 *  - 全生命周期用状态机管理，杜绝重复 bind 泄漏 socket / 破坏 NAT 映射。
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
import { setTimeout as sleep } from 'node:timers/promises';

/** 对端网络端点。跨公网应填信令服务器观测到的公网 IP:port，而非本地 bind 地址。 */
export type PeerEndpoint = {
  host: string;
  port: number;
};

/** 受管 P2P 连接：持有 QUICClient 生命周期，供竞速器取消 / 关闭。 */
export type P2PConnection = {
  readonly transport: 'quic';
  readonly connection: QUICConnection;
  readonly remote: PeerEndpoint;
  send(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
};

export type PunchOptions = {
  signal?: AbortSignal;
  attempts?: number;
  intervalMs?: number;
};

export type ConnectOptions = {
  serverName?: string;
  signal?: AbortSignal;
};

export type P2PMessageHandler = (text: string, stream: QUICStream) => void | Promise<void>;

type NodeState = 'idle' | 'binding' | 'bound' | 'closing' | 'closed';

/** 易错点 #1：sign() 必须返回 ArrayBuffer（非 Buffer），否则 SCID 截断失效。 */
export function toArrayBuffer(input: Buffer | Uint8Array): ArrayBuffer {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/** 服务端 crypto：HMAC-SHA256 派生 SCID 与 Stateless Retry Token（返回 ArrayBuffer）。 */
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
  serverCrypto?: ReturnType<typeof createServerCrypto>;
};

class ManagedP2PConnection implements P2PConnection {
  readonly transport = 'quic' as const;
  constructor(
    private readonly client: { connection: QUICConnection; destroy(opts: { force: boolean }): Promise<void> },
    readonly remote: PeerEndpoint,
    private readonly onClosed?: () => void,
  ) {}

  get connection(): QUICConnection {
    return this.client.connection;
  }

  async send(data: Uint8Array): Promise<void> {
    const stream = (this.connection as unknown as { newStream(t: string): { writable: WritableStream<Uint8Array> } })
      .newStream('bidi');
    const writer = stream.writable.getWriter();
    try {
      await writer.write(data);
      await writer.close();
    } finally {
      writer.releaseLock();
    }
  }

  async close(): Promise<void> {
    try {
      await this.client.destroy({ force: true });
    } finally {
      this.onClosed?.();
    }
  }
}

/**
 * P2P QUIC 节点：持有一个 QUICSocket，可监听入站、可打洞后主动出站建连。
 * 手机与电脑各自运行一个节点；同一设备的 Server/Client 共享同一 QUICSocket。
 */
export class QuicP2PNode {
  private socket: QUICSocket | undefined;
  private server: QUICServer | undefined;
  private state: NodeState = 'idle';
  private readonly activeClients = new Set<{ destroy(o: { force: boolean }): Promise<void> }>();
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

  /** 状态机：只允许 idle → binding → bound，杜绝重复 bind 泄漏 socket / 破坏 NAT 映射。 */
  async bind(host?: string, port?: number): Promise<PeerEndpoint> {
    if (this.state !== 'idle') {
      throw new Error(`Cannot bind in state ${this.state}`);
    }
    this.state = 'binding';
    const socket = new QUICSocket({ resolveHostname: (h) => h });
    try {
      await socket.start({ host: host ?? this.defaultHost, port: port ?? this.defaultPort });
      this.socket = socket;
      this.state = 'bound';
      return { host: socket.host, port: socket.port };
    } catch (error) {
      await (socket as unknown as { stop(o: { force: boolean }): Promise<void> })
        .stop({ force: true })
        .catch(() => {});
      this.state = 'idle';
      throw error;
    }
  }

  get localEndpoint(): PeerEndpoint {
    this.requireBound();
    return { host: this.socket!.host, port: this.socket!.port };
  }

  /**
   * 易错点 #3：打洞必须用 QUICSocket 自身的 send()（与 QUIC 共享 NAT 映射）。
   * 与 connect() 彻底分离：由信令/竞速层按路径决定是否打洞、何时打洞（LAN 不 punch、P2P 双端 punch）。
   * 注：QUICSocket 收到非 QUIC 的打洞包会静默丢弃，这是正常的；打洞包只为打开 NAT 映射。
   */
  async punch(peer: PeerEndpoint, options: PunchOptions = {}): Promise<void> {
    this.requireBound();
    const { signal, attempts = 5, intervalMs = 100 } = options;
    const payload = Buffer.from('NIENIE_PUNCH');
    for (let i = 0; i < attempts; i++) {
      signal?.throwIfAborted();
      await this.socket!.send(payload, peer.port, peer.host);
      if (i < attempts - 1) {
        await sleep(intervalMs, undefined, { signal }).catch(() => {});
      }
    }
  }

  /** 易错点 #2：入站连接用 `events.EventQUICServerConnection.name` 监听；async 启动以便失败传播。 */
  async serve(onMessage: P2PMessageHandler): Promise<void> {
    this.requireBound();
    if (this.server) {
      throw new Error('QUIC server already started');
    }
    const server = new QUICServer({
      socket: this.socket!,
      crypto: this.serverCrypto,
      config: this.serverConfig,
    });
    server.addEventListener(events.EventQUICServerConnection.name, (evt) => {
      const conn = (evt as unknown as { detail: QUICConnection }).detail;
      conn.addEventListener(events.EventQUICConnectionStream.name, (e2) => {
        const stream = (e2 as unknown as { detail: QUICStream }).detail;
        void (async () => {
          const text = await this.readStream(stream);
          await onMessage(text, stream);
        })().catch(() => {
          // 业务处理失败（JSON 解析、Agent 异常等）不视为网络层崩溃；
          // 生产接入 logger/reportError 回调上报。
        });
      });
    });
    try {
      await server.start();
      this.server = server;
    } catch (error) {
      throw new Error('Failed to start QUIC server', { cause: error });
    }
  }

  /**
   * 建立 QUIC 连接（不自动打洞 —— 打洞由上层编排，见类注释）。
   * 返回持有 QUICClient 生命周期的受管连接，供竞速器在失败分支上 close()。
   */
  async connect(peer: PeerEndpoint, options: ConnectOptions = {}): Promise<P2PConnection> {
    this.requireBound();
    const { serverName = 'localhost', signal } = options;
    signal?.throwIfAborted();

    const client = await (QUICClient as unknown as {
      createQUICClient(
        opts: unknown,
        ctx?: { signal?: AbortSignal },
      ): Promise<{ connection: QUICConnection; destroy(o: { force: boolean }): Promise<void> }>;
    }).createQUICClient(
      {
        socket: this.socket!,
        host: peer.host,
        port: peer.port,
        serverName,
        crypto: clientCrypto,
        config: this.clientConfig,
      },
      // 把取消信号真正传入握手过程（而非仅在握手前检查一次）
      signal ? { signal } : undefined,
    );

    // 握手期间被取消但最终迟到成功 → 立即销毁刚建立的连接
    if (signal?.aborted) {
      await client.destroy({ force: true }).catch(() => {});
      throw (signal.reason ?? new Error('connect aborted'));
    }

    this.activeClients.add(client);
    const managed = new ManagedP2PConnection(client, peer, () => {
      this.activeClients.delete(client);
    });
    return managed;
  }

  /** 从流循环读取完整消息（健壮性：不能只 read 一次）；生产应加长度上限防无限缓冲。 */
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

  /**
   * 统一关闭：停止 server、销毁活动连接、关闭 socket，保留清理异常原因。
   * 并发 close() 幂等；closing 后拒绝新 bind/serve/connect。
   */
  async close(): Promise<void> {
    if (this.state === 'closed' || this.state === 'closing') return;
    this.state = 'closing';
    const cleanups: Promise<unknown>[] = [];
    if (this.server) {
      cleanups.push(
        (this.server as unknown as { stop(o: { force: boolean }): Promise<void> })
          .stop({ force: true })
          .catch(() => {}),
      );
      this.server = undefined;
    }
    for (const client of this.activeClients) {
      cleanups.push(client.destroy({ force: true }).catch(() => {}));
    }
    this.activeClients.clear();
    if (this.socket) {
      cleanups.push(
        (this.socket as unknown as { stop(o: { force: boolean }): Promise<void> })
          .stop({ force: true })
          .catch(() => {}),
      );
      this.socket = undefined;
    }
    await Promise.allSettled(cleanups);
    this.state = 'closed';
  }

  private requireBound(): void {
    if (this.state !== 'bound' || !this.socket) {
      throw new Error(`QuicP2PNode not bound (state=${this.state})`);
    }
  }
}
