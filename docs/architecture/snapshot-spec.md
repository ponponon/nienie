Commit I 设计规范：SessionSnapshot 状态协议

这次我们先把协议定下来，再写代码。我的建议是：不要把 Commit I 做成现有 getSessionSnapshot() 的简单重构，而是把它作为 Nienie 历史恢复系统的正式 V2 设计。

有一个核心原则需要先确定：

Snapshot 表示某个 Session 在某个确定时刻的完整状态；CanonicalAgentEvent 表示该时刻之后发生的状态变化。

二者不能混用，也不能共享同一套安装逻辑。

我建议 Commit I 最终实现以下架构：

Nienie Session Recovery Architecture

历史状态系统 · Snapshot

SessionSnapshot

完整 Part 状态

Snapshot ID

streamEpoch

watermark

分页信息

手机端 Snapshot Installer

校验完整性

构造临时 Timeline

原子替换

设置 sequence watermark

从 watermark + 1 开始

实时事件系统 · Replay

CanonicalAgentEvent

sequence

streamEpoch

eventId

Delta Reducer

Gap Detection

最终 Timeline

Snapshot 状态 + watermark 之后的实时事件

这套设计最重要的不是 DTO 字段本身，而是 watermark 的定义和 Snapshot 读取期间的事件一致性。

我先给你确定几个不能妥协的约束：

Snapshot 绝不调用 normalizer.nextSequence()。

Snapshot 绝不经过 _handleServerMessage()。

Snapshot 读取失败绝不返回空成功。

不完整 Snapshot 绝不允许覆盖现有 Timeline。

Snapshot 和实时事件必须共享同一个可验证的时间边界。

watermark 之后的事件必须能够从 Replay 缓存连续获取，否则必须重新 Snapshot。

下面给出具体接口。

1. DTO 精确定义

建议把类型放在：

packages/protocol/src/index.ts

实现和状态归约器放在：

packages/agent-events/src/

1.1 Snapshot 的 TypeScript 类型

下面这套类型可以直接作为 Commit I 的基础。

TypeScript
export const SESSION_SNAPSHOT_SCHEMA_VERSION = 1 as const;

export type SnapshotContentBlock =
  | {
      type: 'text';
      text: string;
    }
  | {
      type: 'image';
      mimeType?: string;
      uri?: string;
      alt?: string;
    }
  | {
      type: 'resource';
      uri: string;
      name?: string;
      mimeType?: string;
    };

export type SnapshotPartBase = {
  /**
   * Session 内稳定唯一。
   * 必须来自源 Agent 的 ID 或稳定派生 ID。
   */
  partId: string;

  /**
   * 整个 Session 时间线中的排序位置。
   */
  ordinal: number;

  /**
   * 该 Part 的状态版本。
   * 同一个 partId 下严格单调递增。
   */
  revision: number;

  createdAt: string;
  updatedAt: string;
};

Part 使用 discriminated union。

第一类：消息和思考内容

TypeScript
export type SnapshotMessagePart =
  SnapshotPartBase & {
    kind: 'message';
    messageId?: string;
    role: 'user' | 'assistant';
    content: SnapshotContentBlock[];
  };

export type SnapshotThinkingPart =
  SnapshotPartBase & {
    kind: 'thinking';
    content: string;
  };

这里有个重要约定：

User Prompt 是 message + role=user。

Assistant 正文是 message + role=assistant。

Thinking 单独存储，不混入 Assistant 正文。

不要把一个 Message 的多个文本 Delta 拆成多个 Part。

第二类：Tool Call

TypeScript
export type SnapshotToolCallPart =
  SnapshotPartBase & {
    kind: 'tool_call';

    toolCallId: string;
    name: string;

    input: Record<string, unknown>;

    status:
      | 'pending'
      | 'running'
      | 'completed'
      | 'failed';

    output?: string;

    isError?: boolean;
    truncated?: boolean;
    omittedChars?: number;
    exitCode?: number;
  };

这里特意把 tool_use 和 tool_result 合并成一个状态对象。

例如：

JSON
{
  "kind": "tool_call",
  "partId": "part_123",
  "ordinal": 5,
  "revision": 3,
  "createdAt": "2026-11-09T10:00:00.000Z",
  "updatedAt": "2026-11-09T10:00:05.000Z",
  "toolCallId": "call_123",
  "name": "bash",
  "input": {
    "command": "pytest tests/"
  },
  "status": "failed",
  "output": "3 failed, 20 passed",
  "isError": true,
  "exitCode": 1
}

这样 Snapshot 不需要依次重放 Tool Use 和 Tool Result 两个事件。

第三类：其他 Timeline 状态

TypeScript
export type SnapshotPermissionPart =
  SnapshotPartBase & {
    kind: 'permission';
    permissionId: string;
    permission: string;
    detail: string;
    patterns: string[];
    decision?: 'allow_once' | 'allow_always' | 'reject';
  };

export type SnapshotUsagePart =
  SnapshotPartBase & {
    kind: 'usage';
    usageId: string;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens?: number;
    costUsd: number;
  };

export type SnapshotErrorPart =
  SnapshotPartBase & {
    kind: 'error';
    errorId: string;
    code: string;
    message: string;
    retryable: boolean;
  };

