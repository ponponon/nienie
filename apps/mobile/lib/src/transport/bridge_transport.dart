import 'dart:async';
import 'dart:convert';
import 'dart:io';
import '../models/protocol_models.dart';

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
