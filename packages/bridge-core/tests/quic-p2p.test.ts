/**
 * QUIC-over-hole-punched-UDP 防回归测试（Nienie Tier-2 P2P 传输层）
 *
 * 锁定 ChatGPT (2026-11-08) 诊断出的三条易错点，防止未来重构时回归：
 *  1. `crypto.ops.sign()` 必须返回 ArrayBuffer（不能返回 Buffer/Uint8Array）——
 *     否则 `QUICConnectionId`（继承 Uint8Array）会复制整个签名而非截取前 20 字节（MAX_CONN_ID_LEN），
 *     导致 SCID 长度错误、TLS 握手永不收尾。
 *  2. 服务端入站连接事件必须用 `events.EventQUICServerConnection.name`，不是字符串 `'connection'`。
 *  3. UDP 打洞必须用 QUICSocket 自身的 `socket.send()`（与 QUIC 共享同一 NAT 映射），
 *     不能用独立 dgram socket。`reuseAddr` 属于 `QUICSocket.start()`，复用已有 socket 的 QUICServer 不涉及。
 *
 * 架构语义：对应 RustDesk 的 Tier-2（P2P 打洞）——同内网直连 → UDP 打洞 P2P（0 带宽）→ 失败才中继。
 */
import { describe, expect, it } from 'vitest';
import { QUICSocket, QUICServer, QUICClient, events } from '@matrixai/quic';
import { createHmac, randomBytes, randomFillSync, timingSafeEqual } from 'node:crypto';