export type SnapshotFileChangePart =
  SnapshotPartBase & {
    kind: 'file_change';
    diffId: string;
    file: string;
    before: string;
    after: string;
    additions: number;
    deletions: number;
  };

最后合并：

TypeScript
export type SessionSnapshotPart =
  | SnapshotMessagePart
  | SnapshotThinkingPart
  | SnapshotToolCallPart
  | SnapshotPermissionPart
  | SnapshotUsagePart
  | SnapshotErrorPart
  | SnapshotFileChangePart;

这七种类型覆盖当前 Nienie Timeline 已有的主要状态。

屏幕截图、附件等以后可以增加新的 Part 类型，不要将图片 Base64 直接塞入 Snapshot。图片应该通过 URI 或资源引用传输。

1.2 SessionSnapshot 本身
TypeScript
export type SessionSnapshot = {
  schemaVersion: typeof SESSION_SNAPSHOT_SCHEMA_VERSION;

  /**
   * 每次 Snapshot 捕获生成一个全新的 ID。
   */
  snapshotId: string;

  sessionId: string;
  agentId: AgentId;

  /**
   * 必须和实时事件使用同一个 epoch。
   */
  streamEpoch: string;

  /**
   * Snapshot 完整覆盖的最后一个 Canonical Event sequence。
   */
  watermark: number;

  capturedAt: string;

  /**
   * Adapter 返回的是完整状态，不允许返回部分成功。
   */
  complete: true;
  hasMore: false;

  totalParts: number;
  parts: SessionSnapshotPart[];

  sessionStatus?: AgentStatus;
};

注意：这里的 complete 和 hasMore 是完整 Adapter Snapshot 的约束，始终分别为 true 和 false。

1.3 为什么还需要 SessionSnapshotPage？

因为当前 Bridge 有：

TypeScript
DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;

不能假设所有 Session 都能一次性通过 WebSocket 传输。

因此 Bridge 对外需要分页协议：

TypeScript
export type SessionSnapshotPage = {
  schemaVersion: typeof SESSION_SNAPSHOT_SCHEMA_VERSION;

  snapshotId: string;
  sessionId: string;
  agentId: AgentId;
  streamEpoch: string;

  watermark: number;
  capturedAt: string;

  parts: SessionSnapshotPart[];

  /**
   * 当前页是否已经完成整个 Snapshot。
   */
  complete: boolean;

  /**
   * 是否还有下一页。
   */
  hasMore: boolean;

  nextCursor?: string;

  totalParts: number;
};

两者的职责：

类型

	

职责

	

是否允许部分数据




SessionSnapshot

	

Adapter 内部完整状态

	

不允许




SessionSnapshotPage

	

Bridge 网络传输

	

允许




Mobile Timeline

	

用户最终看到的状态

	

只能安装完整 Snapshot

必须保证：

TypeScript
page.complete === !page.hasMore

对于最后一页：

JSON
{
  "complete": true,
  "hasMore": false
}

对于中间页：

JSON
{
  "complete": false,
  "hasMore": true,
  "nextCursor": "opaque_cursor"
}

手机端绝不能在收到第一页时就清空 Timeline。

2. 两套系统如何通过 watermark 衔接

这是整个设计的核心。

2.1 watermark 的精确定义

定义：

watermark 是 Snapshot 所覆盖的最后一条已经成功应用到 Adapter 状态存储中的 CanonicalAgentEvent.sequence。

例如：

纯文本
epoch = E1

实时事件：
1  用户消息
2  Assistant 文本
3  Thinking
4  Tool Use
5  Tool Result
6  Assistant 文本
7  Status

在 sequence=7 之后获取 Snapshot：

JSON
{
  "streamEpoch": "E1",
  "watermark": 7,
  "parts": [
    {"kind": "message", "partId": "p1"},
    {"kind": "thinking", "partId": "p2"},
    {"kind": "tool_call", "partId": "p3"}
  ]
}

手机端安装完成：

纯文本
currentEpoch = E1
lastSequence = 7

接下来请求：

JSON
{
  "type": "events.replay",
  "sessionId": "session_123",
  "streamEpoch": "E1",
  "afterSequence": 7
}

Bridge 必须返回：

纯文本
8
9
10
11
...

而不能返回：

纯文本
7
8
10
11

也不能返回：

纯文本
10
11

除非明确告诉客户端需要重新 Snapshot。

2.2 谁维护 watermark？

Adapter 的 Session State Store 维护。

不是：

SQLite rowid。

SQLite 最后一条记录的时间戳。

Part 数量。

Bridge 缓存最后一个事件的 sequence。

客户端收到的最后一个 eventId。

Snapshot 自己生成的 sequence。

建议在 @nienie/agent-events 中增加：

TypeScript
export interface SessionStateStore {
  applyEvent(event: CanonicalAgentEvent): void;

  getLastAppliedSequence(
    sessionId: string,
  ): number;

  createSnapshot(
    sessionId: string,
  ): SessionSnapshot;
}

这里的 applyEvent() 必须同步更新 Part 状态和最后应用的 sequence。

例如：

