import 'dart:async';
import 'package:flutter/foundation.dart';
import '../i18n/app_strings.dart';
import '../models/protocol_models.dart';
import '../models/timeline_items.dart';
import '../storage/credential_store.dart';
import '../transport/bridge_transport.dart';

enum BridgeConnectionState { disconnected, connecting, connected, error }

class ProjectWorkspaceGroup {
  final String projectName;
  final String projectPath;
  final List<AgentSession> sessions;

  const ProjectWorkspaceGroup({
    required this.projectName,
    required this.projectPath,
    required this.sessions,
  });
}

class MobileBridgeClient extends ChangeNotifier {
  final BridgeTransport transport;
  final DeviceCredentialStore credentialStore;
  AppLanguage language;

  BridgeConnectionState connectionState = BridgeConnectionState.disconnected;
  String? errorMessage;
  String? activeMachineId;
  final Set<String> connectedMachineIds = {};
  List<SavedDeviceCredential> savedMachines = const [];
  List<AgentInfo> agents = const [];
  String selectedAgentId = 'opencode';
  List<ModelInfo> models = const [];
  String? selectedModelId;
  List<AgentSession> sessions = const [];
  AgentSession? activeSession;

  final Map<String, int> _lastSequenceBySession = {};
  final Map<String, List<SessionTimelineItem>> _timelineBySession = {};
  final Map<String, String> _sessionStatusBySession = {};
  StreamSubscription<Map<String, dynamic>>? _subscription;
  int _requestCounter = 0;

  MobileBridgeClient({
    required this.transport,
    required this.credentialStore,
    this.language = AppLanguage.en,
  }) {
    _subscription = transport.incomingMessages.listen(_handleServerMessage);
  }

  NienieStrings get strings => NienieStrings(language);

  Future<void> setLanguage(AppLanguage nextLanguage) async {
    language = nextLanguage;
    notifyListeners();
    await credentialStore.saveLanguage(nextLanguage);
  }

  Future<void> loadSavedPreferences() async {
    final savedLang = await credentialStore.loadLanguage();
    if (savedLang != null) {
      language = savedLang;
    }
    savedMachines = await credentialStore.listMachines();
    notifyListeners();
  }

  List<SessionTimelineItem> timelineFor(String sessionId) {
    return List.unmodifiable(_timelineBySession[sessionId] ?? const []);
  }

  String statusFor(String sessionId) {
    return _sessionStatusBySession[sessionId] ??
        activeSession?.status ??
        'idle';
  }

  Future<void> refreshSavedMachines() async {
    savedMachines = await credentialStore.listMachines();
    notifyListeners();
  }

  Future<void> removeSavedMachine(String machineId) async {
    await credentialStore.removeMachine(machineId);
    await refreshSavedMachines();
  }

  Future<void> disconnect() async {
    await transport.close();
    connectionState = BridgeConnectionState.disconnected;
    activeSession = null;
    await refreshSavedMachines();
  }

  Future<void> pairWithQrUri(
    String qrUri, {
    String deviceName = 'Nienie Flutter Mobile',
    String platform = 'ios',
  }) async {
    final payload = PairingQrPayload.decode(qrUri);
    await pairAndConnect(
      wsUrl: payload.wsUrl,
      pairingCode: payload.pairingCode,
      deviceName: deviceName,
      platform: platform,
      allowLocalhostFallback: true,
    );
  }

