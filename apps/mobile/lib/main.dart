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
}

abstract class DeviceCredentialStore {
  Future<void> save(SavedDeviceCredential credential);
  Future<SavedDeviceCredential?> load();
  Future<void> clear();
}

class InMemoryCredentialStore implements DeviceCredentialStore {
  SavedDeviceCredential? _saved;

  @override
  Future<void> save(SavedDeviceCredential credential) async {
    _saved = credential;
  }

  @override
  Future<SavedDeviceCredential?> load() async => _saved;

  @override
  Future<void> clear() async {
    _saved = null;
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

class FakeBridgeTransport implements BridgeTransport {
  final StreamController<Map<String, dynamic>> _incomingController =
      StreamController<Map<String, dynamic>>.broadcast();
  final List<String> sentPrompts = [];

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
        return {
          'type': 'response',
          'requestId': requestId,
          'ok': true,
          'data': {'accepted': true, 'sessionId': request['sessionId']},
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

  Future<void> reconnectWithSavedCredential() async {
    final saved = await credentialStore.load();
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
    notifyListeners();
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
        // Agent list bar
        SizedBox(
          height: 60,
          child: ListView.separated(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            scrollDirection: Axis.horizontal,
            itemCount: client.agents.length,
            separatorBuilder: (_, __) => const SizedBox(width: 8),
            itemBuilder: (context, index) {
              final agent = client.agents[index];
              return Chip(
                avatar: Icon(
                  agent.available ? Icons.check_circle_outline : Icons.cancel_outlined,
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
        };
      },
    );
  }
}