TypeScript
applyEvent(event) {
  // 1. 检查 epoch
  // 2. 检查 sequence 连续性
  // 3. 根据事件类型更新 Part
  // 4. 更新 sessionStatus
  // 5. 更新 lastAppliedSequence
}

顺序不能颠倒。

只有状态更新成功之后，才能认为该 sequence 已经被 Snapshot 覆盖。

2.3 最关键的实现：Snapshot 捕获屏障

我建议所有 Adapter 统一使用一个 per-session 串行执行器。

接口：

TypeScript
export interface SessionSerialExecutor {
  run<T>(
    sessionId: string,
    operation: () => Promise<T> | T,
  ): Promise<T>;
}

所有实时事件都必须经过它：

TypeScript
async function publishEvent(
  sessionId: string,
  rawEvent: RawEvent,
): Promise<void> {
  await executor.run(sessionId, () => {
    const event = normalizeAndAssignSequence(rawEvent);

    stateStore.applyEvent(event);

    emitToListeners(event);
  });
}

Snapshot 也使用同一个执行器：

TypeScript
async function getSessionSnapshot(
  sessionId: string,
): Promise<SessionSnapshot> {
  return executor.run(sessionId, () => {
    return stateStore.createSnapshot(sessionId);
  });
}

createSnapshot() 在这个临界区内必须是同步的：

读取 lastAppliedSequence。

深拷贝 Part 状态。

记录 streamEpoch。

生成 snapshotId。

返回不可变快照。

不要在这个临界区内执行 SQLite 查询、网络请求或其他长时间 I/O。

这样就能保证：

Snapshot 捕获时刻

已完成

Event 100 已应用到 State Store。

Snapshot 屏障

捕获 watermark=100，复制当前全部 Part。

后续事件

Event 101、102、103 等待屏障释放，然后依次应用。

最终结果

Snapshot 包含截至 100 的状态，Replay 从 101 开始。

这样 Snapshot 和实时事件之间就不存在不确定的重叠区间。

特别强调：Snapshot 不需要等待 SQLite 再读一遍数据库。

SQLite、JSONL 等是初始历史状态的来源，不应该是每次 Snapshot 的直接数据来源。

这也是我对原先设计的一项重要调整。

2.4 初始历史如何进入 State Store？

这也是 Commit I 必须一起处理的地方。

当 Adapter 第一次加载一个已有 Session：

纯文本
loadSession(sessionId)
    ↓
从 SQLite / JSONL / thread_history 加载完整历史
    ↓
转换为 SessionSnapshotPart[]
    ↓
初始化 SessionStateStore
    ↓
sequence 初始化为 0
    ↓
启动或启用实时事件接收
    ↓
第一条实时事件 sequence=1

注意：这里的历史数据不再转换成 CanonicalAgentEvent 发送。

否则你又会回到之前的设计。

对于新 Session：

纯文本
空 State Store
watermark = 0
sequence = 0

随后正常接收事件。

对于已经开始实时运行、但还没有完成历史初始化的 Session，不能直接用数据库结果覆盖当前状态。必须先完成初始化，或者明确报告无法获得一致 Snapshot。

这也意味着 Adapter 的历史加载逻辑需要从原来的：

TypeScript
emitSqliteSessionHistory(sessionId);

改成：

TypeScript
hydrateSessionState(sessionId);

两者的语义完全不同。

3. Snapshot 期间实时 SSE 事件怎么处理？

采用刚才的串行屏障后，Adapter 内部已经解决了状态一致性问题。

但手机端还有一个独立问题：Snapshot 下载期间，WebSocket 仍然可能收到实时事件。

因此需要客户端暂存。

3.1 手机端增加状态
dart
final Set<String> _snapshotInProgress = {};

final Map<String, List<CanonicalAgentEvent>>
    _snapshotEventBuffer = {};

修改 _handleServerMessage()：

dart
void _handleServerMessage(Map<String, dynamic> raw) {
  if (raw['type'] != 'session.event') {
    // 其他消息正常处理
    return;
  }

  final event = CanonicalAgentEvent.fromJson(
    Map<String, dynamic>.from(raw['event'] as Map),
  );

  if (_snapshotInProgress.contains(event.sessionId)) {
    _snapshotEventBuffer
        .putIfAbsent(event.sessionId, () => [])
        .add(event);

    return;
  }

  _handleCanonicalEventNormally(event);
}

注意，暂存必须发生在 eventId 去重之前。

因为这些事件还没有正式提交到当前 Timeline。

3.2 为什么不会重复文本？

假设：

纯文本
Snapshot watermark = 100

Snapshot 下载期间：

纯文本
101：文本 delta "Hello"
102：文本 delta " World"
103：tool_use

三个事件进入客户端暂存区。

Snapshot 安装后：

纯文本
Timeline = Snapshot Part State
lastSequence = 100

接下来：

dart
final buffered = _snapshotEventBuffer.remove(sessionId) ?? [];

buffered.sort((a, b) => a.sequence.compareTo(b.sequence));

for (final event in buffered) {
  if (event.streamEpoch != snapshot.streamEpoch) {
    continue;
  }

  if (event.sequence <= snapshot.watermark) {
    continue;
  }

  _handleCanonicalEventNormally(event);
}

