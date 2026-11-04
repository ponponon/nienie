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
            default:
              ws.add(
                jsonEncode({
                  'type': 'response',
                  'requestId': reqId,
                  'ok': true,
                  'data': <String, dynamic>{},
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

  test(
    'RelayBridgeTransport registers mobile role, tracks bridgeOnline presence, and forwards requests/events through Relay',
    () async {
      final relayServer = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      addTearDown(() async => relayServer.close(force: true));

      final List<Map<String, dynamic>> relayReceived = [];
      relayServer.transform(WebSocketTransformer()).listen((WebSocket ws) {
        ws.listen((dynamic raw) {
          final msg = jsonDecode(raw as String) as Map<String, dynamic>;
          relayReceived.add(msg);

          if (msg['type'] == 'relay.register') {
            ws.add(
              jsonEncode({
                'type': 'relay.registered',
                'role': 'mobile',
                'machineId': msg['machineId'],
                'clientId': msg['clientId'],
                'bridgeOnline': true,
              }),
            );
          } else if (msg['type'] == 'relay.forward') {
            final inner = jsonDecode(msg['payload'] as String) as Map<String, dynamic>;
            final reqId = inner['requestId'] as String;
            ws.add(
              jsonEncode({
                'type': 'relay.forward',
                'machineId': msg['machineId'],
                'fromClientId': 'bridge_server_1',
                'toClientId': msg['fromClientId'],
                'payload': jsonEncode({
                  'type': 'response',
                  'requestId': reqId,
                  'ok': true,
                  'data': {
                    'agents': [
                      {'id': 'opencode', 'name': 'OpenCode', 'available': true},
                    ],
                  },
                }),
              }),
            );
            ws.add(
              jsonEncode({
                'type': 'relay.presence',
                'machineId': msg['machineId'],
                'bridgeOnline': false,
              }),
            );
          }
        });
      });

      final relayUrl = 'ws://127.0.0.1:${relayServer.port}';
      final relayTransport = RelayBridgeTransport(
        machineId: 'machine_remote_1',
        clientId: 'mobile_rel_1',
      );
      addTearDown(relayTransport.close);

      await relayTransport.connect(relayUrl);
      expect(relayTransport.bridgeOnline, isTrue);

      final res = await relayTransport.sendRequest({
        'type': 'agents.list',
        'requestId': 'req_via_relay',
      });
      expect(res['ok'], isTrue);
      await Future<void>.delayed(const Duration(milliseconds: 30));
      expect(relayTransport.bridgeOnline, isFalse);
      expect(relayReceived.first['type'], 'relay.register');
    },
  );

  test(
    'AutoFallbackBridgeTransport automatically falls back to Relay when LAN wsUrl is unreachable',
    () async {
      final relayServer = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      addTearDown(() async => relayServer.close(force: true));

      relayServer.transform(WebSocketTransformer()).listen((WebSocket ws) {
        ws.listen((dynamic raw) {
          final msg = jsonDecode(raw as String) as Map<String, dynamic>;
          if (msg['type'] == 'relay.register') {
            ws.add(
              jsonEncode({
                'type': 'relay.registered',
                'role': 'mobile',
                'machineId': msg['machineId'],
                'clientId': msg['clientId'],
                'bridgeOnline': true,
              }),
            );
          } else if (msg['type'] == 'relay.forward') {
            final inner = jsonDecode(msg['payload'] as String) as Map<String, dynamic>;
            ws.add(
              jsonEncode({
                'type': 'relay.forward',
                'machineId': msg['machineId'],
                'fromClientId': 'bridge_1',
                'toClientId': msg['fromClientId'],
                'payload': jsonEncode({
                  'type': 'response',
                  'requestId': inner['requestId'],
                  'ok': true,
                  'data': {'pong': true},
                }),
              }),
            );
          }
        });
      });

      final relayUrl = 'ws://127.0.0.1:${relayServer.port}';
      final transport = AutoFallbackBridgeTransport(
        directTransport: IoBridgeTransport(),
        relayTransport: RelayBridgeTransport(
          machineId: 'machine_fallback',
          clientId: 'mob_fb_1',
        ),
        relayUrl: relayUrl,
      );
      addTearDown(transport.close);

      // Unreachable LAN port 1 triggers automatic Relay fallback
      await transport.connect('ws://127.0.0.1:1');
      expect(transport.activeMode, BridgeRouteMode.relay);

      final pingRes = await transport.sendRequest({
        'type': 'ping',
        'requestId': 'req_fb_ping',
      });
      expect(pingRes['ok'], isTrue);
    },
  );
}
