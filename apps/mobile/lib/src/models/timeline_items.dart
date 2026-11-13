sealed class SessionTimelineItem {
  const SessionTimelineItem();
}

/// 附件元数据（J0.6b-3.2）：结构化保留文件名/MIME/来源，UI 可见，不再随文本丢失。
class AttachmentMeta {
  final String name;
  final String mime;
  final String sourceType; // 'uri' | 'inline'
  final String? uri;
  final String? contentHash;
  const AttachmentMeta({
    this.name = '',
    required this.mime,
    required this.sourceType,
    this.uri,
    this.contentHash,
  });
}

/// 发送回执（路线图 3.3）：iMessage 心智——发送中/已送达电脑/发送失败可重发
enum SendReceipt { pending, delivered, failed }

class UserPromptItem extends SessionTimelineItem {
  SendReceipt receipt;
  String message;
  /// 4.3：消息时间（事件真实时间/快照 createdAt），供相对时间戳显示
  DateTime createdAt;
  /// 消息携带的附件元数据（文件名/MIME 可见）。
  List<AttachmentMeta> attachments;
  /// 内容归属标识与状态版本（J0.4）：同 partId 的用户消息增量精确追加，重放不重复。
  String? partId;
  int revision;
  /// 服务端（或客户端预生成）消息关联 ID（J0.6b-3b）：历史/事件按此认领本地乐观消息，防止重复。
  String? messageId;
  UserPromptItem(this.message,
      {this.partId,
      this.revision = 0,
      this.messageId,
      this.attachments = const [],
      this.receipt = SendReceipt.delivered,
      DateTime? createdAt})
      : createdAt = createdAt ?? DateTime.now();
}

/// 发送后、回复到达前的「等待中」占位卡片。
/// 若 [timedOut] 为 true 表示长时间未收到回复，UI 切换为「重试 / 查看电脑端」兜底。
class PendingResponseItem extends SessionTimelineItem {
  final String promptText;
  bool timedOut;
  PendingResponseItem({required this.promptText, this.timedOut = false});
}

/// 工具卡片的显式生命周期状态。状态是领域数据，禁止用 resultContent 是否存在来推断（J0.4）。
enum ToolCallStatus { pending, running, completed, failed }

ToolCallStatus parseToolCallStatus(String? raw) {
  switch (raw) {
    case 'completed':
      return ToolCallStatus.completed;
    case 'failed':
      return ToolCallStatus.failed;
    case 'running':
      return ToolCallStatus.running;
    default:
      return ToolCallStatus.pending;
  }
}

class StreamingTextItem extends SessionTimelineItem {
  String text;
  final bool isThinking;
  /// 4.3：消息时间（事件真实时间/快照 createdAt），供相对时间戳显示
  DateTime createdAt;
  /// 思考过程可折叠：回答完成后折叠，避免占用过多屏幕空间。
  bool collapsed;
  /// 内容归属标识与状态版本：同 partId 下 revision 严格单调递增，供幂等归约（J0.4）。
  String? partId;
  int revision;
  StreamingTextItem({
    required this.text,
    this.isThinking = false,
    this.collapsed = false,
    this.partId,
    this.revision = 0,
    DateTime? createdAt,
  }) : createdAt = createdAt ?? DateTime.now();
}

class ToolCallCardItem extends SessionTimelineItem {
  final String toolCallId;
  /// 可被真实工具名补齐（占位卡先于 tool_use 创建时为 'tool'）。
  String name;
  final Map<String, dynamic> input;
  String? resultContent;
  bool isError;
  /// 显式状态：pending/running/completed/failed。completed/failed 是终态。
  ToolCallStatus status;
  String? partId;
  int revision;
  /// 工具结果详情可折叠（默认收起，点击展开/收起）。
  bool expanded;
  /// 4.4：执行耗时（tool_use→tool_result 事件真实时间差）与退出码（事件可选字段）。
  DateTime? startedAt;
  DateTime? finishedAt;
  int? exitCode;
  ToolCallCardItem({
    required this.toolCallId,
    required this.name,
    required Map<String, dynamic> input,
    this.resultContent,
    this.isError = false,
    this.status = ToolCallStatus.running,
    this.partId,
    this.revision = 0,
    this.expanded = false,
    this.startedAt,
    this.finishedAt,
    this.exitCode,
  }) : input = Map<String, dynamic>.of(input);

  /// 4.4：执行耗时文案（120ms / 3.2s / 1m12s），未完成返回 null。
  String? get durationLabel {
    final start = startedAt;
    final end = finishedAt;
    if (start == null || end == null) return null;
    final ms = end.difference(start).inMilliseconds;
    if (ms < 0) return null;
    if (ms < 1000) return '${ms}ms';
    final totalSeconds = ms / 1000.0;
    if (totalSeconds < 60) {
      return '${totalSeconds.toStringAsFixed(totalSeconds < 10 ? 1 : 0)}s';
    }
    // 先舍入整数秒再拆分（修 1m60s 边界）
    final roundedSeconds = (ms / 1000).round();
    final minutes = roundedSeconds ~/ 60;
    final seconds = roundedSeconds % 60;
    return '${minutes}m${seconds.toString().padLeft(2, '0')}s';
  }
}