于是：

纯文本
101 → 应用
102 → 应用
103 → 应用

不会重复。

因为刚才定义的 Snapshot 屏障保证：

纯文本
Snapshot 中不包含 101、102、103。

而 watermark 是一个确定边界，不是猜测出来的时间戳。

3.3 事件缓冲区必须有限制

建议：

dart
static const int maxSnapshotBufferedEvents = 5000;

超过限制：

纯文本
标记当前 Snapshot 安装需要重新校验

不要无限缓存。

如果超过限制导致无法完整接续：

不允许静默丢弃事件。

Snapshot 安装完成后重新 Replay。

Replay 仍然有缺口则重新获取 Snapshot。

Snapshot 失败时保留旧 Timeline。

3.4 事件需要增加 Part Revision

虽然有 watermark 屏障，但我仍建议补齐 Part Revision。

当前 OpenCode normalizer 已经有：

TypeScript
this.partLengths

但目前没有把稳定的 partId 和版本信息完整传给手机端。

例如，修改后的文本 Delta 应当具有：

TypeScript
{
  type: 'text_delta',
  payload: {
    partId: 'part_123',
    baseRevision: 5,
    revision: 6,
    delta: 'Hello'
  }
}

其含义：

纯文本
当前 Part revision=5
    ↓
追加 Hello
    ↓
Part revision=6

手机端处理：

dart
void applyTextDelta(
  SnapshotAwarePart part,
  CanonicalAgentEvent event,
) {
  final baseRevision = event.payload['baseRevision'] as int;
  final revision = event.payload['revision'] as int;

  if (revision <= part.revision) {
    return; // 已经应用过，或者 Snapshot 已包含
  }

  if (baseRevision != part.revision) {
    throw const PartRevisionMismatchException();
  }

  part.text += event.payload['delta'] as String;
  part.revision = revision;
}

这里需要注意：

revision 是单调递增版本号。

不应该直接用文本长度作为 revision。

文本可能被替换、缩短或编辑。

baseRevision 不匹配时不能盲目追加，应该触发恢复。

Tool Result 也使用同样的机制，但它的 output 是完整覆盖值，而不是追加 Delta。

例如：

TypeScript
{
  type: 'tool_result',
  payload: {
    partId: 'tool_123',
    baseRevision: 1,
    revision: 2,
    output: 'Command completed',
    isError: false
  }
}

这样即使未来某些 Agent 的底层事件存在重复通知，也有第二层保护。

4. Flutter 原子安装的正确实现

涉及当前：

mobile_bridge_client.dart

我建议把 Snapshot 安装彻底独立出来。

4.1 接口定义
dart
Future<void> installSnapshot(
  SessionSnapshot snapshot,
);

分页下载：

dart
Future<SessionSnapshot> fetchCompleteSnapshot(
  String sessionId,
);

内部 DTO 可以根据 TypeScript 协议生成或手动维护。

4.2 安装必须经过五个阶段

阶段一：完整性校验

schemaVersion 正确

sessionId 正确

agentId 正确

streamEpoch 非空

watermark 为非负整数

complete=true

hasMore=false

Part ID 唯一

revision 合法

阶段二：构建临时 Timeline

将 Snapshot Part 转换为现有 UI Item。

不允许修改 _timelineBySession。

阶段三：准备状态替换

准备 epoch、watermark、Part revision 索引、权限状态等数据。

阶段四：原子提交

在同一个同步调用中替换所有 Session 状态。

阶段五：接续实时事件

应用 Snapshot 期间缓存的事件，然后 Replay watermark 之后的事件。

4.3 核心伪代码
dart
Future<void> installSnapshot(
  SessionSnapshot snapshot,
) async {
  // 1. 校验
  _validateSnapshot(snapshot);

  final sessionId = snapshot.sessionId;
  final epoch = snapshot.streamEpoch;

  // 2. 完全独立地构建临时数据
  final nextTimeline = <SessionTimelineItem>[];

  for (final part in snapshot.parts) {
    nextTimeline.add(_buildTimelineItem(part));
  }

  // 3. 构建 Part revision 索引
  final nextRevisions = <String, int>{
    for (final part in snapshot.parts)
      part.partId: part.revision,
  };

  // 4. 进入同步提交区
  // 以下操作之间不能有 await。
  _timelineBySession[sessionId] = nextTimeline;

  _currentEpochBySession[sessionId] = epoch;

  _lastSequenceBySession[
    '$sessionId#$epoch'
  ] = snapshot.watermark;

  _partRevisionBySession[sessionId] = nextRevisions;

  _pendingEventsByEpoch.removeWhere(
    (key, _) => key == sessionId ||
        key.startsWith('$sessionId#'),
  );

  _seenEventIds.removeWhere(
    (key) => key.startsWith('$sessionId#'),
  );

  // 5. 提交后通知 UI
  notifyListeners();

  // 6. 接续 Snapshot 期间的事件
  await _drainSnapshotEventBuffer(
    sessionId,
    epoch,
    snapshot.watermark,
  );

  // 7. 补齐剩余事件
  await replayMissedEvents(sessionId);
}

