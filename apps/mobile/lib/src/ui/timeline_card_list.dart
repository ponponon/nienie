import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../models/protocol_models.dart';
import '../models/timeline_items.dart';
import '../state/mobile_bridge_client.dart';
import 'agent_brand_logo.dart';

class SessionTimelineList extends StatefulWidget {
  final MobileBridgeClient client;
  final AgentSession session;

  const SessionTimelineList({
    super.key,
    required this.client,
    required this.session,
  });

  @override
  State<SessionTimelineList> createState() => _SessionTimelineListState();
}

class _SessionTimelineListState extends State<SessionTimelineList> {
  Widget _permissionRow(String label, String value) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 56,
            child: Text(
              label,
              style: const TextStyle(fontSize: 10.5, color: _textSecondary),
            ),
          ),
          Expanded(
            child: SelectableText(
              value,
              style: const TextStyle(
                fontSize: 11.5,
                fontFamily: 'monospace',
                color: _textPrimary,
              ),
            ),
          ),
        ],
      ),
    );
  }

  void _toggleExpand(SessionTimelineItem item) {
    setState(() {
      if (item is StreamingTextItem) item.collapsed = !item.collapsed;
      if (item is ToolCallCardItem) item.expanded = !item.expanded;
    });
  }

  static const Color _weTypeGreen = Color(0xFF17B378);
  static const Color _textPrimary = Color(0xFF141416);
  static const Color _textSecondary = Color(0xFF686C75);
  static const Color _borderSubtle = Color(0x12000000);

  @override
  Widget build(BuildContext context) {
    final items = widget.client.timelineFor(widget.session.id);
    return ListView.separated(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      itemCount: items.length,
      separatorBuilder: (_, __) => const SizedBox(height: 12),
      itemBuilder: (context, index) {
        final item = items[index];
        return switch (item) {
          // Kelivo Soft Gray User Prompt Bubble (borderless R18 pill)
          UserPromptItem() => Align(
              alignment: Alignment.centerRight,
              child: Container(
                constraints: BoxConstraints(
                  maxWidth: MediaQuery.sizeOf(context).width * 0.8,
                ),
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                decoration: const BoxDecoration(
                  color: Color(0xFFF3F4F6),
                  borderRadius: BorderRadius.only(
                    topLeft: Radius.circular(18),
                    topRight: Radius.circular(18),
                    bottomLeft: Radius.circular(18),
                    bottomRight: Radius.circular(4),
                  ),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      item.message,
                      style: const TextStyle(
                        color: _textPrimary,
                        fontSize: 14,
                        height: 1.45,
                      ),
                    ),
                    // 附件元数据可见（J0.6b-3.2）：文件名 + MIME
                    for (final attachment in item.attachments) ...[
                      const SizedBox(height: 6),
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
                        decoration: BoxDecoration(
                          color: Colors.white.withValues(alpha: 0.7),
                          borderRadius: BorderRadius.circular(8),
                        ),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            const Icon(
                              LucideIcons.paperclip,
                              size: 12,
                              color: _textSecondary,
                            ),
                            const SizedBox(width: 5),
                            Flexible(
                              child: Text(
                                attachment.name.isNotEmpty
                                    ? '${attachment.name} · ${attachment.mime}'
                                    : attachment.mime,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: const TextStyle(
                                  fontSize: 11,
                                  color: _textSecondary,
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            ),

          // 等待回复占位 / 超时兜底卡片
          PendingResponseItem() => item.timedOut
              ? Container(
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                  decoration: BoxDecoration(
                    color: const Color(0xFFFFF7ED),
                    border: Border.all(
                      color: const Color(0xFFF59E0B).withValues(alpha: 0.35),
                    ),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          const Icon(
                            LucideIcons.clockAlert,
                            size: 14,
                            color: Color(0xFFB45309),
                          ),
                          const SizedBox(width: 6),
                          const Text(
                            'Reply timed out',
                            style: TextStyle(
                              fontSize: 12,
                              fontWeight: FontWeight.w600,
                              color: Color(0xFFB45309),
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 6),
                      const Text(
                        'No response yet. The agent may still be working on the computer.',
                        style: TextStyle(
                          color: _textSecondary,
                          fontSize: 13,
                          height: 1.45,
                        ),
                      ),
                      const SizedBox(height: 8),
                      Row(
                        children: [
                          _ActionButton(
                            icon: LucideIcons.refreshCw,
                            label: 'Retry',
                            filled: true,
                            onTap: () => widget.client.retryPrompt(item.promptText),
                          ),
                          const SizedBox(width: 8),
                          const _ActionButton(
                            icon: LucideIcons.monitor,
                            label: 'Check desktop',
                            filled: false,
                            onTap: null,
                          ),
                        ],
                      ),
                    ],
                  ),
                )
              : Row(
                  children: [
                    AgentBrandLogo(agentId: widget.session.agentId, size: 14),
                    const SizedBox(width: 8),
                    Text(
                      widget.session.agentId.toUpperCase(),
                      style: const TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w600,
                        color: _textSecondary,
                      ),
                    ),
                    const SizedBox(width: 8),
                    const SizedBox(
                      width: 13,
                      height: 13,
                      child: CircularProgressIndicator(
                        strokeWidth: 1.8,
                        color: _weTypeGreen,
                      ),
                    ),
                    const SizedBox(width: 8),
                    const Text(
                      'Thinking…',
                      style: TextStyle(
                        fontSize: 12.5,
                        color: _textSecondary,
                        height: 1.4,
                      ),
                    ),
                  ],
                ),

          // Kelivo Borderless Agent Response with Brand Header
          StreamingTextItem() => Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                InkWell(
                  onTap: item.isThinking ? () => _toggleExpand(item) : null,
                  borderRadius: BorderRadius.circular(8),
                  child: Row(
                  children: [
                    if (item.isThinking)
                      Container(
                        width: 22,
                        height: 22,
                        decoration: BoxDecoration(
                          color: const Color(0xFFF3F4F6),
                          borderRadius: BorderRadius.circular(6),
                        ),
                        alignment: Alignment.center,
                        child: const Icon(
                          LucideIcons.sparkles,
                          size: 13,
                          color: _weTypeGreen,
                        ),
                      )
                    else
                      AgentBrandLogo(agentId: widget.session.agentId, size: 14),
                    const SizedBox(width: 8),
                    Text(
                      item.isThinking ? 'Thinking' : widget.session.agentId.toUpperCase(),
                      style: const TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w600,
                        color: _textSecondary,
                      ),
                    ),
                    if (item.isThinking) ...[
                      const SizedBox(width: 6),
                      Icon(
                        item.collapsed
                            ? LucideIcons.chevronDown
                            : LucideIcons.chevronUp,
                        size: 14,
                        color: _textSecondary,
                      ),
                    ],
                  ],
                ),
                ),
                if (!item.isThinking || !item.collapsed) ...[
                const SizedBox(height: 6),
                Padding(
                  padding: const EdgeInsets.only(left: 2),
                  child: Text(
                    item.text,
                    style: TextStyle(
                      color: item.isThinking ? _textSecondary : _textPrimary,
                      fontSize: 14,
                      height: 1.55,
                    ),
                  ),
                ),
                ],
              ],
            ),

          // Kelivo Compact Tool Call Pill
          ToolCallCardItem() => Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
              decoration: BoxDecoration(
                color: const Color(0xFFF7F8FA),
                border: Border.all(
                  color: item.status == ToolCallStatus.failed
                      ? const Color(0xFFEF4444).withValues(alpha: 0.35)
                      : _borderSubtle,
                ),
                borderRadius: BorderRadius.circular(12),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  InkWell(
                    onTap: item.resultContent != null
                        ? () => _toggleExpand(item)
                        : null,
                    borderRadius: BorderRadius.circular(8),
                    child: Row(
                    children: [
                      const Icon(
                        LucideIcons.terminal,
                        size: 13.5,
                        color: _textSecondary,
                      ),
                      const SizedBox(width: 7),
                      Text(
                        item.name,
                        style: const TextStyle(
                          fontWeight: FontWeight.w600,
                          fontSize: 12,
                          fontFamily: 'monospace',
                          color: _textPrimary,
                        ),
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          jsonEncode(item.input),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            fontSize: 11,
                            fontFamily: 'monospace',
                            color: _textSecondary,
                          ),
                        ),
                      ),
                      // 状态图标来自显式 status（J0.4：禁止用 resultContent 推断成败）
                      Icon(
                        switch (item.status) {
                          ToolCallStatus.pending => LucideIcons.circleDashed,
                          ToolCallStatus.running => LucideIcons.loaderCircle,
                          ToolCallStatus.completed => LucideIcons.check,
                          ToolCallStatus.failed => LucideIcons.circleX,
                        },
                        size: 13,
                        color: switch (item.status) {
                          ToolCallStatus.failed => const Color(0xFFDC2626),
                          ToolCallStatus.completed => _weTypeGreen,
                          ToolCallStatus.running => _weTypeGreen,
                          ToolCallStatus.pending => _textSecondary,
                        },
                      ),
                      if (item.resultContent != null) ...[
                        const SizedBox(width: 6),
                        Icon(
                          item.expanded
                              ? LucideIcons.chevronUp
                              : LucideIcons.chevronDown,
                          size: 13,
                          color: _textSecondary,
                        ),
                      ],
                    ],
                  ),
                  ),
                  if (item.resultContent != null && item.expanded) ...[
                    const SizedBox(height: 5),
                    Text(
                      item.resultContent!,
                      style: TextStyle(
                        fontSize: 11.5,
                        fontFamily: 'monospace',
                        color: item.status == ToolCallStatus.failed
                            ? const Color(0xFFDC2626)
                            : _textSecondary,
                      ),
                    ),
                  ],
                ],
              ),
            ),

          // Structured Error Card
          ErrorCardItem() => Container(
              padding: const EdgeInsets.all(11),
              decoration: BoxDecoration(
                color: const Color(0xFFFEF2F2),
                border: Border.all(
                  color: const Color(0xFFEF4444).withValues(alpha: 0.3),
                ),
                borderRadius: BorderRadius.circular(12),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      const Icon(
                        LucideIcons.circleAlert,
                        size: 15,
                        color: Color(0xFFDC2626),
                      ),
                      const SizedBox(width: 6),
                      Text(
                        item.code,
                        style: const TextStyle(
                          fontWeight: FontWeight.w700,
                          fontSize: 12,
                          fontFamily: 'monospace',
                          color: Color(0xFFDC2626),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 3),
                  Text(
                    item.message,
                    style: const TextStyle(fontSize: 12.5, color: _textPrimary),
                  ),
                ],
              ),
            ),

          // Structured Permission Approval Card
          PermissionRequestCardItem() => Builder(builder: (context) {
              final risk = item.risk;
              final riskColor = switch (risk) {
                PermissionRiskLevel.low => _weTypeGreen,
                PermissionRiskLevel.medium => const Color(0xFFD97706),
                PermissionRiskLevel.high => const Color(0xFFDC2626),
                PermissionRiskLevel.unknown => _textSecondary,
              };
              final riskLabel = switch (risk) {
                PermissionRiskLevel.low => widget.client.strings.riskLow,
                PermissionRiskLevel.medium => widget.client.strings.riskMedium,
                PermissionRiskLevel.high => widget.client.strings.riskHigh,
                PermissionRiskLevel.unknown => widget.client.strings.riskUnknown,
              };
              final riskIcon = switch (risk) {
                PermissionRiskLevel.low => LucideIcons.shieldCheck,
                PermissionRiskLevel.medium => LucideIcons.shieldAlert,
                PermissionRiskLevel.high => LucideIcons.shieldBan,
                PermissionRiskLevel.unknown => LucideIcons.shieldAlert,
              };
              final focused =
                  widget.client.focusedPermissionSessionId == widget.session.id &&
                  widget.client.focusedPermissionId == item.permissionId &&
                  item.resolvedDecision == null;
              return Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: focused ? const Color(0xFFEFF6FF) : const Color(0xFFFFFDF7),
                border: Border.all(
                  color: focused ? riskColor : riskColor.withValues(alpha: 0.32),
                  width: focused ? 2 : 1,
                ),
                borderRadius: BorderRadius.circular(14),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Icon(riskIcon, size: 15, color: riskColor),
                      const SizedBox(width: 6),
                      Expanded(
                        child: Text(
                          widget.client.strings.permRequestHeader,
                          style: const TextStyle(
                            fontWeight: FontWeight.w600,
                            fontSize: 12.5,
                            color: _textPrimary,
                          ),
                        ),
                      ),
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                        decoration: BoxDecoration(
                          color: riskColor.withValues(alpha: 0.12),
                          borderRadius: BorderRadius.circular(999),
                        ),
                        child: Text(
                          riskLabel,
                          style: TextStyle(
                            fontSize: 10,
                            fontWeight: FontWeight.w600,
                            color: riskColor,
                          ),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 8),
                  _permissionRow(widget.client.strings.permActionLabel, item.permission),
                  if (item.detail.isNotEmpty)
                    _permissionRow(widget.client.strings.permDetailLabel, item.detail),
                  if (item.patterns.isNotEmpty) ...[
                    const SizedBox(height: 6),
                    Text(
                      widget.client.strings.permResourcesLabel,
                      style: const TextStyle(fontSize: 10.5, color: _textSecondary),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      item.patterns.join('\n'),
                      style: const TextStyle(
                        fontSize: 11,
                        fontFamily: 'monospace',
                        color: _textPrimary,
                      ),
                    ),
                  ],
                  const SizedBox(height: 8),
                  if (item.resolvedDecision != null)
                    Text(
                      switch (item.resolvedDecision!) {
                        'allow_once' => widget.client.strings.permResultOnce,
                        'allow_always' => widget.client.strings.permResultAlways,
                        'reject' => widget.client.strings.permResultReject,
                        _ => widget.client.strings.permResultUnknown,
                      },
                      key: Key('perm-result-${item.permissionId}'),
                      style: TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w500,
                        color: item.resolvedDecision == 'reject'
                            ? const Color(0xFFDC2626)
                            : item.resolvedDecision == 'unknown'
                                ? _textSecondary
                                : _weTypeGreen,
                      ),
                    )
                  else if (item.resolutionUncertain)
                    Text(
                      widget.client.strings.permUncertainNote,
                      key: Key('perm-uncertain-${item.permissionId}'),
                      style: const TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w500,
                        color: Color(0xFFD97706),
                      ),
                    )
                  else
                    Row(
                      children: [
                        SizedBox(
                          height: 30,
                          child: FilledButton(
                            key: Key('btn-perm-allow-once-${item.permissionId}'),
                            style: FilledButton.styleFrom(
                              backgroundColor: _textPrimary,
                              padding: const EdgeInsets.symmetric(horizontal: 10),
                              shape: RoundedRectangleBorder(
                                borderRadius: BorderRadius.circular(8),
                              ),
                            ),
                            onPressed: () => widget.client.replyPermission(
                              sessionId: widget.session.id,
                              permissionId: item.permissionId,
                              decision: 'allow_once',
                            ),
                            child: Text(
                              widget.client.strings.allowOnceBtn,
                              style: const TextStyle(fontSize: 11.5),
                            ),
                          ),
                        ),
                        const SizedBox(width: 6),
                        SizedBox(
                          height: 30,
                          child: FilledButton.tonal(
                            key: Key('btn-perm-allow-always-${item.permissionId}'),
                            style: FilledButton.styleFrom(
                              padding: const EdgeInsets.symmetric(horizontal: 10),
                              shape: RoundedRectangleBorder(
                                borderRadius: BorderRadius.circular(8),
                              ),
                            ),
                            onPressed: () => widget.client.replyPermission(
                              sessionId: widget.session.id,
                              permissionId: item.permissionId,
                              decision: 'allow_always',
                            ),
                            child: Text(
                              widget.client.strings.allowAlwaysBtn,
                              style: const TextStyle(fontSize: 11.5),
                            ),
                          ),
                        ),
                        const SizedBox(width: 6),
                        SizedBox(
                          height: 30,
                          child: OutlinedButton(
                            key: Key('btn-perm-reject-${item.permissionId}'),
                            style: OutlinedButton.styleFrom(
                              padding: const EdgeInsets.symmetric(horizontal: 10),
                              shape: RoundedRectangleBorder(
                                borderRadius: BorderRadius.circular(8),
                              ),
                            ),
                            onPressed: () => widget.client.replyPermission(
                              sessionId: widget.session.id,
                              permissionId: item.permissionId,
                              decision: 'reject',
                            ),
                            child: Text(
                              widget.client.strings.rejectBtn,
                              style: const TextStyle(fontSize: 11.5),
                            ),
                          ),
                        ),
                      ],
                    ),
                ],
              ),
            );
            }),

          // File Diff Card
          FileDiffCardItem() => Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
              decoration: BoxDecoration(
                color: const Color(0xFFF7F8FA),
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: _borderSubtle),
              ),
              child: Row(
                children: [
                  const Icon(
                    LucideIcons.fileDiff,
                    size: 14.5,
                    color: Color(0xFF2563EB),
                  ),
                  const SizedBox(width: 7),
                  Expanded(
                    child: Text(
                      item.file,
                      style: const TextStyle(
                        fontWeight: FontWeight.w600,
                        fontSize: 12,
                        fontFamily: 'monospace',
                        color: _textPrimary,
                      ),
                    ),
                  ),
                  Text(
                    '+${item.additions} / -${item.deletions}',
                    style: const TextStyle(
                      fontSize: 11.5,
                      fontFamily: 'monospace',
                      fontWeight: FontWeight.w600,
                      color: _weTypeGreen,
                    ),
                  ),
                ],
              ),
            ),

          // Desktop Screen Capture Card
          ScreenCaptureCardItem() => Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
              decoration: BoxDecoration(
                color: const Color(0xFFF7F8FA),
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: _borderSubtle),
              ),
              child: Row(
                children: [
                  const Icon(
                    LucideIcons.monitor,
                    size: 14.5,
                    color: Color(0xFF2563EB),
                  ),
                  const SizedBox(width: 7),
                  Expanded(
                    child: Text(
                      'Screen Capture (${item.displayId})',
                      style: const TextStyle(
                        fontWeight: FontWeight.w600,
                        fontSize: 12,
                        color: _textPrimary,
                      ),
                    ),
                  ),
                  Text(
                    '${item.width}x${item.height}',
                    style: const TextStyle(
                      fontSize: 11,
                      fontFamily: 'monospace',
                      color: _textSecondary,
                    ),
                  ),
                ],
              ),
            ),

          // Token & Cost Usage Summary Card
          UsageSummaryItem() => Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              decoration: BoxDecoration(
                color: const Color(0xFFF7F8FA),
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: _borderSubtle),
              ),
              child: Row(
                children: [
                  const Icon(LucideIcons.activity, size: 13.5, color: _weTypeGreen),
                  const SizedBox(width: 7),
                  Text(
                    '${item.inputTokens} in · ${item.outputTokens} out · \$${item.costUsd.toStringAsFixed(4)}',
                    style: const TextStyle(
                      fontSize: 11,
                      fontFamily: 'monospace',
                      color: _textSecondary,
                    ),
                  ),
                ],
              ),
            ),
        };
      },
    );
  }
}

class _ActionButton extends StatelessWidget {
  final IconData icon;
  final String label;
  final bool filled;
  final VoidCallback? onTap;

  const _ActionButton({
    required this.icon,
    required this.label,
    required this.filled,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final color = filled ? Colors.white : const Color(0xFFB45309);
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(8),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
        decoration: BoxDecoration(
          color: filled ? const Color(0xFFB45309) : Colors.transparent,
          border: Border.all(
            color: const Color(0xFFB45309).withValues(alpha: 0.45),
          ),
          borderRadius: BorderRadius.circular(8),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 13, color: color),
            const SizedBox(width: 5),
            Text(
              label,
              style: TextStyle(
                fontSize: 12,
                fontWeight: FontWeight.w600,
                color: color,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
