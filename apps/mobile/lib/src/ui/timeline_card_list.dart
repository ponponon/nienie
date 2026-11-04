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
      padding: const EdgeInsets.all(12),
      itemCount: items.length,
      separatorBuilder: (_, __) => const SizedBox(height: 8),
      itemBuilder: (context, index) {
        final item = items[index];
        return switch (item) {
          UserPromptItem() => Card(
              color: const Color(0xFF1E293B),
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: Row(
                  children: [
                    const Icon(Icons.person_outline, size: 16),
                    const SizedBox(width: 8),
                    Expanded(child: Text(item.message)),
                  ],
                ),
              ),
            ),
          StreamingTextItem() => Card(
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Icon(
                      item.isThinking ? Icons.psychology_outlined : Icons.smart_toy_outlined,
                      size: 16,
                      color: const Color(0xFF3B82F6),
                    ),
                    const SizedBox(width: 8),
                    Expanded(child: Text(item.text)),
                  ],
                ),
              ),
            ),
          ToolCallCardItem() => Card(
              shape: RoundedRectangleBorder(
                side: BorderSide(
                  color: item.isError
                      ? const Color(0xFFEF4444)
                      : const Color(0xFF2B2B2B),
                ),
                borderRadius: BorderRadius.circular(8),
              ),
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        const Icon(Icons.terminal, size: 16, color: Color(0xFF10B981)),
                        const SizedBox(width: 6),
                        Text(
                          item.name,
                          style: const TextStyle(fontWeight: FontWeight.w600),
                        ),
                      ],
                    ),
                    const SizedBox(height: 6),
                    Text(
                      jsonEncode(item.input),
                      style: const TextStyle(fontSize: 12, color: Color(0xFF9CA3AF)),
                    ),
                    if (item.resultContent != null) ...[
                      const SizedBox(height: 6),
                      Text(
                        item.resultContent!,
                        style: TextStyle(
                          fontSize: 12,
                          color: item.isError
                              ? const Color(0xFFEF4444)
                              : const Color(0xFFF3F4F6),
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            ),
          ErrorCardItem() => Card(
              color: const Color(0xFFEF4444).withValues(alpha: 0.14),
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        const Icon(Icons.error_outline, size: 16, color: Color(0xFFEF4444)),
                        const SizedBox(width: 6),
                        Text(
                          item.code,
                          style: const TextStyle(
                            fontWeight: FontWeight.w700,
                            color: Color(0xFFEF4444),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 4),
                    Text(item.message),
                  ],
                ),
              ),
            ),
          PermissionRequestCardItem() => Card(
              color: const Color(0xFFF59E0B).withValues(alpha: 0.14),
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        const Icon(Icons.shield_outlined, size: 16, color: Color(0xFFF59E0B)),
                        const SizedBox(width: 6),
                        Expanded(
                          child: Text(
                            item.detail,
                            style: const TextStyle(fontWeight: FontWeight.w600),
                          ),
                        ),
                      ],
                    ),
                    if (item.patterns.isNotEmpty) ...[
                      const SizedBox(height: 4),
                      Text(
                        item.patterns.join(', '),
                        style: const TextStyle(fontSize: 12, color: Color(0xFF9CA3AF)),
                      ),
                    ],
                    const SizedBox(height: 8),
                    if (item.resolvedDecision != null)
                      Text('Decision: ${item.resolvedDecision}')
                    else
                      Row(
                        children: [
                          FilledButton(
                            key: Key('btn-perm-allow-once-${item.permissionId}'),
                            onPressed: () => client.replyPermission(
                              sessionId: session.id,
                              permissionId: item.permissionId,
                              decision: 'allow_once',
                            ),
                            child: Text(client.strings.allowOnceBtn),
                          ),
                          const SizedBox(width: 8),
                          FilledButton.tonal(
                            key: Key('btn-perm-allow-always-${item.permissionId}'),
                            onPressed: () => client.replyPermission(
                              sessionId: session.id,
                              permissionId: item.permissionId,
                              decision: 'allow_always',
                            ),
                            child: Text(client.strings.allowAlwaysBtn),
                          ),
                          const SizedBox(width: 8),
                          OutlinedButton(
                            key: Key('btn-perm-reject-${item.permissionId}'),
                            onPressed: () => client.replyPermission(
                              sessionId: session.id,
                              permissionId: item.permissionId,
                              decision: 'reject',
                            ),
                            child: Text(client.strings.rejectBtn),
                          ),
                        ],
                      ),
                  ],
                ),
              ),
            ),
          FileDiffCardItem() => Card(
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: Row(
                  children: [
                    const Icon(Icons.difference_outlined, size: 16, color: Color(0xFF3B82F6)),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        item.file,
                        style: const TextStyle(fontWeight: FontWeight.w600),
                      ),
                    ),
                    Text(
                      '+${item.additions} / -${item.deletions}',
                      style: const TextStyle(fontSize: 12, color: Color(0xFF10B981)),
                    ),
                  ],
                ),
              ),
            ),
          ScreenCaptureCardItem() => Card(
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: Row(
                  children: [
                    const Icon(Icons.desktop_windows_outlined, size: 16, color: Color(0xFF3B82F6)),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        'Screen Capture (${item.displayId})',
                        style: const TextStyle(fontWeight: FontWeight.w600),
                      ),
                    ),
                    Text(
                      '${item.width}x${item.height}',
                      style: const TextStyle(fontSize: 12, color: Color(0xFF9CA3AF)),
                    ),
                  ],
                ),
              ),
            ),
          UsageSummaryItem() => Card(
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: Row(
                  children: [
                    const Icon(Icons.analytics_outlined, size: 16, color: Color(0xFF10B981)),
                    const SizedBox(width: 8),
                    Text(
                      '${item.inputTokens} in · ${item.outputTokens} out · \$${item.costUsd.toStringAsFixed(4)}',
                      style: const TextStyle(fontSize: 12, color: Color(0xFF9CA3AF)),
                    ),
                  ],
                ),
              ),
            ),
        };
      },
    );
  }
}