  Future<void> pairAndConnect({
    required String wsUrl,
    required String pairingCode,
    String deviceName = 'Nienie Flutter Mobile',
    String platform = 'ios',
    bool allowLocalhostFallback = false,
  }) async {
    if (pairingCode.trim().isEmpty) {
      connectionState = BridgeConnectionState.error;
      errorMessage = strings.emptyPairingCodeError;
      notifyListeners();
      return;
    }

    connectionState = BridgeConnectionState.connecting;
    errorMessage = null;
    notifyListeners();

    String effectiveWsUrl = wsUrl;
    try {
      try {
        await transport.connect(wsUrl);
      } catch (_) {
        final parsedUri = Uri.tryParse(wsUrl);
        if (allowLocalhostFallback &&
            parsedUri != null &&
            parsedUri.host != '127.0.0.1' &&
            parsedUri.host != 'localhost' &&
            parsedUri.hasPort) {
          effectiveWsUrl = 'ws://127.0.0.1:${parsedUri.port}';
          await transport.connect(effectiveWsUrl);
        } else {
          rethrow;
        }
      }

      final res = await transport.sendRequest({
        'type': 'pair.confirm',
        'requestId': _nextRequestId(),
        'pairingCode': pairingCode,
        'deviceName': deviceName,
        'platform': platform,
      });

      if (res['ok'] != true) {
        final err = res['error'] as Map<String, dynamic>?;
        throw StateError(err?['message'] as String? ?? 'Pairing failed');
      }

      final data = res['data'] as Map<String, dynamic>;
      final machineId = data['machineId'] as String;
      await credentialStore.save(
        SavedDeviceCredential(
          machineId: machineId,
          wsUrl: effectiveWsUrl,
          deviceId: data['deviceId'] as String,
          deviceToken: data['deviceToken'] as String,
        ),
      );
      activeMachineId = machineId;
      connectedMachineIds.add(machineId);
      savedMachines = await credentialStore.listMachines();

      connectionState = BridgeConnectionState.connected;
      await refreshAgents();
      await refreshSessions();
      if (activeSession == null && sessions.isNotEmpty) {
        activeSession = sessions.first;
        selectedAgentId = activeSession!.agentId;
      }
      notifyListeners();
    } catch (e) {
      connectionState = BridgeConnectionState.error;
      errorMessage = e.toString();
      notifyListeners();
      rethrow;
    }
  }

  Future<void> reconnectWithSavedCredential([String? machineId]) async {
    final saved = await credentialStore.load(machineId);
    if (saved == null) {
      throw StateError('No saved device credential found');
    }

    connectionState = BridgeConnectionState.connecting;
    errorMessage = null;
    notifyListeners();

    await transport.connect(saved.wsUrl);
    final res = await transport.sendRequest({
      'type': 'hello',
      'requestId': _nextRequestId(),
      'protocolVersion': PROTOCOL_VERSION,
      'deviceToken': saved.deviceToken,
    });

    if (res['ok'] != true) {
      connectionState = BridgeConnectionState.error;
      final err = res['error'] as Map<String, dynamic>?;
      errorMessage = err?['message'] as String? ?? 'Reconnect failed';
      notifyListeners();
      throw StateError(errorMessage!);
    }

    activeMachineId = saved.machineId;
    connectedMachineIds.add(saved.machineId);
    connectionState = BridgeConnectionState.connected;
    await refreshAgents();
    await refreshSessions();
    if (activeSession != null) {
      await replayMissedEvents(activeSession!.id);
    } else if (sessions.isNotEmpty) {
      activeSession = sessions.first;
      selectedAgentId = activeSession!.agentId;
    }
    notifyListeners();
  }

  Future<void> replayMissedEvents(String sessionId) async {
    final afterSeq = _lastSequenceBySession[sessionId] ?? 0;
    final res = await transport.sendRequest({
      'type': 'events.replay',
      'requestId': _nextRequestId(),
      'sessionId': sessionId,
      'afterSequence': afterSeq,
    });
    if (res['ok'] == true) {
      final data = res['data'] as Map<String, dynamic>;
      final events = data['events'] as List<dynamic>? ?? const [];
      for (final rawEvt in events) {
        _handleServerMessage({
          'type': 'session.event',
          'event': rawEvt,
        });
      }
    }
  }

  Future<void> replyPermission({
    required String sessionId,
    required String permissionId,
    required String decision,
  }) async {
    await transport.sendRequest({
      'type': 'permission.reply',
      'requestId': _nextRequestId(),
      'sessionId': sessionId,
      'permissionId': permissionId,
      'decision': decision,
    });
    final items = _timelineBySession[sessionId];
    if (items != null) {
      for (final item in items) {
        if (item is PermissionRequestCardItem && item.permissionId == permissionId) {
          item.resolvedDecision = decision;
        }
      }
      notifyListeners();
    }
  }

