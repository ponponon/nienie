import 'package:flutter/material.dart';
import 'theme_colors.dart';

import '../i18n/app_strings.dart';
import '../state/mobile_bridge_client.dart';


/// 5.1：快捷指令栏——输入框上方自定义胶囊（按 Agent 定制，点击填充输入框）。
class QuickCommandsBar extends StatefulWidget {
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
  State<QuickCommandsBar> createState() => _QuickCommandsBarState();
}

class _QuickCommandsBarState extends State<QuickCommandsBar> {
  @override
  void initState() {
    super.initState();
    // P1：生产路径自动加载持久化的自定义指令（幂等，已加载不重复）
    widget.client.ensureQuickCommandsLoaded(widget.agentId);
    widget.client.addListener(_onClientChanged);
  }

  void _onClientChanged() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    widget.client.removeListener(_onClientChanged);
    super.dispose();
  }

  @override
  void didUpdateWidget(covariant QuickCommandsBar oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.agentId != widget.agentId) {
      // 切换 Agent：加载目标 Agent 的指令（结果按 scope 隔离，无竞态覆盖）
      widget.client.ensureQuickCommandsLoaded(widget.agentId);
    }
  }

  @override
  Widget build(BuildContext context) {
    final strings = widget.client.strings;
    final commands =
        widget.client.quickCommandsFor(widget.agentId) ?? strings.defaultQuickCommands;
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
              onAdd: (value) => widget.client.addQuickCommand(widget.agentId, value),
            );
          }
          final command = commands[index];
          return GestureDetector(
            key: Key('quick-command-$command'),
            onTap: () => widget.onUse(command),
            onLongPress: () => _confirmRemove(context, strings, command),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 12),
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: chipBgColor(context),
                borderRadius: BorderRadius.circular(999),
              ),
              child: Text(
                command,
                style: TextStyle(
                  fontSize: 12.5,
                  fontWeight: FontWeight.w500,
                  color: primaryTextColor(context),
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
        content: Text(strings.quickCmdDeleteConfirm),
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
              widget.client.removeQuickCommand(widget.agentId, command);
              ScaffoldMessenger.of(context).showSnackBar(
                SnackBar(
                  content: Text(strings.quickCmdDeleted),
                  duration: const Duration(seconds: 1),
                ),
              );
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
        child: Icon(Icons.add, size: 15, color: secondaryTextColor(context)),
      ),
    );
  }
}
