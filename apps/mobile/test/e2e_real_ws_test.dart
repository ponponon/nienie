import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:nienie_mobile/main.dart';

void main() {
  test(
    'IoBridgeTransport connects over real WebSocket, pairs, reconnects with token, and streams canonical events into MobileBridgeClient',
    () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      addTearDown(() async => server.close(force: true));

      final List<WebSocket> sockets = [];
      server.transform(WebSocketTransformer()).listen((WebSocket ws) {
        sockets.add(ws);
        ws.listen((dynamic raw) {
          final req = jsonDecode(raw as String) as Map<String, dynamic>;
          final reqId = req['requestId'] as String;
          final type = req['type'] as String;

          switch (type) {
            case 'pair.confirm':
              ws.add(
                jsonEncode({
                  'type': 'response',
                  'requestId': reqId,
                  'ok': true,
                  'data': {
                    'deviceId': 'dev_real_ws',
                    'deviceToken': 'ntk_real_ws_secret_token',
                    'machineId': 'machine_e2e',
                    'pairedAt': '2026-11-04T10:00:00Z',
                  },
                }),
              );
              break;
            case 'hello':
              ws.add(
                jsonEncode({
                  'type': 'response',
                  'requestId': reqId,
                  'ok': true,
                  'data': {
                    'protocolVersion': 1,
                    'machineId': 'machine_e2e',
                    'authenticated': req['deviceToken'] == 'ntk_real_ws_secret_token',
                  },
                }),
              );
              break;
            case 'agents.list':
              ws.add(
                jsonEncode({
                  'type': 'response',
                  'requestId': reqId,
                  'ok': true,
                  'data': {
                    'agents': [
                      {'id': 'opencode', 'name': 'OpenCode', 'available': true, 'version': '0.15.2'},
                    ],
                  },
                }),
              );
              break;
            case 'sessions.list':
              ws.add(
                jsonEncode({
                  'type': 'response',
                  'requestId': reqId,
                  'ok': true,
                  'data': {
                    'sessions': [
                      {
                        'id': 'ses_e2e_1',
                        'agentId': 'opencode',
                        'title': 'E2E Real WS Session',
                        'projectPath': '/workspace/nienie',
                        'status': 'idle',
                      },
                    ],
                  },
                }),
              );
              break;
            case 'session.load':
              ws.add(
                jsonEncode({
                  'type': 'response',
                  'requestId': reqId,
                  'ok': true,
                  'data': {
                    'session': {
                      'id': 'ses_e2e_1',
                      'agentId': 'opencode',
                      'title': 'E2E Real WS Session',
                      'projectPath': '/workspace/nienie',
                      'status': 'idle',
                    },
                  },
                }),
              );
              break;
            case 'session.send':
              ws.add(
                jsonEncode({
                  'type': 'response',
                  'requestId': reqId,
                  'ok': true,
                  'data': {'accepted': true, 'sessionId': 'ses_e2e_1'},
                }),
              );
              ws.add(
                jsonEncode({
                  'type': 'session.event',
                  'event': {
                    'version': 1,
                    'eventId': 'evt_ws_1',
                    'sessionId': 'ses_e2e_1',
                    'sequence': 1,
                    'timestamp': '2026-11-04T10:00:01Z',
                    'type': 'text_delta',
                    'payload': {'delta': 'Real WebSocket E2E OK'},
                  },
                }),
              );
              break;
          }
        });
      });

      final wsUrl = 'ws://127.0.0.1:${server.port}';
      final store = InMemoryCredentialStore();
      final client = MobileBridgeClient(
        transport: IoBridgeTransport(),
        credentialStore: store,
      );
      addTearDown(client.dispose);

      // Pair & connect
      await client.pairAndConnect(wsUrl: wsUrl, pairingCode: '999888');
      expect(client.connectionState, BridgeConnectionState.connected);
      expect(client.agents.single.id, 'opencode');
      expect(client.sessions.single.id, 'ses_e2e_1');

      // Reconnect using saved deviceToken
      await client.reconnectWithSavedCredential();
      expect(client.connectionState, BridgeConnectionState.connected);

      // Enter session and send prompt
      await client.openSession(client.sessions.single);
      await client.sendMessage('ping e2e');

      await Future<void>.delayed(const Duration(milliseconds: 50));
      final timeline = client.timelineFor('ses_e2e_1');
      expect(timeline.length, 2);
      expect((timeline[0] as UserPromptItem).message, 'ping e2e');
      expect((timeline[1] as StreamingTextItem).text, 'Real WebSocket E2E OK');
    },
  );
}
