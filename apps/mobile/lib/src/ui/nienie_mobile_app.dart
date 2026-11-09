import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../i18n/app_strings.dart';
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
              child: !isConnected
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
    final state = client.connectionState;
    final s = client.strings;
    final label = switch (state) {
      BridgeConnectionState.connected => s.statusConnected,
      BridgeConnectionState.connecting => s.statusConnecting,
      BridgeConnectionState.error => s.statusError,
      BridgeConnectionState.disconnected => s.statusDisconnected,
    };
    final color = switch (state) {
      BridgeConnectionState.connected => _weTypeGreen,
      BridgeConnectionState.connecting => const Color(0xFFF59E0B),
      BridgeConnectionState.error => const Color(0xFFEF4444),
      BridgeConnectionState.disconnected => const Color(0xFF8E929B),
    };
    return Container(
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
            label,
            style: TextStyle(
              color: color,
              fontSize: 11,
              fontWeight: FontWeight.w600,
            ),
          ),
        ],
      ),
    );
  }

  String _currentModelName(MobileBridgeClient client) {
    if (client.models.isEmpty) return 'Model';
    final selected = client.models
        .where((m) => m.id == client.selectedModelId)
        .firstOrNull;
    return (selected ?? client.models.first).name;
  }

  void _showModelPicker(BuildContext context, MobileBridgeClient client) {
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: Colors.white,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (ctx) {
        return SafeArea(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Padding(
                padding: EdgeInsets.fromLTRB(16, 16, 16, 8),
                child: Text(
                  '选择模型',
                  style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
                ),
              ),
              for (final model in client.models)
                ListTile(
                  key: Key('model-option-${model.id}'),
                  leading: const Icon(LucideIcons.cpu, size: 18),
                  title: Text(model.name),
                  trailing: model.id == client.selectedModelId
                      ? const Icon(LucideIcons.check, size: 18, color: _weTypeGreen)
                      : null,
                  onTap: () {
                    client.selectModel(model.id);
                    Navigator.of(ctx).pop();
                  },
                ),
              const SizedBox(height: 8),
            ],
          ),
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
                  // Upper Deck: Full-width borderless input field
                  TextField(
                    key: const Key('input-session-prompt'),
                    controller: _promptController,
                    textInputAction: TextInputAction.send,
                    onSubmitted: (value) {
                      final text = value.trim();
                      if (text.isEmpty) return;
                      _promptController.clear();
                      client.sendMessage(text);
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

                  // Lower Deck: Agent Pills + Workspace Actions + Send Circle
                  SizedBox(
                    height: 32,
                    child: Row(
                      children: [
                        // Left scrollable Agent switcher pills + tools
                        Expanded(
                          child: SingleChildScrollView(
                            scrollDirection: Axis.horizontal,
                            child: Row(
                              children: [
                                // Model selector：显示当前模型，点击切换
                                // （agent 选择属于会话层，在会话头部/抽屉，不在此）
                                InkWell(
                                  key: const Key('btn-select-model'),
                                  borderRadius: BorderRadius.circular(999),
                                  onTap: () => _showModelPicker(context, client),
                                  child: Container(
                                    padding: const EdgeInsets.symmetric(
                                      horizontal: 10,
                                      vertical: 5,
                                    ),
                                    decoration: BoxDecoration(
                                      color: Colors.white,
                                      borderRadius: BorderRadius.circular(999),
                                      border: Border.all(
                                        color: const Color(0x18000000),
                                      ),
                                    ),
                                    child: Row(
                                      mainAxisSize: MainAxisSize.min,
                                      children: [
                                        const Icon(
                                          LucideIcons.cpu,
                                          size: 13,
                                          color: _textSecondary,
                                        ),
                                        const SizedBox(width: 5),
                                        Text(
                                          _currentModelName(client),
                                          style: const TextStyle(
                                            fontSize: 11.5,
                                            fontWeight: FontWeight.w600,
                                            color: _textPrimary,
                                          ),
                                        ),
                                        const SizedBox(width: 3),
                                        const Icon(
                                          LucideIcons.chevronDown,
                                          size: 12,
                                          color: _textSecondary,
                                        ),
                                      ],
                                    ),
                                  ),
                                ),
                                IconButton(
                                  key: const Key('btn-capture-screen'),
                                  visualDensity: VisualDensity.compact,
                                  padding: const EdgeInsets.symmetric(
                                    horizontal: 6,
                                  ),
                                  constraints: const BoxConstraints(),
                                  tooltip: 'Capture Desktop Screen',
                                  onPressed: () => client.captureScreen('main'),
                                  icon: const Icon(
                                    LucideIcons.monitor,
                                    size: 17,
                                    color: _textSecondary,
                                  ),
                                ),
                                IconButton(
                                  key: const Key('btn-cancel-session'),
                                  visualDensity: VisualDensity.compact,
                                  padding: const EdgeInsets.symmetric(
                                    horizontal: 6,
                                  ),
                                  constraints: const BoxConstraints(),
                                  tooltip: 'Cancel Session',
                                  onPressed: client.cancelActiveSession,
                                  icon: const Icon(
                                    LucideIcons.circleStop,
                                    size: 17,
                                    color: _textSecondary,
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ),

                        const SizedBox(width: 6),

                        // Circular Send Button (Kelivo R32 Circle)
                        SizedBox(
                          width: 32,
                          height: 32,
                          child: IconButton.filled(
                            key: const Key('btn-send-prompt'),
                            padding: EdgeInsets.zero,
                            style: IconButton.styleFrom(
                              backgroundColor: _textPrimary,
                              foregroundColor: Colors.white,
                              shape: const CircleBorder(),
                            ),
                            onPressed: () {
                              final text = _promptController.text;
                              _promptController.clear();
                              client.sendMessage(text);
                            },
                            icon: const Icon(LucideIcons.arrowUp, size: 16),
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
