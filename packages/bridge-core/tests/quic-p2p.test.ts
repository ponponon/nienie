/**
 * QUIC-over-hole-punched-UDP 防回归测试（Nienie Tier-2 P2P 传输层）
 *
 * 本测试直接调用生产实现 `src/quic-p2p.ts` 的 `QuicP2PNode`（而非底层 @matrixai/quic API），
 * 锁定 ChatGPT (2026-11-08) 诊断出的三条易错点，防止未来重构时回归：
 *  1. `crypto.ops.sign()` 必须返回 ArrayBuffer（不是 Buffer）——否则 `QUICConnectionId`
 *     （继承 Uint8Array）复制整个签名而非截取前 20 字节（MAX_CONN_ID_LEN），SCID 长度错、握手必挂。
 *  2. 服务端入站连接事件必须用 `events.EventQUICServerConnection.name`，不是字符串 `'connection'`。
 *  3. UDP 打洞必须用 QUICSocket 自身的 `send()`（与 QUIC 共享同一 NAT 映射），不能用独立 dgram socket。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  QuicP2PNode,
  toArrayBuffer,
  createServerCrypto,
} from '../src/quic-p2p.js';

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

const tls = { key: TEST_KEY, cert: TEST_CERT };

describe('QUIC crypto primitives（锁定 ChatGPT 诊断的返回类型）', () => {
  it('toArrayBuffer 必须精确保留 Buffer subarray 边界（不能泄露底层大 buffer）', () => {
    const original = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const sub = original.subarray(3, 7); // 视图：byteOffset=3, byteLength=4
    const result = toArrayBuffer(sub);
    expect(result.byteLength).toBe(4);
    expect(Array.from(new Uint8Array(result))).toEqual([3, 4, 5, 6]);
  });

  it('server sign 必须返回 32 字节 ArrayBuffer（返回 Buffer 会导致 SCID 截断失效）', async () => {
    const crypto = createServerCrypto();
    const data = new Uint8Array([1, 2, 3]).buffer;
    const signature = await crypto.ops.sign(crypto.key, data);
    expect(signature).toBeInstanceOf(ArrayBuffer);
    expect(signature.byteLength).toBe(32); // HMAC-SHA256 输出 32 字节，quiche 截取前 20
  });

  it('server verify 必须能自校验签名且拒绝篡改', async () => {
    const crypto = createServerCrypto();
    const data = new Uint8Array([9, 8, 7]).buffer;
    const sig = await crypto.ops.sign(crypto.key, data);
    expect(await crypto.ops.verify(crypto.key, data, sig)).toBe(true);
    const tampered = await crypto.ops.sign(crypto.key, new Uint8Array([1]).buffer);
    expect(await crypto.ops.verify(crypto.key, data, tampered)).toBe(false);
  });
});

describe('QUIC over hole-punched UDP (Nienie Tier-2 P2P) · 生产 QuicP2PNode', () => {
  it(
    '两个 QuicP2PNode 经打洞后建立 QUIC 隧道并双向收发消息（打洞与建连职责分离）',
    async () => {
      const nodeA = new QuicP2PNode({ tls });
      const nodeB = new QuicP2PNode({ tls });
      try {
        const epA = await nodeA.bind('127.0.0.1', 0);
        const epB = await nodeB.bind('127.0.0.1', 0);

        const serverGot = new Promise<string>((resolve) => {
          // 易错点 #2：生产 serve() 内部用 events.EventQUICServerConnection.name
          void nodeA.serve((text, stream) => {
            resolve(text);
            const writer = stream.writable.getWriter();
            void writer.write(Buffer.from('ACK: ' + text)).then(() => writer.close());
          });
        });

        // 打洞与建连分离：上层（信令/竞速）编排双端 punch，再建连（ChatGPT 建议）
        const punchSpyB = vi.spyOn(nodeB, 'punch');
        await Promise.all([nodeA.punch(epB), nodeB.punch(epA)]);
        expect(punchSpyB).toHaveBeenCalled();

        const conn = await nodeB.connect(epA);
        expect(conn.transport).toBe('quic');

        await conn.send(Buffer.from('Nienie P2P QUIC tunnel message'));
        const received = await serverGot;
        expect(received).toBe('Nienie P2P QUIC tunnel message');

        await conn.close();
      } finally {
        await nodeA.close();
        await nodeB.close();
      }
    },
    25000,
  );

  it('bind 重复调用必须被状态机拒绝（防止泄漏 socket / 破坏 NAT 映射）', async () => {
    const node = new QuicP2PNode({ tls });
    try {
      await node.bind('127.0.0.1', 0);
      await expect(node.bind('127.0.0.1', 0)).rejects.toThrow(/Cannot bind/);
    } finally {
      await node.close();
    }
  });

  it('connect 传入已 AbortSignal 必须立即中止（供竞速器取消失败分支）', async () => {
    const nodeA = new QuicP2PNode({ tls });
    const nodeB = new QuicP2PNode({ tls });
    try {
      const epA = await nodeA.bind('127.0.0.1', 0);
      await nodeB.bind('127.0.0.1', 0);
      const controller = new AbortController();
      controller.abort();
      await expect(
        nodeB.connect(epA, { signal: controller.signal }),
      ).rejects.toThrow();
    } finally {
      await nodeA.close();
      await nodeB.close();
    }
  });
});
