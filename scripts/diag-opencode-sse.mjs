#!/usr/bin/env node
/**
 * OpenCode/MiMo 事件流诊断脚本。
 *
 * 一键复现并定位「回复生成了但手机不显示」这类问题：
 * 对比「建会话是否带 ?directory=」×「订阅全局 /event 还是 /event?directory=<dir>」
 * 四种组合下，一次 Prompt 能收到多少 SSE 事件。
 *
 * 背景：OpenCode/MiMo 事件总线按 directory 分片——带 ?directory= 建的会话，
 * 其 session/message 事件只推给 /event?directory=<dir> 订阅者，不进全局 /event。
 *
 * 用法：
 *   node scripts/diag-opencode-sse.mjs
 *   node scripts/diag-opencode-sse.mjs --url http://127.0.0.1:4096 --dir /path/to/project --wait 5000
 *
 * 退出码：0 = 正常（目录级订阅能收到事件）；1 = 发现丢事件风险；2 = 连不上服务。
 */

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const BASE = argValue('url', process.env.NIENIE_OPENCODE_URL || 'http://127.0.0.1:4096').replace(/\/+$/, '');
const DIR = argValue('dir', process.env.NIENIE_DIAG_DIR || '/tmp/nienie-diag-project');
const WAIT_MS = Number(argValue('wait', '5000'));

/** 订阅一条 SSE，返回 { count, types, stop }。 */
async function subscribe(eventUrl) {
  const controller = new AbortController();
  const events = [];
  const res = await fetch(eventUrl, {
    headers: { accept: 'text/event-stream' },
    signal: controller.signal,
  });
  const pump = (async () => {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const evt = JSON.parse(line.slice(6));
            events.push({
              type: evt.type,
              sessionID: evt.properties?.sessionID,
            });
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      /* aborted */
    }
  })();
  return {
    get count() {
      return events.length;
    },
    events,
    async stop() {
      controller.abort();
      await pump.catch(() => {});
    },
  };
}

/** 建会话（带或不带 ?directory=）。 */
async function createSession(withDir) {
  const url = withDir
    ? `${BASE}/session?directory=${encodeURIComponent(DIR)}`
    : `${BASE}/session`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'nienie-diag' }),
  });
  if (!res.ok) throw new Error(`POST /session 失败: ${res.status}`);
  return res.json();
}

/** 发一条 Prompt。 */
async function sendPrompt(sessionId, withDir) {
  const url = withDir
    ? `${BASE}/session/${sessionId}/prompt_async?directory=${encodeURIComponent(DIR)}`
    : `${BASE}/session/${sessionId}/prompt_async`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(withDir ? { 'x-opencode-directory': DIR } : {}),
    },
    body: JSON.stringify({ parts: [{ type: 'text', text: '只回答两个字：收到' }] }),
  });
  return res.status;
}

async function runCombo(label, createWithDir, subscribeUrl) {
  const sub = await subscribe(subscribeUrl);
  const ses = await createSession(createWithDir);
  await sendPrompt(ses.id, createWithDir);
  await new Promise((r) => setTimeout(r, WAIT_MS));
  await sub.stop();
  // 只统计本次诊断会话的事件：排除 server.connected 噪声，也排除同目录其他会话的事件
  const mine = sub.events.filter((e) => e.sessionID === ses.id && e.type !== 'server.connected');
  const types = [...new Set(mine.map((e) => e.type))];
  return { label, total: sub.count, meaningful: mine.length, types };
}

async function main() {
  // 健康检查
  try {
    const health = await fetch(`${BASE}/global/health`).then((r) => (r.ok ? r.json() : null));
    if (!health) throw new Error('health 非 200');
  } catch (e) {
    console.error(`✗ 连不上 OpenCode 服务 ${BASE}：${e.message}`);
    console.error('  请确认服务已启动（opencode serve --port 4096）或用 --url 指定地址。');
    process.exit(2);
  }

  console.log(`OpenCode 事件流诊断`);
  console.log(`  服务: ${BASE}`);
  console.log(`  项目目录: ${DIR}`);
  console.log(`  每组合等待: ${WAIT_MS}ms\n`);

  const combos = [
    await runCombo('建会话无dir + 订阅全局/event        ', false, `${BASE}/event`),
    await runCombo('建会话无dir + 订阅/event?directory  ', false, `${BASE}/event?directory=${encodeURIComponent(DIR)}`),
    await runCombo('建会话带dir + 订阅全局/event        ', true, `${BASE}/event`),
    await runCombo('建会话带dir + 订阅/event?directory  ', true, `${BASE}/event?directory=${encodeURIComponent(DIR)}`),
  ];

  // 表格输出
  const header = `| 组合 | 事件数 | 有效事件 | 结论 |`;
  const sep = `|------|--------|----------|------|`;
  console.log(header);
  console.log(sep);
  for (const c of combos) {
    const verdict = c.meaningful > 3 ? '✓ 事件正常' : c.meaningful === 0 ? '✗ 无事件(丢回复)' : `△ 偏少(${c.meaningful})`;
    console.log(`| ${c.label} | ${c.total} | ${c.meaningful} | ${verdict} |`);
  }

  console.log(`\n各组合事件类型:`);
  for (const c of combos) {
    console.log(`  ${c.label} → ${c.types.join(', ') || '(无)'}`);
  }

  // 结论判定
  const dirOnGlobal = combos[2].meaningful;
  const dirOnDir = combos[3].meaningful;
  console.log(`\n诊断结论:`);
  if (dirOnGlobal === 0 && dirOnDir > 3) {
    console.log(`  ✓ 符合已知行为：目录会话只推 /event?directory=<dir>，不进全局 /event。`);
    console.log(`    适配器必须按会话 directory 订阅 SSE（已修复），否则项目会话回复会丢。`);
    process.exit(0);
  } else if (dirOnGlobal > 3 && dirOnDir > 3) {
    console.log(`  i 此 OpenCode 版本全局 /event 也投递目录会话事件（行为已变宽松）。`);
    console.log(`    订阅任一端点均可，但保持目录级订阅更稳妥。`);
    process.exit(0);
  } else if (dirOnDir === 0) {
    console.log(`  ✗ 异常：连目录级订阅都收不到事件，可能服务未真正处理 Prompt 或事件流损坏。`);
    process.exit(1);
  } else {
    console.log(`  ? 结果不明确，请人工核对上表事件数。`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('诊断脚本异常:', e.message);
  process.exit(2);
});
