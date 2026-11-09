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

/** 链路自检：追踪一次「建会话→订阅→发 Prompt→收事件」的全链路，逐步报告状态。 */
async function runLinkCheck() {
  const steps = [];
  const add = (name, result) => steps.push({ name, result });

  // 1. Health
  let version = 'unknown';
  try {
    const health = await fetch(`${BASE}/global/health`).then((r) => (r.ok ? r.json() : null));
    version = health?.version ?? 'unknown';
    add('OpenCode Health', health ? `OK (v${version})` : 'FAIL');
  } catch (e) {
    add('OpenCode Health', `FAIL (${e.message})`);
  }

  // 2. Create Session（带 directory）
  let sesId = '';
  try {
    const res = await fetch(`${BASE}/session?directory=${encodeURIComponent(DIR)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'nienie-link-check' }),
    });
    const ses = await res.json();
    sesId = ses.id;
    add('Create Session', res.ok ? `OK (${sesId})` : `FAIL (${res.status})`);
    add('Session Directory', ses.directory ? `${ses.directory}` : '(未记录)');
  } catch (e) {
    add('Create Session', `FAIL (${e.message})`);
    return reportLink(steps);
  }

  // 3. 订阅 /event?directory=X
  const ctrl = new AbortController();
  const seen = [];
  let sseHttp = 'FAIL';
  let sseConnected = '否';
  let sseReadError = '';
  const esPromise = (async () => {
    try {
      const res = await fetch(`${BASE}/event?directory=${encodeURIComponent(DIR)}`, {
        headers: { accept: 'text/event-stream' },
        signal: ctrl.signal,
      });
      sseHttp = `${res.status}`;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value);
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const l of lines) {
          if (!l.startsWith('data: ')) continue;
          try {
            const evt = JSON.parse(l.slice(6));
            seen.push(evt);
            if (evt.type === 'server.connected') sseConnected = 'OK';
          } catch {
            /* ignore */
          }
        }
      }
    } catch (e) {
      if (!sseHttp.startsWith('2')) sseReadError = e.message;
    }
  })();
  // 等一下让 server.connected 到达
  await new Promise((r) => setTimeout(r, 400));
  add('SSE HTTP', sseHttp);
  add('SSE Connected', sseConnected + (sseReadError ? ` (${sseReadError})` : ''));

  // 4. 发 Prompt
  let promptHttp = 'FAIL';
  try {
    const res = await fetch(
      `${BASE}/session/${sesId}/prompt_async?directory=${encodeURIComponent(DIR)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-opencode-directory': DIR },
        body: JSON.stringify({ parts: [{ type: 'text', text: '只回答两个字：收到' }] }),
      },
    );
    promptHttp = `${res.status}`;
  } catch (e) {
    promptHttp = `FAIL (${e.message})`;
  }
  add('Prompt HTTP', promptHttp);

  // 5. 等待事件
  await new Promise((r) => setTimeout(r, WAIT_MS));
  ctrl.abort();
  await esPromise.catch(() => {});

  const mine = seen.filter((e) => e.properties?.sessionID === sesId);
  const types = new Set(mine.map((e) => e.type));
  add('Session Status (busy)', types.has('session.status') ? 'OK' : '(未见)');
  const delta = mine.find((e) => e.type === 'message.part.delta');
  add('Assistant Text Delta', delta ? `OK ("${(delta.properties?.delta ?? '').slice(0, 20)}")` : '(未收到)');
  add('Session Idle', types.has('session.idle') ? 'OK' : '(未见)');

  return reportLink(steps);
}

function reportLink(steps) {
  console.log(`\n链路自检表：`);
  console.log(`| 环节 | 结果 |`);
  console.log(`|------|------|`);
  for (const s of steps) {
    console.log(`| ${s.name} | ${s.result} |`);
  }
  const failed = steps.filter((s) => /FAIL/.test(s.result));
  if (failed.length > 0) {
    console.log(`\n✗ 链路在 [${failed.map((s) => s.name).join(', ')}] 处失败。`);
    return false;
  }
  const ok = steps.some((s) => s.name === 'Assistant Text Delta' && /^OK/.test(s.result));
  console.log(ok ? '\n✓ 全链路通畅，事件回流正常。' : '\n△ 链路部分通畅但未收到回复文本。');
  return ok;
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

  // ① 全链路自检表
  await runLinkCheck();

  // ② 四组合订阅矩阵
  console.log(`\n订阅矩阵对比:`);
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
