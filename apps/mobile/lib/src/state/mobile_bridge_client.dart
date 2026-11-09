import 'dart:async';
import 'package:flutter/foundation.dart';
import '../i18n/app_strings.dart';
import '../models/protocol_models.dart';
import '../models/timeline_items.dart';
import '../storage/credential_store.dart';
import '../transport/bridge_transport.dart';
import '../utils/device_identity.dart';

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
  // 每会话当前事件流 epoch，供 replay 定位
  final Map<String, String> _currentEpochBySession = {};
  // 正在回放缺口的会话，避免重复触发
  final Set<String> _gapReplayInFlight = <String>{};
  // 乱序缓冲：epochKey → (sequence → event)，水位只表示已连续应用的最大序号
  final Map<String, Map<int, CanonicalAgentEvent>> _pendingEventsByEpoch = {};
  // eventId 幂等去重：稳定事件 ID（如 history:sid:part:rev）重复到达只处理一次
  final Set<String> _seenEventIds = <String>{};
  static const int _maxSeenEventIds = 2000;
  final Map<String, List<SessionTimelineItem>> _timelineBySession = {};
  final Map<String, String> _sessionStatusBySession = {};
  final Map<PendingResponseItem, Timer> _pendingTimers = {};
  StreamSubscription<Map<String, dynamic>>? _subscription;
  int _requestCounter = 0;

  /// 发送后多久未收到任何回复内容即判定为「等待超时」，UI 切换为兜底卡片。
  static const Duration pendingResponseTimeout = Duration(seconds: 45);

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

  Future<void> loadSavedPreferences({bool autoReconnect = false}) async {
    final savedLang = await credentialStore.loadLanguage();
    if (savedLang != null) {
      language = savedLang;
    }
    savedMachines = await credentialStore.listMachines();
    notifyListeners();
    if (autoReconnect &&
        savedMachines.isNotEmpty &&
        connectionState == BridgeConnectionState.disconnected) {
      try {
        await reconnectWithSavedCredential(savedMachines.first.machineId);
      } catch (_) {
        // Stay on pairing screen if computer is currently offline
      }
    }
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
    activeMachineId = null;
    connectedMachineIds.clear();
    agents = const [];
    sessions = const [];
    models = const [];
    selectedModelId = null;
    activeSession = null;
    await refreshSavedMachines();
  }

  Future<void> pairWithQrUri(
    String qrUri, {
    String? deviceName,
    String? platform,
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
    String? deviceName,
    String? platform,
    bool allowLocalhostFallback = false,
  }) async {
    if (pairingCode.trim().isEmpty) {
      connectionState = BridgeConnectionState.error;
      errorMessage = strings.emptyPairingCodeError;
      notifyListeners();
      return;
    }

    // 缺省用真实设备身份（手机型号 + 实际平台），让设备列表有区分度
    String effectiveName = deviceName ?? '';
    String effectivePlatform = platform ?? '';
    if (deviceName == null || platform == null) {
      final identity = await resolveDeviceIdentity();
      effectiveName = deviceName ?? identity.name;
      effectivePlatform = platform ?? identity.platform;
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
        'deviceName': effectiveName,
        'platform': effectivePlatform,
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
        await loadModels(selectedAgentId);
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

    String effectiveWsUrl = saved.wsUrl;
    try {
      await transport.connect(saved.wsUrl);
    } catch (_) {
      final parsedUri = Uri.tryParse(saved.wsUrl);
      if (parsedUri != null &&
          parsedUri.host != '127.0.0.1' &&
          parsedUri.host != 'localhost' &&
          parsedUri.hasPort) {
        effectiveWsUrl = 'ws://127.0.0.1:${parsedUri.port}';
        await transport.connect(effectiveWsUrl);
      } else {
        connectionState = BridgeConnectionState.disconnected;
        notifyListeners();
        rethrow;
      }
    }

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

    if (effectiveWsUrl != saved.wsUrl) {
      await credentialStore.save(
        SavedDeviceCredential(
          machineId: saved.machineId,
          wsUrl: effectiveWsUrl,
          deviceId: saved.deviceId,
          deviceToken: saved.deviceToken,
        ),
      );
      savedMachines = await credentialStore.listMachines();
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
      await loadModels(selectedAgentId);
    }
    notifyListeners();
  }

  Future<void> replayMissedEvents(String sessionId) async {
    final epoch = _currentEpochBySession[sessionId];
    final epochKey = epoch != null && epoch.isNotEmpty ? '$sessionId#$epoch' : sessionId;
    // 注意：判重 key 与 _handleServerMessage 的 epochKey 必须一致（都是 sessionId#streamEpoch）
    final afterSeq = _lastSequenceBySession[epochKey] ?? 0;
    final res = await transport.sendRequest({
      'type': 'events.replay',
      'requestId': _nextRequestId(),
      'sessionId': sessionId,
      if (epoch != null && epoch.isNotEmpty) 'streamEpoch': epoch,
      'afterSequence': afterSeq,
    });
    if (res['ok'] == true) {
      final data = res['data'] as Map<String, dynamic>;
      final serverEpoch = data['streamEpoch'] as String? ?? '';
      final resetRequired = data['resetRequired'] == true;
      final truncated = data['truncated'] == true;
      // 2.3 epoch 绑定：更新本地 epoch，避免一直带旧 epoch 反复 resetRequired。
      if (serverEpoch.isNotEmpty) {
        _currentEpochBySession[sessionId] = serverEpoch;
      }
      // 2.2 resetRequired/truncated：调用 session.snapshot 原子重建（不再丢数据）
      if (resetRequired || truncated) {
        await loadSessionSnapshot(sessionId);
        return;
      }
      final events = data['events'] as List<dynamic>? ?? const [];
      for (final rawEvt in events) {
        _handleServerMessage({
          'type': 'session.event',
          'event': rawEvt,
        });
      }
    }
  }

  /// 会话快照：resetRequired/truncated 时拉完整 Part 状态，原子替换本地时间线。
  /// Snapshot 是「状态」不是「事件」：临时构建 Timeline → 校验 → 同步一次性替换。
  Future<void> loadSessionSnapshot(String sessionId) async {
    final res = await transport.sendRequest({
      'type': 'session.snapshot',
      'requestId': _nextRequestId(),
      'sessionId': sessionId,
    });
    if (res['ok'] != true) {
      // 读取失败绝不清空旧 Timeline，只提示
      errorMessage = '快照恢复失败，已保留当前记录';
      notifyListeners();
      return;
    }
    final data = res['data'] as Map<String, dynamic>;
    final epoch = data['streamEpoch'] as String? ?? '';
    final watermark = (data['watermark'] as num?)?.toInt() ?? 0;
    final parts = (data['parts'] as List<dynamic>? ?? const []);
    // 阶段二：独立构建临时 Timeline（不修改现有状态）
    final nextTimeline = <SessionTimelineItem>[];
    for (final raw in parts) {
      final p = Map<String, dynamic>.from(raw as Map);
      final kind = p['kind'] as String?;
      if (kind == 'message') {
        final role = p['role'] as String?;
        final content = (p['content'] as List<dynamic>? ?? const [])
            .map((b) => Map<String, dynamic>.from(b as Map))
            .where((b) => b['type'] == 'text')
            .map((b) => b['text'] as String? ?? '')
            .join();
        if (content.isEmpty) continue;
        if (role == 'user') {
          nextTimeline.add(UserPromptItem(content));
        } else {
          nextTimeline.add(StreamingTextItem(text: content, isThinking: false));
        }
      } else if (kind == 'thinking') {
        nextTimeline.add(StreamingTextItem(text: p['content'] as String? ?? '', isThinking: true));
      } else if (kind == 'tool_call') {
        nextTimeline.add(ToolCallCardItem(
          toolCallId: p['toolCallId'] as String? ?? '',
          name: p['name'] as String? ?? 'tool',
          input: Map<String, dynamic>.from(p['input'] as Map? ?? const {}),
          resultContent: p['output'] as String?,
          isError: p['isError'] as bool? ?? false,
        ));
      } else if (kind == 'error') {
        nextTimeline.add(ErrorCardItem(
          code: p['code'] as String? ?? 'ERROR',
          message: p['message'] as String? ?? 'Error',
          retryable: p['retryable'] as bool? ?? false,
        ));
      } else if (kind == 'usage') {
        nextTimeline.add(UsageSummaryItem(
          inputTokens: (p['inputTokens'] as num?)?.toInt() ?? 0,
          outputTokens: (p['outputTokens'] as num?)?.toInt() ?? 0,
          costUsd: (p['costUsd'] as num?)?.toDouble() ?? 0.0,
        ));
      }
    }
    // 阶段三/四：同步原子替换（不 await），一次 notify
    if (epoch.isNotEmpty) _currentEpochBySession[sessionId] = epoch;
    _timelineBySession[sessionId] = nextTimeline;
    _lastSequenceBySession.removeWhere((k, _) => k == sessionId || k.startsWith('$sessionId#'));
    if (epoch.isNotEmpty) _lastSequenceBySession['$sessionId#$epoch'] = watermark;
    _pendingEventsByEpoch.removeWhere((k, _) => k == sessionId || k.startsWith('$sessionId#'));
    _seenEventIds.removeWhere((k) => k.startsWith('$sessionId#'));
    notifyListeners();
    // 阶段五：接续 watermark 之后的增量
    await replayMissedEvents(sessionId);
  }

  /// 撤回最后一条用户消息：从时间线移除（真撤回），返回其内容供输入框编辑重发。
  String? recallLastUserPrompt(String sessionId) {
    final items = _timelineBySession[sessionId];
    if (items == null || items.isEmpty) return null;
    for (int i = items.length - 1; i >= 0; i--) {
      if (items[i] is UserPromptItem) {
        final msg = (items[i] as UserPromptItem).message;
        items.removeAt(i);
        // 一并清掉其后未完成的占位（并取消计时器），保持时间线干净
        while (items.isNotEmpty && items.last is PendingResponseItem) {
          final p = items.removeLast() as PendingResponseItem;
          _pendingTimers.remove(p)?.cancel();
        }
        notifyListeners();
        return msg;
      }
    }
    return null;
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
    activeSession = sessions.where((s) => s.agentId == agentId).firstOrNull;
    models = const [];
    selectedModelId = null;
    notifyListeners();
    await loadModels(agentId);
  }

  AgentInfo? get selectedAgentInfo {
    return agents.where((a) => a.id == selectedAgentId).firstOrNull;
  }

  List<ProjectWorkspaceGroup> projectsForAgent([String? agentId]) {
    final targetAgent = agentId ?? selectedAgentId;
    final filtered = sessions.where((s) => s.agentId == targetAgent).toList();
    final grouped = <String, List<AgentSession>>{};
    for (final session in filtered) {
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

  int _modelRequestGeneration = 0;

  Future<void> loadModels(String agentId) async {
    final generation = ++_modelRequestGeneration;
    final res = await transport.sendRequest({
      'type': 'models.list',
      'requestId': _nextRequestId(),
      'agentId': agentId,
    });
    // 请求代际保护：快速切换 Agent 时，旧响应不能覆盖新 Agent 的模型列表
    if (generation != _modelRequestGeneration) return;
    if (res['ok'] == true) {
      final list = (res['data'] as Map<String, dynamic>)['models'] as List<dynamic>? ?? const [];
      models = list
          .map((item) => ModelInfo.fromJson(Map<String, dynamic>.from(item as Map)))
          .toList();
      if (selectedModelId == null || !models.any((m) => m.id == selectedModelId)) {
        selectedModelId =
            models.where((m) => m.isDefault).firstOrNull?.id ?? models.firstOrNull?.id;
      }
    } else {
      models = const [];
      selectedModelId = null;
    }
    notifyListeners();
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
    selectedAgentId = created.agentId;
    activeSession = created;
    await loadModels(created.agentId);
    notifyListeners();
    return created;
  }

  Future<void> openSession(AgentSession session) async {
    selectedAgentId = session.agentId;
    await loadModels(session.agentId);
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
    if ((_timelineBySession[session.id] ?? const []).isEmpty) {
      try {
        await replayMissedEvents(session.id);
      } catch (_) {}
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
    final trimmed = text.trim();
    if (trimmed.isEmpty) return;

    AgentSession? current = activeSession;
    if (current == null) {
      final targetAgent = selectedAgentId.isNotEmpty
          ? selectedAgentId
          : (agents.where((a) => a.available).firstOrNull?.id ?? 'opencode');
      current = await createSession(
        agentId: targetAgent,
        title: trimmed.length > 28 ? trimmed.substring(0, 28) : trimmed,
      );
    }

    final items = _timelineBySession.putIfAbsent(current.id, () => []);
    items.add(UserPromptItem(trimmed));
    final pending = PendingResponseItem(promptText: trimmed);
    items.add(pending);
    _startPendingTimer(current.id, pending);
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
      _resolvePending(current.id, pending);
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

  /// 启动「等待回复」超时计时器：到期若 Agent 仍在运行则继续等待，
  /// 仅当会话不在运行态且仍无回复内容时才判定为超时（此时重试才安全）。
  void _startPendingTimer(String sessionId, PendingResponseItem pending) {
    _pendingTimers[pending] = Timer(pendingResponseTimeout, () {
      final items = _timelineBySession[sessionId];
      if (items == null || !items.contains(pending)) return;
      // Agent 正在工作（running）：不算超时，重新计时继续等待
      if (_sessionStatusBySession[sessionId] == 'running') {
        _startPendingTimer(sessionId, pending);
        return;
      }
      _pendingTimers.remove(pending);
      if (!pending.timedOut) {
        pending.timedOut = true;
        notifyListeners();
      }
    });
  }

  /// 收到回复内容或会话空闲时，移除「等待中」占位并取消超时计时。
  void _resolvePending(String sessionId, [PendingResponseItem? specific]) {
    final timer = specific != null ? _pendingTimers.remove(specific) : null;
    timer?.cancel();
    final items = _timelineBySession[sessionId];
    if (items == null) return;
    if (specific != null) {
      items.remove(specific);
      return;
    }
    // 未指定时移除末尾的等待占位（回复开始 / 结束）
    while (items.isNotEmpty && items.last is PendingResponseItem) {
      final p = items.removeLast() as PendingResponseItem;
      _pendingTimers.remove(p)?.cancel();
    }
  }

  /// 兜底卡片的「重试」：重发该卡片记录的 prompt。
  Future<void> retryPrompt(String promptText) async {
    await sendMessage(promptText);
  }

  void _handleServerMessage(Map<String, dynamic> raw) {
    if (raw['type'] == 'transport.disconnected') {
      if (connectionState == BridgeConnectionState.connected) {
        final targetMachine = activeMachineId;
        Future<void>.delayed(const Duration(milliseconds: 1200), () async {
          for (int attempt = 0; attempt < 4; attempt++) {
            try {
              await reconnectWithSavedCredential(targetMachine);
              return;
            } catch (_) {
              await Future<void>.delayed(const Duration(milliseconds: 1500));
            }
          }
        });
      }
      return;
    }
    if (raw['type'] != 'session.event') return;
    final eventMap = raw['event'] as Map?;
    if (eventMap == null) return;

    final event = CanonicalAgentEvent.fromJson(Map<String, dynamic>.from(eventMap));

    // 1) eventId 幂等去重（含 sessionId+epoch）：同一历史事件在不同 epoch 可有相同
    //    eventId，故去重键必须带 epoch，避免跨 epoch 误判为重复。
    if (event.eventId.isNotEmpty) {
      final dedupeKey = '${event.sessionId}#${event.streamEpoch}#${event.eventId}';
      if (_seenEventIds.contains(dedupeKey)) return;
      _seenEventIds.add(dedupeKey);
      if (_seenEventIds.length > _maxSeenEventIds) {
        _seenEventIds.remove(_seenEventIds.first);
      }
    }

    // 2) epoch 切换：新事件流的第一条（seq=1，如 Bridge 重启）切换 epoch 并应用；
    //    旧 epoch 迟到事件（seq>1 且 epoch 不同）不混排、不切换，触发 replay 同步。
    final currentEpoch = _currentEpochBySession[event.sessionId];
    if (currentEpoch == null || currentEpoch.isEmpty) {
      _currentEpochBySession[event.sessionId] = event.streamEpoch;
    } else if (event.streamEpoch.isNotEmpty && event.streamEpoch != currentEpoch) {
      if (event.sequence <= 1) {
        // 新事件流起点：切换 epoch（sequence 也重置）
        _currentEpochBySession[event.sessionId] = event.streamEpoch;
      } else {
        // 旧 epoch 迟到事件：丢弃 + 触发 replay 拿正确 epoch/事件
        if (!_gapReplayInFlight.contains(event.sessionId)) {
          _gapReplayInFlight.add(event.sessionId);
          unawaited(
            replayMissedEvents(event.sessionId).whenComplete(
              () => _gapReplayInFlight.remove(event.sessionId),
            ),
          );
        }
        return;
      }
    }
    final epochKey = '${event.sessionId}#${event.streamEpoch}';
    final lastApplied = _lastSequenceBySession[epochKey] ?? 0;
    if (event.sequence <= lastApplied) {
      return; // 重复事件
    }
    if (event.sequence > lastApplied + 1) {
      // 缺口：暂存到乱序缓冲，并触发回放补齐
      _pendingEventsByEpoch.putIfAbsent(epochKey, () => {})[event.sequence] = event;
      if (!_gapReplayInFlight.contains(event.sessionId)) {
        _gapReplayInFlight.add(event.sessionId);
        unawaited(
          replayMissedEvents(event.sessionId).whenComplete(
            () => _gapReplayInFlight.remove(event.sessionId),
          ),
        );
      }
      return;
    }
    // 连续：应用 + 排空缓冲中的连续事件
    _applyInOrder(epochKey, event);

    notifyListeners();
  }

  /// 应用一个连续事件，并排空乱序缓冲里可连续应用的后续事件。
  void _applyInOrder(String epochKey, CanonicalAgentEvent first) {
    var seq = first.sequence;
    _applyCanonicalEvent(first);
    _lastSequenceBySession[epochKey] = seq;
    final pending = _pendingEventsByEpoch[epochKey];
    if (pending == null) return;
    while (pending.containsKey(seq + 1)) {
      final next = pending.remove(seq + 1)!;
      _applyCanonicalEvent(next);
      seq = next.sequence;
      _lastSequenceBySession[epochKey] = seq;
    }
    if (pending.isEmpty) _pendingEventsByEpoch.remove(epochKey);
  }

  /// 将事件写入时间线（状态归约）；事件必须已按 sequence 有序调用。
  void _applyCanonicalEvent(CanonicalAgentEvent event) {
    final items = _timelineBySession.putIfAbsent(event.sessionId, () => []);

    switch (event.type) {
      case 'status':
        final status = event.payload['status'] as String? ?? 'idle';
        _sessionStatusBySession[event.sessionId] = status;
        if (status == 'idle') {
          // 回复结束：收起「等待中」占位
          _resolvePending(event.sessionId);
        }
        final permissionId = event.payload['permissionId'] as String?;
        if (status == 'waiting' && permissionId != null) {
          // 权限请求到达：收起「等待中」占位，改为展示权限卡片
          _resolvePending(event.sessionId);
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
        final role = event.payload['role'] as String?;
        if (role == 'user') {
          items.add(UserPromptItem(delta));
          break;
        }
        // 回复内容开始到达：收起「等待中」占位
        _resolvePending(event.sessionId);
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
        _resolvePending(event.sessionId);
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
        _resolvePending(event.sessionId);
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
        _resolvePending(event.sessionId);
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
  }

  String _nextRequestId() => 'mreq_${++_requestCounter}';

  @override
  void dispose() {
    for (final timer in _pendingTimers.values) {
      timer.cancel();
    }
    _pendingTimers.clear();
    _subscription?.cancel();
    transport.close();
    super.dispose();
  }
}
