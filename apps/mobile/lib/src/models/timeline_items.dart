sealed class SessionTimelineItem {
  const SessionTimelineItem();
}

class UserPromptItem extends SessionTimelineItem {
  String message;
  /// 内容归属标识与状态版本（J0.4）：同 partId 的用户消息增量精确追加，重放不重复。
  String? partId;
  int revision;
  UserPromptItem(this.message, {this.partId, this.revision = 0});
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
  });
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
  }) : input = Map<String, dynamic>.of(input);
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

class PermissionRequestCardItem extends SessionTimelineItem {
  final String permissionId;
  final String permission;
  final String detail;
  final List<String> patterns;
  String? resolvedDecision;

  PermissionRequestCardItem({
    required this.permissionId,
    required this.permission,
    required this.detail,
    this.patterns = const [],
    this.resolvedDecision,
  });
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