  Future<void> loadSessionDiffs(String sessionId) async {
    final res = await transport.sendRequest({
      'type': 'session.diff',
      'requestId': _nextRequestId(),
      'sessionId': sessionId,
    });
    if (res['ok'] == true) {
      final data = res['data'] as Map<String, dynamic>;
      final diffs = data['diffs'] as List<dynamic>? ?? const [];
      final items = _timelineBySession.putIfAbsent(sessionId, () => []);
      for (final raw in diffs) {
        final map = Map<String, dynamic>.from(raw as Map);
        items.add(
          FileDiffCardItem(
            file: map['file'] as String? ?? '',
            additions: map['additions'] as int? ?? 0,
            deletions: map['deletions'] as int? ?? 0,
          ),
        );
      }
      notifyListeners();
    }
  }

  Future<void> registerPushToken({
    required String platform,
    required String provider,
    required String pushToken,
  }) async {
    await transport.sendRequest({
      'type': 'push.register',
      'requestId': _nextRequestId(),
      'platform': platform,
      'provider': provider,
      'pushToken': pushToken,
    });
  }

  Future<void> captureScreen([String displayId = 'main']) async {
    final current = activeSession;
    if (current == null) return;
    final res = await transport.sendRequest({
      'type': 'screen.capture',
      'requestId': _nextRequestId(),
      'displayId': displayId,
    });
    if (res['ok'] == true) {
      final data = res['data'] as Map<String, dynamic>;
      final frame = Map<String, dynamic>.from(data['frame'] as Map);
      final items = _timelineBySession.putIfAbsent(current.id, () => []);
      items.add(
        ScreenCaptureCardItem(
          frameId: frame['frameId'] as String? ?? 'frm',
          displayId: frame['displayId'] as String? ?? displayId,
          width: frame['width'] as int? ?? 0,
          height: frame['height'] as int? ?? 0,
          capturedAt: frame['capturedAt'] as String? ?? '',
        ),
      );
      notifyListeners();
    }
  }

  Future<void> refreshAgents() async {
    final res = await transport.sendRequest({
      'type': 'agents.list',
      'requestId': _nextRequestId(),
    });
    if (res['ok'] == true) {
      final list = (res['data'] as Map<String, dynamic>)['agents'] as List<dynamic>;
      agents = list
          .map((item) => AgentInfo.fromJson(Map<String, dynamic>.from(item as Map)))
          .toList();
      if (agents.isNotEmpty && !agents.any((a) => a.id == selectedAgentId)) {
        selectedAgentId =
            agents.where((a) => a.available).firstOrNull?.id ?? agents.first.id;
      }
      notifyListeners();
    }
  }

  Future<void> selectAgent(String agentId) async {
    selectedAgentId = agentId;
    final matching = sessions.where((s) => s.agentId == agentId).firstOrNull;
    if (matching != null) {
      activeSession = matching;
    }
    notifyListeners();
    await loadModels(agentId);
  }

  List<ProjectWorkspaceGroup> projectsForAgent([String? agentId]) {
    final targetAgent = agentId ?? selectedAgentId;
    final filtered = sessions.where((s) => s.agentId == targetAgent).toList();
    final source = filtered.isNotEmpty ? filtered : sessions;
    final grouped = <String, List<AgentSession>>{};
    for (final session in source) {
      final path = session.projectPath.trim().isNotEmpty
          ? session.projectPath.trim()
          : '/workspace';
      grouped.putIfAbsent(path, () => []).add(session);
    }
    return grouped.entries.map((entry) {
      final segments = entry.key
          .split(RegExp(r'[/\\]'))
          .where((seg) => seg.trim().isNotEmpty)
          .toList();
      final folderName = segments.isNotEmpty ? segments.last : entry.key;
      return ProjectWorkspaceGroup(
        projectName: folderName,
        projectPath: entry.key,
        sessions: entry.value,
      );
    }).toList();
  }