这里是架构示意，_validateSnapshot 和 _buildTimelineItem 应当分别独立实现和测试。

4.4 一个容易遗漏的细节：本地临时状态

当前 Timeline 还有：

dart
PendingResponseItem

它是手机端本地生成的，并不一定已经写入 Agent 的持久化历史。

因此不能把所有本地状态都简单清掉。

建议区分：

纯文本
Server-owned Timeline
    Message
    Thinking
    Tool
    Permission
    Usage
    Error

Client-local Overlay
    PendingResponse
    尚未确认的本地发送状态
    输入框草稿

Snapshot 只替换 Server-owned Timeline。

如果 Commit I 不准备同时改造 Overlay，那么至少要在 Snapshot 安装期间暂停该 Session 的新消息发送，避免本地乐观消息被覆盖。

4.5 原子性真正依靠什么？

不是 Dart 的事务，也不是 setState()。

而是：

纯文本
先构造所有新对象
    ↓
校验全部通过
    ↓
同步替换 Map 中对应 Session 的状态
    ↓
一次 notifyListeners()

整个提交阶段不允许 await。

这样 Flutter UI 不会观察到：

纯文本
空 Timeline
部分 Timeline
完整 Timeline

只会观察到：

纯文本
旧 Timeline
    ↓
完整新 Timeline
5. Adapter 契约和不同 Agent 的历史来源

涉及：

agent-events/src/index.ts

5.1 AgentAdapter 修改

当前：

TypeScript
getSessionSnapshot?(
  sessionId: string,
): Promise<{
  streamEpoch: string;
  watermark: number;
  events: CanonicalAgentEvent[];
}>;

改成：

TypeScript
getSessionSnapshot?(
  sessionId: string,
): Promise<SessionSnapshot>;

另外，AgentCapabilities 增加：

TypeScript
export type AgentCapabilities = {
  streaming: boolean;
  thinking: boolean;
  toolCalls: boolean;
  fileChanges: boolean;
  permissionRequests: boolean;
  modelSwitch: boolean;
  sessionResume: boolean;
  cancel: boolean;

  /**
   * 能否提供完整、具有一致性屏障的 Session Snapshot。
   */
  sessionSnapshot: boolean;

  /**
   * Adapter 重启后能否从持久化来源重新构建完整历史。
   */
  sessionSnapshotAfterRestart: boolean;
};

这两个能力必须分开。

举例：

情况

	

sessionSnapshot

	

sessionSnapshotAfterRestart




完整历史在内存 State Store 中

	

true

	

false




有完整持久化历史且能重建

	

true

	

true




只有实时输出，无法恢复历史

	

false

	

false

约束：

TypeScript
if (
  adapter.capabilities.sessionSnapshotAfterRestart &&
  !adapter.capabilities.sessionSnapshot
) {
  throw new Error('Invalid snapshot capabilities');
}

sessionResume 不代表 sessionSnapshot。

这两个能力不能互相推导。

5.2 各 Agent 的实现策略

这里我不建议为了追求所有 Agent 都显示支持 Snapshot，就给它们编造一个历史数据来源。

应该按照实际可读取的数据来实现。

Adapter

	

历史数据来源

	

Commit I 建议




OpenCode

	

opencode.db

	

优先完整实现




MiMo

	

mimocode.db

	

按实际数据库结构实现




Codex

	

~/.codex 下的 thread_history SQLite

	

优先完整实现




Claude Code

	

~/.claude/projects 下的 JSONL

	

优先完整实现




DSH

	

实际使用的历史文件

	

确认格式后实现




Pi

	

Agent 自身 Session 持久化存储

	

先确认真实存储接口




ACP

	

Agent 的 Session Load / History 能力

	

不能确认完整历史就先不支持




OpenClaw

	

远端 Session History API

	

确认实际 API 后实现




PTY

	

进程输出

	

默认不支持完整历史 Snapshot

特别说几个细节。

OpenCode

当前代码：

SQL
SELECT
  json_extract(p.data, '$.id'),
  json_extract(m.data, '$.role'),
  json_extract(p.data, '$.type'),
  json_extract(p.data, '$.text'),
  json_extract(p.data, '$.tool'),
  json_extract(p.data, '$.callID'),
  json_extract(p.data, '$.state.output')

不够。

建议读取完整的：

SQL
p.data
m.data

然后在 TypeScript 层解析。

至少保留：

Part ID

Message ID

Role

Part Type

Text / Reasoning

Tool Name

Call ID

Tool Input

Tool Status

Tool Output

Tool Error

创建与更新时间

稳定排序信息

不要再通过几个 json_extract() 字段把原始状态丢掉。

Codex

当前已有：

SQL
thread_items

读取：

纯文本
item_id
item_type
item_json
created_at_ms
rollout_ordinal

建议直接以 item_json 为主要解析来源。

重点恢复：

userMessage

agentMessage

reasoning

commandExecution

MCP Tool Call

fileChange

Tool 的 command、aggregated_output、exit_code 都应该保留。

Claude Code

直接解析 JSONL：

纯文本
uuid
type
timestamp
message.content[]

稳定 Part ID 可以使用：

TypeScript
const partId = `${uuid}:${blockIndex}`;

