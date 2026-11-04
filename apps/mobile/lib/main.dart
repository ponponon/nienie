import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';

const int PROTOCOL_VERSION = 1;
const String DEFAULT_RELAY_URL = 'wss://nienie-replay.quniv.cn';

void main() {
  runApp(
    NienieMobileApp(
      client: MobileBridgeClient(
        transport: IoBridgeTransport(),
        credentialStore: InMemoryCredentialStore(),
      ),
    ),
  );
}

class PairingQrPayload {
  final int version;
  final String machineId;
  final String wsUrl;
  final String relayUrl;
  final String pairingCode;
  final String expiresAt;

  const PairingQrPayload({
    required this.version,
    required this.machineId,
    required this.wsUrl,
    required this.relayUrl,
    required this.pairingCode,
    required this.expiresAt,
  });

  static PairingQrPayload decode(String input) {
    final trimmed = input.trim();
    String jsonText = trimmed;
    if (trimmed.startsWith('nienie://')) {
      final uri = Uri.parse(trimmed);
      final dataParam = uri.queryParameters['data'];
      if (dataParam == null || dataParam.isEmpty) {
        throw const FormatException('Missing data parameter in pairing URI');
      }
      final normalized = base64Url.normalize(dataParam);
      jsonText = utf8.decode(base64Url.decode(normalized));
    }

    final map = jsonDecode(jsonText) as Map<String, dynamic>;
    final version = map['version'];
    if (version != PROTOCOL_VERSION) {
      throw FormatException('Unsupported pairing QR version: $version');
    }

    final customRelay = (map['relayUrl'] as String?)?.trim();
    return PairingQrPayload(
      version: PROTOCOL_VERSION,
      machineId: map['machineId'] as String,
      wsUrl: map['wsUrl'] as String,
      relayUrl: (customRelay != null && customRelay.isNotEmpty)
          ? customRelay
          : DEFAULT_RELAY_URL,
      pairingCode: map['pairingCode'] as String,
      expiresAt: map['expiresAt'] as String,
    );
  }
}

class AgentInfo {
  final String id;
  final String name;
  final bool available;
  final String? version;

  const AgentInfo({
    required this.id,
    required this.name,
    required this.available,
    this.version,
  });

  factory AgentInfo.fromJson(Map<String, dynamic> json) {
    return AgentInfo(
      id: json['id'] as String,
      name: json['name'] as String,
      available: json['available'] as bool? ?? false,
      version: json['version'] as String?,
    );
  }
}

class ModelInfo {
  final String id;
  final String name;
  final String providerId;
  final bool isDefault;

  const ModelInfo({
    required this.id,
    required this.name,
    required this.providerId,
    required this.isDefault,
  });

  factory ModelInfo.fromJson(Map<String, dynamic> json) {
    return ModelInfo(
      id: json['id'] as String,
      name: json['name'] as String? ?? json['id'] as String,
      providerId: json['providerId'] as String? ?? '',
      isDefault: json['isDefault'] as bool? ?? false,
    );
  }
}

class AgentSession {
  final String id;
  final String agentId;
  final String title;
  final String projectPath;
  final String status;

  const AgentSession({
    required this.id,
    required this.agentId,
    required this.title,
    required this.projectPath,
    required this.status,
  });

  factory AgentSession.fromJson(Map<String, dynamic> json) {
    return AgentSession(
      id: json['id'] as String,
      agentId: json['agentId'] as String,
      title: json['title'] as String? ?? 'Untitled',
      projectPath: json['projectPath'] as String? ?? '',
      status: json['status'] as String? ?? 'idle',
    );
  }
}

class CanonicalAgentEvent {
  final int version;
  final String eventId;
  final String sessionId;
  final int sequence;
  final String timestamp;
  final String type;
  final Map<String, dynamic> payload;

  const CanonicalAgentEvent({
    required this.version,
    required this.eventId,
    required this.sessionId,
    required this.sequence,
    required this.timestamp,
    required this.type,
    required this.payload,
  });

  factory CanonicalAgentEvent.fromJson(Map<String, dynamic> json) {
    return CanonicalAgentEvent(
      version: json['version'] as int? ?? PROTOCOL_VERSION,
      eventId: json['eventId'] as String? ?? '',
      sessionId: json['sessionId'] as String,
      sequence: json['sequence'] as int,
      timestamp: json['timestamp'] as String? ?? '',
      type: json['type'] as String,
      payload: Map<String, dynamic>.from(json['payload'] as Map? ?? const {}),
    );
  }
}