class ErrorCardItem extends SessionTimelineItem {
  final String code;
  final String message;
  final bool retryable;

  const ErrorCardItem({
    required this.code,
    required this.message,
    required this.retryable,
  });
}

/// 审批风险分级（路线图 2.1）：只按 action/resources 白名单规则判断，绝不推断实际影响。
enum PermissionRiskLevel { low, medium, high, unknown }

PermissionRiskLevel classifyPermissionRisk(String action, List<String> resources) {
  const destructiveActions = {'delete', 'remove', 'move', 'write', 'edit', 'patch', 'kill', 'exec'};
  const commandActions = {'bash', 'shell', 'run', 'terminal', 'process'};
  const readOnlyActions = {'read', 'grep', 'glob', 'list', 'search', 'webfetch', 'websearch', 'fetch'};
  // 词边界=非字母数字（覆盖引号/逗号/反斜杠等包裹），大小写归一（DEL/Rm 均命中）
  final destructiveResource = RegExp(
    r'(^|[^A-Za-z0-9])(delete|deltree|unlink|mkfs|shutdown|reboot|kill|rm|rmdir|del)([^A-Za-z0-9]|$)',
    caseSensitive: false,
  );
  final a = action.trim().toLowerCase();
  // 高风险优先级最高：明确命中破坏性 action 或破坏性 resource 规则
  if (destructiveActions.contains(a) || resources.any((r) => destructiveResource.hasMatch(r))) {
    return PermissionRiskLevel.high;
  }
  if (commandActions.contains(a)) return PermissionRiskLevel.medium;
  if (readOnlyActions.contains(a)) return PermissionRiskLevel.low;
  return PermissionRiskLevel.unknown;
}

class PermissionRequestCardItem extends SessionTimelineItem {
  final String permissionId;
  String permission;
  String detail;
  List<String> patterns;
  String? resolvedDecision;
  /// 审批提交中（目标③：防误触/重复审批的进行中状态）
  bool replyPending;
  /// 回执不可信（fail-closed）：结果未知，禁止重试按钮，等待权威状态同步
  bool resolutionUncertain;
  /// 等待起点（目标③：超时提醒只报"等待时长"，绝不冒充服务端过期）
  DateTime waitingSince;

  PermissionRequestCardItem({
    required this.permissionId,
    required this.permission,
    required this.detail,
    this.patterns = const [],
    this.resolvedDecision,
    this.replyPending = false,
    this.resolutionUncertain = false,
    DateTime? waitingSince,
  }) : waitingSince = waitingSince ?? DateTime.now();

  /// 风险分级（规则推导，展示用）
  PermissionRiskLevel get risk => classifyPermissionRisk(permission, patterns);
}

class FileDiffCardItem extends SessionTimelineItem {
  final String diffId;
  final String file;
  final String before;
  final String after;
  final int additions;
  final int deletions;

  const FileDiffCardItem({
    required this.diffId,
    required this.file,
    required this.before,
    required this.after,
    required this.additions,
    required this.deletions,
  });
}

/// 6.3：单文件改动条目（改动摘要卡内文件列表/展开 diff 用）
class FileDiffEntry {
  final String file;
  final String before;
  final String after;
  final int additions;
  final int deletions;

  const FileDiffEntry({
    required this.file,
    required this.before,
    required this.after,
    required this.additions,
    required this.deletions,
  });
}

/// 6.3：改动摘要卡——「本轮改动 N 文件 +X/-Y」汇总卡 → 点开文件列表 → diff
class ChangeSummaryCardItem extends SessionTimelineItem {
  final String diffId;
  final List<FileDiffEntry> files;

  /// 文件列表展开/收起
  bool expanded;

  /// 当前展开 diff 的文件（点文件行切换）
  String? expandedFile;

  ChangeSummaryCardItem({
    required this.diffId,
    required this.files,
    this.expanded = false,
    this.expandedFile,
  });

  int get totalAdditions => files.fold(0, (sum, f) => sum + f.additions);
  int get totalDeletions => files.fold(0, (sum, f) => sum + f.deletions);
}

class ScreenCaptureCardItem extends SessionTimelineItem {
  final String frameId;
  final String displayId;
  final int width;
  final int height;
  final String capturedAt;

  const ScreenCaptureCardItem({
    required this.frameId,
    required this.displayId,
    required this.width,
    required this.height,
    required this.capturedAt,
  });
}

class UsageSummaryItem extends SessionTimelineItem {
  final int inputTokens;
  final int outputTokens;
  final double costUsd;

  const UsageSummaryItem({
    required this.inputTokens,
    required this.outputTokens,
    required this.costUsd,
  });
}