// openssl 生成的测试自签证书（2048 RSA，CN=localhost，SAN=DNS:localhost,IP:127.0.0.1，有效期至 2049）
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDCUau4AXYkz2CV
bqJ67vzwgRpmXuBxjgyAe18o9/VtWWwo+QVv77EtH2uoHf3kLPeHcDFaUBofhEsV
0PG2dhiX9jbzcyRVE/pURSZnBJ+86udrG0HI/uLdS2zVouXlm9kRsDX3ZcNe5Co7
dQ17HJ6kUStQt1jVzMuYH2mDrSipzxHeGTtN75cNMFgtqcNlHlu40WtfXXWBkMo1
C3MY0VpaOKFy+Q3zVgLejFpS69FIcZTYmTAqze1cn3O6TMqA9jvb7E2VC7H7VQ5q
EOuxvM2wdmlSm65/XvqCdawjj4uE17chKXG+UIlpKmSXgkz+qC+0Y1lk3N8F6EP9
ARBaorgHAgMBAAECggEAHtvIaNK2l9bk8CYfIGWmfm0KK7qiavYTby3oaUGjVIew
YPtWzTVjzhYgyxRkNuGbN4NuGvkAhQPFxsOlNwQfGLbNeDDPUsF27f4DQLXfxikJ
sh0kf85Waa0qLe0OFD4BJUl18IFVGtMiD8ohZ20ellqbhdhv/5fjtxc58uLDQ9/q
l+OMMuSuea4BCT8GBFR34fjm3AoKLAtz48AVE379nNwILtNNqSWEvxIMQtAjvGFS
2X+j9OybFhdN/+YE1ynKFijsgBa0BfEV0A1LqeasZWFlvSHFMaEHbCnYUf2wIxse
ryg4bCdnPvY7h8stN375iHi9Msyql8NvErWa74uz3QKBgQD6PeJnzD79bCKqXL3F
P5r1Ehggyxl8w7SI9yYlLcBVhIdGtrxcuaP+8tYBmmoyugW/qbTvXZLimYWrYLRU
JYMkXYVstzJf7O8jUTiLcHQX9UGxY9tYsLGWmm4Uq5Y5E2MCUDMipHYAV6HE1pJO
F//FHneVoCkzJ3CRQhIb8OkbVQKBgQDGylvX74VyX+tcJVCdgYiPrn1Z2xKDTFCH
j7uXTaocqUc27LUDE0T6AXYwEHICzbWh4Hl890ddfc/T20+Ps1u+EfzMDoKl4ab/
WY8YJGXpi33YJ6IVmP/wThQmMC97n+1DuMXQEc1dqC64RuD9qriTh5xY12ljnXrc
7Ie6JlYd6wKBgHNujnyg+8F82zTI2QUfBQTdVuHxrg0eXa38i80EoL8SBjC5ZIRF
Yf/d1pggubIymypBR2RPPs1mUgGu9yAFucvRlBWFICidq+YXtkSkF/lhOe9xB6KO
xyyYigTg7cfgSICtrBjj0kbwJYAeFpkNev9bwX/0xGyDWeq3lpDq/SyNAoGANhFZ
85xo/lfKaxCXIY/WtcWuwF7OZTm/eW+FhTyRdSQxg2XUQdbe3uTA4YfHiq2qpjGo
uW2EUpBik2vF8v7EiCjaSiH0NOvwAOm5+sYDlgbjnoQBGMC5dAG4hz5527T+0nmS
C+qbocqZknNsxHHHrBCpXJySRI7TmP0YWXAN4isCgYEAwK3pn+Ou+cw7kQ5+mERS
lQEJhlhDnQ8g01t0CxRTjw7DjeQL5xpohfM7rR4IpV9en7Gk2L+v9RxVGfoJgiCc
guQF1Ww2VXIqQE1S40GSduamUZBNoNbpJmD+WF/3k697BM0f0dSJGVxOF3geElxa
ACd2jdU0StCLNBItCf0TCa4=
-----END PRIVATE KEY-----`;

const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIDBDCCAeygAwIBAgIULd8MM0MjmEbqdhzYn1/d1C6G0eMwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MTEwODE0MDExNFoXDTQ5MDYx
MDE0MDExNFowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAwlGruAF2JM9glW6ieu788IEaZl7gcY4MgHtfKPf1bVls
KPkFb++xLR9rqB395Cz3h3AxWlAaH4RLFdDxtnYYl/Y283MkVRP6VEUmZwSfvOrn
axtByP7i3Uts1aLl5ZvZEbA192XDXuQqO3UNexyepFErULdY1czLmB9pg60oqc8R
3hk7Te+XDTBYLanDZR5buNFrX111gZDKNQtzGNFaWjihcvkN81YC3oxaUuvRSHGU
2JkwKs3tXJ9zukzKgPY72+xNlQux+1UOahDrsbzNsHZpUpuuf176gnWsI4+LhNe3
ISlxvlCJaSpkl4JM/qgvtGNZZNzfBehD/QEQWqK4BwIDAQABo04wTDAdBgNVHQ4E
FgQU/6sgfy/gpnr30Xe8xfOP5KGLUQgwDwYDVR0TAQH/BAUwAwEB/zAaBgNVHREE
EzARgglsb2NhbGhvc3SHBH8AAAEwDQYJKoZIhvcNAQELBQADggEBAFeXYMTklQtu
zW3e9+Z2ofp2Vo2L7kQzFTd7DteKWIz2MenVlSUWTxOar/JFXPqHhvLKK3etPhpF
dcqBJR8lNW4aKtGOwupP6t4qdudN/rxVS0ZOfx46Kljp/KA4pOhPx1qtq21VYIsB
A69kiXqAiFBY9ee5V3sZl3rgLi7PewpwOmT9d0158a2GJDe5dcooRWkRFQbhx2Kt
3bnzdH5E3F6TBi4u9V9l3koVzmqffPdmN951sPYkiBE5yJTsH+KgYcX0D71foLKC
AieN+PbUyuqJkc5edv03SkzVX1iJU09s4sArMNmuLI7hSJ2/lKWgxg8ftQHRpkSW
S6uK81YRO3k=
-----END CERTIFICATE-----`;

