import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'theme_colors.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../models/protocol_models.dart';
import '../models/timeline_items.dart';
import '../state/mobile_bridge_client.dart';
import 'agent_brand_logo.dart';
import 'markdown_message.dart';

class SessionTimelineList extends StatefulWidget {
  final MobileBridgeClient client;
  final AgentSession session;

  /// 4.5：引用追问——把引用文本交回输入框（controller 在 app 层）
  final void Function(String quoteText)? onQuoteReply;

  const SessionTimelineList({
    super.key,
    required this.client,
    required this.session,
    this.onQuoteReply,
  });

  @override
  State<SessionTimelineList> createState() => _SessionTimelineListState();
}

class _SessionTimelineListState extends State<SessionTimelineList> {
  // ===== 5.2 回到底部：翻历史时新回复浮出，不强制跳底 =====
  final ScrollController _scrollController = ScrollController();
  bool _atBottom = true;
  bool _showJumpToBottom = false;
  int _lastItemCount = 0;
  int _lastContentVersion = 0;
  Timer? _waitingRefreshTimer;

  @override
  void initState() {
    super.initState();
    // Round3 P2-4：先建立当前 Session 的水位基线（ValueKey 重建走 initState）——
    // 否则历史内容被误判为新回复
    _lastContentVersion = widget.client.timelineVersionFor(widget.session.id);
    _lastItemCount = widget.client.timelineFor(widget.session.id).length;
    widget.client.addListener(_onClientChanged);
    _scrollController.addListener(_onScroll);
    // 5.2：聊天语义——初始停在底部（最新消息）
    WidgetsBinding.instance.addPostFrameCallback((_) => _scrollToBottomImmediate());
    // 超时提醒刷新（只提示等待时长，不冒充服务端过期）
    _waitingRefreshTimer = Timer.periodic(const Duration(seconds: 30), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    widget.client.removeListener(_onClientChanged);
    _scrollController.dispose();
    _waitingRefreshTimer?.cancel();
    super.dispose();
  }

  /// 目标③：批准/拒绝入口——allow_always 与高风险操作先二次确认（说明永久影响），其余直达
  Future<void> _handlePermissionDecision(PermissionRequestCardItem item, String decision) async {
    // 交互矩阵（Round 4）：reject 永远直达（拒绝是安全操作）；
    // allow_always 必须确认；allow_once 仅高风险/未分类需要确认；低/中风险直达防审批疲劳
    final needsConfirm = decision == 'allow_always' ||
        (decision == 'allow_once' &&
            (item.risk == PermissionRiskLevel.high || item.risk == PermissionRiskLevel.unknown));
    if (needsConfirm) {
      final confirmed = await showDialog<bool>(
        context: context,
        builder: (dialogContext) {
          final isAlways = decision == 'allow_always';
          return AlertDialog(
            title: Text(
              isAlways
                  ? widget.client.strings.permConfirmTitle
                  : item.risk == PermissionRiskLevel.high
                      ? widget.client.strings.permConfirmHighRiskNote
                      : widget.client.strings.permConfirmUnknownNote,
              style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
            ),
            content: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  isAlways
                      ? widget.client.strings.permConfirmAlwaysLine
                      : widget.client.strings.permConfirmOnceLine,
                  style: TextStyle(fontSize: 12.5),
                ),
                const SizedBox(height: 4),
                Text(item.permission,
                    style: TextStyle(fontSize: 12, fontFamily: 'monospace')),
                if (item.patterns.isNotEmpty) ...[
                  const SizedBox(height: 8),
                  Text(widget.client.strings.permConfirmResources, style: TextStyle(fontSize: 11, color: secondaryTextColor(context))),
                  Text(item.patterns.join('\n'),
                      style: TextStyle(fontSize: 11, fontFamily: 'monospace')),
                ],
                if (isAlways) ...[
                  const SizedBox(height: 8),
                  Text(widget.client.strings.permConfirmFutureNote,
                      style: TextStyle(fontSize: 11, color: warnTextColor(context))),
                ],
              ],
            ),
            actions: [
              TextButton(
                key: const Key('btn-perm-confirm-cancel'),
                onPressed: () => Navigator.of(dialogContext).pop(false),
                child: Text(widget.client.strings.permCancelBtn),
              ),
              FilledButton(
                key: const Key('btn-perm-confirm-ok'),
                onPressed: () => Navigator.of(dialogContext).pop(true),
                child: Text(widget.client.strings.permConfirmOk),
              ),
            ],
          );
        },
      );
      if (confirmed != true) return;
    }
    await widget.client.replyPermission(
      sessionId: widget.session.id,
      permissionId: item.permissionId,
      decision: decision,
    );
  }

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
              style: TextStyle(fontSize: 10.5, color: secondaryTextColor(context)),
            ),
          ),
          Expanded(
            child: SelectableText(
              value,
              style: TextStyle(
                fontSize: 11.5,
                fontFamily: 'monospace',
                color: primaryTextColor(context),
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

  /// unified diff 形态判定（@@/diff --git/+/-/空格上下文行）
  static bool _looksLikePatch(String content) {
    final firstLine = content
        .split('\n')
        .firstWhere((l) => l.trim().isNotEmpty, orElse: () => '');
    return firstLine.startsWith('@@') ||
        firstLine.startsWith('diff --git') ||
        firstLine.startsWith('+') ||
        firstLine.startsWith('-');
  }

  /// 6.3：unified patch 着色视图（- 红 / + 绿 / @@ 蓝 / 空格灰）
  Widget _buildPatchView(String label, String patch) {
    final lines = patch.split('\n');
    return Container(
      key: const Key('diff-patch-view'),
      width: double.infinity,
      padding: const EdgeInsets.all(8),
      decoration: BoxDecoration(
        color: cardBgColor(context),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: subtleBorderColor(context)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            label,
            style: TextStyle(
              fontSize: 10.5,
              fontWeight: FontWeight.w600,
              color: Color(0xFF2563EB),
            ),
          ),
          const SizedBox(height: 4),
          ConstrainedBox(
            constraints: const BoxConstraints(maxHeight: 180),
            child: SingleChildScrollView(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  for (final line in lines)
                    Text(
                      line.isEmpty ? ' ' : line,
                      style: TextStyle(
                        fontSize: 11,
                        fontFamily: 'monospace',
                        height: 1.5,
                        color: line.startsWith('+')
                            ? _weTypeGreen
                            : line.startsWith('-')
                                ? dangerTextColor(context)
                                : line.startsWith('@@')
                                    ? const Color(0xFF2563EB)
                                    : secondaryTextColor(context),
                        backgroundColor: line.startsWith('+')
                            ? _weTypeGreen.withValues(alpha: 0.07)
                            : line.startsWith('-')
                                ? const Color(0xFFEF4444).withValues(alpha: 0.06)
                                : null,
                      ),
                    ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  /// 6.3：diff Before/After 区块（mono 内滚动，轻底色区分）
  Widget _buildDiffSection(String label, String content, bool isAfter) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(8),
      decoration: BoxDecoration(
        color: isAfter
            ? _weTypeGreen.withValues(alpha: 0.06)
            : const Color(0xFFEF4444).withValues(alpha: 0.05),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: subtleBorderColor(context)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            label,
            style: TextStyle(
              fontSize: 10.5,
              fontWeight: FontWeight.w600,
              color: isAfter ? _weTypeGreen : dangerTextColor(context),
            ),
          ),
          const SizedBox(height: 4),
          ConstrainedBox(
            constraints: const BoxConstraints(maxHeight: 180),
            child: SingleChildScrollView(
              child: Text(
                content.isEmpty ? '—' : content,
                style: TextStyle(
                  fontSize: 11,
                  fontFamily: 'monospace',
                  color: secondaryTextColor(context),
                  height: 1.5,
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  /// 4.5：长按操作菜单——复制文本 / 引用追问 / 从这里重试（用户消息）
  void _showMessageActions(
    BuildContext context, {
    required String text,
    UserPromptItem? userItem,
  }) {
    HapticFeedback.lightImpact(); // 7.3：长按菜单触感
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: appBgColor(context),
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const SizedBox(height: 8),
            ListTile(
              key: const Key('menu-copy-text'),
              leading: Icon(LucideIcons.copy, size: 19),
              title: Text(widget.client.strings.actionCopyText),
              onTap: () async {
                Navigator.of(ctx).pop();
                await Clipboard.setData(ClipboardData(text: text));
                if (context.mounted) {
                  ScaffoldMessenger.of(context).showSnackBar(
                    SnackBar(
                      content: Text(widget.client.strings.codeCopiedLabel),
                      duration: const Duration(seconds: 1),
                    ),
                  );
                }
              },
            ),
            ListTile(
              key: const Key('menu-quote-reply'),
              leading: Icon(LucideIcons.quote, size: 19),
              title: Text(widget.client.strings.actionQuoteReply),
              onTap: () {
                Navigator.of(ctx).pop();
                // 引用块交回 app 层输入框（保留已有草稿）
                final quote = text.length > 200 ? '${text.substring(0, 200)}…' : text;
                widget.onQuoteReply?.call(quote);
              },
            ),
            // Round 3：pending 时隐藏重试项（点击无效会误导用户）
            if (userItem != null && userItem.receipt != SendReceipt.pending)
              ListTile(
                key: const Key('menu-resend-from-here'),
                leading: Icon(LucideIcons.rotateCcw, size: 19),
                title: Text(widget.client.strings.actionResendFromHere),
                onTap: () {
                  Navigator.of(ctx).pop();
                  if (userItem.receipt == SendReceipt.failed) {
                    widget.client.retrySendPrompt(widget.session, userItem);
                  } else if (userItem.receipt == SendReceipt.pending) {
                    // 发送中：不重复出站（幂等保护，双触发只一次有效）
                  } else {
                    widget.client.sendMessage(userItem.message);
                  }
                },
              ),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
  }

  void _onScroll() {
    if (!_scrollController.hasClients) return;
    final atBottom = _scrollController.position.pixels >=
        _scrollController.position.maxScrollExtent - 60;
    if (atBottom != _atBottom) {
      setState(() {
        _atBottom = atBottom;
        if (atBottom) _showJumpToBottom = false; // 用户自己滚回底部 → 收起
      });
    }
  }

  void _scrollToBottomImmediate() {
    if (_scrollController.hasClients) {
      _scrollController.jumpTo(_scrollController.position.maxScrollExtent);
    }
  }

  void _onClientChanged() {
    if (!mounted) return;
    // P1：内容水位判定（含同 partId 增量/工具卡/占位消失），普通状态通知不触发滚动
    final version = widget.client.timelineVersionFor(widget.session.id);
    if (version > _lastContentVersion) {
      _lastContentVersion = version;
      if (_atBottom) {
        // 在底部：静默跟随新内容（流式增量持续跟随）
        // Round3 P2-5：回调执行时重查——注册后用户已翻历史则放弃跟随（不强制跳底）
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (!mounted || !_atBottom) return;
          _scrollToBottomImmediate();
        });
      } else {
        // 5.2：翻历史时新内容到达 → 浮出按钮，不强制跳底（持续可见）
        setState(() => _showJumpToBottom = true);
      }
    }
    _lastItemCount = widget.client.timelineFor(widget.session.id).length;
  }

  @override
  void didUpdateWidget(covariant SessionTimelineList oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.session.id != widget.session.id) {
      // P2：切换会话——重置滚动状态/提示并定位最新（同一会话普通 rebuild 不重置）
      _atBottom = true;
      _showJumpToBottom = false;
      _lastItemCount = widget.client.timelineFor(widget.session.id).length;
      _lastContentVersion = widget.client.timelineVersionFor(widget.session.id);
      WidgetsBinding.instance.addPostFrameCallback((_) => _scrollToBottomImmediate());
    }
  }

  void _jumpToBottom() {
    _scrollController.animateTo(
      _scrollController.position.maxScrollExtent,
      duration: const Duration(milliseconds: 250),
      curve: Curves.easeOut,
    );
    setState(() => _showJumpToBottom = false);
  }

  static const Color _weTypeGreen = Color(0xFF17B378);
  @override
  Widget build(BuildContext context) {
    final items = widget.client.timelineFor(widget.session.id);
    if (items.length != _lastItemCount) {
      _lastItemCount = items.length;
    }
    return Stack(
      children: [
    ListView.separated(
      key: const Key('session-timeline-list'),
      controller: _scrollController,
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      itemCount: items.length,
      separatorBuilder: (_, __) => const SizedBox(height: 12),
      itemBuilder: (context, index) {
        final item = items[index];
        return switch (item) {
          // Kelivo Soft Gray User Prompt Bubble (borderless R18 pill)
          UserPromptItem() => TweenAnimationBuilder<double>(
              // 7.3：新气泡淡入微动效（150ms 一次性）
              tween: Tween(begin: 0, end: 1),
              duration: const Duration(milliseconds: 150),
              builder: (context, opacity, child) =>
                  Opacity(opacity: opacity, child: child),
              child: Column(
              crossAxisAlignment: CrossAxisAlignment.end,
              mainAxisSize: MainAxisSize.min,
              children: [
                Align(
              alignment: Alignment.centerRight,
              child: GestureDetector(
                // 4.5：长按——复制/引用追问/从这里重试
                onLongPress: () => _showMessageActions(
                  context,
                  text: item.message,
                  userItem: item,
                ),
                child: Container(
                  key: const Key('user-bubble'),
                constraints: BoxConstraints(
                  maxWidth: MediaQuery.sizeOf(context).width * 0.8,
                ),
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                decoration: BoxDecoration(
                  color: userBubbleBgColor(context),
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
                    Row(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.end,
                      children: [
                        Flexible(
                          child: Text(
                            item.message,
                            style: TextStyle(
                              color: primaryTextColor(context),
                              fontSize: 14,
                              height: 1.45,
                            ),
                          ),
                        ),
                        // 路线图 3.3：送达回执（iMessage 心智）——发送中/已送达电脑/未送达可重发
                        const SizedBox(width: 5),
                        Builder(builder: (context) {
                          final receipt = item.receipt;
                          final icon = switch (receipt) {
                            SendReceipt.pending => Icon(
                                LucideIcons.clock,
                                size: 12,
                                color: secondaryTextColor(context),
                              ),
                            SendReceipt.delivered => Icon(
                                LucideIcons.checkCheck,
                                size: 13,
                                color: _weTypeGreen,
                              ),
                            SendReceipt.failed => Icon(
                                LucideIcons.circleAlert,
                                size: 13,
                                color: dangerTextColor(context),
                              ),
                          };
                          if (receipt == SendReceipt.failed) {
                            return Tooltip(
                              message: widget.client.strings.notDeliveredLabel,
                              child: GestureDetector(
                                key: Key('btn-resend-${item.messageId ?? item.message}'),
                                onTap: () => widget.client.retrySendPrompt(widget.session, item),
                                child: icon,
                              ),
                            );
                          }
                          return receipt == SendReceipt.delivered
                              ? Tooltip(
                                  message: widget.client.strings.deliveredReceipt,
                                  child: icon,
                                )
                              : icon;
                        }),
                      ],
                    ),
                    // 附件元数据可见（J0.6b-3.2）：文件名 + MIME
                    for (final attachment in item.attachments) ...[
                      const SizedBox(height: 6),
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
                        decoration: BoxDecoration(
                          color: attachChipBgColor(context),
                          borderRadius: BorderRadius.circular(8),
                        ),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Icon(
                              LucideIcons.paperclip,
                              size: 12,
                              color: secondaryTextColor(context),
                            ),
                            const SizedBox(width: 5),
                            Flexible(
                              child: Text(
                                attachment.name.isNotEmpty
                                    ? '${attachment.name} · ${attachment.mime}'
                                    : attachment.mime,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: TextStyle(
                                  fontSize: 11,
                                  color: secondaryTextColor(context),
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
            ),
                // 4.3：相对时间戳（事件真实时间，历史恢复不显示「刚刚」）
                const SizedBox(height: 3),
                Padding(
                  padding: const EdgeInsets.only(right: 4),
                  child: Text(
                    widget.client.strings.relativeTime(item.createdAt),
                    style: TextStyle(fontSize: 11, color: secondaryTextColor(context)),
                  ),
                ),
              ],
            ),
            ),

          // 等待回复占位 / 超时兜底卡片
          PendingResponseItem() => item.timedOut
              ? Container(
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                  decoration: BoxDecoration(
                    color: warnBgColor(context),
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
                          Icon(
                            LucideIcons.clockAlert,
                            size: 14,
                            color: warnTextColor(context),
                          ),
                          const SizedBox(width: 6),
                          Text(
                            widget.client.strings.replyTimedOutLabel,
                            style: TextStyle(
                              fontSize: 12,
                              fontWeight: FontWeight.w600,
                              color: warnTextColor(context),
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 6),
                      Text(
                        'No response yet. The agent may still be working on the computer.',
                        style: TextStyle(
                          color: secondaryTextColor(context),
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
                      style: TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w600,
                        color: secondaryTextColor(context),
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
                    Text(
                      'Thinking…',
                      style: TextStyle(
                        fontSize: 12.5,
                        color: secondaryTextColor(context),
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
                          color: chipBgColor(context),
                          borderRadius: BorderRadius.circular(6),
                        ),
                        alignment: Alignment.center,
                        child: Icon(
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
                      style: TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w600,
                        color: secondaryTextColor(context),
                      ),
                    ),
                    if (item.isThinking) ...[
                      const SizedBox(width: 6),
                      Icon(
                        item.collapsed
                            ? LucideIcons.chevronDown
                            : LucideIcons.chevronUp,
                        size: 14,
                        color: secondaryTextColor(context),
                      ),
                    ],
                  ],
                ),
                ),
                if (!item.isThinking || !item.collapsed) ...[
                const SizedBox(height: 6),
                Padding(
                  padding: const EdgeInsets.only(left: 2),
                  // 4.1：Agent 输出按 Markdown 渲染（含语法高亮代码块）；思考过程保持纯文本
                  child: GestureDetector(
                    // 4.5：长按——复制/引用追问
                    onLongPress: () => _showMessageActions(
                      context,
                      text: item.text,
                    ),
                    child: item.isThinking
                        ? Text(
                            item.text,
                            style: TextStyle(
                              color: secondaryTextColor(context),
                              fontSize: 14,
                              height: 1.55,
                            ),
                          )
                        : MarkdownMessage(
                            data: item.text,
                            strings: widget.client.strings,
                          ),
                  ),
                ),
                ],
                // 4.3：相对时间戳（事件真实时间；思考过程不打点）
                if (!item.isThinking) ...[
                  const SizedBox(height: 4),
                  Text(
                    widget.client.strings.relativeTime(item.createdAt),
                    style: TextStyle(fontSize: 11, color: secondaryTextColor(context)),
                  ),
                ],
              ],
            ),

          // 4.4 工具卡：执行过程可视化——状态徽标/耗时/退出码/长输出内滚动/输出可复制
          ToolCallCardItem() => Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
              decoration: BoxDecoration(
                color: cardBgColor(context),
                border: Border.all(
                  color: switch (item.status) {
                    ToolCallStatus.failed =>
                      const Color(0xFFEF4444).withValues(alpha: 0.35),
                    ToolCallStatus.completed =>
                      _weTypeGreen.withValues(alpha: 0.25),
                    ToolCallStatus.running =>
                      _weTypeGreen.withValues(alpha: 0.35),
                    ToolCallStatus.pending => subtleBorderColor(context),
                  },
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
                      // 状态图标来自显式 status（J0.4：禁止用 resultContent 推断成败）
                      Icon(
                        switch (item.status) {
                          ToolCallStatus.pending => LucideIcons.circleDashed,
                          ToolCallStatus.running => LucideIcons.loaderCircle,
                          ToolCallStatus.completed => LucideIcons.circleCheck,
                          ToolCallStatus.failed => LucideIcons.circleX,
                        },
                        size: 14,
                        color: switch (item.status) {
                          ToolCallStatus.failed => dangerTextColor(context),
                          ToolCallStatus.completed => _weTypeGreen,
                          ToolCallStatus.running => _weTypeGreen,
                          ToolCallStatus.pending => secondaryTextColor(context),
                        },
                      ),
                      const SizedBox(width: 7),
                      Text(
                        item.name,
                        style: TextStyle(
                          fontWeight: FontWeight.w600,
                          fontSize: 12,
                          fontFamily: 'monospace',
                          color: primaryTextColor(context),
                        ),
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          jsonEncode(item.input),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontSize: 11,
                            fontFamily: 'monospace',
                            color: secondaryTextColor(context),
                          ),
                        ),
                      ),
                      // 状态文案（五态可视化的语言层）
                      Text(
                        switch (item.status) {
                          ToolCallStatus.pending => widget.client.strings.toolStatusPending,
                          ToolCallStatus.running => widget.client.strings.toolStatusRunning,
                          ToolCallStatus.completed => widget.client.strings.toolStatusDone,
                          ToolCallStatus.failed => widget.client.strings.toolStatusFailed,
                        },
                        style: TextStyle(
                          fontSize: 10.5,
                          fontWeight: FontWeight.w600,
                          color: switch (item.status) {
                            ToolCallStatus.failed => dangerTextColor(context),
                            ToolCallStatus.completed => _weTypeGreen,
                            ToolCallStatus.running => _weTypeGreen,
                            ToolCallStatus.pending => secondaryTextColor(context),
                          },
                        ),
                      ),
                      // 4.4：耗时（完成后）/ 退出码徽标
                      if (item.durationLabel != null) ...[
                        const SizedBox(width: 6),
                        Text(
                          item.durationLabel!,
                          style: TextStyle(
                            fontSize: 10.5,
                            fontFamily: 'monospace',
                            color: secondaryTextColor(context),
                          ),
                        ),
                      ],
                      if (item.exitCode != null) ...[
                        const SizedBox(width: 5),
                        Container(
                          padding: const EdgeInsets.symmetric(
                              horizontal: 5, vertical: 1.5),
                          decoration: BoxDecoration(
                            color: item.exitCode == 0
                                ? _weTypeGreen.withValues(alpha: 0.12)
                                : const Color(0xFFEF4444).withValues(alpha: 0.12),
                            borderRadius: BorderRadius.circular(5),
                          ),
                          child: Text(
                            widget.client.strings.toolExitLabel(item.exitCode!),
                            style: TextStyle(
                              fontSize: 9.5,
                              fontWeight: FontWeight.w600,
                              fontFamily: 'monospace',
                              color: item.exitCode == 0
                                  ? _weTypeGreen
                                  : dangerTextColor(context),
                            ),
                          ),
                        ),
                      ],
                      if (item.resultContent != null) ...[
                        const SizedBox(width: 4),
                        Icon(
                          item.expanded
                              ? LucideIcons.chevronUp
                              : LucideIcons.chevronDown,
                          size: 13,
                          color: secondaryTextColor(context),
                        ),
                      ],
                    ],
                  ),
                  ),
                  if (item.resultContent != null && item.expanded) ...[
                    const SizedBox(height: 5),
                    // 输出头部：可复制（远程复制=核心动作）
                    Row(
                      children: [
                        const Spacer(),
                        Tooltip(
                          message: widget.client.strings.copyCodeLabel,
                          child: GestureDetector(
                            key: Key('btn-copy-tool-output-${item.toolCallId}'),
                            onTap: () async {
                              await Clipboard.setData(
                                  ClipboardData(text: item.resultContent!));
                            },
                            child: Icon(
                              LucideIcons.copy,
                              size: 13,
                              color: secondaryTextColor(context),
                            ),
                          ),
                        ),
                      ],
                    ),
                    // 4.4 长输出：内滚动封顶（不把时间线撑爆），全文可复制
                    ConstrainedBox(
                      constraints: const BoxConstraints(maxHeight: 280),
                      child: SingleChildScrollView(
                        child: Text(
                          item.resultContent!,
                          style: TextStyle(
                            fontSize: 11.5,
                            fontFamily: 'monospace',
                            color: item.status == ToolCallStatus.failed
                                ? dangerTextColor(context)
                                : secondaryTextColor(context),
                          ),
                        ),
                      ),
                    ),
                  ],
                ],
              ),
            ),

          // Structured Error Card
          ErrorCardItem() => Container(
              key: const Key('error-card'),
              padding: const EdgeInsets.all(11),
              decoration: BoxDecoration(
                color: dangerBgColor(context),
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
                      Icon(
                        LucideIcons.circleAlert,
                        size: 15,
                        color: dangerTextColor(context),
                      ),
                      const SizedBox(width: 6),
                      Text(
                        item.code,
                        style: TextStyle(
                          fontWeight: FontWeight.w700,
                          fontSize: 12,
                          fontFamily: 'monospace',
                          color: dangerTextColor(context),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 3),
                  Text(
                    item.message,
                    style: TextStyle(fontSize: 12.5, color: primaryTextColor(context)),
                  ),
                ],
              ),
            ),

          // Structured Permission Approval Card
          PermissionRequestCardItem() => Builder(builder: (context) {
              final risk = item.risk;
              final riskColor = switch (risk) {
                PermissionRiskLevel.low => _weTypeGreen,
                PermissionRiskLevel.medium => warnTextColor(context),
                PermissionRiskLevel.high => dangerTextColor(context),
                PermissionRiskLevel.unknown => secondaryTextColor(context),
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
                color: focused ? infoBgColor(context) : cautionBgColor(context),
                border: Border.all(
                  // 聚焦用独立蓝色描边（与风险色解耦）
                  color: focused ? const Color(0xFF2563EB) : riskColor.withValues(alpha: 0.32),
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
                          style: TextStyle(
                            fontWeight: FontWeight.w600,
                            fontSize: 12.5,
                            color: primaryTextColor(context),
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
                      style: TextStyle(fontSize: 10.5, color: secondaryTextColor(context)),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      item.patterns.join('\n'),
                      style: TextStyle(
                        fontSize: 11,
                        fontFamily: 'monospace',
                        color: primaryTextColor(context),
                      ),
                    ),
                  ],
                  const SizedBox(height: 8),
                  AnimatedSwitcher(
                    duration: MediaQuery.of(context).disableAnimations
                        ? Duration.zero
                        : const Duration(milliseconds: 220),
                    child: item.resolvedDecision != null
                        ? KeyedSubtree(
                            key: ValueKey('resolved-${item.permissionId}-${item.resolvedDecision}'),
                            child: Row(
                              children: [
                                Icon(
                                  item.resolvedDecision == 'reject'
                                      ? LucideIcons.circleX
                                      : item.resolvedDecision == 'unknown'
                                          ? LucideIcons.circleHelp
                                          : LucideIcons.circleCheck,
                                  size: 15,
                                  color: item.resolvedDecision == 'reject'
                                      ? dangerTextColor(context)
                                      : item.resolvedDecision == 'unknown'
                                          ? secondaryTextColor(context)
                                          : _weTypeGreen,
                                ),
                                const SizedBox(width: 6),
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
                                        ? dangerTextColor(context)
                                        : item.resolvedDecision == 'unknown'
                                            ? secondaryTextColor(context)
                                            : _weTypeGreen,
                                  ),
                                ),
                              ],
                            ),
                          )
                        : item.resolutionUncertain
                            ? KeyedSubtree(
                                key: ValueKey('uncertain-${item.permissionId}'),
                                child: Text(
                                  widget.client.strings.permUncertainNote,
                                  key: Key('perm-uncertain-${item.permissionId}'),
                                  style: TextStyle(
                                    fontSize: 12,
                                    fontWeight: FontWeight.w500,
                                    color: warnTextColor(context),
                                  ),
                                ),
                              )
                            : KeyedSubtree(
                                key: ValueKey('pending-${item.permissionId}-${item.replyPending}'),
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.stretch,
                                  children: [
                                    Row(
                                      children: [
                                        // 拒绝：独立视觉分区（灰/红描边），与批准区拉开距离防误触
                                        SizedBox(
                                          height: 44,
                                          child: OutlinedButton(
                                            key: Key('btn-perm-reject-${item.permissionId}'),
                                            style: OutlinedButton.styleFrom(
                                              foregroundColor: dangerTextColor(context),
                                              side: BorderSide(color: Color(0xFFF0B7B7)),
                                              padding: const EdgeInsets.symmetric(horizontal: 14),
                                              shape: RoundedRectangleBorder(
                                                borderRadius: BorderRadius.circular(10),
                                              ),
                                            ),
                                            onPressed: item.replyPending
                                                ? null
                                                : () => _handlePermissionDecision(item, 'reject'),
                                            child: Text(
                                              widget.client.strings.rejectBtn,
                                              style: TextStyle(fontSize: 12),
                                            ),
                                          ),
                                        ),
                                        const Spacer(),
                                        SizedBox(
                                          height: 44,
                                          child: FilledButton.tonal(
                                            key: Key('btn-perm-allow-once-${item.permissionId}'),
                                            style: FilledButton.styleFrom(
                                              padding: const EdgeInsets.symmetric(horizontal: 12),
                                              shape: RoundedRectangleBorder(
                                                borderRadius: BorderRadius.circular(10),
                                              ),
                                            ),
                                            onPressed: item.replyPending
                                                ? null
                                                : () {
                                                    HapticFeedback.lightImpact(); // 7.3：批准触感
                                                    _handlePermissionDecision(item, 'allow_once');
                                                  },
                                            child: Text(
                                              widget.client.strings.allowOnceBtn,
                                              style: TextStyle(fontSize: 12),
                                            ),
                                          ),
                                        ),
                                        const SizedBox(width: 8),
                                        SizedBox(
                                          height: 44,
                                          child: FilledButton(
                                            key: Key('btn-perm-allow-always-${item.permissionId}'),
                                            style: FilledButton.styleFrom(
                                              backgroundColor: _weTypeGreen,
                                              padding: const EdgeInsets.symmetric(horizontal: 12),
                                              shape: RoundedRectangleBorder(
                                                borderRadius: BorderRadius.circular(10),
                                              ),
                                            ),
                                            onPressed: item.replyPending
                                                ? null
                                                : () => _handlePermissionDecision(item, 'allow_always'),
                                            child: Text(
                                              widget.client.strings.allowAlwaysBtn,
                                              style: TextStyle(fontSize: 12),
                                            ),
                                          ),
                                        ),
                                      ],
                                    ),
                                    if (DateTime.now().difference(item.waitingSince).inMinutes >= 2)
                                      Padding(
                                        padding: const EdgeInsets.only(top: 6),
                                        child: Text(
                                          widget.client.strings.permWaitingLong,
                                          key: Key('perm-waiting-${item.permissionId}'),
                                          style: TextStyle(
                                            fontSize: 10.5,
                                            color: warnTextColor(context),
                                          ),
                                        ),
                                      ),
                                  ],
                                ),
                              ),
                  ),
                ],
              ),
            );
            }),

          // File Diff Card
          // 6.3：改动摘要卡——「本轮改动 N 文件 +X/-Y」→ 点开文件列表 → diff
          ChangeSummaryCardItem() => Container(
              key: Key('change-summary-${item.diffId}'),
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
              decoration: BoxDecoration(
                color: cardBgColor(context),
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: subtleBorderColor(context)),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  InkWell(
                    key: const Key('change-summary-header'),
                    onTap: () => setState(() => item.expanded = !item.expanded),
                    borderRadius: BorderRadius.circular(8),
                    child: Row(
                      children: [
                        Icon(
                          LucideIcons.fileDiff,
                          size: 14.5,
                          color: Color(0xFF2563EB),
                        ),
                        const SizedBox(width: 7),
                        Text(
                          widget.client.strings.changeSummaryLabel,
                          style: TextStyle(
                            fontWeight: FontWeight.w600,
                            fontSize: 12,
                            color: primaryTextColor(context),
                          ),
                        ),
                        const SizedBox(width: 7),
                        Text(
                          item.files.isEmpty
                              ? widget.client.strings.changeNoChanges
                              : widget.client.strings.changeFilesCount(item.files.length),
                          style: TextStyle(fontSize: 11, color: secondaryTextColor(context)),
                        ),
                        const Spacer(),
                        if (item.files.isNotEmpty)
                          Text(
                            '+${item.totalAdditions} / -${item.totalDeletions}',
                            style: TextStyle(
                              fontSize: 11.5,
                              fontFamily: 'monospace',
                              fontWeight: FontWeight.w600,
                              color: _weTypeGreen,
                            ),
                          ),
                        const SizedBox(width: 4),
                        Icon(
                          item.expanded ? LucideIcons.chevronUp : LucideIcons.chevronDown,
                          size: 13,
                          color: secondaryTextColor(context),
                        ),
                      ],
                    ),
                  ),
                  if (item.expanded && item.files.isNotEmpty) ...[
                    const SizedBox(height: 6),
                    for (final f in item.files) ...[
                      InkWell(
                        key: Key('change-file-${f.file}'),
                        onTap: () => setState(() {
                          item.expandedFile = item.expandedFile == f.file ? null : f.file;
                        }),
                        borderRadius: BorderRadius.circular(8),
                        child: Padding(
                          padding: const EdgeInsets.symmetric(vertical: 5, horizontal: 2),
                          child: Row(
                            children: [
                              Expanded(
                                child: Text(
                                  f.file,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: TextStyle(
                                    fontSize: 11.5,
                                    fontFamily: 'monospace',
                                    color: primaryTextColor(context),
                                  ),
                                ),
                              ),
                              Text(
                                '+${f.additions} / -${f.deletions}',
                                style: TextStyle(
                                  fontSize: 11,
                                  fontFamily: 'monospace',
                                  color: secondaryTextColor(context),
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                      if (item.expandedFile == f.file) ...[
                        const SizedBox(height: 4),
                        // 6.3 Round3：显式 format 契约优先（unified_patch→着色；content→单/双栏），
                        // 旧服务端无 format 才回退启发式（不再凭 before 空就断言 patch）
                        ...() {
                          final isPatch = f.format == 'unified_patch' ||
                              (f.format == null && _looksLikePatch(f.after));
                          if (isPatch) {
                            return [ _buildPatchView(widget.client.strings.changePatchLabel, f.after) ];
                          }
                          // content：新增=After 单栏；删除=Before 单栏；修改=双栏
                          final widgets = <Widget>[];
                          if (f.before.isNotEmpty && f.after.isNotEmpty) {
                            widgets.add(_buildDiffSection(widget.client.strings.changeBeforeLabel, f.before, false));
                            widgets.add(const SizedBox(height: 6));
                            widgets.add(_buildDiffSection(widget.client.strings.changeAfterLabel, f.after, true));
                          } else if (f.after.isNotEmpty) {
                            widgets.add(_buildDiffSection(widget.client.strings.changeAfterLabel, f.after, true));
                          } else {
                            widgets.add(_buildDiffSection(widget.client.strings.changeBeforeLabel, f.before, false));
                          }
                          return widgets;
                        }(),
                        const SizedBox(height: 6),
                      ],
                    ],
                  ],
                ],
              ),
            ),

          FileDiffCardItem() => Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
              decoration: BoxDecoration(
                color: cardBgColor(context),
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: subtleBorderColor(context)),
              ),
              child: Row(
                children: [
                  Icon(
                    LucideIcons.fileDiff,
                    size: 14.5,
                    color: Color(0xFF2563EB),
                  ),
                  const SizedBox(width: 7),
                  Expanded(
                    child: Text(
                      item.file,
                      style: TextStyle(
                        fontWeight: FontWeight.w600,
                        fontSize: 12,
                        fontFamily: 'monospace',
                        color: primaryTextColor(context),
                      ),
                    ),
                  ),
                  Text(
                    '+${item.additions} / -${item.deletions}',
                    style: TextStyle(
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
                color: cardBgColor(context),
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: subtleBorderColor(context)),
              ),
              child: Row(
                children: [
                  Icon(
                    LucideIcons.monitor,
                    size: 14.5,
                    color: Color(0xFF2563EB),
                  ),
                  const SizedBox(width: 7),
                  Expanded(
                    child: Text(
                      '${widget.client.strings.screenCaptureLabel} (${item.displayId})',
                      style: TextStyle(
                        fontWeight: FontWeight.w600,
                        fontSize: 12,
                        color: primaryTextColor(context),
                      ),
                    ),
                  ),
                  Text(
                    '${item.width}x${item.height}',
                    style: TextStyle(
                      fontSize: 11,
                      fontFamily: 'monospace',
                      color: secondaryTextColor(context),
                    ),
                  ),
                ],
              ),
            ),

          // Token & Cost Usage Summary Card
          UsageSummaryItem() => Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              decoration: BoxDecoration(
                color: cardBgColor(context),
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: subtleBorderColor(context)),
              ),
              child: Row(
                children: [
                  Icon(LucideIcons.activity, size: 13.5, color: _weTypeGreen),
                  const SizedBox(width: 7),
                  Text(
                    widget.client.strings.usageCardLabel,
                    style: TextStyle(
                      fontSize: 11.5,
                      fontWeight: FontWeight.w600,
                      color: secondaryTextColor(context),
                    ),
                  ),
                  const Spacer(),
                  // 7.5：本轮 tokens/费用三格展示
                  Text(
                    '${widget.client.strings.usageInput} ${item.inputTokens}',
                    style: TextStyle(fontSize: 10.5, fontFamily: 'monospace', color: secondaryTextColor(context)),
                  ),
                  const SizedBox(width: 8),
                  Text(
                    '${widget.client.strings.usageOutput} ${item.outputTokens}',
                    style: TextStyle(fontSize: 10.5, fontFamily: 'monospace', color: secondaryTextColor(context)),
                  ),
                  const SizedBox(width: 8),
                  Text(
                    '${widget.client.strings.usageCost} \$${item.costUsd.toStringAsFixed(4)}',
                    style: TextStyle(
                      fontSize: 10.5,
                      fontFamily: 'monospace',
                      fontWeight: FontWeight.w600,
                      color: _weTypeGreen,
                    ),
                  ),
                ],
              ),
            ),
        };
      },
    ),
        // 5.2：翻历史时新回复浮出「↓ 有新回复」，不强制跳底
        Positioned(
          right: 16,
          bottom: 12,
          child: Offstage(
            offstage: !_showJumpToBottom,
            child: AnimatedSlide(
            duration: const Duration(milliseconds: 180),
            offset: _showJumpToBottom ? Offset.zero : const Offset(0, 1.2),
            child: AnimatedOpacity(
              duration: const Duration(milliseconds: 180),
              opacity: _showJumpToBottom ? 1 : 0,
              child: IgnorePointer(
                ignoring: !_showJumpToBottom,
                child: FilledButton.tonalIcon(
                  key: const Key('btn-jump-to-latest'),
                  onPressed: _jumpToBottom,
                  icon: Icon(LucideIcons.arrowDown, size: 14),
                  label: Text(
                    widget.client.strings.newRepliesBelow,
                    style: TextStyle(fontSize: 12),
                  ),
                  style: FilledButton.styleFrom(
                    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(999),
                    ),
                  ),
                ),
              ),
            ),
            ),
          ),
        ),
      ],
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
    final color = filled ? Colors.white : warnTextColor(context); // 白字配 warnBtnBg
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(8),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
        decoration: BoxDecoration(
          color: filled ? warnBtnBgColor(context) : Colors.transparent,
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