Tool Use 和 Tool Result 应通过对应的 Tool ID 关联，而不是单纯按顺序拼接。

ACP / OpenClaw / Pi

这三个我不建议现在就承诺具体实现路径。

ACP 的 session/load 成功，并不等于已经取得完整历史。OpenClaw 当前代码能发送消息，也不代表存在完整历史读取 API。

需要先确认各自的真实历史接口。无法保证完整性时就返回：

TypeScript
throw new SnapshotUnavailableError(
  'Complete session history is unavailable',
);

不能返回：

TypeScript
{
  complete: true,
  parts: [],
  ...
}
5.3 一个必须统一的 Adapter 内部流程

建议把历史恢复统一成：

TypeScript
async function hydrateSessionState(
  sessionId: string,
): Promise<void> {
  const sourceSnapshot =
    await loadSourceHistory(sessionId);

  const parts = normalizeSourceSnapshot(
    sourceSnapshot,
  );

  stateStore.initializeSession({
    sessionId,
    streamEpoch,
    parts,
    initialSequence: 0,
  });
}

注意：

TypeScript
initialSequence: 0

代表历史状态是这个新事件流的初始基线，不是 0 条历史记录。

然后：

TypeScript
async function getSessionSnapshot(
  sessionId: string,
): Promise<SessionSnapshot> {
  return stateStore.createSnapshot(sessionId);
}

后续 Snapshot 不再反复扫描 SQLite 或 JSONL。

这会同时解决：

Snapshot 生成期间的数据库竞争。

Snapshot 期间实时 SSE 重复。

Snapshot 消耗 sequence。

历史恢复和实时事件重复。

每次 Snapshot 都扫描整个数据库的性能问题。

有一点需要特别处理：如果 Adapter 已经开始接收该 Session 的实时事件，就不能再把数据库历史直接重新 hydrate 到它的 State Store。历史初始化必须发生在首次实时事件之前。对于无法满足这个顺序的来源，需要先建立 source revision 去重机制，不能强行覆盖已有状态。

6. Bridge Replay 缓存内部缺口检测

涉及：

ws-server.ts

目前主要是：

TypeScript
const truncated =
  buffered.length > 0 &&
  request.afterSequence + 1 < earliestSequence;

只能检测前缀丢失，无法检测内部缺口。

建议将缓存状态改为：

6.1 缓存结构
TypeScript
export type SessionReplayBuffer = {
  sessionId: string;
  streamEpoch: string;

  events: CanonicalAgentEvent[];

  earliestSequence: number;
  latestSequence: number;

  /**
   * 是否存在无法恢复的 sequence 缺口。
   */
  hasInternalGap: boolean;

  /**
   * 是否必须通过 Snapshot 重建。
   */
  requiresSnapshot: boolean;
};
6.2 接收事件时检测
TypeScript
function appendEvent(
  buffer: SessionReplayBuffer,
  event: CanonicalAgentEvent,
): void {
  if (event.streamEpoch !== buffer.streamEpoch) {
    resetBufferForEpoch(buffer, event.streamEpoch);
  }

  if (event.sequence <= buffer.latestSequence) {
    // 重复 sequence 应检查 eventId 是否一致。
    // 相同则幂等忽略，不同则标记缓存损坏。
    return;
  }

  if (event.sequence !== buffer.latestSequence + 1) {
    buffer.hasInternalGap = true;
    buffer.requiresSnapshot = true;
  }

  buffer.events.push(event);
  buffer.latestSequence = event.sequence;

  if (buffer.events.length > MAX_EVENTS) {
    buffer.events.shift();
  }

  buffer.earliestSequence =
    buffer.events[0]?.sequence ?? 0;
}

这只是核心逻辑，首次事件也要特殊处理：

TypeScript
if (buffer.events.length === 0 && event.sequence > 1) {
  buffer.requiresSnapshot = true;
}

因为 Bridge 如果从 sequence=100 才开始观察，就不能声称自己拥有完整历史。

6.3 Replay 判断规则

建议统一写成一个纯函数：

TypeScript
export function evaluateReplay(
  buffer: SessionReplayBuffer,
  request: {
    streamEpoch?: string;
    afterSequence: number;
  },
): ReplayDecision {
  // epoch mismatch
  // client ahead
  // prefix truncated
  // internal gap
  // sequence continuity
}

判断顺序：

条件

	

结果




请求 epoch 与服务端不同

	

resetRequired




客户端 afterSequence 大于服务端 latest

	

resetRequired




afterSequence 小于 earliestSequence - 1

	

truncated + resetRequired




缓存存在内部缺口

	

resetRequired




Replay 返回的第一条不是 afterSequence+1

	

resetRequired




中间 sequence 不连续

	

resetRequired




所有事件连续

	

正常 Replay

正常 Replay 必须满足：

𝑆
𝑖
+
1
=
𝑆
𝑖
+
1
S
i+1
	​

=S
i
	​

+1

建议增加原因字段：

TypeScript
export type ReplayResetReason =
  | 'epoch_mismatch'
  | 'prefix_truncated'
  | 'internal_gap'
  | 'client_ahead'
  | 'history_unavailable';

