import 'dart:convert';
import 'package:flutter/material.dart';
import '../models/protocol_models.dart';
import '../models/timeline_items.dart';
import '../state/mobile_bridge_client.dart';

class SessionTimelineList extends StatelessWidget {
  final MobileBridgeClient client;
  final AgentSession session;

  const SessionTimelineList({
    super.key,
    required this.client,
    required this.session,
  });

  @override
  Widget build(BuildContext context) {
    final items = client.timelineFor(session.id);
    return ListView.separated(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      itemCount: items.length,
      separatorBuilder: (_, __) => const SizedBox(height: 6),
      itemBuilder: (context, index) {
        final item = items[index];
        return switch (item) {
          // WeChat right-aligned green bubble for user prompts
          UserPromptItem() => Align(
              alignment: Alignment.centerRight,
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                decoration: BoxDecoration(
                  color: const Color(0xFF95EC69),
                  borderRadius: BorderRadius.circular(10),
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Flexible(
                      child: Text(
                        item.message,
                        style: const TextStyle(
                          color: Color(0xFF181818),
                          fontSize: 13,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          // WeChat left-aligned clean white bubble for agent responses
          StreamingTextItem() => Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
              decoration: BoxDecoration(
                color: const Color(0xFFFFFFFF),
                borderRadius: BorderRadius.circular(10),
              ),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(
                    item.isThinking ? Icons.psychology_outlined : Icons.smart_toy_outlined,
                    size: 15,
                    color: const Color(0xFF07C160),
                  ),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      item.text,
                      style: const TextStyle(
                        color: Color(0xFF181818),
                        fontSize: 13,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ToolCallCardItem() => Container(
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: const Color(0xFFFFFFFF),
                border: Border.all(
                  color: item.isError
                      ? const Color(0xFFFA5151)
                      : const Color(0xFFE5E5EA),
                ),
                borderRadius: BorderRadius.circular(10),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      const Icon(Icons.terminal, size: 14, color: Color(0xFF07C160)),
                      const SizedBox(width: 6),
                      Text(
                        item.name,
                        style: const TextStyle(
                          fontWeight: FontWeight.w600,
                          fontSize: 12,
                          color: Color(0xFF181818),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 4),
                  Text(
                    jsonEncode(item.input),
                    style: const TextStyle(fontSize: 11, color: Color(0xFF8E8E93)),
                  ),
                  if (item.resultContent != null) ...[
                    const SizedBox(height: 4),
                    Text(
                      item.resultContent!,
                      style: TextStyle(
                        fontSize: 12,
                        color: item.isError
                            ? const Color(0xFFFA5151)
                            : const Color(0xFF181818),
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ErrorCardItem() => Container(
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: const Color(0xFFFFF2F2),
                border: Border.all(color: const Color(0xFFFA5151).withValues(alpha: 0.3)),
                borderRadius: BorderRadius.circular(10),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      const Icon(Icons.error_outline, size: 15, color: Color(0xFFFA5151)),
                      const SizedBox(width: 6),
                      Text(
                        item.code,
                        style: const TextStyle(
                          fontWeight: FontWeight.w700,
                          fontSize: 12,
                          color: Color(0xFFFA5151),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 2),
                  Text(
                    item.message,
                    style: const TextStyle(fontSize: 12, color: Color(0xFF181818)),
                  ),
                ],
              ),
            ),
          PermissionRequestCardItem() => Container(
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: const Color(0xFFFFF9EC),
                border: Border.all(color: const Color(0xFFFF9500).withValues(alpha: 0.35)),
                borderRadius: BorderRadius.circular(10),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      const Icon(Icons.shield_outlined, size: 15, color: Color(0xFFFF9500)),
                      const SizedBox(width: 6),
                      Expanded(
                        child: Text(
                          item.detail,
                          style: const TextStyle(
                            fontWeight: FontWeight.w600,
                            fontSize: 12,
                            color: Color(0xFF181818),
                          ),
                        ),
                      ),
                    ],
                  ),
                  if (item.patterns.isNotEmpty) ...[
                    const SizedBox(height: 2),
                    Text(
                      item.patterns.join(', '),
                      style: const TextStyle(fontSize: 11, color: Color(0xFF8E8E93)),
                    ),
                  ],
                  const SizedBox(height: 6),
                  if (item.resolvedDecision != null)
                    Text(
                      'Decision: ${item.resolvedDecision}',
                      style: const TextStyle(fontSize: 12, color: Color(0xFF181818)),
                    )
                  else
                    Row(
                      children: [
                        SizedBox(
                          height: 30,
                          child: FilledButton(
                            key: Key('btn-perm-allow-once-${item.permissionId}'),
                            style: FilledButton.styleFrom(
                              backgroundColor: const Color(0xFF07C160),
                              padding: const EdgeInsets.symmetric(horizontal: 10),
                            ),
                            onPressed: () => client.replyPermission(
                              sessionId: session.id,
                              permissionId: item.permissionId,
                              decision: 'allow_once',
                            ),
                            child: Text(
                              client.strings.allowOnceBtn,
                              style: const TextStyle(fontSize: 11),
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
                            ),
                            onPressed: () => client.replyPermission(
                              sessionId: session.id,
                              permissionId: item.permissionId,
                              decision: 'allow_always',
                            ),
                            child: Text(
                              client.strings.allowAlwaysBtn,
                              style: const TextStyle(fontSize: 11),
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
                            ),
                            onPressed: () => client.replyPermission(
                              sessionId: session.id,
                              permissionId: item.permissionId,
                              decision: 'reject',
                            ),
                            child: Text(
                              client.strings.rejectBtn,
                              style: const TextStyle(fontSize: 11),
                            ),
                          ),
                        ),
                      ],
                    ),
                ],
              ),
            ),
          FileDiffCardItem() => Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
              decoration: BoxDecoration(
                color: const Color(0xFFFFFFFF),
                borderRadius: BorderRadius.circular(10),
              ),
              child: Row(
                children: [
                  const Icon(Icons.difference_outlined, size: 15, color: Color(0xFF007AFF)),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      item.file,
                      style: const TextStyle(
                        fontWeight: FontWeight.w600,
                        fontSize: 12,
                        color: Color(0xFF181818),
                      ),
                    ),
                  ),
                  Text(
                    '+${item.additions} / -${item.deletions}',
                    style: const TextStyle(
                      fontSize: 11,
                      fontWeight: FontWeight.w600,
                      color: Color(0xFF07C160),
                    ),
                  ),
                ],
              ),
            ),
          ScreenCaptureCardItem() => Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
              decoration: BoxDecoration(
                color: const Color(0xFFFFFFFF),
                borderRadius: BorderRadius.circular(10),
              ),
              child: Row(
                children: [
                  const Icon(Icons.desktop_windows_outlined, size: 15, color: Color(0xFF007AFF)),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      'Screen Capture (${item.displayId})',
                      style: const TextStyle(
                        fontWeight: FontWeight.w600,
                        fontSize: 12,
                        color: Color(0xFF181818),
                      ),
                    ),
                  ),
                  Text(
                    '${item.width}x${item.height}',
                    style: const TextStyle(fontSize: 11, color: Color(0xFF8E8E93)),
                  ),
                ],
              ),
            ),
          UsageSummaryItem() => Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
              decoration: BoxDecoration(
                color: const Color(0xFFFFFFFF),
                borderRadius: BorderRadius.circular(10),
              ),
              child: Row(
                children: [
                  const Icon(Icons.analytics_outlined, size: 14, color: Color(0xFF07C160)),
                  const SizedBox(width: 6),
                  Text(
                    '${item.inputTokens} in · ${item.outputTokens} out · \$${item.costUsd.toStringAsFixed(4)}',
                    style: const TextStyle(fontSize: 11, color: Color(0xFF8E8E93)),
                  ),
                ],
              ),
            ),
        };
      },
    );
  }
}