sealed class SessionTimelineItem {
  const SessionTimelineItem();
}

class UserPromptItem extends SessionTimelineItem {
  final String message;
  const UserPromptItem(this.message);
}

class StreamingTextItem extends SessionTimelineItem {
  String text;
  final bool isThinking;
  StreamingTextItem({required this.text, this.isThinking = false});
}

class ToolCallCardItem extends SessionTimelineItem {
  final String toolCallId;
  final String name;
  final Map<String, dynamic> input;
  String? resultContent;
  bool isError;

  ToolCallCardItem({
    required this.toolCallId,
    required this.name,
    required this.input,
    this.resultContent,
    this.isError = false,
  });
}

class ErrorCardItem extends SessionTimelineItem {
  final String code;
  final String message;
  final bool retryable;

  const ErrorCardItem({
    required this.code,
    required this.message,
    required this.retryable,
  });
}

class PermissionRequestCardItem extends SessionTimelineItem {
  final String permissionId;
  final String permission;
  final String detail;
  final List<String> patterns;
  String? resolvedDecision;

  PermissionRequestCardItem({
    required this.permissionId,
    required this.permission,
    required this.detail,
    this.patterns = const [],
    this.resolvedDecision,
  });
}

class FileDiffCardItem extends SessionTimelineItem {
  final String file;
  final int additions;
  final int deletions;

  const FileDiffCardItem({
    required this.file,
    required this.additions,
    required this.deletions,
  });
}

class ScreenCaptureCardItem extends SessionTimelineItem {
  final String frameId;
  final String displayId;
  final int width;
  final int height;
  final String capturedAt;

  const ScreenCaptureCardItem({
    required this.frameId,
    required this.displayId,
    required this.width,
    required this.height,
    required this.capturedAt,
  });
}

class SavedDeviceCredential {
  final String machineId;
  final String wsUrl;
  final String deviceId;
  final String deviceToken;

  const SavedDeviceCredential({
    required this.machineId,
    required this.wsUrl,
    required this.deviceId,
    required this.deviceToken,
  });

  Map<String, dynamic> toJson() => {
        'machineId': machineId,
        'wsUrl': wsUrl,
        'deviceId': deviceId,
        'deviceToken': deviceToken,
      };

  factory SavedDeviceCredential.fromJson(Map<String, dynamic> json) {
    return SavedDeviceCredential(
      machineId: json['machineId'] as String,
      wsUrl: json['wsUrl'] as String,
      deviceId: json['deviceId'] as String,
      deviceToken: json['deviceToken'] as String,
    );
  }
}

abstract class DeviceCredentialStore {
  Future<void> save(SavedDeviceCredential credential);
  Future<SavedDeviceCredential?> load([String? machineId]);
  Future<List<SavedDeviceCredential>> listMachines();
  Future<void> removeMachine(String machineId);
  Future<void> clear();
}

class InMemoryCredentialStore implements DeviceCredentialStore {
  final Map<String, SavedDeviceCredential> _machines = {};
  String? _activeMachineId;

  @override
  Future<void> save(SavedDeviceCredential credential) async {
    _machines[credential.machineId] = credential;
    _activeMachineId = credential.machineId;
  }

  @override
  Future<SavedDeviceCredential?> load([String? machineId]) async {
    final targetId = machineId ?? _activeMachineId;
    if (targetId == null) return null;
    return _machines[targetId];
  }

  @override
  Future<List<SavedDeviceCredential>> listMachines() async {
    return List.unmodifiable(_machines.values);
  }

  @override
  Future<void> removeMachine(String machineId) async {
    _machines.remove(machineId);
    if (_activeMachineId == machineId) {
      _activeMachineId = _machines.keys.firstOrNull;
    }
  }

  @override
  Future<void> clear() async {
    _machines.clear();
    _activeMachineId = null;
  }
}

class FileCredentialStore implements DeviceCredentialStore {
  final File file;

  const FileCredentialStore(this.file);

  Future<Map<String, dynamic>> _readState() async {
    if (!await file.exists()) {
      return {'activeMachineId': null, 'machines': <String, dynamic>{}};
    }
    final text = await file.readAsString();
    if (text.trim().isEmpty) {
      return {'activeMachineId': null, 'machines': <String, dynamic>{}};
    }
    return Map<String, dynamic>.from(jsonDecode(text) as Map);
  }

  Future<void> _writeState(Map<String, dynamic> state) async {
    await file.parent.create(recursive: true);
    await file.writeAsString(jsonEncode(state));
  }

