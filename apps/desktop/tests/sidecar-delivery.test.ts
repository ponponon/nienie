import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexAdapter, CodexSessionStore } from '@nienie/adapter-codex';
import { AgentRegistry, BridgeServer } from '@nienie/bridge-core';
import type { CanonicalAgentEvent } from '@nienie/protocol';

/**
 * P1（第十八轮）：sidecar 的最终失败提示必须穿过**真实调用链**
 * CodexAdapter → AgentRegistry → BridgeServer → WebSocket 到达下游。
 *
 * 此前的 Adapter 直连监听器测试绕过了 AgentRegistry 中间层——注册即订阅的转发层
 * 会把事件发进空监听器集合静默丢掉，还顺手把 sidecar 确认消费掉。这两个测试
 * 按真实启动顺序组装整条链，不再用直连监听器冒充。
 */
describe('sidecar 真实链路交付（CodexAdapter → AgentRegistry → BridgeServer → WS）', () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  function seedStoreWithSidecar(): {
    codexHome: string;
    storePath: string;
    sidecar: string;
    dir: string;
  } {
    const codexHome = mkdtempSync(join(tmpdir(), 'nienie-codex-home-'));
    const dir = mkdtempSync(join(tmpdir(), 'nienie-sidecar-store-'));
    const storePath = join(dir, 'codex-sessions.json');
    new CodexSessionStore({ filePath: storePath }).save([
      {
        id: 'codex_ses_sidecar',
        title: '手机端任务',
        projectPath: '/workspace/nienie',
        status: 'idle',
        createdAt: '2026-11-24T00:00:00.000Z',
        updatedAt: '2026-11-24T00:10:00.000Z',
      },
    ]);
    const sidecar = `${storePath}.stale-outcomes`;
    writeFileSync(
      sidecar,
      `${JSON.stringify({
        sessionId: 'codex_ses_sidecar',
        at: '2026-11-24T05:00:00.000Z',
        message: 'codex session codex_ses_sidecar: 终态最终未能写入本地索引（重试已放弃），其他窗口可能仍把它显示成运行中',
      })}\n`,
      'utf8',
    );
    cleanups.push(() => {
      rmSync(codexHome, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    });
    return { codexHome, storePath, sidecar, dir };
  }

  function makeAdapter(codexHome: string, storePath: string): CodexAdapter {
    return new CodexAdapter({
      codexHome,
      defaultProjectPath: '/workspace/nienie',
      sessionStorePath: storePath,
      discoverLocalHistory: false,
      spawnProcess: () => {
        throw new Error('本测试不 spawn 进程');
      },
    });
  }

  it('BridgeServer.start() 全链路：PERSIST_FAILED 经 WS 可见，送达后 sidecar 才被确认消费', async () => {
    const { codexHome, storePath, sidecar, dir } = seedStoreWithSidecar();
    const adapter = makeAdapter(codexHome, storePath);
    const registry = new AgentRegistry();
    registry.register(adapter);
    const server = new BridgeServer({ registry });
    cleanups.push(async () => {
      await server.stop();
      await registry.dispose();
    });
    const address = await server.start();

    const ws = new WebSocket(address.url);
    const events: CanonicalAgentEvent[] = [];
    ws.addEventListener('message', (ev: MessageEvent) => {
      const msg = JSON.parse(String(ev.data)) as {
        type: string;
        event?: CanonicalAgentEvent;
      };
      if (msg.type === 'session.event' && msg.event) events.push(msg.event);
    });
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', (err) => reject(err), { once: true });
    });

    const replay = await new Promise<{
      type: string;
      requestId?: string;
      ok?: boolean;
      data?: { events?: CanonicalAgentEvent[] };
    }>((resolve) => {
      const requestId = 'req_replay_1';
      const handler = (ev: MessageEvent) => {
        const msg = JSON.parse(String(ev.data)) as {
          type: string;
          requestId?: string;
          ok?: boolean;
          data?: { events?: CanonicalAgentEvent[] };
        };
        if (msg.type === 'response' && msg.requestId === requestId) {
          ws.removeEventListener('message', handler);
          resolve(msg);
        }
      };
      ws.addEventListener('message', handler);
      ws.send(
        JSON.stringify({
          type: 'events.replay',
          requestId,
          sessionId: 'codex_ses_sidecar',
          afterSequence: 0,
        }),
      );
    });

    const delivered = (replay.data?.events ?? []).filter(
      (event) => event.type === 'error' && event.payload.code === 'PERSIST_FAILED',
    );
    expect(delivered).toHaveLength(1);
    expect(String(delivered[0]?.payload.message)).toContain('终态最终未能写入本地索引');
    // 送达之后才确认消费：主文件与领取副本都必须消失
    expect(existsSync(sidecar)).toBe(false);
    expect(readdirSync(dir).filter((name) => name.includes('.claim'))).toEqual([]);
    ws.close();
  });

  it('没有真正下游时不确认消费：领取副本留盘、不送达；下游接上后恰好补发一次', async () => {
    const { codexHome, storePath, dir } = seedStoreWithSidecar();
    const adapter = makeAdapter(codexHome, storePath);
    const registry = new AgentRegistry();
    registry.register(adapter);
    cleanups.push(() => registry.dispose());

    // 真实 BridgeServer.start() 的前半段（此时 BridgeServer 还没订阅 registry）
    await registry.listSessions();
    // 事件尚未送达：领取副本（记录本体）必须还在盘上，不许确认消费
    expect(readdirSync(dir).filter((name) => name.includes('.claim')).length).toBeGreaterThan(0);

    // 真实 BridgeServer.start() 的后半段：registry.onEvent 注册真正下游
    const received: CanonicalAgentEvent[] = [];
    registry.onEvent((event) => {
      received.push(event);
    });
    const delivered = received.filter(
      (event) => event.type === 'error' && event.payload.code === 'PERSIST_FAILED',
    );
    expect(delivered).toHaveLength(1); // 恰好补发一次，不重复
    expect(readdirSync(dir).filter((name) => name.includes('.claim'))).toEqual([]);
  });
});
