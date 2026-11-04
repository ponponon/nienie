import 'package:flutter/material.dart';
import '../i18n/app_strings.dart';
import '../state/mobile_bridge_client.dart';
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
        scaffoldBackgroundColor: const Color(0xFFEDEDED),
        cardColor: const Color(0xFFFFFFFF),
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xFF07C160),
          primary: const Color(0xFF07C160),
        ),
      ),
      home: AnimatedBuilder(
        animation: widget.client,
        builder: (context, _) {
          final client = widget.client;
          return Scaffold(
            appBar: AppBar(
              toolbarHeight: 44,
              backgroundColor: const Color(0xFFF7F7F7),
              foregroundColor: const Color(0xFF181818),
              elevation: 0,
              titleSpacing: 12,
              title: Row(
                children: [
                  const Icon(Icons.chat_bubble_rounded, size: 18, color: Color(0xFF07C160)),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      client.strings.appTitle,
                      style: const TextStyle(
                        fontSize: 15,
                        fontWeight: FontWeight.w600,
                        color: Color(0xFF181818),
                      ),
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  PopupMenuButton<AppLanguage>(
                    key: const Key('btn-switch-language'),
                    initialValue: client.language,
                    onSelected: client.setLanguage,
                    itemBuilder: (context) => const [
                      PopupMenuItem(value: AppLanguage.zh, child: Text('中文')),
                      PopupMenuItem(value: AppLanguage.en, child: Text('English')),
                      PopupMenuItem(value: AppLanguage.ja, child: Text('日本語')),
                      PopupMenuItem(value: AppLanguage.ko, child: Text('한국어')),
                    ],
                    child: Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
                      child: Row(
                        children: [
                          const Icon(Icons.language, size: 15, color: Color(0xFF181818)),
                          const SizedBox(width: 3),
                          Text(
                            client.strings.langShortLabel,
                            style: const TextStyle(fontSize: 12, color: Color(0xFF181818)),
                          ),
                        ],
                      ),
                    ),
                  ),
                  const SizedBox(width: 4),
                  _buildConnectionBadge(client),
                  if (client.connectionState == BridgeConnectionState.connected) ...[
                    const SizedBox(width: 4),
                    IconButton(
                      key: const Key('btn-disconnect'),
                      visualDensity: VisualDensity.compact,
                      tooltip: 'Disconnect',
                      onPressed: client.disconnect,
                      icon: const Icon(Icons.link_off, size: 17, color: Color(0xFF8E8E93)),
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
      BridgeConnectionState.connected => const Color(0xFF07C160),
      BridgeConnectionState.connecting => const Color(0xFFFF9500),
      BridgeConnectionState.error => const Color(0xFFFA5151),
      BridgeConnectionState.disconnected => const Color(0xFF8E8E93),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.14),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        label,
        style: TextStyle(color: color, fontSize: 11, fontWeight: FontWeight.w600),
      ),
    );
  }

  Widget _buildConnectedWorkspace(MobileBridgeClient client) {
    final active = client.activeSession;
    return Column(
      children: [
        // Compact Top Agent + Session Header Bar
        Container(
          color: const Color(0xFFF7F7F7),
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
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
                            backgroundColor: const Color(0xFFFFFFFF),
                            avatar: Icon(
                              agent.available
                                  ? Icons.check_circle
                                  : Icons.remove_circle_outline,
                              size: 14,
                              color: agent.available
                                  ? const Color(0xFF07C160)
                                  : const Color(0xFF8E8E93),
                            ),
                            label: Text(
                              agent.name,
                              style: const TextStyle(fontSize: 12, color: Color(0xFF181818)),
                            ),
                            onPressed: () => client.loadModels(agent.id),
                          );
                        },
                      ),
                    ),
                    SizedBox(
                      width: 32,
                      height: 32,
                      child: IconButton.filledTonal(
                        key: const Key('btn-new-session'),
                        padding: EdgeInsets.zero,
                        tooltip: 'New Session',
                        style: IconButton.styleFrom(
                          backgroundColor: const Color(0xFF07C160),
                          foregroundColor: Colors.white,
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
                        icon: const Icon(Icons.add, size: 18),
                      ),
                    ),
                  ],
                ),
              ),
              if (client.models.isNotEmpty)
                SizedBox(
                  height: 34,
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
              const SizedBox(height: 4),
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
                        onTap: () => client.openSession(session),
                        child: Container(
                          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                          decoration: BoxDecoration(
                            color: isSelected
                                ? const Color(0xFF07C160).withValues(alpha: 0.14)
                                : const Color(0xFFFFFFFF),
                            border: Border.all(
                              color: isSelected
                                  ? const Color(0xFF07C160)
                                  : const Color(0xFFE5E5EA),
                            ),
                            borderRadius: BorderRadius.circular(8),
                          ),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            mainAxisAlignment: MainAxisAlignment.center,
                            children: [
                              Text(
                                session.title,
                                style: const TextStyle(
                                  fontSize: 12,
                                  fontWeight: FontWeight.w600,
                                  color: Color(0xFF181818),
                                ),
                              ),
                              Text(
                                session.projectPath,
                                style: const TextStyle(
                                  fontSize: 10,
                                  color: Color(0xFF8E8E93),
                                ),
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
          ),
        ),
        const Divider(height: 1, color: Color(0xFFE5E5EA)),
        // Active session detail timeline
        Expanded(
          child: active == null
              ? Center(
                  child: Text(
                    client.strings.selectSessionHint,
                    style: const TextStyle(color: Color(0xFF8E8E93), fontSize: 13),
                  ),
                )
              : SessionTimelineList(client: client, session: active),
        ),
        // WeChat-style bottom composer bar
        if (active != null)
          Container(
            color: const Color(0xFFF7F7F7),
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
            child: Row(
              children: [
                IconButton(
                  key: const Key('btn-load-diffs'),
                  visualDensity: VisualDensity.compact,
                  tooltip: 'Load Session Diffs',
                  onPressed: () => client.loadSessionDiffs(active.id),
                  icon: const Icon(Icons.difference_outlined, size: 20, color: Color(0xFF181818)),
                ),
                IconButton(
                  key: const Key('btn-capture-screen'),
                  visualDensity: VisualDensity.compact,
                  tooltip: 'Capture Desktop Screen',
                  onPressed: () => client.captureScreen('main'),
                  icon: const Icon(Icons.desktop_windows_outlined, size: 20, color: Color(0xFF181818)),
                ),
                IconButton(
                  key: const Key('btn-cancel-session'),
                  visualDensity: VisualDensity.compact,
                  tooltip: 'Cancel Session',
                  onPressed: client.cancelActiveSession,
                  icon: const Icon(Icons.stop_circle_outlined, size: 20, color: Color(0xFFFA5151)),
                ),
                Expanded(
                  child: Container(
                    decoration: BoxDecoration(
                      color: const Color(0xFFFFFFFF),
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: TextField(
                      key: const Key('input-session-prompt'),
                      controller: _promptController,
                      style: const TextStyle(fontSize: 13, color: Color(0xFF181818)),
                      decoration: InputDecoration(
                        hintText: client.strings.promptHint,
                        border: InputBorder.none,
                        isDense: true,
                        contentPadding: const EdgeInsets.symmetric(
                          horizontal: 10,
                          vertical: 8,
                        ),
                      ),
                    ),
                  ),
                ),
                const SizedBox(width: 6),
                SizedBox(
                  height: 34,
                  width: 34,
                  child: IconButton.filled(
                    key: const Key('btn-send-prompt'),
                    padding: EdgeInsets.zero,
                    style: IconButton.styleFrom(
                      backgroundColor: const Color(0xFF07C160),
                      foregroundColor: Colors.white,
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(8),
                      ),
                    ),
                    onPressed: () {
                      final text = _promptController.text;
                      _promptController.clear();
                      client.sendMessage(text);
                    },
                    icon: const Icon(Icons.send, size: 16),
                  ),
                ),
              ],
            ),
          ),
      ],
    );
  }
}
