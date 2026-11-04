import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nienie_mobile/main.dart';

void main() {
  test('decodes nienie://pair QR URI and pairs tool_use with tool_result by sequence', () {
    final rawPayload = {
      'version': 1,
      'machineId': 'machine_mac',
      'wsUrl': 'ws://127.0.0.1:4100',
      'relayUrl': DEFAULT_RELAY_URL,
      'pairingCode': '654321',
      'expiresAt': '2026-11-04T12:00:00.000Z',
    };
    final encoded = base64Url.encode(utf8.encode(jsonEncode(rawPayload)));
    final qrPayload = PairingQrPayload.decode('nienie://pair?data=$encoded');

    expect(qrPayload.machineId, 'machine_mac');
    expect(qrPayload.pairingCode, '654321');
    expect(qrPayload.relayUrl, DEFAULT_RELAY_URL);
  });

  testWidgets(
    'connects to computer, lists agents and sessions, enters session, sends prompt, and renders streaming text, tool calls, and errors',
    (WidgetTester tester) async {
      final transport = FakeBridgeTransport();
      final client = MobileBridgeClient(
        transport: transport,
        credentialStore: InMemoryCredentialStore(),
      );

      await tester.pumpWidget(NienieMobileApp(client: client));

      // 1. Pair and connect to computer
      await tester.enterText(find.byKey(const Key('input-ws-url')), 'ws://127.0.0.1:4100');
      await tester.enterText(find.byKey(const Key('input-pairing-code')), '123456');
      await tester.tap(find.byKey(const Key('btn-connect-pair')));
      await tester.pumpAndSettle();

      expect(client.connectionState, BridgeConnectionState.connected);

      // 2. View Agent list
      expect(find.text('OpenCode'), findsOneWidget);
      expect(find.text('Codex'), findsOneWidget);

      // 3. View Session list and enter session
      expect(find.text('Implement OpenCode adapter'), findsOneWidget);
      await tester.tap(find.text('Implement OpenCode adapter'));
      await tester.pumpAndSettle();

      expect(client.activeSession?.id, 'ses_alpha');

      // 4. Send message inside session
      await tester.enterText(find.byKey(const Key('input-session-prompt')), '请运行测试');
      await tester.tap(find.byKey(const Key('btn-send-prompt')));
      await tester.pumpAndSettle();

      expect(transport.sentPrompts.single, '请运行测试');
      expect(find.text('请运行测试'), findsOneWidget);

      // 5. Render streaming text deltas (in order and deduplicated by sequence)
      transport.emitServerEvent({
        'version': 1,
        'eventId': 'evt_1',
        'sessionId': 'ses_alpha',
        'sequence': 1,
        'timestamp': '2026-11-04T10:00:01Z',
        'type': 'text_delta',
        'payload': {'delta': '正在执行 '},
      });
      transport.emitServerEvent({
        'version': 1,
        'eventId': 'evt_2',
        'sessionId': 'ses_alpha',
        'sequence': 2,
        'timestamp': '2026-11-04T10:00:02Z',
        'type': 'text_delta',
        'payload': {'delta': 'pnpm test'},
      });
      // Duplicate sequence 2 should be ignored
      transport.emitServerEvent({
        'version': 1,
        'eventId': 'evt_2_dup',
        'sessionId': 'ses_alpha',
        'sequence': 2,
        'timestamp': '2026-11-04T10:00:02Z',
        'type': 'text_delta',
        'payload': {'delta': 'pnpm test'},
      });
      await tester.pumpAndSettle();

      expect(find.text('正在执行 pnpm test'), findsOneWidget);

      // 6. Render tool call and paired tool result card
      transport.emitServerEvent({
        'version': 1,
        'eventId': 'evt_3',
        'sessionId': 'ses_alpha',
        'sequence': 3,
        'timestamp': '2026-11-04T10:00:03Z',
        'type': 'tool_use',
        'payload': {
          'toolCallId': 'call_bash_1',
          'name': 'bash',
          'input': {'command': 'pnpm test'},
        },
      });
      transport.emitServerEvent({
        'version': 1,
        'eventId': 'evt_4',
        'sessionId': 'ses_alpha',
        'sequence': 4,
        'timestamp': '2026-11-04T10:00:04Z',
        'type': 'tool_result',
        'payload': {
          'toolCallId': 'call_bash_1',
          'content': 'All 19 tests passed',
          'isError': false,
        },
      });
      await tester.pumpAndSettle();

      expect(find.text('bash'), findsOneWidget);
      expect(find.textContaining('All 19 tests passed'), findsOneWidget);

      // 7. Render structured error card
      transport.emitServerEvent({
        'version': 1,
        'eventId': 'evt_5',
        'sessionId': 'ses_alpha',
        'sequence': 5,
        'timestamp': '2026-11-04T10:00:05Z',
        'type': 'error',
        'payload': {
          'code': 'APIError',
          'message': 'Upstream rate limit reached',
          'retryable': true,
        },
      });
      await tester.pumpAndSettle();

      expect(find.text('APIError'), findsOneWidget);
      expect(find.text('Upstream rate limit reached'), findsOneWidget);
    },
  );
}
