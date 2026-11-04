import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nienie_mobile/main.dart';

void main() {
  test('decodes nienie://pair QR URI and pairs tool_use with tool_result by sequence', () async {
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

    final transport = FakeBridgeTransport();
    final client = MobileBridgeClient(
      transport: transport,
      credentialStore: InMemoryCredentialStore(),
    );
    await client.pairWithQrUri('nienie://pair?data=$encoded');
    expect(client.connectionState, BridgeConnectionState.connected);
  });

  test('manages multiple paired machines in DeviceCredentialStore', () async {
    final store = InMemoryCredentialStore();
    await store.save(
      const SavedDeviceCredential(
        machineId: 'macbook_pro',
        wsUrl: 'ws://192.168.1.10:4100',
        deviceId: 'dev_1',
        deviceToken: 'ntk_1',
      ),
    );
    await store.save(
      const SavedDeviceCredential(
        machineId: 'linux_workstation',
        wsUrl: 'ws://192.168.1.20:4100',
        deviceId: 'dev_2',
        deviceToken: 'ntk_2',
      ),
    );

    final machines = await store.listMachines();
    expect(machines.map((m) => m.machineId).toList(), ['macbook_pro', 'linux_workstation']);
    expect((await store.load('macbook_pro'))?.wsUrl, 'ws://192.168.1.10:4100');

    await store.removeMachine('linux_workstation');
    expect((await store.listMachines()).single.machineId, 'macbook_pro');
  });

  test('persists device credentials across restarts with FileCredentialStore', () async {
    final tempDir = await Directory.systemTemp.createTemp('nienie_cred_test_');
    addTearDown(() async => tempDir.delete(recursive: true));
    final file = File('${tempDir.path}/credentials.json');

    final writerStore = FileCredentialStore(file);
    await writerStore.save(
      const SavedDeviceCredential(
        machineId: 'mac_studio',
        wsUrl: 'ws://192.168.1.50:4100',
        deviceId: 'dev_persisted',
        deviceToken: 'ntk_persisted_secret',
      ),
    );

    final readerStore = FileCredentialStore(file);
    final loaded = await readerStore.load();
    expect(loaded?.machineId, 'mac_studio');
    expect(loaded?.deviceToken, 'ntk_persisted_secret');
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

      // 8. Render permission request card and approve once
      transport.emitServerEvent({
        'version': 1,
        'eventId': 'evt_6',
        'sessionId': 'ses_alpha',
        'sequence': 6,
        'timestamp': '2026-11-04T10:00:06Z',
        'type': 'status',
        'payload': {
          'status': 'waiting',
          'detail': 'Permission requested: bash',
          'permissionId': 'perm_rm_1',
          'permission': 'bash',
          'patterns': ['rm -rf build'],
        },
      });
      await tester.pumpAndSettle();

      expect(find.text('Permission requested: bash'), findsOneWidget);
      final allowBtn = find.byKey(const Key('btn-perm-allow-once-perm_rm_1'));
      await tester.ensureVisible(allowBtn);
      await tester.pumpAndSettle();
      await tester.tap(allowBtn);
      await tester.pumpAndSettle();

      expect(transport.permissionReplies.single, {
        'sessionId': 'ses_alpha',
        'permissionId': 'perm_rm_1',
        'decision': 'allow_once',
      });

      // 9. Tap toolbar buttons to load session file diffs and capture desktop screen
      await tester.tap(find.byKey(const Key('btn-load-diffs')));
      await tester.pumpAndSettle();
      await tester.drag(find.byType(ListView).last, const Offset(0, -300));
      await tester.pumpAndSettle();

      expect(find.text('src/index.ts'), findsOneWidget);
      expect(find.text('+3 / -1'), findsOneWidget);

      // 10. Load models and send message with selected modelId
      await client.loadModels('opencode');
      expect(client.models.single.id, 'anthropic/claude-sonnet-4');
      expect(client.selectedModelId, 'anthropic/claude-sonnet-4');

      await client.sendMessage('use selected model');
      expect(transport.sentModelIds.last, 'anthropic/claude-sonnet-4');

      // 11. Register push token and tap toolbar button to request remote desktop fallback screen capture
      await client.registerPushToken(
        platform: 'ios',
        provider: 'apns',
        pushToken: 'apns_mobile_tok_1',
      );
      expect(transport.registeredPushes.single['pushToken'], 'apns_mobile_tok_1');

      await tester.tap(find.byKey(const Key('btn-capture-screen')));
      await tester.pumpAndSettle();
      await tester.drag(find.byType(ListView).last, const Offset(0, -300));
      await tester.pumpAndSettle();

      expect(find.text('Screen Capture (main)'), findsOneWidget);
      expect(find.text('1440x900'), findsOneWidget);

      // 12. Emit usage event and verify usage summary card, then cancel session and create a new session
      transport.emitServerEvent({
        'version': 1,
        'eventId': 'evt_usage_1',
        'sessionId': 'ses_alpha',
        'sequence': 7,
        'timestamp': '2026-11-04T10:00:07Z',
        'type': 'usage',
        'payload': {
          'inputTokens': 1500,
          'outputTokens': 420,
          'costUsd': 0.0142,
        },
      });
      await tester.pumpAndSettle();
      await tester.drag(find.byType(ListView).last, const Offset(0, -300));
      await tester.pumpAndSettle();

      expect(find.textContaining('1500 in · 420 out'), findsOneWidget);

      await tester.tap(find.byKey(const Key('btn-cancel-session')));
      await tester.pumpAndSettle();
      expect(transport.cancelledSessionIds.single, 'ses_alpha');

      await tester.tap(find.byKey(const Key('btn-new-session')));
      await tester.pumpAndSettle();

      expect(client.activeSession?.id, 'ses_created_mobile');
      expect(find.text('Mobile Session'), findsOneWidget);
    },
  );

  testWidgets('pairs directly by pasting nienie://pair QR URI in the pairing panel', (
    WidgetTester tester,
  ) async {
    final transport = FakeBridgeTransport();
    final client = MobileBridgeClient(
      transport: transport,
      credentialStore: InMemoryCredentialStore(),
    );

    final rawPayload = {
      'version': 1,
      'machineId': 'machine_qr_ui',
      'wsUrl': 'ws://127.0.0.1:4100',
      'relayUrl': DEFAULT_RELAY_URL,
      'pairingCode': '777888',
      'expiresAt': '2026-11-04T12:00:00.000Z',
    };
    final encoded = base64Url.encode(utf8.encode(jsonEncode(rawPayload)));
    final qrUri = 'nienie://pair?data=$encoded';

    await tester.pumpWidget(NienieMobileApp(client: client));

    await tester.enterText(find.byKey(const Key('input-qr-uri')), qrUri);
    await tester.tap(find.byKey(const Key('btn-pair-qr-uri')));
    await tester.pumpAndSettle();

    expect(client.connectionState, BridgeConnectionState.connected);
    expect(find.text('OpenCode'), findsOneWidget);
  });
}
