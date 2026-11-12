import 'package:flutter/material.dart';

import '../i18n/app_strings.dart';
import '../state/mobile_bridge_client.dart';

const Color _textPrimary = Color(0xFF141416);
const Color _textSecondary = Color(0xFF686C75);
const Color _chipBg = Color(0xFFF3F4F6);

/// 5.1：快捷指令栏——输入框上方自定义胶囊（按 Agent 定制，点击填充输入框）。
class QuickCommandsBar extends StatelessWidget {
  final MobileBridgeClient client;
  final String agentId;

  /// 点击胶囊：把指令文本交给输入框（追加保留草稿）
  final void Function(String command) onUse;

  const QuickCommandsBar({
    super.key,
    required this.client,
    required this.agentId,
    required this.onUse,
  });

  @override
  Widget build(BuildContext context) {
    final strings = client.strings;
    final commands = client.quickCommandsFor(agentId) ?? strings.defaultQuickCommands;
    return SizedBox(
      height: 36,
      child: ListView.separated(
        key: const Key('quick-commands-bar'),
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 16),
        itemCount: commands.length + 1,
        separatorBuilder: (_, __) => const SizedBox(width: 7),
        itemBuilder: (context, index) {
          if (index == commands.length) {
            return _AddCommandButton(
              strings: strings,
              onAdd: (value) => client.addQuickCommand(agentId, value),
            );
          }
          final command = commands[index];
          return GestureDetector(
            key: Key('quick-command-$command'),
            onTap: () => onUse(command),
            onLongPress: () => _confirmRemove(context, strings, command),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 12),
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: _chipBg,
                borderRadius: BorderRadius.circular(999),
              ),
              child: Text(
                command,
                style: const TextStyle(
                  fontSize: 12.5,
                  fontWeight: FontWeight.w500,
                  color: _textPrimary,
                ),
              ),
            ),
          );
        },
      ),
    );
  }

  void _confirmRemove(BuildContext context, NienieStrings strings, String command) {
    showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(command),
        content: Text(strings.quickCmdDeleted),
        actions: [
          TextButton(
            key: const Key('quick-command-remove-cancel'),
            onPressed: () => Navigator.of(ctx).pop(),
            child: Text(strings.permCancelBtn),
          ),
          TextButton(
            key: const Key('quick-command-remove-ok'),
            onPressed: () {
              Navigator.of(ctx).pop();
              client.removeQuickCommand(agentId, command);
            },
            child: Text(strings.permConfirmOk),
          ),
        ],
      ),
    );
  }
}

class _AddCommandButton extends StatelessWidget {
  final NienieStrings strings;
  final Future<void> Function(String value) onAdd;

  const _AddCommandButton({required this.strings, required this.onAdd});

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      key: const Key('btn-add-quick-command'),
      onTap: () async {
        final controller = TextEditingController();
        final value = await showDialog<String>(
          context: context,
          builder: (ctx) => AlertDialog(
            title: Text(strings.quickCmdAddLabel),
            content: TextField(
              key: const Key('input-quick-command'),
              controller: controller,
              autofocus: true,
              decoration: InputDecoration(hintText: strings.quickCmdHint),
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.of(ctx).pop(),
                child: Text(strings.permCancelBtn),
              ),
              TextButton(
                key: const Key('btn-quick-command-confirm'),
                onPressed: () => Navigator.of(ctx).pop(controller.text),
                child: Text(strings.permConfirmOk),
              ),
            ],
          ),
        );
        if (value != null && value.trim().isNotEmpty) {
          await onAdd(value);
        }
      },
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 11),
        alignment: Alignment.center,
        decoration: BoxDecoration(
          border: Border.all(color: const Color(0x12000000)),
          borderRadius: BorderRadius.circular(999),
        ),
        child: const Icon(Icons.add, size: 15, color: _textSecondary),
      ),
    );
  }
}