  @override
  Future<void> save(SavedDeviceCredential credential) async {
    final state = await _readState();
    final machines = Map<String, dynamic>.from(
      state['machines'] as Map? ?? const {},
    );
    machines[credential.machineId] = credential.toJson();
    state['machines'] = machines;
    state['activeMachineId'] = credential.machineId;
    await _writeState(state);
  }

  @override
  Future<SavedDeviceCredential?> load([String? machineId]) async {
    final state = await _readState();
    final targetId = machineId ?? state['activeMachineId'] as String?;
    if (targetId == null) return null;
    final machines = Map<String, dynamic>.from(
      state['machines'] as Map? ?? const {},
    );
    final raw = machines[targetId];
    if (raw == null) return null;
    return SavedDeviceCredential.fromJson(Map<String, dynamic>.from(raw as Map));
  }

  @override
  Future<List<SavedDeviceCredential>> listMachines() async {
    final state = await _readState();
    final machines = Map<String, dynamic>.from(
      state['machines'] as Map? ?? const {},
    );
    return machines.values
        .map((raw) => SavedDeviceCredential.fromJson(Map<String, dynamic>.from(raw as Map)))
        .toList();
  }

  @override
  Future<void> removeMachine(String machineId) async {
    final state = await _readState();
    final machines = Map<String, dynamic>.from(
      state['machines'] as Map? ?? const {},
    );
    machines.remove(machineId);
    state['machines'] = machines;
    if (state['activeMachineId'] == machineId) {
      state['activeMachineId'] = machines.keys.firstOrNull;
    }
    await _writeState(state);
  }

  @override
  Future<void> clear() async {
    if (await file.exists()) {
      await file.delete();
    }
  }
}

abstract class BridgeTransport {
  Stream<Map<String, dynamic>> get incomingMessages;
  Future<void> connect(String wsUrl);
  Future<Map<String, dynamic>> sendRequest(Map<String, dynamic> request);
  Future<void> close();
}

class IoBridgeTransport implements BridgeTransport {
  WebSocket? _socket;
  final StreamController<Map<String, dynamic>> _incomingController =
      StreamController<Map<String, dynamic>>.broadcast();
  final Map<String, Completer<Map<String, dynamic>>> _pending = {};

  @override
  Stream<Map<String, dynamic>> get incomingMessages => _incomingController.stream;

  @override
  Future<void> connect(String wsUrl) async {
    await close();
    final socket = await WebSocket.connect(wsUrl);
    _socket = socket;
    socket.listen(
      (dynamic raw) {
        final decoded = jsonDecode(raw as String) as Map<String, dynamic>;
        if (decoded['type'] == 'response') {
          final reqId = decoded['requestId'] as String?;
          final completer = reqId != null ? _pending.remove(reqId) : null;
          completer?.complete(decoded);
        } else {
          _incomingController.add(decoded);
        }
      },
      onDone: () {
        for (final completer in _pending.values) {
          if (!completer.isCompleted) {
            completer.completeError(StateError('WebSocket connection closed'));
          }
        }
        _pending.clear();
      },
    );
  }

  @override
  Future<Map<String, dynamic>> sendRequest(Map<String, dynamic> request) {
    final socket = _socket;
    if (socket == null) {
      throw StateError('Not connected to Bridge WebSocket');
    }
    final requestId = request['requestId'] as String;
    final completer = Completer<Map<String, dynamic>>();
    _pending[requestId] = completer;
    socket.add(jsonEncode(request));
    return completer.future;
  }

  @override
  Future<void> close() async {
    final socket = _socket;
    _socket = null;
    if (socket != null) {
      await socket.close();
    }
  }
}

class RelayBridgeTransport implements BridgeTransport {
  final String machineId;
  final String clientId;
  bool bridgeOnline = false;

  WebSocket? _socket;
  final StreamController<Map<String, dynamic>> _incomingController =
      StreamController<Map<String, dynamic>>.broadcast();
  final Map<String, Completer<Map<String, dynamic>>> _pending = {};

  RelayBridgeTransport({
    required this.machineId,
    required this.clientId,
  });

  @override
  Stream<Map<String, dynamic>> get incomingMessages => _incomingController.stream;