  Future<void> loadModels(String agentId) async {
    final res = await transport.sendRequest({
      'type': 'models.list',
      'requestId': _nextRequestId(),
      'agentId': agentId,
    });
    if (res['ok'] == true) {
      final list = (res['data'] as Map<String, dynamic>)['models'] as List<dynamic>? ?? const [];
      models = list
          .map((item) => ModelInfo.fromJson(Map<String, dynamic>.from(item as Map)))
          .toList();
      selectedModelId ??= models.where((m) => m.isDefault).firstOrNull?.id ?? models.firstOrNull?.id;
      notifyListeners();
    }
  }

  void selectModel(String modelId) {
    selectedModelId = modelId;
    notifyListeners();
  }

  Future<void> refreshSessions() async {
    final res = await transport.sendRequest({
      'type': 'sessions.list',
      'requestId': _nextRequestId(),
    });
    if (res['ok'] == true) {
      final list = (res['data'] as Map<String, dynamic>)['sessions'] as List<dynamic>;
      sessions = list
          .map((item) => AgentSession.fromJson(Map<String, dynamic>.from(item as Map)))
          .toList();
      notifyListeners();
    }
  }

  Future<AgentSession> createSession({
    required String agentId,
    String? title,
    String? projectPath,
  }) async {
    final res = await transport.sendRequest({
      'type': 'session.create',
      'requestId': _nextRequestId(),
      'agentId': agentId,
      'input': {
        if (title != null) 'title': title,
        if (projectPath != null) 'projectPath': projectPath,
      },
    });
    if (res['ok'] != true) {
      final err = res['error'] as Map<String, dynamic>?;
      throw StateError(err?['message'] as String? ?? 'Failed to create session');
    }
    final sessionMap = (res['data'] as Map<String, dynamic>)['session'] as Map;
    final created = AgentSession.fromJson(Map<String, dynamic>.from(sessionMap));
    sessions = [created, ...sessions.where((s) => s.id != created.id)];
    activeSession = created;
    notifyListeners();
    return created;
  }

  Future<void> openSession(AgentSession session) async {
    final res = await transport.sendRequest({
      'type': 'session.load',
      'requestId': _nextRequestId(),
      'agentId': session.agentId,
      'sessionId': session.id,
    });
    if (res['ok'] == true) {
      final sessionMap = (res['data'] as Map<String, dynamic>)['session'] as Map;
      activeSession = AgentSession.fromJson(Map<String, dynamic>.from(sessionMap));
    } else {
      activeSession = session;
    }
    notifyListeners();
  }

  Future<void> cancelActiveSession() async {
    final current = activeSession;
    if (current == null) return;
    await transport.sendRequest({
      'type': 'session.cancel',
      'requestId': _nextRequestId(),
      'sessionId': current.id,
    });
    _sessionStatusBySession[current.id] = 'cancelled';
    notifyListeners();
  }

  Future<void> sendMessage(String text) async {
    final current = activeSession;
    if (current == null || text.trim().isEmpty) return;

    final trimmed = text.trim();
    final items = _timelineBySession.putIfAbsent(current.id, () => []);
    items.add(UserPromptItem(trimmed));
    notifyListeners();

    final res = await transport.sendRequest({
      'type': 'session.send',
      'requestId': _nextRequestId(),
      'sessionId': current.id,
      'agentId': current.agentId,
      'message': trimmed,
      if (selectedModelId != null) 'modelId': selectedModelId,
    });

    if (res['ok'] != true) {
      final err = res['error'] as Map<String, dynamic>?;
      items.add(
        ErrorCardItem(
          code: err?['code'] as String? ?? 'SEND_FAILED',
          message: err?['message'] as String? ?? 'Failed to send prompt',
          retryable: true,
        ),
      );
      notifyListeners();
    }
  }

