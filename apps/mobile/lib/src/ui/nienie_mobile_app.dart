import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:file_picker/file_picker.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../i18n/app_strings.dart';
import '../models/protocol_models.dart';
import '../models/timeline_items.dart';
import '../state/mobile_bridge_client.dart';
import 'kelivo_workspace_drawer.dart';
import 'pairing_panel.dart';
import 'timeline_card_list.dart';

class NienieMobileApp extends StatefulWidget {
  final MobileBridgeClient client;

  const NienieMobileApp({super.key, required this.client});

  @override
  State<NienieMobileApp> createState() => _NienieMobileAppState();
}

class _NienieMobileAppState extends State<NienieMobileApp> {
  final GlobalKey<ScaffoldState> _scaffoldKey = GlobalKey<ScaffoldState>();
  final TextEditingController _wsUrlController =
      TextEditingController(text: 'ws://127.0.0.1:4100');
  final TextEditingController _pairingCodeController = TextEditingController();
  final TextEditingController _qrUriController = TextEditingController();
  final TextEditingController _promptController = TextEditingController();
  final List<_Attachment> _attachments = [];

  static const Color _weTypeGreen = Color(0xFF17B378);
  static const Color _textPrimary = Color(0xFF141416);
  static const Color _textSecondary = Color(0xFF686C75);
  static const Color _borderSubtle = Color(0x14000000);

  // Kelivo's exact 2-bar staggered menu icon (assets/icons/list.svg)
  static const String _kelivoMenuListSvg = '''
<svg width="20" height="16" viewBox="0 0 20 16" fill="#141416" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="2.4" width="20" height="2.2" rx="1.1" />
  <rect x="0" y="11.4" width="13" height="2.2" rx="1.1" />
</svg>
''';

  @override
  void dispose() {
    _wsUrlController.dispose();
    _pairingCodeController.dispose();
    _qrUriController.dispose();
    _promptController.dispose();
    super.dispose();
  }

