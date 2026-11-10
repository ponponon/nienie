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
                child: Text(
                  item.message,
                  style: const TextStyle(
                    color: _textPrimary,
                    fontSize: 14,
                    height: 1.45,
                  ),
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
                  color: item.isError
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
                      if (item.resultContent != null) ...[
                        Icon(
                          item.isError ? LucideIcons.circleX : LucideIcons.check,
                          size: 13,
                          color: item.isError
                              ? const Color(0xFFDC2626)
                              : _weTypeGreen,
                        ),
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
                        color: item.isError
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
          PermissionRequestCardItem() => Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: const Color(0xFFFFFDF7),
                border: Border.all(
                  color: const Color(0xFFF59E0B).withValues(alpha: 0.32),
                ),
                borderRadius: BorderRadius.circular(14),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      const Icon(
                        LucideIcons.shieldAlert,
                        size: 15,
                        color: Color(0xFFD97706),
                      ),
                      const SizedBox(width: 6),
                      Expanded(
                        child: Text(
                          item.detail,
                          style: const TextStyle(
                            fontWeight: FontWeight.w600,
                            fontSize: 12.5,
                            color: _textPrimary,
                          ),
                        ),
                      ),
                    ],
                  ),
                  if (item.patterns.isNotEmpty) ...[
                    const SizedBox(height: 4),
                    Text(
                      item.patterns.join(', '),
                      style: const TextStyle(
                        fontSize: 11,
                        fontFamily: 'monospace',
                        color: _textSecondary,
                      ),
                    ),
                  ],
                  const SizedBox(height: 8),
                  if (item.resolvedDecision != null)
                    Text(
                      'Decision: ${item.resolvedDecision}',
                      style: const TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w500,
                        color: _textPrimary,
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
            ),

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