  void _handleServerMessage(Map<String, dynamic> raw) {
    if (raw['type'] != 'session.event') return;
    final eventMap = raw['event'] as Map?;
    if (eventMap == null) return;

    final event = CanonicalAgentEvent.fromJson(Map<String, dynamic>.from(eventMap));
    final lastSeq = _lastSequenceBySession[event.sessionId] ?? 0;
    if (event.sequence <= lastSeq) {
      return;
    }
    _lastSequenceBySession[event.sessionId] = event.sequence;

    final items = _timelineBySession.putIfAbsent(event.sessionId, () => []);

    switch (event.type) {
      case 'status':
        final status = event.payload['status'] as String? ?? 'idle';
        _sessionStatusBySession[event.sessionId] = status;
        final permissionId = event.payload['permissionId'] as String?;
        if (status == 'waiting' && permissionId != null) {
          final permission = event.payload['permission'] as String? ?? 'permission';
          final detail = event.payload['detail'] as String? ?? 'Permission requested';
          final rawPatterns = event.payload['patterns'] as List<dynamic>? ?? const [];
          items.add(
            PermissionRequestCardItem(
              permissionId: permissionId,
              permission: permission,
              detail: detail,
              patterns: rawPatterns.map((e) => e.toString()).toList(),
            ),
          );
        }
        break;

      case 'text_delta':
        final delta = event.payload['delta'] as String? ?? '';
        if (delta.isEmpty) break;
        if (items.isNotEmpty &&
            items.last is StreamingTextItem &&
            !(items.last as StreamingTextItem).isThinking) {
          (items.last as StreamingTextItem).text += delta;
        } else {
          items.add(StreamingTextItem(text: delta, isThinking: false));
        }
        break;

      case 'thinking_delta':
        final delta = event.payload['delta'] as String? ?? '';
        if (delta.isEmpty) break;
        if (items.isNotEmpty &&
            items.last is StreamingTextItem &&
            (items.last as StreamingTextItem).isThinking) {
          (items.last as StreamingTextItem).text += delta;
        } else {
          items.add(StreamingTextItem(text: delta, isThinking: true));
        }
        break;

      case 'tool_use':
        final toolCallId = event.payload['toolCallId'] as String? ?? '';
        final name = event.payload['name'] as String? ?? 'tool';
        final input = Map<String, dynamic>.from(
          event.payload['input'] as Map? ?? const {},
        );
        items.add(
          ToolCallCardItem(
            toolCallId: toolCallId,
            name: name,
            input: input,
          ),
        );
        break;

      case 'tool_result':
        final toolCallId = event.payload['toolCallId'] as String? ?? '';
        final content = event.payload['content'] as String? ?? '';
        final isError = event.payload['isError'] as bool? ?? false;
        ToolCallCardItem? existing;
        for (final item in items.reversed) {
          if (item is ToolCallCardItem && item.toolCallId == toolCallId) {
            existing = item;
            break;
          }
        }
        if (existing != null) {
          existing.resultContent = content;
          existing.isError = isError;
        } else {
          items.add(
            ToolCallCardItem(
              toolCallId: toolCallId,
              name: 'tool',
              input: const {},
              resultContent: content,
              isError: isError,
            ),
          );
        }
        break;

      case 'error':
        items.add(
          ErrorCardItem(
            code: event.payload['code'] as String? ?? 'ERROR',
            message: event.payload['message'] as String? ?? 'Agent error',
            retryable: event.payload['retryable'] as bool? ?? false,
          ),
        );
        break;

      case 'usage':
        final inputTokens = (event.payload['inputTokens'] as num?)?.toInt() ?? 0;
        final outputTokens = (event.payload['outputTokens'] as num?)?.toInt() ?? 0;
        final costUsd = (event.payload['costUsd'] as num?)?.toDouble() ?? 0.0;
        items.add(
          UsageSummaryItem(
            inputTokens: inputTokens,
            outputTokens: outputTokens,
            costUsd: costUsd,
          ),
        );
        break;
    }

    notifyListeners();
  }

  String _nextRequestId() => 'mreq_${++_requestCounter}';

  @override
  void dispose() {
    _subscription?.cancel();
    transport.close();
    super.dispose();
  }
}
