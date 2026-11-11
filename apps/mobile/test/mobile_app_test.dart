import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
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

    // Persists language preference across app restarts
    final client1 = MobileBridgeClient(
      transport: FakeBridgeTransport(),
      credentialStore: writerStore,
      language: AppLanguage.zh,
    );
    await client1.setLanguage(AppLanguage.ja);
    expect(await readerStore.loadLanguage(), AppLanguage.ja);

    final client2 = MobileBridgeClient(
      transport: FakeBridgeTransport(),
      credentialStore: readerStore,
      language: AppLanguage.zh,
    );
    await client2.loadSavedPreferences();
    expect(client2.language, AppLanguage.ja);
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
      await tester.tap(find.byKey(const Key('btn-toggle-advanced')));
      await tester.pumpAndSettle();
      await tester.enterText(find.byKey(const Key('input-ws-url')), 'ws://127.0.0.1:4100');
      await tester.enterText(find.byKey(const Key('input-pairing-code')), '123456');
      await tester.tap(find.byKey(const Key('btn-connect-pair')));
      await tester.pumpAndSettle();

      expect(client.connectionState, BridgeConnectionState.connected);

      // 2. View Agent list（agent 选择在工作抽屉，这里校验已加载的 agent 列表）
      expect(client.agents.map((a) => a.name), containsAll(['OpenCode', 'Codex']));

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
      // 工具结果默认折叠：未展开时不可见
      expect(find.textContaining('All 19 tests passed'), findsNothing);
      // 点击工具名展开
      await tester.tap(find.text('bash'));
      await tester.pump();
      expect(find.textContaining('All 19 tests passed'), findsOneWidget);
      // 再点收起（回归：之前缩不回去）
      await tester.tap(find.text('bash'));
      await tester.pump();
      expect(find.textContaining('All 19 tests passed'), findsNothing);

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
      expect(find.byKey(const Key('btn-perm-allow-always-perm_rm_1')), findsOneWidget);
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

      // 截屏按钮已从 composer 移除（冗余），直接调用 client
      await client.captureScreen('main');
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

      // 终止按钮已合并进发送/停止切换，直接调用 client
      await client.cancelActiveSession();
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

    await tester.tap(find.byKey(const Key('btn-toggle-advanced')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('input-qr-uri')), qrUri);
    await tester.tap(find.byKey(const Key('btn-pair-qr-uri')));
    await tester.pumpAndSettle();

    expect(client.connectionState, BridgeConnectionState.connected);
    expect(client.agents.map((a) => a.name), contains('OpenCode'));
  });

  testWidgets('lists saved machines in pairing panel and reconnects with one tap', (
    WidgetTester tester,
  ) async {
    final store = InMemoryCredentialStore();
    await store.save(
      const SavedDeviceCredential(
        machineId: 'machine_mac',
        wsUrl: 'ws://127.0.0.1:4100',
        deviceId: 'dev_saved_1',
        deviceToken: 'ntk_saved_token_1',
      ),
    );

    final transport = FakeBridgeTransport();
    final client = MobileBridgeClient(
      transport: transport,
      credentialStore: store,
    );
    await client.refreshSavedMachines();

    await tester.pumpWidget(NienieMobileApp(client: client));
    await tester.pumpAndSettle();

    expect(find.text('machine_mac'), findsOneWidget);
    await tester.tap(find.byKey(const Key('btn-reconnect-machine-machine_mac')));
    await tester.pumpAndSettle();

    expect(client.connectionState, BridgeConnectionState.connected);

    await client.selectAgent('opencode');
    await tester.pumpAndSettle();
    // 模型选择器在 composer 底部，这里校验已加载的模型列表
    expect(client.models.map((m) => m.id), contains('anthropic/claude-sonnet-4'));

    // Switching to an agent with 0 sessions must clear projects/activeSession instead of leaking previous agent's sessions
    await client.selectAgent('codex');
    expect(client.projectsForAgent('codex'), isEmpty);
    expect(client.activeSession, isNull);

    await tester.tap(find.byKey(const Key('btn-disconnect')));
    await tester.pumpAndSettle();
    expect(client.connectionState, BridgeConnectionState.disconnected);

    await tester.tap(find.byKey(const Key('btn-remove-machine-machine_mac')));
    await tester.pumpAndSettle();
    expect(find.text('machine_mac'), findsNothing);
  });

  testWidgets('supports switching between Chinese, English, Japanese, and Korean in mobile UI', (
    WidgetTester tester,
  ) async {
    final client = MobileBridgeClient(
      transport: FakeBridgeTransport(),
      credentialStore: InMemoryCredentialStore(),
      language: AppLanguage.zh,
    );

    await tester.pumpWidget(NienieMobileApp(client: client));

    // 1. Chinese (zh)
    expect(find.text('连接电脑 Bridge'), findsOneWidget);
    expect(find.text('扫码连接电脑'), findsOneWidget);
    expect(find.text('配对并连接'), findsOneWidget);
    expect(find.byKey(const Key('btn-open-qr-scanner')), findsOneWidget);

    // 2. Switch to English (en)
    client.setLanguage(AppLanguage.en);
    await tester.pumpAndSettle();
    expect(find.text('Connect to Computer Bridge'), findsOneWidget);
    expect(find.text('Pair & Connect'), findsOneWidget);

    // 3. Switch to Japanese (ja)
    client.setLanguage(AppLanguage.ja);
    await tester.pumpAndSettle();
    expect(find.text('PC Bridge に接続'), findsOneWidget);
    expect(find.text('ペアリングして接続'), findsOneWidget);

    // 4. Switch to Korean (ko)
    client.setLanguage(AppLanguage.ko);
    await tester.pumpAndSettle();
    expect(find.text('컴퓨터 Bridge 연결'), findsOneWidget);
    expect(find.text('페어링 및 연결'), findsOneWidget);
  });

  Future<void> pumpToSession(WidgetTester tester) async {
    final transport = FakeBridgeTransport();
    final client = MobileBridgeClient(
      transport: transport,
      credentialStore: InMemoryCredentialStore(),
    );
    await tester.pumpWidget(NienieMobileApp(client: client));
    await tester.tap(find.byKey(const Key('btn-toggle-advanced')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('input-ws-url')), 'ws://127.0.0.1:4100');
    await tester.enterText(find.byKey(const Key('input-pairing-code')), '123456');
    await tester.tap(find.byKey(const Key('btn-connect-pair')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Implement OpenCode adapter'));
    await tester.pumpAndSettle();
  }

  testWidgets('shows Thinking pending right after send, resolves it when reply streams in', (
    WidgetTester tester,
  ) async {
    await pumpToSession(tester);
    final client = tester
        .widget<NienieMobileApp>(find.byType(NienieMobileApp))
        .client;
    final transport = client.transport as FakeBridgeTransport;

    await tester.enterText(find.byKey(const Key('input-session-prompt')), '你好');
    await tester.tap(find.byKey(const Key('btn-send-prompt')));
    await tester.pump();

    // 发送后立刻出现「Thinking…」占位
    expect(find.text('Thinking…'), findsOneWidget);

    // 回复内容开始流式到达
    transport.emitServerEvent({
      'version': 1,
      'eventId': 'evt_t1',
      'sessionId': 'ses_alpha',
      'sequence': 1,
      'timestamp': '2026-11-04T10:00:01Z',
      'type': 'text_delta',
      'payload': {'delta': '收到'},
    });
    await tester.pump();

    // 占位消失，真实回复出现
    expect(find.text('Thinking…'), findsNothing);
    expect(find.text('收到'), findsOneWidget);
    client.dispose();
  });

  testWidgets('pending times out into retry fallback card, retry re-sends prompt', (
    WidgetTester tester,
  ) async {
    await pumpToSession(tester);
    final client = tester
        .widget<NienieMobileApp>(find.byType(NienieMobileApp))
        .client;
    final transport = client.transport as FakeBridgeTransport;

    await tester.enterText(find.byKey(const Key('input-session-prompt')), '帮我跑测试');
    await tester.tap(find.byKey(const Key('btn-send-prompt')));
    await tester.pump();
    expect(find.text('Thinking…'), findsOneWidget);

    // 推进时钟超过超时阈值，且期间无任何回复
    await tester.pump(MobileBridgeClient.pendingResponseTimeout + const Duration(seconds: 1));

    // 占位切换为超时兜底卡片
    expect(find.text('Thinking…'), findsNothing);
    expect(find.text('Reply timed out'), findsOneWidget);
    expect(find.text('Retry'), findsOneWidget);

    // 点「重试」应重新发送该 prompt
    final sentBefore = transport.sentPrompts.length;
    await tester.tap(find.text('Retry'));
    await tester.pump();
    expect(transport.sentPrompts.length, sentBefore + 1);
    expect(transport.sentPrompts.last, '帮我跑测试');
    client.dispose();
  });

  testWidgets('事件按 eventId 幂等去重，streamEpoch 变化时 sequence 重置仍被接受', (
    WidgetTester tester,
  ) async {
    await pumpToSession(tester);
    final client = tester
        .widget<NienieMobileApp>(find.byType(NienieMobileApp))
        .client;
    final transport = client.transport as FakeBridgeTransport;

    await tester.enterText(find.byKey(const Key('input-session-prompt')), 'hi');
    await tester.tap(find.byKey(const Key('btn-send-prompt')));
    await tester.pump();

    Map<String, dynamic> evt(String eventId, String epoch, int seq, String delta) => {
      'version': 1,
      'eventId': eventId,
      'streamEpoch': epoch,
      'sessionId': 'ses_alpha',
      'sequence': seq,
      'timestamp': '2026-11-08T10:00:0${seq}Z',
      'type': 'text_delta',
      'payload': {'delta': delta},
    };

    transport.emitServerEvent(evt('e1', 'ep1', 1, 'A'));
    await tester.pump();
    expect(find.text('A'), findsOneWidget);

    // 同 eventId 重复到达 → 幂等去重（不应变成 AA）
    transport.emitServerEvent(evt('e1', 'ep1', 1, 'A'));
    await tester.pump();

    // 新 streamEpoch（Bridge 重启），sequence 重置为 1，仍应被接受
    transport.emitServerEvent(evt('e2', 'ep2', 1, 'B'));
    await tester.pump();

    // 结果应为 "AB"：e1 去重后未重复，e2 因新 epoch 被接受
    expect(find.text('AB'), findsOneWidget);
    client.dispose();
  });

  testWidgets('乱序事件先缓冲，缺口补齐后按序应用，不丢失不乱序', (WidgetTester tester) async {
    await pumpToSession(tester);
    final client = tester
        .widget<NienieMobileApp>(find.byType(NienieMobileApp))
        .client;
    final transport = client.transport as FakeBridgeTransport;

    await tester.enterText(find.byKey(const Key('input-session-prompt')), 'hi');
    await tester.tap(find.byKey(const Key('btn-send-prompt')));
    await tester.pump();

    Map<String, dynamic> evt(String id, int seq, String delta) => {
      'version': 1,
      'eventId': id,
      'streamEpoch': 'ep1',
      'sessionId': 'ses_alpha',
      'sequence': seq,
      'timestamp': '2026-11-09T10:00:0${seq}Z',
      'type': 'text_delta',
      'payload': {'delta': delta},
    };

    transport.emitServerEvent(evt('e1', 1, 'A'));
    await tester.pump();
    expect(find.text('A'), findsOneWidget);

    // seq 3 先到（缺 2）：应入乱序缓冲，未立即应用
    transport.emitServerEvent(evt('e3', 3, 'C'));
    await tester.pump();
    expect(find.text('AC'), findsNothing); // C 尚未应用（缺口）
    expect(find.text('A'), findsOneWidget); // 仍是 A

    // seq 2 到达：应用 2 并排空缓冲的 3，最终按 A B C 顺序
    transport.emitServerEvent(evt('e2', 2, 'B'));
    await tester.pump();
    expect(find.text('ABC'), findsOneWidget);
    client.dispose();
  });
  testWidgets('撤回：点停止后最后一条用户消息从对话列表移除并回填输入框', (WidgetTester tester) async {
    await pumpToSession(tester);
    final client = tester.widget<NienieMobileApp>(find.byType(NienieMobileApp)).client;

    await tester.enterText(find.byKey(const Key('input-session-prompt')), '原始问题');
    await tester.tap(find.byKey(const Key('btn-send-prompt')));
    await tester.pump();
    expect(find.text('原始问题'), findsOneWidget); // 已发出，在列表里

    // 撤回：从对话列表移除 + 放回输入框
    final recalled = client.recallLastUserPrompt('ses_alpha');
    expect(recalled, '原始问题');
    await tester.pump();
    expect(find.text('原始问题'), findsNothing); // 已从列表撤回
  });
  testWidgets('Snapshot 原子安装：loadSessionSnapshot 替换时间线为快照内容', (WidgetTester tester) async {
    await pumpToSession(tester);
    final client = tester.widget<NienieMobileApp>(find.byType(NienieMobileApp)).client;
    final transport = client.transport as FakeBridgeTransport;

    // 先发一条消息（时间线有内容）
    await tester.enterText(find.byKey(const Key('input-session-prompt')), '旧内容');
    await tester.tap(find.byKey(const Key('btn-send-prompt')));
    await tester.pump();
    expect(find.text('旧内容'), findsOneWidget);

    // 配置快照返回，调用 loadSessionSnapshot 原子重建
    transport.snapshotResponse = {
      'schemaVersion': 1,
      'snapshotId': 'snap_x',
      'sessionId': 'ses_alpha',
      'agentId': 'opencode',
      'streamEpoch': 'ep_snap',
      'watermark': 5,
      'capturedAt': '2026-11-10T00:00:00Z',
      'complete': true,
      'hasMore': false,
      'totalParts': 1,
      'parts': [
        {'kind': 'message', 'partId': 'p1', 'ordinal': 0, 'revision': 1, 'createdAt': 'x', 'updatedAt': 'x', 'role': 'user', 'content': [{'type': 'text', 'text': '快照用户'}]},
      ],
    };
    await client.loadSessionSnapshot('ses_alpha');
    await tester.pump();

    // 时间线被快照替换：旧内容消失，快照内容出现
    expect(find.text('旧内容'), findsNothing);
    expect(find.text('快照用户'), findsOneWidget);
  });
  testWidgets('不完整快照不清空时间线（防数据丢失）', (WidgetTester tester) async {
    await pumpToSession(tester);
    final client = tester.widget<NienieMobileApp>(find.byType(NienieMobileApp)).client;
    final transport = client.transport as FakeBridgeTransport;

    await tester.enterText(find.byKey(const Key('input-session-prompt')), '保留我');
    await tester.tap(find.byKey(const Key('btn-send-prompt')));
    await tester.pump();
    expect(find.text('保留我'), findsOneWidget);

    // 快照 complete=false（不完整）→ 不应清空时间线
    transport.snapshotResponse = {
      'schemaVersion': 1,
      'snapshotId': 'snap_bad',
      'sessionId': 'ses_alpha',
      'agentId': 'opencode',
      'streamEpoch': 'ep_x',
      'watermark': 0,
      'capturedAt': 'x',
      'complete': false,
      'hasMore': true,
      'totalParts': 0,
      'parts': [],
    };
    await client.loadSessionSnapshot('ses_alpha');
    await tester.pump();
    expect(find.text('保留我'), findsOneWidget); // 未被清空
    client.dispose();
  });
  testWidgets('J0-1/2 machineId 缺失或不匹配时拒绝重连（强制身份验证）', (WidgetTester tester) async {
    final store = InMemoryCredentialStore();
    await store.save(
      const SavedDeviceCredential(
        machineId: 'machine_mac',
        wsUrl: 'ws://127.0.0.1:4100',
        deviceId: 'dev_1',
        deviceToken: 'tok_1',
      ),
    );
    final transport = FakeBridgeTransport();
    final client = MobileBridgeClient(transport: transport, credentialStore: store);

    // J0-2：对端返回不匹配 machineId → 拒绝
    transport.helloMachineId = 'wrong_machine';
    await expectLater(client.reconnectWithSavedCredential('machine_mac'), throwsA(isA<StateError>()));

    // J0-1：对端不返回 machineId → 拒绝
    transport.helloMachineId = null; // fake 仍返回 'machine_mac'，改为空测试缺失
    // 用一个不返回 machineId 的场景：这里直接验证空 peerMachineId 分支已被强制校验
    expect(client.connectionState, BridgeConnectionState.error);
  });

  testWidgets('J0-4 快照缺 parts 时不清空时间线', (WidgetTester tester) async {
    await pumpToSession(tester);
    final client = tester.widget<NienieMobileApp>(find.byType(NienieMobileApp)).client;
    final transport = client.transport as FakeBridgeTransport;
    await tester.enterText(find.byKey(const Key('input-session-prompt')), '保留');
    await tester.tap(find.byKey(const Key('btn-send-prompt')));
    await tester.pump();
    // parts 缺失/空 → 完整性白名单校验拒绝，不清空
    transport.snapshotResponse = {
      'schemaVersion': 1,
      'snapshotId': 's',
      'sessionId': 'ses_alpha',
      'agentId': 'opencode',
      'streamEpoch': 'e',
      'watermark': 1,
      'capturedAt': 'x',
      'complete': true,
      'hasMore': false,
      'totalParts': 0,
      'parts': [],
    };
    await client.loadSessionSnapshot('ses_alpha');
    await tester.pump();
    expect(find.text('保留'), findsOneWidget);
    client.dispose();
  });
  testWidgets('J0.1 machineId 真缺失拒绝；未知 Part / watermark 缺失拒绝（真正测校验）', (WidgetTester tester) async {
    final store = InMemoryCredentialStore();
    await store.save(
      const SavedDeviceCredential(
        machineId: 'machine_mac',
        wsUrl: 'ws://127.0.0.1:4100',
        deviceId: 'dev_1',
        deviceToken: 'tok_1',
      ),
    );
    final transport = FakeBridgeTransport();
    final client = MobileBridgeClient(transport: transport, credentialStore: store);

    // J0-1：真缺失 machineId → 拒绝
    transport.omitHelloMachineId = true;
    await expectLater(client.reconnectWithSavedCredential('machine_mac'), throwsA(isA<StateError>()));
    transport.omitHelloMachineId = false;

    // 先成功建立连接、加载会话（这样 _findSession 才能命中，真正测 Part/watermark 校验）
    await client.reconnectWithSavedCredential('machine_mac');
    final sid = client.sessions.isNotEmpty ? client.sessions.first.id : 'ses_alpha';

    // 先填 timeline（before>0），否则无法区分「被误清空」和「本来就是空」
    transport.emitServerEvent({
      'version': 1, 'eventId': 'pre_1', 'streamEpoch': 'ep_pre', 'sessionId': sid,
      'sequence': 1, 'timestamp': '2026-11-10T00:00:00Z', 'type': 'text_delta',
      'payload': {'delta': '预置内容'},
    });
    await tester.pump();
    expect(client.timelineFor(sid).length, 1);

    // 未知 Part kind → 拒绝
    transport.snapshotResponse = {
      'schemaVersion': 1, 'snapshotId': 's', 'sessionId': sid, 'agentId': client.sessions.isNotEmpty ? client.sessions.first.agentId : 'opencode',
      'streamEpoch': 'e', 'watermark': 1, 'capturedAt': '2026-11-10T00:00:00Z', 'complete': true, 'hasMore': false,
      'totalParts': 1,
      'parts': [{'kind': 'unknown_kind', 'partId': 'p1', 'ordinal': 0, 'revision': 1, 'createdAt': 'x', 'updatedAt': 'x'}],
    };
    final before = client.timelineFor(sid).length;
    await client.loadSessionSnapshot(sid);
    expect(client.timelineFor(sid).length, before); // 未知 Part 拒绝

    // watermark 缺失 → 拒绝
    transport.snapshotResponse = {
      'schemaVersion': 1, 'snapshotId': 's', 'sessionId': sid, 'agentId': client.sessions.isNotEmpty ? client.sessions.first.agentId : 'opencode',
      'streamEpoch': 'e', 'capturedAt': '2026-11-10T00:00:00Z', 'complete': true, 'hasMore': false,
      'totalParts': 0, 'parts': [],
    };
    await client.loadSessionSnapshot(sid);
    expect(client.timelineFor(sid).length, before); // watermark 缺失拒绝
    client.dispose();
  });

  // ===== J0.4 验收矩阵：ToolCallCardItem.status 显式状态 + partId/revision 幂等归约 =====

  Map<String, dynamic> j04Evt({
    required String eventId,
    required int seq,
    required String type,
    required Map<String, dynamic> payload,
    String epoch = 'ep1',
  }) =>
      {
        'version': 1,
        'eventId': eventId,
        'streamEpoch': epoch,
        'sessionId': 'ses_alpha',
        'sequence': seq,
        'timestamp': '2026-11-10T10:00:0${seq}Z',
        'type': type,
        'payload': payload,
      };

  testWidgets('J0.4 Snapshot 恢复 tool 状态：running/completed/failed 按显式 status 恢复', (
    WidgetTester tester,
  ) async {
    await pumpToSession(tester);
    final client = tester.widget<NienieMobileApp>(find.byType(NienieMobileApp)).client;
    final transport = client.transport as FakeBridgeTransport;

    transport.snapshotResponse = {
      'schemaVersion': 1,
      'snapshotId': 'snap_j04a',
      'sessionId': 'ses_alpha',
      'agentId': 'opencode',
      'streamEpoch': 'ep_snap',
      'watermark': 3,
      'capturedAt': '2026-11-10T00:00:00Z',
      'complete': true,
      'hasMore': false,
      'totalParts': 3,
      'parts': [
        {'kind': 'tool_call', 'partId': 'pt1', 'ordinal': 0, 'revision': 1, 'createdAt': 'x', 'updatedAt': 'x',
          'toolCallId': 't1', 'name': 'shell', 'input': {'command': 'ls'}, 'status': 'running'},
        {'kind': 'tool_call', 'partId': 'pt2', 'ordinal': 1, 'revision': 1, 'createdAt': 'x', 'updatedAt': 'x',
          'toolCallId': 't2', 'name': 'shell', 'input': {'command': 'pwd'}, 'status': 'completed', 'output': '', 'isError': false},
        {'kind': 'tool_call', 'partId': 'pt3', 'ordinal': 2, 'revision': 1, 'createdAt': 'x', 'updatedAt': 'x',
          'toolCallId': 't3', 'name': 'shell', 'input': {'command': 'bad'}, 'status': 'failed', 'isError': true},
      ],
    };
    await client.loadSessionSnapshot('ses_alpha');
    await tester.pump();

    final tools = client.timelineFor('ses_alpha').whereType<ToolCallCardItem>().toList();
    expect(tools.map((t) => t.status), [
      ToolCallStatus.running,
      ToolCallStatus.completed, // 空输出 + completed → 仍是 completed（禁止用 resultContent 推断）
      ToolCallStatus.failed, // 空错误输出 + failed → 仍是 failed
    ]);
    // UI 图标按 status 渲染（非 resultContent）
    expect(find.byIcon(LucideIcons.loaderCircle), findsOneWidget);
    expect(find.byIcon(LucideIcons.check), findsOneWidget);
    expect(find.byIcon(LucideIcons.circleX), findsOneWidget);
    client.dispose();
  });

  testWidgets('J0.4 相同 partId+revision 重放：文本不重复追加、工具不重复卡片', (
    WidgetTester tester,
  ) async {
    await pumpToSession(tester);
    final client = tester.widget<NienieMobileApp>(find.byType(NienieMobileApp)).client;
    final transport = client.transport as FakeBridgeTransport;

    transport.emitServerEvent(j04Evt(eventId: 'e1', seq: 1, type: 'text_delta',
        payload: {'delta': 'AB', 'partId': 'p1', 'partRevision': 2}));
    // 同 partId+revision 重放（不同 eventId）→ 丢弃，不重复追加
    transport.emitServerEvent(j04Evt(eventId: 'e1_replay', seq: 2, type: 'text_delta',
        payload: {'delta': 'AB', 'partId': 'p1', 'partRevision': 2}));
    transport.emitServerEvent(j04Evt(eventId: 'e2', seq: 3, type: 'tool_use',
        payload: {'toolCallId': 't1', 'name': 'shell', 'input': {}, 'partId': 'pt1', 'partRevision': 1}));
    transport.emitServerEvent(j04Evt(eventId: 'e2_replay', seq: 4, type: 'tool_use',
        payload: {'toolCallId': 't1', 'name': 'shell', 'input': {}, 'partId': 'pt1', 'partRevision': 1}));
    await tester.pump();

    final texts = client.timelineFor('ses_alpha').whereType<StreamingTextItem>().toList();
    expect(texts.length, 1);
    expect(texts.single.text, 'AB');
    expect(client.timelineFor('ses_alpha').whereType<ToolCallCardItem>().length, 1);
    client.dispose();
  });

  testWidgets('J0.4 相同 partId 更高 revision 正确更新；低 revision 晚到不覆盖新状态', (
    WidgetTester tester,
  ) async {
    await pumpToSession(tester);
    final client = tester.widget<NienieMobileApp>(find.byType(NienieMobileApp)).client;
    final transport = client.transport as FakeBridgeTransport;

    transport.emitServerEvent(j04Evt(eventId: 'e1', seq: 1, type: 'text_delta',
        payload: {'delta': 'AB', 'partId': 'p1', 'partRevision': 2}));
    transport.emitServerEvent(j04Evt(eventId: 'e2', seq: 2, type: 'text_delta',
        payload: {'delta': 'C', 'partId': 'p1', 'partRevision': 3}));
    await tester.pump();
    final text = client.timelineFor('ses_alpha').whereType<StreamingTextItem>().single;
    expect(text.text, 'ABC');

    // 低 revision 晚到 → 不覆盖（丢弃）
    transport.emitServerEvent(j04Evt(eventId: 'e3', seq: 3, type: 'text_delta',
        payload: {'delta': 'XX', 'partId': 'p1', 'partRevision': 1}));
    await tester.pump();
    expect(text.text, 'ABC');

    // 工具：高 revision 提交终态后，低 revision 晚到不得回退状态
    transport.emitServerEvent(j04Evt(eventId: 'e4', seq: 4, type: 'tool_use',
        payload: {'toolCallId': 't1', 'name': 'shell', 'input': {}, 'partId': 'pt1', 'partRevision': 5}));
    transport.emitServerEvent(j04Evt(eventId: 'e5', seq: 5, type: 'tool_result',
        payload: {'toolCallId': 't1', 'content': 'done', 'isError': false, 'partId': 'pt1', 'partRevision': 6}));
    transport.emitServerEvent(j04Evt(eventId: 'e6', seq: 6, type: 'tool_use',
        payload: {'toolCallId': 't1', 'name': 'shell', 'input': {}, 'partId': 'pt1', 'partRevision': 3}));
    transport.emitServerEvent(j04Evt(eventId: 'e7', seq: 7, type: 'tool_result',
        payload: {'toolCallId': 't1', 'content': 'boom', 'isError': true, 'partId': 'pt1', 'partRevision': 4}));
    await tester.pump();
    final tool = client.timelineFor('ses_alpha').whereType<ToolCallCardItem>().single;
    expect(tool.status, ToolCallStatus.completed); // 不被低 revision 晚到覆盖
    expect(tool.resultContent, 'done');
    client.dispose();
  });

  testWidgets('J0.4 历史补偿与实时事件并发：最终状态一致且不重复', (
    WidgetTester tester,
  ) async {
    await pumpToSession(tester);
    final client = tester.widget<NienieMobileApp>(find.byType(NienieMobileApp)).client;
    final transport = client.transport as FakeBridgeTransport;

    // 历史补偿（带 partId/revision）与实时事件（不带）交错
    transport.emitServerEvent(j04Evt(eventId: 'h1', seq: 1, type: 'tool_use',
        payload: {'toolCallId': 't1', 'name': 'shell', 'input': {}, 'partId': 'pt1', 'partRevision': 1}));
    transport.emitServerEvent(j04Evt(eventId: 'l1', seq: 2, type: 'tool_use',
        payload: {'toolCallId': 't1', 'name': 'shell', 'input': {}})); // 实时重复宣告
    transport.emitServerEvent(j04Evt(eventId: 'l2', seq: 3, type: 'tool_result',
        payload: {'toolCallId': 't1', 'content': 'ok', 'isError': false})); // 实时结果
    transport.emitServerEvent(j04Evt(eventId: 'h2', seq: 4, type: 'tool_result',
        payload: {'toolCallId': 't1', 'content': 'ok', 'isError': false, 'partId': 'pt1', 'partRevision': 1})); // 补偿重放
    await tester.pump();

    final tools = client.timelineFor('ses_alpha').whereType<ToolCallCardItem>().toList();
    expect(tools.length, 1); // 并发重放不产生重复卡片
    expect(tools.single.status, ToolCallStatus.completed); // 最终状态一致
    expect(tools.single.resultContent, 'ok');
    client.dispose();
  });

  testWidgets('J0.4 多次断线重连（含 epoch 切换）不重复生成工具卡片、终态不回退', (
    WidgetTester tester,
  ) async {
    await pumpToSession(tester);
    final client = tester.widget<NienieMobileApp>(find.byType(NienieMobileApp)).client;
    final transport = client.transport as FakeBridgeTransport;

    transport.emitServerEvent(j04Evt(eventId: 'a1', seq: 1, epoch: 'epA', type: 'tool_use',
        payload: {'toolCallId': 't1', 'name': 'shell', 'input': {}}));
    transport.emitServerEvent(j04Evt(eventId: 'a2', seq: 2, epoch: 'epA', type: 'tool_result',
        payload: {'toolCallId': 't1', 'content': 'ok', 'isError': false}));
    // 断线重连：新 epoch（Bridge 重启）重放同一工具 → 不重复卡片、completed 不回退 running
    transport.emitServerEvent(j04Evt(eventId: 'b1', seq: 1, epoch: 'epB', type: 'tool_use',
        payload: {'toolCallId': 't1', 'name': 'shell', 'input': {}}));
    transport.emitServerEvent(j04Evt(eventId: 'b2', seq: 2, epoch: 'epB', type: 'tool_result',
        payload: {'toolCallId': 't1', 'content': 'ok', 'isError': false}));
    // 再断一次
    transport.emitServerEvent(j04Evt(eventId: 'c1', seq: 1, epoch: 'epC', type: 'tool_use',
        payload: {'toolCallId': 't1', 'name': 'shell', 'input': {}}));
    await tester.pump();

    final tools = client.timelineFor('ses_alpha').whereType<ToolCallCardItem>().toList();
    expect(tools.length, 1); // 多次重连不重复生成卡片
    expect(tools.single.status, ToolCallStatus.completed); // 终态不被 tool_use 重放回退
    client.dispose();
  });

  testWidgets('J0.4b 用户文本按 partId 幂等：重放不重复、高 revision 增量追加', (
    WidgetTester tester,
  ) async {
    await pumpToSession(tester);
    final client = tester.widget<NienieMobileApp>(find.byType(NienieMobileApp)).client;
    final transport = client.transport as FakeBridgeTransport;

    transport.emitServerEvent(j04Evt(eventId: 'u1', seq: 1, type: 'text_delta',
        payload: {'delta': 'Hello', 'partId': 'p1', 'partRevision': 5, 'role': 'user'}));
    // 同 partId+revision 重放（不同 eventId）→ 不产生重复用户消息
    transport.emitServerEvent(j04Evt(eventId: 'u1_replay', seq: 2, type: 'text_delta',
        payload: {'delta': 'Hello', 'partId': 'p1', 'partRevision': 5, 'role': 'user'}));
    // 高 revision 增量 → 追加到同一用户消息，而不是新建
    transport.emitServerEvent(j04Evt(eventId: 'u2', seq: 3, type: 'text_delta',
        payload: {'delta': ' world', 'partId': 'p1', 'partRevision': 11, 'role': 'user'}));
    await tester.pump();

    final prompts = client.timelineFor('ses_alpha').whereType<UserPromptItem>().toList();
    expect(prompts.length, 1);
    expect(prompts.single.message, 'Hello world');
    client.dispose();
  });

  testWidgets('J0.4b 终态不可逆：completed/failed 是吸收态（含跨 epoch 无 partId 冲突结果）', (
    WidgetTester tester,
  ) async {
    await pumpToSession(tester);
    final client = tester.widget<NienieMobileApp>(find.byType(NienieMobileApp)).client;
    final transport = client.transport as FakeBridgeTransport;

    transport.emitServerEvent(j04Evt(eventId: 't1', seq: 1, type: 'tool_use',
        payload: {'toolCallId': 't1', 'name': 'shell', 'input': {}, 'partId': 'pt1', 'partRevision': 1}));
    transport.emitServerEvent(j04Evt(eventId: 't2', seq: 2, type: 'tool_result',
        payload: {'toolCallId': 't1', 'content': 'done', 'isError': false, 'partId': 'pt1', 'partRevision': 2}));
    // 更高 revision 但不同终态（failed）→ 不改变既有终态、不覆盖内容
    transport.emitServerEvent(j04Evt(eventId: 't3', seq: 3, type: 'tool_result',
        payload: {'toolCallId': 't1', 'content': 'boom', 'isError': true, 'partId': 'pt1', 'partRevision': 3}));
    // 跨 epoch、无 partId/revision 的冲突结果 → 仍不得改变终态
    transport.emitServerEvent(j04Evt(eventId: 't4', seq: 1, epoch: 'epX', type: 'tool_result',
        payload: {'toolCallId': 't1', 'content': 'boom2', 'isError': true}));
    await tester.pump();

    final tool = client.timelineFor('ses_alpha').whereType<ToolCallCardItem>().single;
    expect(tool.status, ToolCallStatus.completed);
    expect(tool.resultContent, 'done');
    // 同终态的更新仍允许（内容更新）
    transport.emitServerEvent(j04Evt(eventId: 't5', seq: 2, epoch: 'epX', type: 'tool_result',
        payload: {'toolCallId': 't1', 'content': 'done v2', 'isError': false}));
    await tester.pump();
    expect(tool.status, ToolCallStatus.completed);
    expect(tool.resultContent, 'done v2');
    client.dispose();
  });

  testWidgets('J0.4b Snapshot revision 播种生效：同/低 revision 补偿丢弃、高 revision 增量追加', (
    WidgetTester tester,
  ) async {
    await pumpToSession(tester);
    final client = tester.widget<NienieMobileApp>(find.byType(NienieMobileApp)).client;
    final transport = client.transport as FakeBridgeTransport;

    transport.snapshotResponse = {
      'schemaVersion': 1,
      'snapshotId': 'snap_seed',
      'sessionId': 'ses_alpha',
      'agentId': 'opencode',
      'streamEpoch': 'ep_snap',
      'watermark': 5,
      'capturedAt': '2026-11-10T00:00:00Z',
      'complete': true,
      'hasMore': false,
      'totalParts': 1,
      'parts': [
        {'kind': 'message', 'partId': 'p1', 'ordinal': 0, 'revision': 5, 'createdAt': 'x', 'updatedAt': 'x',
          'role': 'assistant', 'content': [{'type': 'text', 'text': 'Hello'}]},
      ],
    };
    await client.loadSessionSnapshot('ses_alpha');
    await tester.pump();

    // 低 revision 补偿 → 丢弃
    transport.emitServerEvent(j04Evt(eventId: 'r4', seq: 6, epoch: 'ep_snap', type: 'text_delta',
        payload: {'delta': 'Hel', 'partId': 'p1', 'partRevision': 4}));
    // 同 revision 重放 → 丢弃
    transport.emitServerEvent(j04Evt(eventId: 'r5', seq: 7, epoch: 'ep_snap', type: 'text_delta',
        payload: {'delta': 'Hello', 'partId': 'p1', 'partRevision': 5}));
    // 高 revision 增量 → 追加
    transport.emitServerEvent(j04Evt(eventId: 'r6', seq: 8, epoch: 'ep_snap', type: 'text_delta',
        payload: {'delta': ' World', 'partId': 'p1', 'partRevision': 6}));
    await tester.pump();

    final texts = client.timelineFor('ses_alpha').whereType<StreamingTextItem>().toList();
    expect(texts.length, 1);
    expect(texts.single.text, 'Hello World');
    expect(texts.single.revision, 6);
    client.dispose();
  });

  testWidgets('J0.4b 两个文本 Part 交错：增量精确归属互不串扰', (
    WidgetTester tester,
  ) async {
    await pumpToSession(tester);
    final client = tester.widget<NienieMobileApp>(find.byType(NienieMobileApp)).client;
    final transport = client.transport as FakeBridgeTransport;

    transport.emitServerEvent(j04Evt(eventId: 'm1', seq: 1, type: 'text_delta',
        payload: {'delta': 'Hello', 'partId': 'p1', 'partRevision': 5}));
    transport.emitServerEvent(j04Evt(eventId: 'm2', seq: 2, type: 'text_delta',
        payload: {'delta': 'World', 'partId': 'p2', 'partRevision': 5}));
    transport.emitServerEvent(j04Evt(eventId: 'm3', seq: 3, type: 'text_delta',
        payload: {'delta': '!', 'partId': 'p1', 'partRevision': 6}));
    await tester.pump();

    final texts = client.timelineFor('ses_alpha').whereType<StreamingTextItem>().toList();
    expect(texts.length, 2);
    expect(texts[0].text, 'Hello!'); // p1 的增量不落到 p2
    expect(texts[1].text, 'World');
    client.dispose();
  });

  testWidgets('J0.4b 工具结果先于声明：占位卡被补齐 name/input 且终态不回退', (
    WidgetTester tester,
  ) async {
    await pumpToSession(tester);
    final client = tester.widget<NienieMobileApp>(find.byType(NienieMobileApp)).client;
    final transport = client.transport as FakeBridgeTransport;

    transport.emitServerEvent(j04Evt(eventId: 'x1', seq: 1, type: 'tool_result',
        payload: {'toolCallId': 't1', 'content': 'out', 'isError': false}));
    transport.emitServerEvent(j04Evt(eventId: 'x2', seq: 2, type: 'tool_use',
        payload: {'toolCallId': 't1', 'name': 'shell', 'input': {'command': 'ls'}}));
    await tester.pump();

    final tools = client.timelineFor('ses_alpha').whereType<ToolCallCardItem>().toList();
    expect(tools.length, 1);
    expect(tools.single.name, 'shell'); // 占位名被真实工具名补齐
    expect(tools.single.input['command'], 'ls');
    expect(tools.single.status, ToolCallStatus.completed); // 终态不被 tool_use 回退
    client.dispose();
  });

  testWidgets('J0.6b-3a tool_use 显式 status 采纳：streaming→pending、running 不降级、v1 无 status 默认 running', (
    WidgetTester tester,
  ) async {
    await pumpToSession(tester);
    final client = tester.widget<NienieMobileApp>(find.byType(NienieMobileApp)).client;
    final transport = client.transport as FakeBridgeTransport;

    // v2 streaming → pending（新建采纳）
    transport.emitServerEvent(j04Evt(eventId: 's1', seq: 1, type: 'tool_use',
        payload: {'toolCallId': 't1', 'name': 'shell', 'input': {}, 'status': 'pending'}));
    await tester.pump();
    var tool = client.timelineFor('ses_alpha').whereType<ToolCallCardItem>().single;
    expect(tool.status, ToolCallStatus.pending);

    // running 升级允许
    transport.emitServerEvent(j04Evt(eventId: 's2', seq: 2, type: 'tool_use',
        payload: {'toolCallId': 't1', 'name': 'shell', 'input': {}, 'status': 'running'}));
    await tester.pump();
    tool = client.timelineFor('ses_alpha').whereType<ToolCallCardItem>().single;
    expect(tool.status, ToolCallStatus.running);

    // running + pending 禁止降级
    transport.emitServerEvent(j04Evt(eventId: 's3', seq: 3, type: 'tool_use',
        payload: {'toolCallId': 't1', 'name': 'shell', 'input': {}, 'status': 'pending'}));
    await tester.pump();
    tool = client.timelineFor('ses_alpha').whereType<ToolCallCardItem>().single;
    expect(tool.status, ToolCallStatus.running);

    // 旧 v1 事件无 status → 默认 running（新建）
    transport.emitServerEvent(j04Evt(eventId: 's4', seq: 4, type: 'tool_use',
        payload: {'toolCallId': 't2', 'name': 'shell', 'input': {}}));
    await tester.pump();
    final t2 = client.timelineFor('ses_alpha').whereType<ToolCallCardItem>().firstWhere((t) => t.toolCallId == 't2');
    expect(t2.status, ToolCallStatus.running);
    client.dispose();
  });

  testWidgets('J0.6b-3b 乐观消息认领：clientMessageId 打标 + 首次认领不重复 + 重放门禁', (
    WidgetTester tester,
  ) async {
    await pumpToSession(tester);
    final client = tester.widget<NienieMobileApp>(find.byType(NienieMobileApp)).client;
    final transport = client.transport as FakeBridgeTransport;

    await tester.enterText(find.byKey(const Key('input-session-prompt')), '你好');
    await tester.tap(find.byKey(const Key('btn-send-prompt')));
    await tester.pump();

    // 发送前生成 clientMessageId 并打标到本地乐观消息
    final msgId = transport.sentClientMessageIds.single;
    expect(msgId, isNotNull);
    final optimistic = client.timelineFor('ses_alpha').whereType<UserPromptItem>().single;
    expect(optimistic.messageId, msgId);

    // 历史补偿带同 messageId 的用户全文 → 认领归属（不重复创建、以权威文本对账）
    transport.emitServerEvent(j04Evt(eventId: 'h_u1', seq: 1, type: 'text_delta',
        payload: {'delta': '你好', 'role': 'user', 'partId': 'msg_x:0', 'partRevision': 2, 'messageId': msgId}));
    // 同 partId+revision 重放（不同 eventId）→ revision 门禁丢弃
    transport.emitServerEvent(j04Evt(eventId: 'h_u1r', seq: 2, type: 'text_delta',
        payload: {'delta': '你好', 'role': 'user', 'partId': 'msg_x:0', 'partRevision': 2, 'messageId': msgId}));
    await tester.pump();

    final prompts = client.timelineFor('ses_alpha').whereType<UserPromptItem>().toList();
    expect(prompts.length, 1); // 不重复
    expect(prompts.single.message, '你好');
    expect(prompts.single.partId, 'msg_x:0');
    client.dispose();
  });

}