// 易错点 #1：sign() 必须返回 ArrayBuffer（非 Buffer），否则 SCID 截断失效
function toArrayBuffer(input: Buffer | Uint8Array): ArrayBuffer {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

function createServerCrypto() {
  const key = toArrayBuffer(randomBytes(32));
  return {
    key,
    ops: {
      async sign(k: ArrayBuffer, data: ArrayBuffer): Promise<ArrayBuffer> {
        const result = createHmac('sha256', Buffer.from(k))
          .update(Buffer.from(data))
          .digest();
        return toArrayBuffer(result); // 关键：ArrayBuffer，让 quiche 截取前 20 字节
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

// 易错点 #2：randomBytes 用 Uint8Array 视图原地填充
const clientCrypto = {
  ops: {
    async randomBytes(data: ArrayBuffer): Promise<void> {
      randomFillSync(new Uint8Array(data));
    },
  },
};

const commonConfig = {
  applicationProtos: ['nienie-p2p'],
  verifyPeer: false,
  grease: false,
  maxIdleTimeout: 8000,
};
const serverConfig = { ...commonConfig, key: TEST_KEY, cert: TEST_CERT };
const clientConfig = { ...commonConfig };

describe('QUIC over hole-punched UDP (Nienie Tier-2 P2P)', () => {
  it(
    '两个对等点经 UDP 打洞后在同一 socket 建立 QUIC 隧道并双向收发消息',
    async () => {
      let socketA: InstanceType<typeof QUICSocket> | undefined;
      let socketB: InstanceType<typeof QUICSocket> | undefined;
      let serverA: InstanceType<typeof QUICServer> | undefined;
      let clientB: InstanceType<typeof QUICClient> | undefined;
      try {
        socketA = new QUICSocket({ resolveHostname: (h) => h });
        socketB = new QUICSocket({ resolveHostname: (h) => h });
        await socketA.start({ host: '127.0.0.1', port: 0 });
        await socketB.start({ host: '127.0.0.1', port: 0 });

        serverA = new QUICServer({
          socket: socketA,
          crypto: createServerCrypto(),
          config: serverConfig,
        });

        const serverGot = new Promise<string>((resolve) => {
          // 易错点 #3：事件名必须是 events.EventQUICServerConnection.name
          serverA!.addEventListener(events.EventQUICServerConnection.name, (evt: any) => {
            const conn = evt.detail;
            conn.addEventListener(events.EventQUICConnectionStream.name, (e2: any) => {
              const stream = e2.detail;
              const reader = stream.readable.getReader();
              reader.read().then(({ value }: any) => {
                const text = Buffer.from(value ?? []).toString('utf8');
                resolve(text);
              });
            });
          });
        });
        await serverA.start();

        // 易错点 #4：打洞必须用 QUICSocket 自身的 socket.send()（共享 NAT 映射）
        await Promise.all([
          socketA.send(Buffer.from('NIE-PUNCH'), socketB.port, socketB.host),
          socketB.send(Buffer.from('NIE-PUNCH'), socketA.port, socketA.host),
        ]);

        clientB = await (QUICClient as any).createQUICClient({
          socket: socketB,
          host: socketA.host,
          port: socketA.port,
          serverName: 'localhost',
          crypto: clientCrypto,
          config: clientConfig,
        }) as InstanceType<typeof QUICClient>;
        const conn = (clientB as any).connection;

        const stream = conn.newStream('bidi');
        const writer = stream.writable.getWriter();
        const msg = 'Nienie P2P QUIC tunnel message';
        await writer.write(Buffer.from(msg));
        await writer.close();

        const received = await serverGot;
        expect(received).toBe(msg);
      } finally {
        if (clientB) await (clientB as any).destroy().catch(() => {});
        if (serverA) await (serverA as any).stop({ force: true }).catch(() => {});
        if (socketA) await (socketA as any).stop({ force: true }).catch(() => {});
        if (socketB) await (socketB as any).stop({ force: true }).catch(() => {});
      }
    },
    25000,
  );
});
