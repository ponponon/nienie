import 'dart:convert';
import 'package:flutter/material.dart';
import '../i18n/app_strings.dart';
import '../models/protocol_models.dart';
import '../models/timeline_items.dart';
import '../state/mobile_bridge_client.dart';

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
      theme: ThemeData.dark(useMaterial3: true).copyWith(
        scaffoldBackgroundColor: const Color(0xFF111111),
        cardColor: const Color(0xFF1A1A1A),
      ),
      home: AnimatedBuilder(
        animation: widget.client,
        builder: (context, _) {
          final client = widget.client;
          return Scaffold(
            appBar: AppBar(
              backgroundColor: const Color(0xFF1A1A1A),
              title: Row(
                children: [
                  const Icon(Icons.hub_outlined, size: 20, color: Color(0xFF3B82F6)),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      client.strings.appTitle,
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
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                      child: Row(
                        children: [
                          const Icon(Icons.language, size: 16),
                          const SizedBox(width: 4),
                          Text(
                            client.strings.langShortLabel,
                            style: const TextStyle(fontSize: 12),
                          ),
                        ],
                      ),
                    ),
                  ),
                  const SizedBox(width: 4),
                  _buildConnectionBadge(client),
                  if (client.connectionState == BridgeConnectionState.connected) ...[
                    const SizedBox(width: 8),
                    IconButton(
                      key: const Key('btn-disconnect'),
                      tooltip: 'Disconnect',
                      onPressed: client.disconnect,
                      icon: const Icon(Icons.link_off, size: 18),
                    ),
                  ],
                ],
              ),
            ),
            body: SafeArea(
              child: client.connectionState != BridgeConnectionState.connected
                  ? _buildPairingPanel(client)
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
      BridgeConnectionState.connected => const Color(0xFF10B981),
      BridgeConnectionState.connecting => const Color(0xFFF59E0B),
      BridgeConnectionState.error => const Color(0xFFEF4444),
      BridgeConnectionState.disconnected => const Color(0xFF9CA3AF),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.16),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        label,
        style: TextStyle(color: color, fontSize: 12, fontWeight: FontWeight.w600),
      ),
    );
  }

  Widget _buildPairingPanel(MobileBridgeClient client) {
    final s = client.strings;
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Card(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  children: [
                    const Icon(Icons.qr_code_scanner, size: 18, color: Color(0xFF3B82F6)),
                    const SizedBox(width: 8),
                    Text(
                      s.connectTitle,
                      style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
                    ),
                  ],
                ),
                const SizedBox(height: 12),
                TextField(
                  key: const Key('input-ws-url'),
                  controller: _wsUrlController,
                  decoration: InputDecoration(
                    labelText: s.wsUrlLabel,
                    border: const OutlineInputBorder(),
                  ),
                ),
                const SizedBox(height: 12),
                TextField(
                  key: const Key('input-pairing-code'),
                  controller: _pairingCodeController,
                  decoration: InputDecoration(
                    labelText: s.pairingCodeLabel,
                    border: const OutlineInputBorder(),
                  ),
                ),
                const SizedBox(height: 12),
                FilledButton.icon(
                  key: const Key('btn-connect-pair'),
                  onPressed: () {
                    client.pairAndConnect(
                      wsUrl: _wsUrlController.text,
                      pairingCode: _pairingCodeController.text,
                    );
                  },
                  icon: const Icon(Icons.link),
                  label: Text(s.pairAndConnectBtn),
                ),
                const SizedBox(height: 16),
                TextField(
                  key: const Key('input-qr-uri'),
                  controller: _qrUriController,
                  decoration: InputDecoration(
                    labelText: s.qrUriLabel,
                    border: const OutlineInputBorder(),
                  ),
                ),
                const SizedBox(height: 8),
                OutlinedButton.icon(
                  key: const Key('btn-pair-qr-uri'),
                  onPressed: () {
                    client.pairWithQrUri(_qrUriController.text);
                  },
                  icon: const Icon(Icons.qr_code),
                  label: Text(s.pairWithQrBtn),
                ),
                if (client.savedMachines.isNotEmpty) ...[
                  const SizedBox(height: 16),
                  Text(
                    s.savedComputersTitle,
                    style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
                  ),
                  const SizedBox(height: 8),
                  for (final machine in client.savedMachines)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 8),
                      child: Row(
                        children: [
                          const Icon(Icons.computer, size: 16, color: Color(0xFF10B981)),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  machine.machineId,
                                  style: const TextStyle(fontWeight: FontWeight.w600),
                                ),
                                Text(
                                  machine.wsUrl,
                                  style: const TextStyle(
                                    fontSize: 11,
                                    color: Color(0xFF9CA3AF),
                                  ),
                                ),
                              ],
                            ),
                          ),
                          FilledButton.tonal(
                            key: Key('btn-reconnect-machine-${machine.machineId}'),
                            onPressed: () =>
                                client.reconnectWithSavedCredential(machine.machineId),
                            child: Text(s.reconnectBtn),
                          ),
                          const SizedBox(width: 4),
                          IconButton(
                            key: Key('btn-remove-machine-${machine.machineId}'),
                            tooltip: 'Remove Machine',
                            onPressed: () => client.removeSavedMachine(machine.machineId),
                            icon: const Icon(Icons.delete_outline, size: 18),
                          ),
                        ],
                      ),
                    ),
                ],
                if (client.errorMessage != null) ...[
                  const SizedBox(height: 12),
                  Text(
                    client.errorMessage!,
                    style: const TextStyle(color: Color(0xFFEF4444)),
                  ),
                ],
              ],
            ),
          ),
        ),
      ],
    );
  }

  Widget _buildConnectedWorkspace(MobileBridgeClient client) {
    final active = client.activeSession;
    return Column(
      children: [
        // Agent list bar + New Session button
        SizedBox(
          height: 60,
          child: Row(
            children: [
              Expanded(
                child: ListView.separated(
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                  scrollDirection: Axis.horizontal,
                  itemCount: client.agents.length,
                  separatorBuilder: (_, __) => const SizedBox(width: 8),
                  itemBuilder: (context, index) {
                    final agent = client.agents[index];
                    return ActionChip(
                      key: Key('chip-agent-${agent.id}'),
                      avatar: Icon(
                        agent.available
                            ? Icons.check_circle_outline
                            : Icons.cancel_outlined,
                        size: 16,
                        color: agent.available
                            ? const Color(0xFF10B981)
                            : const Color(0xFF9CA3AF),
                      ),
                      label: Text(agent.name),
                      onPressed: () => client.loadModels(agent.id),
                    );
                  },
                ),
              ),
              Padding(
                padding: const EdgeInsets.only(right: 12),
                child: IconButton.filledTonal(
                  key: const Key('btn-new-session'),
                  tooltip: 'New Session',
                  onPressed: () {
                    final defaultAgent =
                        client.agents.where((a) => a.available).firstOrNull?.id ??
                            'opencode';
                    client.createSession(
                      agentId: defaultAgent,
                      title: 'Mobile Session',
                    );
                  },
                  icon: const Icon(Icons.add),
                ),
              ),
            ],
          ),
        ),
        if (client.models.isNotEmpty)
          SizedBox(
            height: 44,
            child: ListView.separated(
              padding: const EdgeInsets.symmetric(horizontal: 12),
              scrollDirection: Axis.horizontal,
              itemCount: client.models.length,
              separatorBuilder: (_, __) => const SizedBox(width: 8),
              itemBuilder: (context, index) {
                final model = client.models[index];
                return ChoiceChip(
                  key: Key('chip-model-${model.id}'),
                  label: Text(model.name),
                  selected: client.selectedModelId == model.id,
                  onSelected: (_) => client.selectModel(model.id),
                );
              },
            ),
          ),
        // Session selector list
        SizedBox(
          height: 76,
          child: ListView.builder(
            padding: const EdgeInsets.symmetric(horizontal: 12),
            scrollDirection: Axis.horizontal,
            itemCount: client.sessions.length,
            itemBuilder: (context, index) {
              final session = client.sessions[index];
              final isSelected = active?.id == session.id;
              return Padding(
                padding: const EdgeInsets.only(right: 8),
                child: InkWell(
                  onTap: () => client.openSession(session),
                  child: Container(
                    padding: const EdgeInsets.all(10),
                    decoration: BoxDecoration(
                      color: isSelected
                          ? const Color(0xFF2563EB).withValues(alpha: 0.22)
                          : const Color(0xFF1A1A1A),
                      border: Border.all(
                        color: isSelected
                            ? const Color(0xFF3B82F6)
                            : const Color(0xFF2B2B2B),
                      ),
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Text(
                          session.title,
                          style: const TextStyle(fontWeight: FontWeight.w600),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          session.projectPath,
                          style: const TextStyle(
                            fontSize: 11,
                            color: Color(0xFF9CA3AF),
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
        const Divider(height: 1),
        // Active session detail timeline
        Expanded(
          child: active == null
              ? Center(child: Text(client.strings.selectSessionHint))
              : _buildSessionTimeline(client, active),
        ),
        // Prompt composer bar
        if (active != null)
          Padding(
            padding: const EdgeInsets.all(12),
            child: Row(
              children: [
                IconButton(
                  key: const Key('btn-load-diffs'),
                  tooltip: 'Load Session Diffs',
                  onPressed: () => client.loadSessionDiffs(active.id),
                  icon: const Icon(Icons.difference_outlined),
                ),
                IconButton(
                  key: const Key('btn-capture-screen'),
                  tooltip: 'Capture Desktop Screen',
                  onPressed: () => client.captureScreen('main'),
                  icon: const Icon(Icons.desktop_windows_outlined),
                ),
                IconButton(
                  key: const Key('btn-cancel-session'),
                  tooltip: 'Cancel Session',
                  onPressed: client.cancelActiveSession,
                  icon: const Icon(Icons.stop_circle_outlined, color: Color(0xFFEF4444)),
                ),
                const SizedBox(width: 4),
                Expanded(
                  child: TextField(
                    key: const Key('input-session-prompt'),
                    controller: _promptController,
                    decoration: InputDecoration(
                      hintText: client.strings.promptHint,
                      border: const OutlineInputBorder(),
                      isDense: true,
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                IconButton.filled(
                  key: const Key('btn-send-prompt'),
                  onPressed: () {
                    final text = _promptController.text;
                    _promptController.clear();
                    client.sendMessage(text);
                  },
                  icon: const Icon(Icons.send),
                ),
              ],
            ),
          ),
      ],
    );
  }

  Widget _buildSessionTimeline(MobileBridgeClient client, AgentSession session) {
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