  void _openComputerSheet(BuildContext context, MobileBridgeClient client) {
    showMultiComputerSheet(
      context: context,
      client: client,
      wsUrlController: _wsUrlController,
      pairingCodeController: _pairingCodeController,
      qrUriController: _qrUriController,
    );
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Nienie Mobile',
      debugShowCheckedModeBanner: false,
      theme: ThemeData.light(useMaterial3: true).copyWith(
        scaffoldBackgroundColor: Colors.white,
        cardColor: Colors.white,
        // 水波纹而非 Material3 sparkle：产品更克制，也避免依赖 shader 资源（部分环境测试/低端 GPU 不可用）
        splashFactory: InkRipple.splashFactory,
        colorScheme: ColorScheme.fromSeed(
          seedColor: _weTypeGreen,
          primary: _weTypeGreen,
        ),
      ),
      home: AnimatedBuilder(
        animation: widget.client,
        builder: (context, _) {
          final client = widget.client;
          final isConnected =
              client.connectionState == BridgeConnectionState.connected;

          return Scaffold(
            key: _scaffoldKey,
            backgroundColor:
                isConnected ? Colors.white : const Color(0xFFF3F4F6),
            drawer: isConnected
                ? KelivoWorkspaceDrawer(
                    client: client,
                    onCloseDrawer: () =>
                        _scaffoldKey.currentState?.closeDrawer(),
                    onOpenComputerSheet: () =>
                        _openComputerSheet(context, client),
                  )
                : null,
            appBar: isConnected
                ? _buildKelivoConnectedAppBar(context, client)
                : _buildDisconnectedAppBar(context, client),
            body: SafeArea(
              // 重连中保留会话视图（非静默上下文），横幅提示补发；完全断开才回配对页
              child: !(isConnected ||
                      client.connectionState == BridgeConnectionState.reconnecting)
                  ? PairingPanel(
                      client: client,
                      wsUrlController: _wsUrlController,
                      pairingCodeController: _pairingCodeController,
                      qrUriController: _qrUriController,
                    )
                  : _buildKelivoConnectedBody(context, client),
            ),
          );
        },
      ),
    );
  }

  PreferredSizeWidget _buildDisconnectedAppBar(
    BuildContext context,
    MobileBridgeClient client,
  ) {
    return AppBar(
      toolbarHeight: 50,
      backgroundColor: Colors.white,
      foregroundColor: _textPrimary,
      elevation: 0,
      scrolledUnderElevation: 0,
      titleSpacing: 16,
      title: Row(
        children: [
          SizedBox(
            width: 24,
            height: 24,
            child: ClipRRect(
              borderRadius: BorderRadius.circular(6),
              child: Image.asset(
                'assets/brand/nienie-logo.png',
                width: 24,
                height: 24,
                fit: BoxFit.cover,
              ),
            ),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              client.strings.appTitle,
              style: const TextStyle(
                fontSize: 16,
                fontWeight: FontWeight.w600,
                letterSpacing: -0.2,
                color: _textPrimary,
              ),
              overflow: TextOverflow.ellipsis,
            ),
          ),
          _buildLanguageButton(client),
          const SizedBox(width: 6),
          _buildConnectionBadge(client),
        ],
      ),
    );
  }

  // Kelivo 1:1 Minimalist Two-Line AppBar
  PreferredSizeWidget _buildKelivoConnectedAppBar(
    BuildContext context,
    MobileBridgeClient client,
  ) {
    final active = client.activeSession;
    final folderName = active != null && active.projectPath.trim().isNotEmpty
        ? active.projectPath
            .split(RegExp(r'[/\\]'))
            .where((s) => s.isNotEmpty)
            .lastOrNull ??
            active.projectPath
        : 'workspace';
    final agentName = client.agents
            .where((a) => a.id == (active?.agentId ?? client.selectedAgentId))
            .firstOrNull
            ?.name ??
        (active?.agentId ?? client.selectedAgentId);
    final machineName = client.activeMachineId ?? 'MacBook-Pro-M5';

    return AppBar(
      toolbarHeight: 54,
      backgroundColor: Colors.white,
      surfaceTintColor: Colors.white,
      foregroundColor: _textPrimary,
      elevation: 0,
      scrolledUnderElevation: 0,
      leadingWidth: 46,
      leading: IconButton(
        key: const Key('btn-open-drawer'),
        tooltip: 'Open Workspace Drawer',
        onPressed: () => _scaffoldKey.currentState?.openDrawer(),
        icon: SvgPicture.string(_kelivoMenuListSvg, width: 18, height: 15),
      ),
      titleSpacing: 2,
      title: InkWell(
        borderRadius: BorderRadius.circular(8),
        onTap: () {
          if (active != null) {
            client.openSession(active);
          }
        },
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 2, horizontal: 2),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                active?.title ?? '新对话',
                style: const TextStyle(
                  fontSize: 15.5,
                  fontWeight: FontWeight.w600,
                  color: _textPrimary,
                  height: 1.2,
                ),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
              const SizedBox(height: 2),
              Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Flexible(
                    child: Text(
                      '$folderName · $agentName ($machineName)',
                      style: const TextStyle(
                        fontSize: 11,
                        fontWeight: FontWeight.w500,
                        color: _textSecondary,
                      ),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  const SizedBox(width: 6),
                  _StatusPill(client: client, sessionId: active?.id),
                  const SizedBox(width: 2),
                  const Icon(
                    LucideIcons.chevronDown,
                    size: 11,
                    color: _textSecondary,
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
      actions: [
        _buildLanguageButton(client),
        if (active != null)
          IconButton(
            key: const Key('btn-load-diffs'),
            visualDensity: VisualDensity.compact,
            tooltip: 'Load Session Diffs',
            onPressed: () => client.loadSessionDiffs(active.id),
            icon: const Icon(LucideIcons.map, size: 19, color: _textPrimary),
          ),
        IconButton(
          key: const Key('btn-new-session'),
          visualDensity: VisualDensity.compact,
          tooltip: 'New Session',
          onPressed: () {
            final defaultAgent = client.selectedAgentId.isNotEmpty
                ? client.selectedAgentId
                : (client.agents.where((a) => a.available).firstOrNull?.id ??
                    'opencode');
            client.createSession(
              agentId: defaultAgent,
              title: 'Mobile Session',
              projectPath: active?.projectPath,
            );
          },
          icon: const Icon(
            LucideIcons.messageCircleDashed,
            size: 20,
            color: _textPrimary,
          ),
        ),
        IconButton(
          key: const Key('btn-disconnect'),
          visualDensity: VisualDensity.compact,
          tooltip: 'Disconnect',
          onPressed: client.disconnect,
          icon: const Icon(LucideIcons.unplug, size: 17, color: _textSecondary),
        ),
        const SizedBox(width: 4),
      ],
    );
  }

  Widget _buildLanguageButton(MobileBridgeClient client) {
    return PopupMenuButton<AppLanguage>(
      key: const Key('btn-switch-language'),
      initialValue: client.language,
      onSelected: client.setLanguage,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: const BorderSide(color: _borderSubtle),
      ),
      color: Colors.white,
      elevation: 6,
      itemBuilder: (context) => const [
        PopupMenuItem(value: AppLanguage.zh, child: Text('中文 (简体)')),
        PopupMenuItem(value: AppLanguage.en, child: Text('English')),
        PopupMenuItem(value: AppLanguage.ja, child: Text('日本語')),
        PopupMenuItem(value: AppLanguage.ko, child: Text('한국어')),
      ],
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(LucideIcons.globe, size: 14, color: _textSecondary),
            const SizedBox(width: 3),
            Text(
              client.strings.langShortLabel,
              style: const TextStyle(
                fontSize: 11.5,
                fontWeight: FontWeight.w500,
                color: _textPrimary,
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildConnectionBadge(MobileBridgeClient client) {
    return _StatusPill(client: client);
  }

  /// 路线图 3.2：断线重连横幅（非静默，含补发语义）
  Widget _buildReconnectBanner(MobileBridgeClient client) {
    final s = client.strings;
    return Container(
      key: const Key('reconnect-banner'),
      width: double.infinity,
      margin: const EdgeInsets.fromLTRB(12, 6, 12, 0),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: const Color(0xFFFFF7ED),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: const Color(0xFFF59E0B).withValues(alpha: 0.4)),
      ),
      child: Row(
        children: [
          const Icon(LucideIcons.wifiOff, size: 15, color: Color(0xFFD97706)),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              '${s.reconnectBannerPrefix}${client.reconnectAttempt}${s.reconnectBannerSuffix}',
              style: const TextStyle(fontSize: 12, color: Color(0xFFB45309), height: 1.4),
            ),
          ),
        ],
      ),
    );
  }

  bool _isGenerating(MobileBridgeClient client) {
    final active = client.activeSession;
    if (active == null) return false;
    return client.statusFor(active.id) == 'running' ||
        client.timelineFor(active.id).any((i) => i is PendingResponseItem);
  }

  void _stopGeneration(MobileBridgeClient client) {
    client.cancelActiveSession();
    // 撤回：把最后一条用户消息从对话列表移除（真撤回），放回输入框供编辑重发
    final sessionId = client.activeSession?.id ?? '';
    final recalled = client.recallLastUserPrompt(sessionId);
    if (recalled != null) {
      _promptController.text = recalled;
    }
    setState(() {});
  }

  Future<void> _pickAttachment(FileType type) async {
    final result = await FilePicker.pickFiles(type: type, allowMultiple: true);
    if (result == null) return;
    setState(() {
      for (final f in result.files) {
        if (f.path != null) {
          _attachments.add(_Attachment(name: f.name, path: f.path!));
        }
      }
    });
  }

  void _showAttachMenu(BuildContext context, MobileBridgeClient client) {
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: Colors.white,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Padding(
              padding: EdgeInsets.fromLTRB(16, 16, 16, 8),
              child: Text('添加附件', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
            ),
            ListTile(
              key: const Key('btn-attach-image'),
              leading: const Icon(LucideIcons.image, size: 20),
              title: const Text('图片'),
              onTap: () {
                Navigator.of(ctx).pop();
                _pickAttachment(FileType.image);
              },
            ),
            ListTile(
              key: const Key('btn-attach-file'),
              leading: const Icon(LucideIcons.file, size: 20),
              title: const Text('文件'),
              onTap: () {
                Navigator.of(ctx).pop();
                _pickAttachment(FileType.any);
              },
            ),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
  }

  String _composeMessage(String text) {
    if (_attachments.isEmpty) return text;
    final names = _attachments.map((a) => a.name).join(', ');
    final note = '[附件: $names]';
    return text.trim().isEmpty ? note : '${text.trim()}\n$note';
  }

  bool _agentSupportsModelSwitch(MobileBridgeClient client) {
    final current = client.agents
        .where((a) => a.id == (client.activeSession?.agentId ?? client.selectedAgentId))
        .firstOrNull;
    return current?.modelSwitch ?? true;
  }

  String _currentModelName(MobileBridgeClient client) {
    if (client.models.isEmpty) return 'Model';
    final selected = client.models
        .where((m) => m.id == client.selectedModelId)
        .firstOrNull;
    return (selected ?? client.models.first).name;
  }

  void _showModelPicker(BuildContext context, MobileBridgeClient client) {
    String query = '';
    final collapsed = <String>{};
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: Colors.white,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (ctx) {
        return StatefulBuilder(
          builder: (ctx, setState) {
            final q = query.trim().toLowerCase();
            final filtered = client.models.where((m) {
              if (q.isEmpty) return true;
              return m.name.toLowerCase().contains(q) ||
                  m.id.toLowerCase().contains(q) ||
                  m.providerName.toLowerCase().contains(q) ||
                  m.providerId.toLowerCase().contains(q);
            }).toList();
            // 按 providerName 分组（保持出现顺序）
            final grouped = <String, List<ModelInfo>>{};
            for (final m in filtered) {
              grouped.putIfAbsent(m.providerName, () => []).add(m);
            }

            return SafeArea(
              child: ConstrainedBox(
                constraints: BoxConstraints(
                  maxHeight: MediaQuery.of(ctx).size.height * 0.62,
                ),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Padding(
                      padding: EdgeInsets.fromLTRB(16, 16, 16, 8),
                      child: Text(
                        '选择模型',
                        style: TextStyle(
                          fontSize: 16,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                    // 搜索框
                    Padding(
                      padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
                      child: TextField(
                        onChanged: (v) => setState(() => query = v),
                        style: const TextStyle(fontSize: 14),
                        decoration: InputDecoration(
                          hintText: '搜索模型',
                          hintStyle: const TextStyle(
                            fontSize: 14,
                            color: _textSecondary,
                          ),
                          prefixIcon: const Icon(
                            LucideIcons.search,
                            size: 18,
                            color: _textSecondary,
                          ),
                          isDense: true,
                          contentPadding: const EdgeInsets.symmetric(
                            horizontal: 12,
                            vertical: 10,
                          ),
                          filled: true,
                          fillColor: const Color(0xFFF3F4F6),
                          border: OutlineInputBorder(
                            borderRadius: BorderRadius.circular(12),
                            borderSide: BorderSide.none,
                          ),
                        ),
                      ),
                    ),
                    // 按 provider 分组的模型列表
                    Flexible(
                      child: filtered.isEmpty
                          ? const Padding(
                              padding: EdgeInsets.all(24),
                              child: Text(
                                '暂无可用模型',
                                style: TextStyle(
                                  fontSize: 13,
                                  color: _textSecondary,
                                ),
                              ),
                            )
                          : ListView(
                              shrinkWrap: true,
                              padding: const EdgeInsets.only(bottom: 8),
                              children: [
                                for (final entry in grouped.entries) ...[
                                  // Provider 分组头（可折叠）
                                  InkWell(
                                    onTap: () => setState(() {
                                      if (!collapsed.remove(entry.key)) {
                                        collapsed.add(entry.key);
                                      }
                                    }),
                                    child: Padding(
                                      padding: const EdgeInsets.fromLTRB(
                                        16,
                                        10,
                                        16,
                                        4,
                                      ),
                                      child: Row(
                                        children: [
                                          Expanded(
                                            child: Text(
                                              entry.key,
                                              style: const TextStyle(
                                                fontSize: 12,
                                                fontWeight: FontWeight.w600,
                                                color: _textSecondary,
                                              ),
                                            ),
                                          ),
                                          Icon(
                                            collapsed.contains(entry.key)
                                                ? LucideIcons.chevronDown
                                                : LucideIcons.chevronUp,
                                            size: 14,
                                            color: _textSecondary,
                                          ),
                                        ],
                                      ),
                                    ),
                                  ),
                                  if (!collapsed.contains(entry.key))
                                    for (final model in entry.value)
                                      ListTile(
                                        key: Key('model-option-${model.id}'),
                                        dense: true,
                                      contentPadding:
                                          const EdgeInsets.symmetric(
                                        horizontal: 16,
                                      ),
                                      title: Text(
                                        model.name,
                                        style: TextStyle(
                                          fontSize: 14,
                                          fontWeight:
                                              model.id == client.selectedModelId
                                                  ? FontWeight.w600
                                                  : FontWeight.w400,
                                          color:
                                              model.id == client.selectedModelId
                                                  ? _weTypeGreen
                                                  : _textPrimary,
                                        ),
                                      ),
                                      trailing:
                                          model.id == client.selectedModelId
                                              ? const Icon(
                                                  LucideIcons.check,
                                                  size: 18,
                                                  color: _weTypeGreen,
                                                )
                                              : null,
                                      onTap: () {
                                        client.selectModel(model.id);
                                        Navigator.of(ctx).pop();
                                      },
                                    ),
                                ],
                              ],
                            ),
                    ),
                    const SizedBox(height: 8),
                  ],
                ),
              ),
            );
          },
        );
      },
    );
  }

  Widget _buildKelivoConnectedBody(
    BuildContext context,
    MobileBridgeClient client,
  ) {
    final active = client.activeSession;

    return Column(
      children: [
        // 路线图 3.2：断线/重连横幅（非静默）
        if (client.connectionState == BridgeConnectionState.reconnecting ||
            client.connectionState == BridgeConnectionState.disconnected)
          _buildReconnectBanner(client),
        // Pure Kelivo Chat Canvas (100% clean white space when no messages yet)
        Expanded(
          child: active == null
              ? const SizedBox.shrink()
              : SessionTimelineList(client: client, session: active),
        ),

        // Kelivo 1:1 Floating Two-Deck Rounded Composer Capsule (R22, always visible)
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 4, 12, 10),
          child: Container(
              padding: const EdgeInsets.fromLTRB(14, 10, 10, 8),
              decoration: BoxDecoration(
                color: const Color(0xFFF3F4F6),
                borderRadius: BorderRadius.circular(22),
                border: Border.all(color: const Color(0x16000000), width: 0.8),
              ),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  // 附件预览 chips（已选待发送）
                  if (_attachments.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 6),
                      child: Wrap(
                        spacing: 6,
                        runSpacing: 6,
                        children: [
                          for (final a in _attachments)
                            Chip(
                              label: Text(a.name, style: const TextStyle(fontSize: 11)),
                              deleteIcon: const Icon(LucideIcons.x, size: 13),
                              onDeleted: () => setState(() => _attachments.remove(a)),
                            ),
                        ],
                      ),
                    ),
                  // Upper Deck: Full-width borderless input field
                  TextField(
                    key: const Key('input-session-prompt'),
                    controller: _promptController,
                    textInputAction: TextInputAction.send,
                    onSubmitted: (value) {
                      // R3-2：统一发送入口——确认客户端接受后才清空输入（断线/失败时保留输入不丢失）
                      final text = value.trim();
                      if (text.isEmpty && _attachments.isEmpty) return;
                      final msg = _composeMessage(text);
                      client.sendMessage(msg).then((accepted) {
                        if (accepted) {
                          _promptController.clear();
                          setState(() => _attachments.clear());
                        }
                      });
                    },
                    style: const TextStyle(
                      fontSize: 15,
                      color: _textPrimary,
                      height: 1.35,
                    ),
                    decoration: InputDecoration(
                      hintText: client.strings.promptHint,
                      hintStyle: TextStyle(
                        fontSize: 14.5,
                        color: _textPrimary.withValues(alpha: 0.42),
                      ),
                      border: InputBorder.none,
                      isDense: true,
                      contentPadding: const EdgeInsets.symmetric(vertical: 4),
                    ),
                  ),

                  const SizedBox(height: 8),

// Lower Deck: 附件 + 模型选择 | 发送/停止 切换按钮
                  SizedBox(
                    height: 32,
                    child: Row(
                      children: [
                        IconButton(
                          key: const Key('btn-attach'),
                          visualDensity: VisualDensity.compact,
                          padding: const EdgeInsets.symmetric(horizontal: 6),
                          constraints: const BoxConstraints(),
                          tooltip: '添加附件',
                          onPressed: () => _showAttachMenu(context, client),
                          icon: const Icon(LucideIcons.plus, size: 18, color: _textSecondary),
                        ),
                        if (_agentSupportsModelSwitch(client)) ...[
                          const SizedBox(width: 4),
                          InkWell(
                            key: const Key('btn-select-model'),
                            borderRadius: BorderRadius.circular(999),
                            onTap: () => _showModelPicker(context, client),
                            child: Container(
                              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
                              decoration: BoxDecoration(
                                color: Colors.white,
                                borderRadius: BorderRadius.circular(999),
                                border: Border.all(color: const Color(0x18000000)),
                              ),
                              child: Row(
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  const Icon(LucideIcons.cpu, size: 13, color: _textSecondary),
                                  const SizedBox(width: 5),
                                  Text(_currentModelName(client), style: const TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600, color: _textPrimary)),
                                  const SizedBox(width: 3),
                                  const Icon(LucideIcons.chevronDown, size: 12, color: _textSecondary),
                                ],
                              ),
                            ),
                          ),
                        ],
                        const Spacer(),
                        const SizedBox(width: 6),
                        SizedBox(
                          width: 32,
                          height: 32,
                          child: IconButton.filled(
                            key: const Key('btn-send-prompt'),
                            padding: EdgeInsets.zero,
                            style: IconButton.styleFrom(backgroundColor: _textPrimary, foregroundColor: Colors.white, shape: const CircleBorder()),
                            // 断线/重连期间禁用发送（补发语义：重连后自动同步会话消息，不谎称本地排队）
                            onPressed: client.connectionState == BridgeConnectionState.connected
                                ? () async {
                                    if (_isGenerating(client)) {
                                      _stopGeneration(client);
                                      return;
                                    }
                                    // R3-2：确认接受后才清空输入（点击瞬间状态变化也不丢消息）
                                    final text = _promptController.text;
                                    if (text.trim().isEmpty && _attachments.isEmpty) return;
                                    final msg = _composeMessage(text);
                                    final accepted = await client.sendMessage(msg);
                                    if (accepted) {
                                      _promptController.clear();
                                      setState(() => _attachments.clear());
                                    }
                                  }
                                : null,
                            icon: Icon(_isGenerating(client) ? LucideIcons.square : LucideIcons.arrowUp, size: 16),
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
      ],
    );
  }
}

class _Attachment {
  final String name;
  final String path;
  const _Attachment({required this.name, required this.path});
}

/// 路线图 3.1：顶栏状态胶囊——电脑在线/离线/重连中(第 N 次) + Agent 思考中(计时)/运行工具/等待审批/空闲
class _StatusPill extends StatefulWidget {
  const _StatusPill({required this.client, this.sessionId});
  final MobileBridgeClient client;
  final String? sessionId;

  @override
  State<_StatusPill> createState() => _StatusPillState();
}

class _StatusPillState extends State<_StatusPill> {
  Timer? _ticker;

  @override
  void initState() {
    super.initState();
    _ticker = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _ticker?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final client = widget.client;
    final s = client.strings;
    final state = client.connectionState;
    final (String label, Color color) = switch (state) {
      BridgeConnectionState.connected => (s.statusConnected, const Color(0xFF17B378)),
      BridgeConnectionState.connecting => (s.statusConnecting, const Color(0xFFF59E0B)),
      BridgeConnectionState.reconnecting =>
        ('${s.statusReconnecting}（${client.reconnectAttempt}）', const Color(0xFFF59E0B)),
      BridgeConnectionState.error => (s.statusError, const Color(0xFFEF4444)),
      BridgeConnectionState.disconnected => (s.statusDisconnected, const Color(0xFF8E929B)),
    };
    String activity = '';
    if (state == BridgeConnectionState.connected && widget.sessionId != null) {
      final sessionId = widget.sessionId!;
      final sessionStatus = client.statusFor(sessionId);
      final hasRunningTool = client
          .timelineFor(sessionId)
          .whereType<ToolCallCardItem>()
          .any((t) => t.status == ToolCallStatus.pending || t.status == ToolCallStatus.running);
      if (sessionStatus == 'waiting') {
        activity = s.agentWaitingApproval;
      } else if (hasRunningTool) {
        activity = s.agentToolRunning;
      } else if (sessionStatus == 'running') {
        final since = client.runningSinceFor(sessionId);
        final elapsed = since == null ? 0 : DateTime.now().difference(since).inSeconds;
        activity = '${s.agentThinking} ${elapsed}s';
      } else {
        activity = s.agentIdle;
      }
    }
    return Container(
      key: const Key('status-pill'),
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 6,
            height: 6,
            decoration: BoxDecoration(color: color, shape: BoxShape.circle),
          ),
          const SizedBox(width: 5),
          Text(
            activity.isEmpty ? label : '$label · $activity',
            style: TextStyle(
              fontSize: 10.5,
              fontWeight: FontWeight.w600,
              color: color,
            ),
          ),
        ],
      ),
    );
  }
}