  @override
  Future<void> connect(String relayUrl) async {
    await close();
    final targetUrl = relayUrl.trim().isNotEmpty ? relayUrl.trim() : DEFAULT_RELAY_URL;
    final socket = await WebSocket.connect(targetUrl);
    _socket = socket;
    final regCompleter = Completer<void>();

    socket.listen(
      (dynamic raw) {
        final msg = jsonDecode(raw as String) as Map<String, dynamic>;
        final type = msg['type'] as String?;

        if (type == 'relay.registered') {
          bridgeOnline = msg['bridgeOnline'] as bool? ?? false;
          if (!regCompleter.isCompleted) {
            regCompleter.complete();
          }
          return;
        }

        if (type == 'relay.presence') {
          bridgeOnline = msg['bridgeOnline'] as bool? ?? false;
          return;
        }

        if (type == 'relay.forward') {
          final payloadText = msg['payload'] as String?;
          if (payloadText == null) return;
          final inner = jsonDecode(payloadText) as Map<String, dynamic>;
          if (inner['type'] == 'response') {
            final reqId = inner['requestId'] as String?;
            final completer = reqId != null ? _pending.remove(reqId) : null;
            completer?.complete(inner);
          } else {
            _incomingController.add(inner);
          }
        }
      },
      onDone: () {
        bridgeOnline = false;
        for (final completer in _pending.values) {
          if (!completer.isCompleted) {
            completer.completeError(StateError('Relay WebSocket closed'));
          }
        }
        _pending.clear();
      },
    );

    socket.add(
      jsonEncode({
        'type': 'relay.register',
        'role': 'mobile',
        'machineId': machineId,
        'clientId': clientId,
      }),
    );

    await regCompleter.future;
  }

  @override
  Future<Map<String, dynamic>> sendRequest(Map<String, dynamic> request) {
    final socket = _socket;
    if (socket == null) {
      throw StateError('Not connected to Relay WebSocket');
    }
    final requestId = request['requestId'] as String;
    final completer = Completer<Map<String, dynamic>>();
    _pending[requestId] = completer;

    socket.add(
      jsonEncode({
        'type': 'relay.forward',
        'machineId': machineId,
        'fromClientId': clientId,
        'payload': jsonEncode(request),
      }),
    );
    return completer.future;
  }

  @override
  Future<void> close() async {
    final socket = _socket;
    _socket = null;
    if (socket != null) {
      await socket.close();
    }
  }
}

enum BridgeRouteMode { direct, relay }

class AutoFallbackBridgeTransport implements BridgeTransport {
  final BridgeTransport directTransport;
  final BridgeTransport relayTransport;
  final String relayUrl;

  BridgeRouteMode activeMode = BridgeRouteMode.direct;
  final StreamController<Map<String, dynamic>> _incomingController =
      StreamController<Map<String, dynamic>>.broadcast();
  StreamSubscription<Map<String, dynamic>>? _directSub;
  StreamSubscription<Map<String, dynamic>>? _relaySub;

  AutoFallbackBridgeTransport({
    required this.directTransport,
    required this.relayTransport,
    this.relayUrl = DEFAULT_RELAY_URL,
  }) {
    _directSub = directTransport.incomingMessages.listen((msg) {
      if (activeMode == BridgeRouteMode.direct) {
        _incomingController.add(msg);
      }
    });
    _relaySub = relayTransport.incomingMessages.listen((msg) {
      if (activeMode == BridgeRouteMode.relay) {
        _incomingController.add(msg);
      }
    });
  }

  @override
  Stream<Map<String, dynamic>> get incomingMessages => _incomingController.stream;

  @override
  Future<void> connect(String wsUrl) async {
    try {
      await directTransport.connect(wsUrl);
      activeMode = BridgeRouteMode.direct;
    } catch (_) {
      final targetRelay = relayUrl.trim().isNotEmpty ? relayUrl.trim() : DEFAULT_RELAY_URL;
      await relayTransport.connect(targetRelay);
      activeMode = BridgeRouteMode.relay;
    }
  }

  @override
  Future<Map<String, dynamic>> sendRequest(Map<String, dynamic> request) {
    final active = activeMode == BridgeRouteMode.relay ? relayTransport : directTransport;
    return active.sendRequest(request);
  }

  @override
  Future<void> close() async {
    await _directSub?.cancel();
    await _relaySub?.cancel();
    await directTransport.close();
    await relayTransport.close();
  }
}

class FakeBridgeTransport implements BridgeTransport {
  final StreamController<Map<String, dynamic>> _incomingController =
      StreamController<Map<String, dynamic>>.broadcast();
  final List<String> sentPrompts = [];
  final List<String?> sentModelIds = [];
  final List<Map<String, String>> permissionReplies = [];
  final List<Map<String, String>> registeredPushes = [];

