sealed class SessionTimelineItem {
  const SessionTimelineItem();
}

class UserPromptItem extends SessionTimelineItem {
  final String message;
  const UserPromptItem(this.message);
}

/// 发送后、回复到达前的「等待中」占位卡片。
/// 若 [timedOut] 为 true 表示长时间未收到回复，UI 切换为「重试 / 查看电脑端」兜底。
class PendingResponseItem extends SessionTimelineItem {
  final String promptText;
  bool timedOut;
  PendingResponseItem({required this.promptText, this.timedOut = false});
}

class StreamingTextItem extends SessionTimelineItem {
  String text;
  final bool isThinking;
  StreamingTextItem({required this.text, this.isThinking = false});
}

class ToolCallCardItem extends SessionTimelineItem {
  final String toolCallId;
  final String name;
  final Map<String, dynamic> input;
  String? resultContent;
  bool isError;

  ToolCallCardItem({
    required this.toolCallId,
    required this.name,
    required this.input,
    this.resultContent,
    this.isError = false,
  });
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
  final String file;
  final int additions;
  final int deletions;

  const FileDiffCardItem({
    required this.file,
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