export type EventsReplayResult = {
  sessionId: string;
  streamEpoch: string;

  earliestSequence: number;
  latestSequence: number;

  truncated: boolean;
  resetRequired: boolean;

  resetReason?: ReplayResetReason;

  events: CanonicalAgentEvent[];
};
6.4 Snapshot 与 Replay 缓存的协同

这里还有一个容易遗漏的问题。

假设：

纯文本
Snapshot watermark = 100

Snapshot 有 5000 个 Part，手机分页下载需要 10 秒。

期间实时事件：

纯文本
101 ... 800

Bridge 缓存只有 500 条。

等 Snapshot 下载完成：

纯文本
Bridge 缓存最早事件 = 301

手机再 Replay(100)，发现 101～300 已经丢失。

所以 Snapshot 虽然正确，接续仍然失败。

解决方案：

Bridge 在 Snapshot 活跃期间暂时 pin 住 watermark 之后的事件。

增加：

TypeScript
type ActiveSnapshotPin = {
  snapshotId: string;
  sessionId: string;
  streamEpoch: string;
  watermark: number;
  createdAt: number;
  expiresAt: number;
};

规则：

Snapshot 创建时记录 watermark。

保留 watermark 之后的事件。

普通 Replay 缓存仍然有自己的大小限制。

Snapshot pin 有单独的容量上限和 TTL。

超出容量或 TTL，Snapshot 标记为 expired。

手机收到 SNAPSHOT_EXPIRED，放弃当前分页，重新获取 Snapshot。

不要无限保留事件。

7. Bridge 的 Snapshot 网络协议

建议修改：

TypeScript
type BridgeRequest =
  | {
      type: 'session.snapshot';
      requestId: string;
      sessionId: string;

      expectedStreamEpoch?: string;

      // 首次请求不传，后续分页传入
      snapshotId?: string;
      cursor?: string;

      pageSize?: number;
    };

请求规则：

第一次请求：

JSON
{
  "type": "session.snapshot",
  "requestId": "req_1",
  "sessionId": "session_123",
  "expectedStreamEpoch": "epoch_abc",
  "pageSize": 100
}

Bridge：

验证 Session。

获取完整 Adapter Snapshot。

验证 epoch 和 watermark。

生成不可变分页缓存。

返回第一页。

第二次请求：

JSON
{
  "type": "session.snapshot",
  "requestId": "req_2",
  "sessionId": "session_123",
  "snapshotId": "snap_123",
  "cursor": "opaque_cursor"
}

后续分页必须满足：

纯文本
snapshotId 相同
sessionId 相同
streamEpoch 相同
watermark 相同

而且 Snapshot 应该绑定发起它的已认证客户端，不能允许其他客户端拿着 snapshotId 读取不属于它的分页数据。

7.1 Bridge 需要验证 Adapter 返回值

不能盲目信任：

TypeScript
const snapshot =
  await adapter.getSessionSnapshot(session.id);

至少校验：

TypeScript
snapshot.sessionId === session.id

snapshot.agentId === session.agentId

snapshot.streamEpoch === currentEpoch

snapshot.complete === true

snapshot.hasMore === false

snapshot.watermark <= latestObservedSequence

同时要求：

TypeScript
snapshot.watermark ===
  stateStore.getLastAppliedSequence(session.id);

如果 Bridge 发现 Adapter 的 Snapshot 水位与它观察到的事件流不一致，应该报错，而不是尝试自动纠正。

7.2 错误码统一

建议定义：

错误码

	

含义

	

客户端行为




SNAPSHOT_UNAVAILABLE

	

Agent 不支持完整快照

	

保留旧 Timeline




SNAPSHOT_INCOMPLETE

	

数据源不完整

	

保留旧 Timeline




SNAPSHOT_EXPIRED

	

分页快照已过期

	

重新获取




SNAPSHOT_EPOCH_MISMATCH

	

epoch 已改变

	

重新协商




SNAPSHOT_INVALID

	

DTO 校验失败

	

保留旧 Timeline




SNAPSHOT_TOO_LARGE

	

单个 Part 无法安全传输

	

报错，不截断成功




REPLAY_GAP

	

缓存存在内部缺口

	

获取新 Snapshot

8. Commit I 必须先写的 9 个测试

这是我建议的实际顺序。前四个是状态机正确性的核心，先写它们。

T1 — Snapshot 不消耗 sequence

最高优先

Given：

纯文本
lastSequence = 500

When：

纯文本
getSessionSnapshot()

Then：

纯文本
watermark = 500
next realtime event = 501

Snapshot 不能生成 501、502 等事件。

T2 — Snapshot 一致性屏障

最高优先

模拟事件恰好在 Snapshot 捕获期间到达。

断言：

Snapshot 包含屏障之前的事件。

Snapshot 不包含屏障之后的事件。

屏障之后的事件 sequence 连续。

不重复文本。

不丢失文本。

T3 — watermark 大于 1 时正确安装

最高优先

构造：

纯文本
watermark = 500
parts = 20

安装后：

纯文本
Timeline = 20 Parts
lastSequence = 500
pendingEvents = empty

不允许把 Part 当成 sequence=501 的事件。

T4 — Snapshot 分页一致性

最高优先