  @override
  Stream<Map<String, dynamic>> get incomingMessages => _incomingController.stream;

  @override
  Future<void> connect(String wsUrl) async {}

  @override
  Future<Map<String, dynamic>> sendRequest(Map<String, dynamic> request) async {
    final requestId = request['requestId'] as String;
    final type = request['type'] as String;

    switch (type) {
      case 'pair.confirm':
        return {
          'type': 'response',
          'requestId': requestId,
          'ok': true,
          'data': {
            'deviceId': 'dev_mobile_1',
            'deviceToken': 'ntk_fake_token_1234567890',
            'machineId': 'machine_mac',
            'pairedAt': '2026-11-04T10:00:00Z',
          },
        };
      case 'hello':
        return {
          'type': 'response',
          'requestId': requestId,
          'ok': true,
          'data': {
            'protocolVersion': PROTOCOL_VERSION,
            'machineId': 'machine_mac',
            'authenticated': true,
          },
        };
      case 'agents.list':
        return {
          'type': 'response',
          'requestId': requestId,
          'ok': true,
          'data': {
            'agents': [
              {'id': 'opencode', 'name': 'OpenCode', 'available': true, 'version': '0.15.2'},
              {'id': 'codex', 'name': 'Codex', 'available': false},
            ],
          },
        };
      case 'models.list':
        return {
          'type': 'response',
          'requestId': requestId,
          'ok': true,
          'data': {
            'agentId': request['agentId'],
            'models': [
              {
                'id': 'anthropic/claude-sonnet-4',
                'name': 'Claude Sonnet 4',
                'providerId': 'anthropic',
                'isDefault': true,
              },
            ],
          },
        };
      case 'sessions.list':
        return {
          'type': 'response',
          'requestId': requestId,
          'ok': true,
          'data': {
            'sessions': [
              {
                'id': 'ses_alpha',
                'agentId': 'opencode',
                'title': 'Implement OpenCode adapter',
                'projectPath': '/workspace/nienie',
                'status': 'idle',
              },
            ],
          },
        };
      case 'session.load':
        return {
          'type': 'response',
          'requestId': requestId,
          'ok': true,
          'data': {
            'session': {
              'id': request['sessionId'],
              'agentId': request['agentId'],
              'title': 'Implement OpenCode adapter',
              'projectPath': '/workspace/nienie',
              'status': 'idle',
            },
          },
        };
      case 'session.create':
        return {
          'type': 'response',
          'requestId': requestId,
          'ok': true,
          'data': {
            'session': {
              'id': 'ses_created_mobile',
              'agentId': request['agentId'],
              'title': (request['input'] as Map?)?['title'] ?? 'New Session',
              'projectPath': '/workspace/nienie',
              'status': 'idle',
            },
          },
        };
      case 'session.send':
        sentPrompts.add(request['message'] as String);
        sentModelIds.add(request['modelId'] as String?);
        return {
          'type': 'response',
          'requestId': requestId,
          'ok': true,
          'data': {'accepted': true, 'sessionId': request['sessionId']},
        };
      case 'permission.reply':
        permissionReplies.add({
          'sessionId': request['sessionId'] as String,
          'permissionId': request['permissionId'] as String,
          'decision': request['decision'] as String,
        });
        return {
          'type': 'response',
          'requestId': requestId,
          'ok': true,
          'data': {
            'replied': true,
            'sessionId': request['sessionId'],
            'permissionId': request['permissionId'],
            'decision': request['decision'],
          },
        };
      case 'session.diff':
        return {
          'type': 'response',
          'requestId': requestId,
          'ok': true,
          'data': {
            'sessionId': request['sessionId'],
            'diffs': [
              {
                'file': 'src/index.ts',
                'before': 'a',
                'after': 'b',
                'additions': 3,
                'deletions': 1,
              },
            ],
          },
        };
      case 'push.register':
        registeredPushes.add({
          'platform': request['platform'] as String,
          'provider': request['provider'] as String,
          'pushToken': request['pushToken'] as String,
        });
        return {
          'type': 'response',
          'requestId': requestId,
          'ok': true,
          'data': {
            'registered': true,
            'provider': request['provider'],
          },
        };
      case 'screen.capture':
        return {
          'type': 'response',
          'requestId': requestId,
          'ok': true,
          'data': {
            'frame': {
              'frameId': 'frm_mobile_1',
              'displayId': request['displayId'] ?? 'main',
              'mimeType': 'image/png',
              'width': 1440,
              'height': 900,
              'base64Data': 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
              'capturedAt': '2026-11-04T10:00:00Z',
            },
          },
        };
      default:
        return {
          'type': 'response',
          'requestId': requestId,
          'ok': false,
          'error': {'code': 'UNKNOWN', 'message': 'Unsupported fake command'},
        };
    }
  }

