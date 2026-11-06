import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../i18n/app_strings.dart';
import '../state/mobile_bridge_client.dart';
import 'agent_brand_logo.dart';
import 'pairing_panel.dart';
import 'timeline_card_list.dart';

class NienieMobileApp extends StatefulWidget {
  final MobileBridgeClient client;

  const NienieMobileApp({super.key, required this.client});

  @override
  State<NienieMobileApp> createState() => _NienieMobileAppState();
}

class _NienieMobileAppState extends State<NienieMobileApp> {
  final TextEditingController _wsUrlController =
      TextEditingController(text: 'ws://127.0.0.1:4100');
  final TextEditingController _pairingCodeController = TextEditingController();
  final TextEditingController _qrUriController = TextEditingController();
  final TextEditingController _promptController = TextEditingController();

  static const Color _weTypeGreen = Color(0xFF17B378);
  static const Color _canvasBg = Color(0xFFF1F2F5);
  static const Color _textPrimary = Color(0xFF141416);
  static const Color _textSecondary = Color(0xFF6E7178);
  static const Color _borderSubtle = Color(0x14000000);

  static const String _nienieBrandMarkSvg = '''
<svg viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect width="50" height="50" rx="13" fill="#17B378"/>
  <path d="M17 33V17L33 33V17" stroke="#FFFFFF" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>
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

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Nienie Mobile',
      debugShowCheckedModeBanner: false,
      theme: ThemeData.light(useMaterial3: true).copyWith(
        scaffoldBackgroundColor: _canvasBg,
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
          return Scaffold(
            appBar: AppBar(
              toolbarHeight: 48,
              backgroundColor: Colors.white,
              foregroundColor: _textPrimary,
              elevation: 0,
              scrolledUnderElevation: 0,
              shape: const Border(
                bottom: BorderSide(color: _borderSubtle, width: 1),
              ),
              titleSpacing: 14,
              title: Row(
                children: [
                  SizedBox(
                    width: 24,
                    height: 24,
                    child: SvgPicture.string(_nienieBrandMarkSvg),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      client.strings.appTitle,
                      style: const TextStyle(
                        fontSize: 15.5,
                        fontWeight: FontWeight.w600,
                        letterSpacing: -0.2,
                        color: _textPrimary,
                      ),
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  PopupMenuButton<AppLanguage>(
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
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                      decoration: BoxDecoration(
                        color: const Color(0xFFF6F7F9),
                        borderRadius: BorderRadius.circular(7),
                        border: Border.all(color: _borderSubtle),
                      ),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          const Icon(LucideIcons.globe, size: 13, color: _textSecondary),
                          const SizedBox(width: 4),
                          Text(
                            client.strings.langShortLabel,
                            style: const TextStyle(
                              fontSize: 11.5,
                              fontWeight: FontWeight.w500,
                              color: _textPrimary,
                            ),
                          ),
                          const SizedBox(width: 2),
                          const Icon(LucideIcons.chevronDown, size: 12, color: _textSecondary),
                        ],
                      ),
                    ),
                  ),
                  const SizedBox(width: 6),
                  _buildConnectionBadge(client),
                  if (client.connectionState == BridgeConnectionState.connected) ...[
                    const SizedBox(width: 4),
                    IconButton(
                      key: const Key('btn-disconnect'),
                      visualDensity: VisualDensity.compact,
                      tooltip: 'Disconnect',
                      onPressed: client.disconnect,
                      icon: const Icon(LucideIcons.unplug, size: 16, color: _textSecondary),
                    ),
                  ],
                ],
              ),
            ),
            body: SafeArea(
              child: client.connectionState != BridgeConnectionState.connected
                  ? PairingPanel(
                      client: client,
                      wsUrlController: _wsUrlController,
                      pairingCodeController: _pairingCodeController,
                      qrUriController: _qrUriController,
                    )
                  : _buildConnectedWorkspace(client),
            ),
          );
        },
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
            style: TextStyle(color: color, fontSize: 11, fontWeight: FontWeight.w600),
          ),
        ],
      ),
    );
  }

  Widget _buildConnectedWorkspace(MobileBridgeClient client) {
    final active = client.activeSession;
    return Column(
      children: [
        // Modern Agent + Model + Session Selector Bar
        Container(
          color: Colors.white,
          padding: const EdgeInsets.fromLTRB(10, 6, 10, 8),
          child: Column(
            children: [
              SizedBox(
                height: 36,
                child: Row(
                  children: [
                    Expanded(
                      child: ListView.separated(
                        scrollDirection: Axis.horizontal,
                        itemCount: client.agents.length,
                        separatorBuilder: (_, __) => const SizedBox(width: 6),
                        itemBuilder: (context, index) {
                          final agent = client.agents[index];
                          return ActionChip(
                            key: Key('chip-agent-${agent.id}'),
                            visualDensity: VisualDensity.compact,
                            backgroundColor: const Color(0xFFF8F9FA),
                            side: const BorderSide(color: _borderSubtle),
                            shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(8),
                            ),
                            avatar: AgentBrandLogo(agentId: agent.id, size: 14),
                            label: Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                Text(
                                  agent.name,
                                  style: const TextStyle(
                                    fontSize: 12,
                                    fontWeight: FontWeight.w500,
                                    color: _textPrimary,
                                  ),
                                ),
                                const SizedBox(width: 5),
                                Container(
                                  width: 6,
                                  height: 6,
                                  decoration: BoxDecoration(
                                    color: agent.available
                                        ? _weTypeGreen
                                        : const Color(0xFFC4C7CE),
                                    shape: BoxShape.circle,
                                  ),
                                ),
                              ],
                            ),
                            onPressed: () => client.loadModels(agent.id),
                          );
                        },
                      ),
                    ),
                    const SizedBox(width: 6),
                    SizedBox(
                      width: 32,
                      height: 32,
                      child: IconButton.filled(
                        key: const Key('btn-new-session'),
                        padding: EdgeInsets.zero,
                        tooltip: 'New Session',
                        style: IconButton.styleFrom(
                          backgroundColor: _weTypeGreen,
                          foregroundColor: Colors.white,
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(8),
                          ),
                        ),
                        onPressed: () {
                          final defaultAgent = client.agents
                                  .where((a) => a.available)
                                  .firstOrNull
                                  ?.id ??
                              'opencode';
                          client.createSession(
                            agentId: defaultAgent,
                            title: 'Mobile Session',
                          );
                        },
                        icon: const Icon(LucideIcons.plus, size: 16),
                      ),
                    ),
                  ],
                ),
              ),
              if (client.models.isNotEmpty) ...[
                const SizedBox(height: 4),
                SizedBox(
                  height: 32,
                  child: ListView.separated(
                    scrollDirection: Axis.horizontal,
                    itemCount: client.models.length,
                    separatorBuilder: (_, __) => const SizedBox(width: 6),
                    itemBuilder: (context, index) {
                      final model = client.models[index];
                      return ChoiceChip(
                        key: Key('chip-model-${model.id}'),
                        visualDensity: VisualDensity.compact,
                        label: Text(model.name, style: const TextStyle(fontSize: 11)),
                        selected: client.selectedModelId == model.id,
                        onSelected: (_) => client.selectModel(model.id),
                      );
                    },
                  ),
                ),
              ],
              if (client.sessions.isNotEmpty) ...[
                const SizedBox(height: 6),
                SizedBox(
                  height: 44,
                  child: ListView.builder(
                    scrollDirection: Axis.horizontal,
                    itemCount: client.sessions.length,
                    itemBuilder: (context, index) {
                      final session = client.sessions[index];
                      final isSelected = active?.id == session.id;
                      return Padding(
                        padding: const EdgeInsets.only(right: 6),
                        child: InkWell(
                          borderRadius: BorderRadius.circular(9),
                          onTap: () => client.openSession(session),
                          child: Container(
                            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
                            decoration: BoxDecoration(
                              color: isSelected
                                  ? _weTypeGreen.withValues(alpha: 0.1)
                                  : const Color(0xFFF8F9FA),
                              border: Border.all(
                                color: isSelected ? _weTypeGreen : _borderSubtle,
                              ),
                              borderRadius: BorderRadius.circular(9),
                            ),
                            child: Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                AgentBrandLogo(agentId: session.agentId, size: 13),
                                const SizedBox(width: 7),
                                Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  mainAxisAlignment: MainAxisAlignment.center,
                                  children: [
                                    Text(
                                      session.title,
                                      style: TextStyle(
                                        fontSize: 12,
                                        fontWeight: FontWeight.w600,
                                        color: isSelected ? _weTypeGreen : _textPrimary,
                                      ),
                                    ),
                                    Text(
                                      session.projectPath,
                                      style: const TextStyle(
                                        fontSize: 10,
                                        color: _textSecondary,
                                      ),
                                    ),
                                  ],
                                ),
                              ],
                            ),
                          ),
                        ),
                      );
                    },
                  ),
                ),
              ],
            ],
          ),
        ),
        const Divider(height: 1, color: _borderSubtle),
        // Active session detail timeline
        Expanded(
          child: active == null
              ? Center(
                  child: Text(
                    client.strings.selectSessionHint,
                    style: const TextStyle(color: _textSecondary, fontSize: 13),
                  ),
                )
              : SessionTimelineList(client: client, session: active),
        ),
        // Modern Bottom Composer Bar
        if (active != null)
          Container(
            decoration: const BoxDecoration(
              color: Colors.white,
              border: Border(top: BorderSide(color: _borderSubtle)),
            ),
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 7),
            child: Row(
              children: [
                IconButton(
                  key: const Key('btn-load-diffs'),
                  visualDensity: VisualDensity.compact,
                  tooltip: 'Load Session Diffs',
                  onPressed: () => client.loadSessionDiffs(active.id),
                  icon: const Icon(LucideIcons.fileDiff, size: 18, color: _textSecondary),
                ),
                IconButton(
                  key: const Key('btn-capture-screen'),
                  visualDensity: VisualDensity.compact,
                  tooltip: 'Capture Desktop Screen',
                  onPressed: () => client.captureScreen('main'),
                  icon: const Icon(LucideIcons.monitor, size: 18, color: _textSecondary),
                ),
                IconButton(
                  key: const Key('btn-cancel-session'),
                  visualDensity: VisualDensity.compact,
                  tooltip: 'Cancel Session',
                  onPressed: client.cancelActiveSession,
                  icon: const Icon(LucideIcons.circleStop, size: 18, color: Color(0xFFEF4444)),
                ),
                Expanded(
                  child: Container(
                    decoration: BoxDecoration(
                      color: const Color(0xFFF5F6F8),
                      borderRadius: BorderRadius.circular(9),
                      border: Border.all(color: _borderSubtle),
                    ),
                    child: TextField(
                      key: const Key('input-session-prompt'),
                      controller: _promptController,
                      style: const TextStyle(fontSize: 13.5, color: _textPrimary),
                      decoration: InputDecoration(
                        hintText: client.strings.promptHint,
                        hintStyle: const TextStyle(fontSize: 13, color: _textSecondary),
                        border: InputBorder.none,
                        isDense: true,
                        contentPadding: const EdgeInsets.symmetric(
                          horizontal: 11,
                          vertical: 9,
                        ),
                      ),
                    ),
                  ),
                ),
                const SizedBox(width: 7),
                SizedBox(
                  height: 36,
                  width: 36,
                  child: IconButton.filled(
                    key: const Key('btn-send-prompt'),
                    padding: EdgeInsets.zero,
                    style: IconButton.styleFrom(
                      backgroundColor: _weTypeGreen,
                      foregroundColor: Colors.white,
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(9),
                      ),
                    ),
                    onPressed: () {
                      final text = _promptController.text;
                      _promptController.clear();
                      client.sendMessage(text);
                    },
                    icon: const Icon(LucideIcons.arrowUp, size: 17),
                  ),
                ),
              ],
            ),
          ),
      ],
    );
  }
}