构造 2500 个 Part。

下载过程中继续产生实时事件。

断言：

所有页的 snapshotId 相同。

所有页的 epoch 相同。

所有页的 watermark 相同。

没有重复 Part ID。

最后一页 complete=true。

只有最后一页之后才允许安装。

新事件仍然能够从 watermark 之后 Replay。

T5 — Snapshot 失败不清空 Timeline

分别模拟：

SQLite 不存在。

SQLite 损坏。

Agent 不支持 Snapshot。

分页过期。

Snapshot 数据格式错误。

断言旧 Timeline 完全不变。

T6 — Replay 内部缺口检测

构造：

纯文本
101
102
104
105

请求：

纯文本
afterSequence = 102

必须返回：

纯文本
resetRequired = true
resetReason = internal_gap

T7 — 完整历史超过 2000 Part

构造 2500 个 Part，验证全部恢复。

特别检查：

Tool Input。

Tool Error。

Thinking。

Tool Output。

User Message。

Assistant Message。

不允许静默丢弃最后 500 个 Part。

T8 — 多个客户端同时 Snapshot

两个客户端同时获取同一个 Session。

验证：

snapshotId 不互相覆盖。

cursor 不互相污染。

watermark 一致性正确。

两个客户端都可以独立完成安装。

一个客户端完成 Snapshot 不影响另一个客户端 Replay。

T9 — Part Revision 与恢复幂等性

构造：

纯文本
Snapshot:
  part_1 revision=5
  text="Hello World"

Replay:
  revision=4
  delta="Hello"

  revision=5
  delta=" World"

  revision=6
  delta="!"

最终：

纯文本
Hello World!
revision=6

前两个事件不能重复追加。

如果出现 revision 不连续，例如：

纯文本
baseRevision=8
currentRevision=5

必须触发恢复，不能盲目追加。

测试全部通过后，再开始替换生产实现。

9. Commit I 实际开发顺序

我建议你严格按下面顺序实现，不要同时改 Adapter、Bridge、Flutter 三端。

顺序

	

工作

	

交付




1

	

Protocol DTO

	

Snapshot 类型和请求响应




2

	

SessionStateStore

	

Part 状态归约、revision、watermark




3

	

Adapter 初始化

	

OpenCode 历史 hydrate




4

	

Adapter 快照

	

原子捕获完整状态




5

	

Bridge Snapshot

	

分页、缓存、pin、TTL




6

	

Bridge Replay

	

内部缺口检测




7

	

Flutter DTO

	

Snapshot Page 解析




8

	

Flutter Installer

	

临时构建、原子替换




9

	

集成测试

	

故障注入与多客户端测试

先只让 OpenCode 完整跑通。

然后再迁移 Codex、Claude Code。

不要一开始同时改 9 个 Adapter，否则测试失败时很难定位是 State Store、协议还是某个 Adapter 的历史映射出了问题。

10. 最后几个需要提前定下来的架构约束

还有五件事，我建议 Commit I 就锁定。

① Snapshot 和 Event 不共享 Reducer

TypeScript
installSnapshot(snapshot);
applyCanonicalEvent(event);

两个独立入口。

② Snapshot 不允许部分成功

如果某个 Part 无法解析，不能简单跳过然后返回 complete=true。

要么明确支持的内容被完整解析，要么报告不完整。

③ Part ID 必须稳定

不要用：

TypeScript
part_${events.length}

这种依赖遍历顺序的 ID。

优先源 ID；其次用稳定的源记录 ID + block index 派生。

④ Snapshot 不代表可以无限保存历史

Tool Output 仍然遵守 Nienie 的输出限制，图片等大型资源采用引用。对于超过传输限制的单个 Part，要么实现资源分块，要么明确失败，不能静默截断。

⑤ Epoch 仍然是事件流世代

不要因为 Snapshot 而修改 E 的设计。

Snapshot 只能读取当前 epoch 下的状态，不能创建新的 epoch，也不能自行重置 sequence。

我的最终建议

这次 Commit I 的范围实际上可以缩小为三个核心模块：

Commit I 核心交付物
1

SessionStateStore

解决 Part 状态、revision、watermark、一致性屏障。

2

SessionSnapshot Protocol

解决 DTO、分页、完整性、Snapshot 生命周期。

3

Mobile Snapshot Installer

解决临时构建、原子替换、实时事件接续。

我还有一个特别重要的提醒：不要在 Commit I 中顺手重写所有 Adapter 的实时事件系统。

先把 State Store 和 OpenCode 的历史初始化打通，验证：

纯文本
SQLite
  ↓
SessionStateStore
  ↓
Snapshot(watermark=0)
  ↓
实时事件(1,2,3...)
  ↓
Snapshot(watermark=3)
  ↓
Replay(4...)

这个闭环成立之后，再迁移其他 Agent。

这样后续无论增加 Codex、Claude、Pi 还是新的 ACP Agent，都只需要实现历史状态映射和事件归约，不需要重新设计整个恢复协议。

Commit I 的验收标准只有一句话：任意时刻获取 Snapshot，安装后从 watermark 接续 Replay，最终 Timeline 必须与没有发生过断线的 Timeline 完全一致。