  void emitServerEvent(Map<String, dynamic> canonicalEvent) {
    _incomingController.add({
      'type': 'session.event',
      'event': canonicalEvent,
    });
  }

  @override
  Future<void> close() async {}
}

enum BridgeConnectionState { disconnected, connecting, connected, error }

class MobileBridgeClient extends ChangeNotifier {
  final BridgeTransport transport;
  final DeviceCredentialStore credentialStore;

  BridgeConnectionState connectionState = BridgeConnectionState.disconnected;
  String? errorMessage;
  List<AgentInfo> agents = const [];
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
  }) {
    _subscription = transport.incomingMessages.listen(_handleServerMessage);
  }

  List<SessionTimelineItem> timelineFor(String sessionId) {
    return List.unmodifiable(_timelineBySession[sessionId] ?? const []);
  }

  String statusFor(String sessionId) {
    return _sessionStatusBySession[sessionId] ??
        activeSession?.status ??
        'idle';
  }

  Future<void> pairAndConnect({
    required String wsUrl,
    required String pairingCode,
    String deviceName = 'Nienie Flutter Mobile',
    String platform = 'ios',
  }) async {
    connectionState = BridgeConnectionState.connecting;
    errorMessage = null;
    notifyListeners();

    try {
      await transport.connect(wsUrl);
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
      await credentialStore.save(
        SavedDeviceCredential(
          machineId: data['machineId'] as String,
          wsUrl: wsUrl,
          deviceId: data['deviceId'] as String,
          deviceToken: data['deviceToken'] as String,
        ),
      );

      connectionState = BridgeConnectionState.connected;
      await refreshAgents();
      await refreshSessions();
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

    connectionState = BridgeConnectionState.connected;
    await refreshAgents();
    await refreshSessions();
    if (activeSession != null) {
      await replayMissedEvents(activeSession!.id);
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
      notifyListeners();
    }
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
  final TextEditingController _promptController = TextEditingController();

  @override
  void dispose() {
    _wsUrlController.dispose();
    _pairingCodeController.dispose();
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
                  const Text('Nienie Console'),
                  const Spacer(),
                  _buildConnectionBadge(client.connectionState),
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

  Widget _buildConnectionBadge(BridgeConnectionState state) {
    final label = switch (state) {
      BridgeConnectionState.connected => 'Connected',
      BridgeConnectionState.connecting => 'Connecting',
      BridgeConnectionState.error => 'Error',
      BridgeConnectionState.disconnected => 'Disconnected',
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
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Card(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Row(
                  children: [
                    Icon(Icons.qr_code_scanner, size: 18, color: Color(0xFF3B82F6)),
                    SizedBox(width: 8),
                    Text(
                      'Connect to Computer Bridge',
                      style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
                    ),
                  ],
                ),
                const SizedBox(height: 12),
                TextField(
                  key: const Key('input-ws-url'),
                  controller: _wsUrlController,
                  decoration: const InputDecoration(
                    labelText: 'Bridge WebSocket URL',
                    border: OutlineInputBorder(),
                  ),
                ),
                const SizedBox(height: 12),
                TextField(
                  key: const Key('input-pairing-code'),
                  controller: _pairingCodeController,
                  decoration: const InputDecoration(
                    labelText: 'One-Time Pairing Code',
                    border: OutlineInputBorder(),
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
                  label: const Text('Pair & Connect'),
                ),
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
                    return Chip(
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
              ? const Center(child: Text('Select a session to inspect events'))
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
                const SizedBox(width: 4),
                Expanded(
                  child: TextField(
                    key: const Key('input-session-prompt'),
                    controller: _promptController,
                    decoration: const InputDecoration(
                      hintText: 'Send prompt to local agent...',
                      border: OutlineInputBorder(),
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
                            child: const Text('Allow Once'),
                          ),
                          const SizedBox(width: 8),
                          OutlinedButton(
                            key: Key('btn-perm-reject-${item.permissionId}'),
                            onPressed: () => client.replyPermission(
                              sessionId: session.id,
                              permissionId: item.permissionId,
                              decision: 'reject',
                            ),
                            child: const Text('Reject'),
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
        };
      },
    );
  }
}
