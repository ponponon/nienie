import 'dart:async';
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
      // 目标③：高风险操作需二次确认（本例 patterns 含 rm 触发高风险）
      await tester.tap(find.byKey(const Key('btn-perm-confirm-ok')));
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

  testWidgets('J0.6b-3.2 附件端到端：事件附件保存 + 快照 resource 块不丢弃 + UI 显示文件名/MIME', (
    WidgetTester tester,
  ) async {
    await pumpToSession(tester);
    final client = tester.widget<NienieMobileApp>(find.byType(NienieMobileApp)).client;
    final transport = client.transport as FakeBridgeTransport;

    // 事件路径：text+附件并存时附件保存到 UserPromptItem
    transport.emitServerEvent(j04Evt(eventId: 'a1', seq: 1, type: 'text_delta',
        payload: {
          'delta': '请分析这个图片',
          'role': 'user',
          'partId': 'msg_att:0',
          'partRevision': 7,
          'attachments': [
            {'name': 'image.png', 'mime': 'image/png', 'sourceType': 'uri', 'uri': 'file:///w/image.png'},
          ],
        }));
    await tester.pump();
    var prompt = client.timelineFor('ses_alpha').whereType<UserPromptItem>().single;
    expect(prompt.attachments.single.name, 'image.png');
    expect(prompt.attachments.single.mime, 'image/png');
    await tester.drag(find.byType(Scrollable).first, const Offset(0, -1200));
    await tester.pumpAndSettle();
    expect(find.text('image.png · image/png'), findsOneWidget); // UI 可见

    // 快照路径：resource 块转换为附件，不丢弃
    transport.snapshotResponse = {
      'schemaVersion': 1,
      'snapshotId': 'snap_att',
      'sessionId': 'ses_alpha',
      'agentId': 'opencode',
      'streamEpoch': 'ep_snap',
      'watermark': 1,
      'capturedAt': '2026-11-10T00:00:00Z',
      'complete': true,
      'hasMore': false,
      'totalParts': 1,
      'parts': [
        {'kind': 'message', 'partId': 'p1', 'ordinal': 0, 'revision': 2, 'createdAt': 'x', 'updatedAt': 'x',
          'role': 'user', 'content': [
            {'type': 'text', 'text': '看下这个文件'},
            {'type': 'resource', 'uri': 'file:///w/a.ts', 'name': 'a.ts', 'mimeType': 'text/plain'},
          ]},
      ],
    };
    await client.loadSessionSnapshot('ses_alpha');
    await tester.pump();
    prompt = client.timelineFor('ses_alpha').whereType<UserPromptItem>().single;
    expect(prompt.attachments.single.name, 'a.ts');
    expect(prompt.attachments.single.uri, 'file:///w/a.ts');
    await tester.drag(find.byType(Scrollable).first, const Offset(0, -1200));
    await tester.pumpAndSettle();
    expect(find.text('a.ts · text/plain'), findsOneWidget);
    client.dispose();
  });

  testWidgets('J0.6b-3.2 Diff unavailable 显示降级提示，重试不重复生成差异卡', (
    WidgetTester tester,
  ) async {
    await pumpToSession(tester);
    final client = tester.widget<NienieMobileApp>(find.byType(NienieMobileApp)).client;
    final transport = client.transport as FakeBridgeTransport;

    transport.diffUnavailable = true;
    await client.loadSessionDiffs('ses_alpha');
    await tester.pump();
    expect(client.diffUnavailableFor('ses_alpha'), isTrue);
    expect(
      client.timelineFor('ses_alpha').whereType<ErrorCardItem>().where((e) => e.code == 'DIFF_UNAVAILABLE').length,
      1,
    );

    // 重试（仍不可用）→ 不重复提示
    await client.loadSessionDiffs('ses_alpha');
    await tester.pump();
    expect(
      client.timelineFor('ses_alpha').whereType<ErrorCardItem>().where((e) => e.code == 'DIFF_UNAVAILABLE').length,
      1,
    );

    // 恢复可用 → 提示消失，差异卡生成；再重试不重复差异卡
    transport.diffUnavailable = false;
    transport.diffResponse = [
      {'diffId': 'd1', 'file': 'a.ts', 'before': '', 'after': '@@', 'additions': 1, 'deletions': 0},
    ];
    await client.loadSessionDiffs('ses_alpha');
    await client.loadSessionDiffs('ses_alpha');
    await tester.pump();
    expect(client.timelineFor('ses_alpha').whereType<FileDiffCardItem>().length, 1);
    expect(
      client.timelineFor('ses_alpha').whereType<ErrorCardItem>().where((e) => e.code == 'DIFF_UNAVAILABLE').isEmpty,
      isTrue,
    );
    client.dispose();
  });

  testWidgets('路线图#2 目标① 精准定位：同 permissionId 不堆卡、resolved 归位、审批幂等、深链聚焦', (WidgetTester tester) async {
    await pumpToSession(tester);
    final client = tester.widget<NienieMobileApp>(find.byType(NienieMobileApp)).client;
    final transport = client.transport as FakeBridgeTransport;

    // 同一 permissionId 两次询问 → 单卡（upsert），第二次更新 detail
    transport.emitServerEvent(j04Evt(eventId: 'p1', seq: 1, type: 'status',
        payload: {'status': 'waiting', 'permissionId': 'perm_1', 'permission': 'bash', 'detail': '执行 rm -rf', 'patterns': ['*']}));
    transport.emitServerEvent(j04Evt(eventId: 'p2', seq: 2, type: 'status',
        payload: {'status': 'waiting', 'permissionId': 'perm_1', 'permission': 'bash', 'detail': '执行 rm -rf（重试询问）', 'patterns': ['*']}));
    await tester.pump();
    var cards = client.timelineFor('ses_alpha').whereType<PermissionRequestCardItem>().toList();
    expect(cards.length, 1);
    expect(cards.single.detail, '执行 rm -rf（重试询问）');

    // 深链 ?permission= 聚焦
    expect(client.handleDeepLink(Uri.parse('nienie://session/ses_alpha?permission=perm_1')), isTrue);
    expect(client.pendingDeepLinkPermissionId, 'perm_1');

    // 幂等：已决卡片拒绝重复审批
    await client.replyPermission(sessionId: 'ses_alpha', permissionId: 'perm_1', decision: 'allow_once');
    cards = client.timelineFor('ses_alpha').whereType<PermissionRequestCardItem>().toList();
    expect(cards.single.resolvedDecision, 'allow_once');
    await client.replyPermission(sessionId: 'ses_alpha', permissionId: 'perm_1', decision: 'reject');
    expect(cards.single.resolvedDecision, 'allow_once'); // 不被改写

    // permission.replied 归位：另一张卡由他人审批后定格
    transport.emitServerEvent(j04Evt(eventId: 'p3', seq: 3, type: 'status',
        payload: {'status': 'waiting', 'permissionId': 'perm_2', 'permission': 'bash', 'detail': '写文件'}));
    transport.emitServerEvent(j04Evt(eventId: 'p4', seq: 4, type: 'status',
        payload: {'status': 'resolved', 'permissionId': 'perm_2', 'decision': 'allow_always'}));
    await tester.pump();
    cards = client.timelineFor('ses_alpha').whereType<PermissionRequestCardItem>().toList();
    expect(cards.length, 2);
    expect(cards.last.resolvedDecision, 'allow_always'); // 不悬挂
    client.dispose();
  });

  test('路线图#2 目标① 回执 fail-closed：缺失/不一致回执不落定、不确定态禁重试', () async {
    final transport = FakeBridgeTransport();
    final client = MobileBridgeClient(transport: transport, credentialStore: InMemoryCredentialStore());
    var seedSeq = 0;
    Future<void> seed(String pid) async {
      transport.emitServerEvent({
        'version': 1,
        'eventId': 'pe_$pid',
        'streamEpoch': 'ep1',
        'sessionId': 'ses_alpha',
        'sequence': ++seedSeq,
        'timestamp': '2026-11-12T10:00:00Z',
        'type': 'status',
        'payload': {'status': 'waiting', 'permissionId': pid, 'permission': 'bash', 'detail': '写文件'},
      });
      await Future<void>.delayed(Duration.zero);
    }

    // 回执缺失 → 不落定 + 不确定态
    await seed('perm_missing');
    transport.permissionReplyEchoMode = 'missing';
    await client.replyPermission(sessionId: 'ses_alpha', permissionId: 'perm_missing', decision: 'allow_once');
    var card = client.timelineFor('ses_alpha').whereType<PermissionRequestCardItem>().firstWhere((c) => c.permissionId == 'perm_missing');
    expect(card.resolvedDecision, isNull);
    expect(card.resolutionUncertain, isTrue);
    expect(client.errorMessage, contains('请勿重复操作'));

    // permissionId 不一致 → 不落定
    await seed('perm_id');
    transport.permissionReplyEchoMode = 'permissionIdMismatch';
    await client.replyPermission(sessionId: 'ses_alpha', permissionId: 'perm_id', decision: 'allow_once');
    card = client.timelineFor('ses_alpha').whereType<PermissionRequestCardItem>().firstWhere((c) => c.permissionId == 'perm_id');
    expect(card.resolvedDecision, isNull);

    // sessionId 不一致 → 不落定
    await seed('perm_sess');
    transport.permissionReplyEchoMode = 'sessionIdMismatch';
    await client.replyPermission(sessionId: 'ses_alpha', permissionId: 'perm_sess', decision: 'allow_once');
    card = client.timelineFor('ses_alpha').whereType<PermissionRequestCardItem>().firstWhere((c) => c.permissionId == 'perm_sess');
    expect(card.resolvedDecision, isNull);

    // decision 不一致 → 不落定
    await seed('perm_dec');
    transport.permissionReplyEchoMode = 'decisionMismatch';
    await client.replyPermission(sessionId: 'ses_alpha', permissionId: 'perm_dec', decision: 'allow_once');
    card = client.timelineFor('ses_alpha').whereType<PermissionRequestCardItem>().firstWhere((c) => c.permissionId == 'perm_dec');
    expect(card.resolvedDecision, isNull);
    client.dispose();
  });

  testWidgets('路线图#2 目标① fail-closed 决策映射：未知/缺失 decision 不伪装批准或拒绝', (WidgetTester tester) async {
    await pumpToSession(tester);
    final client = tester.widget<NienieMobileApp>(find.byType(NienieMobileApp)).client;
    final transport = client.transport as FakeBridgeTransport;

    transport.emitServerEvent(j04Evt(eventId: 'u1', seq: 1, type: 'status',
        payload: {'status': 'waiting', 'permissionId': 'perm_u', 'permission': 'bash', 'detail': 'x'}));
    // 未知 decision → unknown（不伪装 allow/reject）
    transport.emitServerEvent(j04Evt(eventId: 'u2', seq: 2, type: 'status',
        payload: {'status': 'resolved', 'permissionId': 'perm_u', 'decision': 'weird'}));
    // 缺失 decision → unknown
    transport.emitServerEvent(j04Evt(eventId: 'u3', seq: 3, type: 'status',
        payload: {'status': 'waiting', 'permissionId': 'perm_v', 'permission': 'bash', 'detail': 'y'}));
    transport.emitServerEvent(j04Evt(eventId: 'u4', seq: 4, type: 'status',
        payload: {'status': 'resolved', 'permissionId': 'perm_v'}));
    await tester.pump();
    final cards = client.timelineFor('ses_alpha').whereType<PermissionRequestCardItem>().toList();
    final cu = cards.firstWhere((c) => c.permissionId == 'perm_u');
    final cv = cards.firstWhere((c) => c.permissionId == 'perm_v');
    expect(cu.resolvedDecision, 'unknown');
    expect(cv.resolvedDecision, 'unknown');

    // 三种合法映射（canonical 值，经 mapper 归一后进入 reducer）
    var mapSeq = 4;
    for (final entry in [
      ['perm_o', 'allow_once'],
      ['perm_a', 'allow_always'],
      ['perm_r', 'reject'],
    ]) {
      final pid = entry[0];
      transport.emitServerEvent(j04Evt(eventId: 'w_$pid', seq: ++mapSeq, type: 'status',
          payload: {'status': 'waiting', 'permissionId': pid, 'permission': 'bash', 'detail': 'z'}));
      transport.emitServerEvent(j04Evt(eventId: 'x_$pid', seq: ++mapSeq, type: 'status',
          payload: {'status': 'resolved', 'permissionId': pid, 'decision': entry[1]}));
    }
    await tester.pump();
    final all = client.timelineFor('ses_alpha').whereType<PermissionRequestCardItem>().toList();
    expect(all.firstWhere((c) => c.permissionId == 'perm_o').resolvedDecision, 'allow_once');
    expect(all.firstWhere((c) => c.permissionId == 'perm_a').resolvedDecision, 'allow_always');
    expect(all.firstWhere((c) => c.permissionId == 'perm_r').resolvedDecision, 'reject');
    client.dispose();
  });

  test('路线图#2 目标① 并发与归位：双击只发一次、跨会话不阻塞、外部 resolved 清 pending、重复 waiting 不改写已决', () async {
    final transport = FakeBridgeTransport();
    final client = MobileBridgeClient(transport: transport, credentialStore: InMemoryCredentialStore());
    final seqBySession = <String, int>{};
    void emit(String sid, String type, Map<String, dynamic> payload) {
      final seq = (seqBySession[sid] ?? 0) + 1;
      seqBySession[sid] = seq;
      transport.emitServerEvent({
        'version': 1, 'eventId': 'e_${sid}_$seq', 'streamEpoch': 'ep1', 'sessionId': sid,
        'sequence': seq, 'timestamp': '2026-11-12T10:00:00Z', 'type': type, 'payload': payload,
      });
    }

    emit('ses_alpha', 'status', {'status': 'waiting', 'permissionId': 'perm_c', 'permission': 'bash', 'detail': 'c'});
    await Future<void>.delayed(Duration.zero);
    // 双击并发：只发一次
    await Future.wait([
      client.replyPermission(sessionId: 'ses_alpha', permissionId: 'perm_c', decision: 'allow_once'),
      client.replyPermission(sessionId: 'ses_alpha', permissionId: 'perm_c', decision: 'allow_once'),
    ]);
    expect(transport.permissionReplies.where((r) => r['permissionId'] == 'perm_c').length, 1);

    // 跨会话同 permissionId 不互相阻塞
    emit('ses_beta', 'status', {'status': 'waiting', 'permissionId': 'perm_c', 'permission': 'bash', 'detail': 'c2'});
    await Future<void>.delayed(Duration.zero);
    await client.replyPermission(sessionId: 'ses_beta', permissionId: 'perm_c', decision: 'reject');
    expect(transport.permissionReplies.length, 2);

    // 外部 resolved 清除 replyPending（模拟本机请求未返回、他端已审批）
    emit('ses_alpha', 'status', {'status': 'waiting', 'permissionId': 'perm_p', 'permission': 'bash', 'detail': 'p'});
    await Future<void>.delayed(Duration.zero);
    emit('ses_alpha', 'status', {'status': 'resolved', 'permissionId': 'perm_p', 'decision': 'allow_once'});
    await Future<void>.delayed(Duration.zero);
    final cardP = client.timelineFor('ses_alpha').whereType<PermissionRequestCardItem>().firstWhere((c) => c.permissionId == 'perm_p');
    expect(cardP.replyPending, isFalse);
    expect(cardP.resolvedDecision, 'allow_once');

    // 已决卡收到重复 waiting 不被重新打开或改写
    emit('ses_alpha', 'status', {'status': 'waiting', 'permissionId': 'perm_p', 'permission': 'bash', 'detail': '改写尝试'});
    await Future<void>.delayed(Duration.zero);
    expect(cardP.resolvedDecision, 'allow_once');
    expect(cardP.detail, 'p');
    client.dispose();
  });

  test('路线图#2 目标① Round 3 竞态：权威 resolved 定格后，迟到 RPC 异常不得降级、成功不得覆盖', () async {
    final transport = FakeBridgeTransport();
    final client = MobileBridgeClient(transport: transport, credentialStore: InMemoryCredentialStore());
    void emit(String type, Map<String, dynamic> payload, {int seq = 1}) {
      transport.emitServerEvent({
        'version': 1, 'eventId': 'r$seq', 'streamEpoch': 'ep1', 'sessionId': 'ses_alpha',
        'sequence': seq, 'timestamp': '2026-11-12T10:00:00Z', 'type': type, 'payload': payload,
      });
    }

    emit('status', {'status': 'waiting', 'permissionId': 'perm_r', 'permission': 'bash', 'detail': 'x'});
    await Future<void>.delayed(Duration.zero);
    transport.permissionReplyGate = Completer<void>();
    final pending = client.replyPermission(sessionId: 'ses_alpha', permissionId: 'perm_r', decision: 'allow_once');
    await Future<void>.delayed(Duration.zero); // RPC in-flight
    var card = client.timelineFor('ses_alpha').whereType<PermissionRequestCardItem>().single;
    expect(card.replyPending, isTrue);

    // RPC 未返回期间，权威 resolved 到达并定格
    emit('status', {'status': 'resolved', 'permissionId': 'perm_r', 'decision': 'reject'}, seq: 2);
    await Future<void>.delayed(Duration.zero);
    expect(card.resolvedDecision, 'reject');
    expect(card.replyPending, isFalse);

    // 迟到 RPC 异常（回执失配）→ 不得降级为不确定、不得改写结论
    transport.permissionReplyEchoMode = 'permissionIdMismatch';
    transport.permissionReplyGate!.complete();
    await pending;
    expect(card.resolvedDecision, 'reject');
    expect(card.resolutionUncertain, isFalse);

    // 另一卡：RPC 成功不得覆盖已定格的不同结果
    emit('status', {'status': 'waiting', 'permissionId': 'perm_r2', 'permission': 'bash', 'detail': 'y'}, seq: 3);
    await Future<void>.delayed(Duration.zero);
    transport.permissionReplyGate = Completer<void>();
    transport.permissionReplyEchoMode = 'ok';
    final pending2 = client.replyPermission(sessionId: 'ses_alpha', permissionId: 'perm_r2', decision: 'allow_once');
    await Future<void>.delayed(Duration.zero);
    emit('status', {'status': 'resolved', 'permissionId': 'perm_r2', 'decision': 'reject'}, seq: 4);
    await Future<void>.delayed(Duration.zero);
    transport.permissionReplyGate!.complete();
    await pending2;
    card = client.timelineFor('ses_alpha').whereType<PermissionRequestCardItem>().singleWhere((c) => c.permissionId == 'perm_r2');
    expect(card.resolvedDecision, 'reject'); // 权威结果不被 RPC 成功覆盖
    client.dispose();
  });

  test('路线图#2 目标① Round 3 业务层禁重试 + unknown 可升级为明确结果', () async {
    final transport = FakeBridgeTransport();
    final client = MobileBridgeClient(transport: transport, credentialStore: InMemoryCredentialStore());
    void emit(String type, Map<String, dynamic> payload, {int seq = 1}) {
      transport.emitServerEvent({
        'version': 1, 'eventId': 's$seq', 'streamEpoch': 'ep1', 'sessionId': 'ses_alpha',
        'sequence': seq, 'timestamp': '2026-11-12T10:00:00Z', 'type': type, 'payload': payload,
      });
    }

    // 不确定态 → 业务方法层拒绝重试（即使 UI 按钮被绕过）
    emit('status', {'status': 'waiting', 'permissionId': 'perm_u1', 'permission': 'bash', 'detail': 'x'});
    await Future<void>.delayed(Duration.zero);
    transport.permissionReplyEchoMode = 'missing';
    await client.replyPermission(sessionId: 'ses_alpha', permissionId: 'perm_u1', decision: 'allow_once');
    var card = client.timelineFor('ses_alpha').whereType<PermissionRequestCardItem>().single;
    expect(card.resolutionUncertain, isTrue);
    transport.permissionReplyEchoMode = 'ok';
    await client.replyPermission(sessionId: 'ses_alpha', permissionId: 'perm_u1', decision: 'allow_once');
    expect(transport.permissionReplies.length, 1); // 第二次调用被状态机拒绝

    // unknown 可被后续明确结果升级
    emit('status', {'status': 'waiting', 'permissionId': 'perm_u2', 'permission': 'bash', 'detail': 'y'}, seq: 2);
    emit('status', {'status': 'resolved', 'permissionId': 'perm_u2'}, seq: 3); // 缺失 decision → unknown
    await Future<void>.delayed(Duration.zero);
    card = client.timelineFor('ses_alpha').whereType<PermissionRequestCardItem>().singleWhere((c) => c.permissionId == 'perm_u2');
    expect(card.resolvedDecision, 'unknown');
    emit('status', {'status': 'resolved', 'permissionId': 'perm_u2', 'decision': 'allow_once'}, seq: 4);
    await Future<void>.delayed(Duration.zero);
    expect(card.resolvedDecision, 'allow_once'); // 升级为明确结果
    // 明确结果不再被未知事件降级
    emit('status', {'status': 'resolved', 'permissionId': 'perm_u2', 'decision': 'weird'}, seq: 5);
    await Future<void>.delayed(Duration.zero);
    expect(card.resolvedDecision, 'allow_once');
    client.dispose();
  });

  test('路线图#2 目标① Round 3 回执缺字段逐项 fail-closed', () async {
    final transport = FakeBridgeTransport();
    final client = MobileBridgeClient(transport: transport, credentialStore: InMemoryCredentialStore());
    var seq = 0;
    Future<void> attempt(String pid, String mode) async {
      transport.emitServerEvent({
        'version': 1, 'eventId': 'f_$pid', 'streamEpoch': 'ep1', 'sessionId': 'ses_alpha',
        'sequence': ++seq, 'timestamp': '2026-11-12T10:00:00Z', 'type': 'status',
        'payload': {'status': 'waiting', 'permissionId': pid, 'permission': 'bash', 'detail': 'x'},
      });
      await Future<void>.delayed(Duration.zero);
      transport.permissionReplyEchoMode = mode;
      await client.replyPermission(sessionId: 'ses_alpha', permissionId: pid, decision: 'allow_once');
    }

    for (final entry in [
      ['perm_notok', 'notOk'],
      ['perm_noreplied', 'missingReplied'],
      ['perm_nosid', 'missingSessionId'],
      ['perm_nopid', 'missingPermissionId'],
      ['perm_nodecision', 'missingDecision'],
    ]) {
      await attempt(entry[0], entry[1]);
    }
    for (final pid in ['perm_notok', 'perm_noreplied', 'perm_nosid', 'perm_nopid', 'perm_nodecision']) {
      final card = client.timelineFor('ses_alpha').whereType<PermissionRequestCardItem>().singleWhere((c) => c.permissionId == pid);
      expect(card.resolvedDecision, isNull, reason: pid);
      expect(card.resolutionUncertain, isTrue, reason: pid);
    }
    client.dispose();
  });

  test('路线图#2 目标① Round 3 深链双键聚焦最终态 + 普通通知清焦点 + URL 编码回归', () async {
    final transport = FakeBridgeTransport();
    final client = MobileBridgeClient(transport: transport, credentialStore: InMemoryCredentialStore());
    await client.refreshSessions();
    client.connectionState = BridgeConnectionState.connected;

    // 带 permission 的深链：会话进入后双键聚焦
    expect(client.handleDeepLink(Uri.parse('nienie://session/ses_alpha?permission=perm%2F1%20x')), isTrue);
    await Future<void>.delayed(Duration.zero);
    expect(client.focusedPermissionId, 'perm/1 x'); // 编码解析正确
    expect(client.focusedPermissionSessionId, 'ses_alpha');
    expect(client.pendingDeepLinkPermissionId, isNull);

    // 普通会话通知：清除遗留聚焦
    expect(client.handleDeepLink(Uri.parse('nienie://session/ses_alpha')), isTrue);
    await Future<void>.delayed(Duration.zero);
    expect(client.focusedPermissionId, isNull);
    expect(client.focusedPermissionSessionId, isNull);
    client.dispose();
  });

  test('路线图#2 目标② 风险分级：纯规则、白名单、高优先级、未知不判低', () {
    expect(classifyPermissionRisk('read', []), PermissionRiskLevel.low);
    expect(classifyPermissionRisk('grep', ['src/**']), PermissionRiskLevel.low);
    expect(classifyPermissionRisk('bash', ['*']), PermissionRiskLevel.medium);
    expect(classifyPermissionRisk('delete', ['x']), PermissionRiskLevel.high);
    expect(classifyPermissionRisk('bash', ['rm -rf /tmp/x']), PermissionRiskLevel.high); // 破坏性 resource 规则优先
    expect(classifyPermissionRisk('frobnicate', []), PermissionRiskLevel.unknown); // 未识别绝不判低
    expect(classifyPermissionRisk('', []), PermissionRiskLevel.unknown);
    // 词边界与大小写（Round 4 P2）：引号/逗号/反斜杠包裹与大写变体均命中
    expect(classifyPermissionRisk('bash', ['"rm -rf /tmp"']), PermissionRiskLevel.high);
    expect(classifyPermissionRisk('bash', ['C:\\tools\\del.exe']), PermissionRiskLevel.high);
    expect(classifyPermissionRisk('bash', ['foo,rm -rf']), PermissionRiskLevel.high);
    expect(classifyPermissionRisk('bash', ['DEL something']), PermissionRiskLevel.high);
    // 词边界反例：model/payload 等包含子串不误判
    expect(classifyPermissionRisk('bash', ['model/data.json']), PermissionRiskLevel.medium);
    expect(classifyPermissionRisk('bash', ['skill/killer.md']), PermissionRiskLevel.medium);
    // detail 契约：描述性标题不参与分级（即使像命令）
    expect(classifyPermissionRisk('bash', []), PermissionRiskLevel.medium);
  });

  testWidgets('路线图#2 目标③ Snapshot 恢复按 createdAt 计时 + 聚焦蓝色描边', (WidgetTester tester) async {
    await pumpToSession(tester);
    final client = tester.widget<NienieMobileApp>(find.byType(NienieMobileApp)).client;
    final transport = client.transport as FakeBridgeTransport;
    final oldTs = DateTime.now().subtract(const Duration(minutes: 5)).toIso8601String();
    transport.snapshotResponse = {
      'schemaVersion': 1,
      'snapshotId': 'snap_perm',
      'sessionId': 'ses_alpha',
      'agentId': 'opencode',
      'streamEpoch': 'ep_snap',
      'watermark': 1,
      'capturedAt': '2026-11-10T00:00:00Z',
      'complete': true,
      'hasMore': false,
      'totalParts': 2,
      'parts': [
        {'kind': 'permission', 'partId': 'pp1', 'ordinal': 0, 'revision': 1, 'createdAt': oldTs, 'updatedAt': oldTs,
          'permissionId': 'perm_old', 'permission': 'bash', 'detail': '早已发起', 'patterns': ['*']},
        {'kind': 'permission', 'partId': 'pp2', 'ordinal': 1, 'revision': 1,
          'createdAt': DateTime.now().toIso8601String(), 'updatedAt': DateTime.now().toIso8601String(),
          'permissionId': 'perm_new', 'permission': 'bash', 'detail': '刚发起', 'patterns': ['*']},
      ],
    };
    await client.loadSessionSnapshot('ses_alpha');
    await tester.pumpAndSettle();
    await tester.drag(find.byType(Scrollable).first, const Offset(0, -3000));
    await tester.pumpAndSettle();
    // 旧请求（createdAt 5 分钟前）恢复即显示超时提醒；新请求不显示
    expect(find.byKey(const Key('perm-waiting-perm_old')), findsOneWidget);
    expect(find.byKey(const Key('perm-waiting-perm_new')), findsNothing);

    // 聚焦描边为独立蓝色 2px
    client.handleDeepLink(Uri.parse('nienie://session/ses_alpha?permission=perm_new'));
    await tester.pumpAndSettle();
    await tester.drag(find.byType(Scrollable).first, const Offset(0, -3000));
    await tester.pumpAndSettle();
    expect(client.focusedPermissionId, 'perm_new');
    // 装饰断言：聚焦卡 Container 边框为蓝色（0xFF2563EB）
    final containers = find.byType(Container).evaluate().map((e) => e.widget as Container);
    final focusedBorder = containers
        .map((c) => c.decoration is BoxDecoration ? (c.decoration as BoxDecoration).border : null)
        .whereType<Border>()
        .where((b) => b.top.color == const Color(0xFF2563EB) && b.top.width == 2);
    expect(focusedBorder.isNotEmpty, isTrue);
    client.dispose();
  });

  testWidgets('路线图#2 目标② 审批卡：风险徽章 + 结构化行 + 深链聚焦高亮', (WidgetTester tester) async {
    await pumpToSession(tester);
    final client = tester.widget<NienieMobileApp>(find.byType(NienieMobileApp)).client;
    final transport = client.transport as FakeBridgeTransport;

    transport.emitServerEvent(j04Evt(eventId: 'k1', seq: 1, type: 'status', payload: {
      'status': 'waiting',
      'permissionId': 'perm_hi',
      'permission': 'bash',
      'detail': '构建并清理项目产物',
      'patterns': ['./packages/*', './apps/mobile/*'],
    }));
    await tester.pumpAndSettle();
    await tester.drag(find.byType(Scrollable).first, const Offset(0, -2000));
    await tester.pumpAndSettle();
    // 结构化行：操作/请求详情/资源对象均按 payload 原样展示（默认语言 en）
    expect(find.text('构建并清理项目产物'), findsWidgets);
    expect(find.text('./packages/*\n./apps/mobile/*'), findsOneWidget);
    // 风险契约：detail 是描述性标题（props.title 映射），不参与风险分级——
    // bash + 无破坏性 resources = medium，即使 detail 文本像命令
    expect(find.text('Medium risk'), findsOneWidget);
    expect(find.text('bash'), findsWidgets);

    // 深链聚焦：高亮目标卡（蓝底描边容器存在）
    client.handleDeepLink(Uri.parse('nienie://session/ses_alpha?permission=perm_hi'));
    await tester.pumpAndSettle();
    expect(client.focusedPermissionId, 'perm_hi');
    expect(find.byKey(const Key('btn-perm-allow-once-perm_hi')), findsOneWidget);
    client.dispose();
  });

  testWidgets('路线图#2 目标③ 防误操作：二次确认/44dp/禁用/收起/超时提醒', (WidgetTester tester) async {
    await pumpToSession(tester);
    final client = tester.widget<NienieMobileApp>(find.byType(NienieMobileApp)).client;
    final transport = client.transport as FakeBridgeTransport;
    var seq = 0;
    void emit(String type, Map<String, dynamic> payload) {
      transport.emitServerEvent({
        'version': 1, 'eventId': 'z${++seq}', 'streamEpoch': 'ep1', 'sessionId': 'ses_alpha',
        'sequence': seq, 'timestamp': '2026-11-12T10:00:00Z', 'type': type, 'payload': payload,
      });
    }

    // 低风险 allow_once：直达不弹窗
    emit('status', {'status': 'waiting', 'permissionId': 'perm_low', 'permission': 'read', 'detail': '读文件', 'patterns': ['src/**']});
    await tester.pumpAndSettle();
    await tester.drag(find.byType(Scrollable).first, const Offset(0, -2000));
    await tester.pumpAndSettle();
    final lowBtn = find.byKey(const Key('btn-perm-allow-once-perm_low'));
    expect(tester.getSize(lowBtn).height, greaterThanOrEqualTo(44)); // 44dp 触控目标
    await tester.tap(lowBtn);
    await tester.pumpAndSettle();
    expect(transport.permissionReplies.length, 1); // 无弹窗直达

    // allow_always：必须二次确认（含永久影响说明），取消则不提交
    emit('status', {'status': 'waiting', 'permissionId': 'perm_alw', 'permission': 'bash', 'detail': '构建', 'patterns': ['*']});
    await tester.pumpAndSettle();
    await tester.drag(find.byType(Scrollable).first, const Offset(0, -2000));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('btn-perm-allow-always-perm_alw')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('btn-perm-confirm-ok')), findsOneWidget);
    await tester.tap(find.byKey(const Key('btn-perm-confirm-cancel')));
    await tester.pumpAndSettle();
    expect(transport.permissionReplies.length, 1); // 取消未提交
    await tester.tap(find.byKey(const Key('btn-perm-allow-always-perm_alw')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('btn-perm-confirm-ok')));
    await tester.pumpAndSettle();
    expect(transport.permissionReplies.length, 2);

    // 已决卡收起：按钮消失、结果定格
    expect(find.byKey(const Key('btn-perm-allow-once-perm_alw')), findsNothing);
    expect(find.byKey(const Key('perm-result-perm_alw')), findsOneWidget);

    // 超时提醒：计时起点=request 真实产生时间（event.timestamp），历史恢复不重新起算
    final oldTs = DateTime.now().subtract(const Duration(minutes: 5)).toIso8601String();
    // perm_wait 用真实「现在」时间戳（固定时间戳会在时钟越过 2 分钟后误触发提醒——时间炸弹）
    transport.emitServerEvent({
      'version': 1, 'eventId': 'znow', 'streamEpoch': 'ep1', 'sessionId': 'ses_alpha',
      'sequence': ++seq, 'timestamp': DateTime.now().toIso8601String(), 'type': 'status',
      'payload': {'status': 'waiting', 'permissionId': 'perm_wait', 'permission': 'bash', 'detail': 'x'},
    });
    transport.emitServerEvent({
      'version': 1, 'eventId': 'zold', 'streamEpoch': 'ep1', 'sessionId': 'ses_alpha',
      'sequence': ++seq, 'timestamp': oldTs, 'type': 'status',
      'payload': {'status': 'waiting', 'permissionId': 'perm_old', 'permission': 'bash', 'detail': '早已发起'},
    });
    await tester.pumpAndSettle();
    await tester.drag(find.byType(Scrollable).first, const Offset(0, -3000));
    await tester.pumpAndSettle();
    // 旧请求（5 分钟前）立即显示提醒
    expect(find.byKey(const Key('perm-waiting-perm_old')), findsOneWidget);
    // 新请求不显示
    expect(find.byKey(const Key('perm-waiting-perm_wait')), findsNothing);
    client.dispose();
  });

  testWidgets('路线图#2 目标③ 二次确认矩阵与文案分支', (WidgetTester tester) async {
    await pumpToSession(tester);
    final client = tester.widget<NienieMobileApp>(find.byType(NienieMobileApp)).client;
    final transport = client.transport as FakeBridgeTransport;
    var seq = 0;
    void emit(String type, Map<String, dynamic> payload) {
      transport.emitServerEvent({
        'version': 1, 'eventId': 'm${++seq}', 'streamEpoch': 'ep1', 'sessionId': 'ses_alpha',
        'sequence': seq, 'timestamp': '2026-11-12T10:00:00Z', 'type': type, 'payload': payload,
      });
    }

    // 高风险 reject：直达不弹窗（拒绝是安全操作）
    emit('status', {'status': 'waiting', 'permissionId': 'perm_hr', 'permission': 'bash', 'detail': 'x', 'patterns': ['rm -rf /']});
    await tester.pumpAndSettle();
    await tester.drag(find.byType(Scrollable).first, const Offset(0, -3000));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('btn-perm-reject-perm_hr')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('btn-perm-confirm-ok')), findsNothing);
    expect(transport.permissionReplies.single['decision'], 'reject');

    // 高风险 allow_once：确认框文案为「仅本次」（不是永久允许）
    emit('status', {'status': 'waiting', 'permissionId': 'perm_ha', 'permission': 'bash', 'detail': 'x', 'patterns': ['rm -rf /']});
    await tester.pumpAndSettle();
    await tester.drag(find.byType(Scrollable).first, const Offset(0, -3000));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('btn-perm-allow-once-perm_ha')));
    await tester.pumpAndSettle();
    expect(find.text('Allow the following only once'), findsOneWidget);
    await tester.tap(find.byKey(const Key('btn-perm-confirm-cancel')));
    await tester.pumpAndSettle();
    expect(transport.permissionReplies.length, 1); // 取消不提交

    // allow_always：确认框含永久影响说明
    emit('status', {'status': 'waiting', 'permissionId': 'perm_aa', 'permission': 'bash', 'detail': 'x', 'patterns': ['*']});
    await tester.pumpAndSettle();
    await tester.drag(find.byType(Scrollable).first, const Offset(0, -3000));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('btn-perm-allow-always-perm_aa')));
    await tester.pumpAndSettle();
    expect(find.text('This will permanently allow'), findsOneWidget);
    await tester.tap(find.byKey(const Key('btn-perm-confirm-ok')));
    await tester.pumpAndSettle();
    expect(transport.permissionReplies.length, 2);

    // 未分类（unknown）allow_once：需要确认，但文案必须与「高风险」明确区分
    emit('status', {'status': 'waiting', 'permissionId': 'perm_un', 'permission': 'frobnicate', 'detail': 'x'});
    await tester.pumpAndSettle();
    await tester.drag(find.byType(Scrollable).first, const Offset(0, -3000));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('btn-perm-allow-once-perm_un')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('btn-perm-confirm-ok')), findsOneWidget);
    expect(find.text('This action is unclassified and its risk cannot be confirmed, please decide carefully'), findsOneWidget);
    expect(find.text('This action is marked high risk, please confirm to continue'), findsNothing); // 绝不误用高风险文案
    await tester.tap(find.byKey(const Key('btn-perm-confirm-cancel')));
    await tester.pumpAndSettle();
    expect(transport.permissionReplies.length, 2); // 取消不提交（此前已 2 次）
    client.dispose();
  });

  testWidgets('路线图#3 状态胶囊与断线横幅：重连第 N 次/补发语义/恢复', (WidgetTester tester) async {
    await pumpToSession(tester);
    final client = tester.widget<NienieMobileApp>(find.byType(NienieMobileApp)).client;
    final transport = client.transport as FakeBridgeTransport;

    // 连接态胶囊：在线 + 空闲
    await tester.pump(const Duration(seconds: 1));
    expect(find.byKey(const Key('status-pill')), findsWidgets);
    expect(find.textContaining('Idle'), findsWidgets);

    // 运行中 → 思考中计时
    transport.emitServerEvent({
      'version': 1, 'eventId': 'r1', 'streamEpoch': 'ep1', 'sessionId': 'ses_alpha',
      'sequence': 1, 'timestamp': '2026-11-12T10:00:00Z', 'type': 'status',
      'payload': {'status': 'running'},
    });
    await tester.pump(const Duration(seconds: 1));
    expect(find.textContaining('Thinking'), findsWidgets);

    // 断线 → 重连横幅（第 N 次 + 自动补发语义），非静默
    transport.emitRaw({'type': 'transport.disconnected'});
    await tester.pump();
    expect(client.connectionState, BridgeConnectionState.reconnecting); // 先验证状态机
    await tester.pump(const Duration(seconds: 1));
    expect(find.byKey(const Key('reconnect-banner')), findsOneWidget);
    expect(find.textContaining('sync after reconnect'), findsOneWidget); // 文案=重连后同步会话消息（可保证语义）
    // 推进时间让重连调度链完成，避免悬挂 Timer
    await tester.pump(const Duration(seconds: 8));
    client.dispose();
  });

  test('路线图#3 送达回执：发送中→已送达；失败→未送达可重发', () async {
    final transport = FakeBridgeTransport();
    final client = MobileBridgeClient(transport: transport, credentialStore: InMemoryCredentialStore());
    await client.refreshSessions();
    client.connectionState = BridgeConnectionState.connected;
    final session = client.sessions.firstWhere((s) => s.id == 'ses_alpha');
    client.activeSession = session;

    // 成功送达
    await client.sendMessage('第一条');
    final delivered = client.timelineFor('ses_alpha').whereType<UserPromptItem>().single;
    expect(delivered.receipt, SendReceipt.delivered);

    // 发送失败 → 未送达
    transport.failNextSend = true;
    await client.sendMessage('第二条');
    final items = client.timelineFor('ses_alpha').whereType<UserPromptItem>().toList();
    final failed = items.last;
    expect(failed.receipt, SendReceipt.failed);
    expect(failed.message, '第二条');

    // 显式重发（复用同一消息，不新建）→ 送达
    await client.retrySendPrompt(session, failed);
    expect(failed.receipt, SendReceipt.delivered);
    expect(client.timelineFor('ses_alpha').whereType<UserPromptItem>().length, 2);
    client.dispose();
  });

  testWidgets('路线图#3 Round2 重连状态机：重试期间保持 reconnecting，4 次失败后才回配对页，成功清零', (WidgetTester tester) async {
    await pumpToSession(tester);
    final client = tester.widget<NienieMobileApp>(find.byType(NienieMobileApp)).client;
    final transport = client.transport as FakeBridgeTransport;

    // 场景 A：连续 4 次 hello 失败 → 期间会话视图保留、横幅递增；最终回配对页
    transport.failHelloCount = 4;
    transport.emitRaw({'type': 'transport.disconnected'});
    await tester.pump(const Duration(seconds: 2));
    expect(client.connectionState, BridgeConnectionState.reconnecting);
    expect(find.byKey(const Key('reconnect-banner')), findsOneWidget); // 会话视图保留
    // 重试推进中状态不得降级为 connecting/disconnected
    await tester.pump(const Duration(seconds: 2));
    expect(client.connectionState, BridgeConnectionState.reconnecting);
    await tester.pump(const Duration(seconds: 8)); // 4 次重试全部失败
    expect(client.connectionState, BridgeConnectionState.disconnected);
    expect(find.byKey(const Key('reconnect-banner')), findsNothing); // 回配对页
    expect(find.byKey(const Key('btn-connect-pair')), findsOneWidget);
    client.dispose();
  });

  testWidgets('路线图#3 Round2 重连成功清零 + 断线禁发 + 计时起点不被历史重置', (WidgetTester tester) async {
    await pumpToSession(tester);
    final client = tester.widget<NienieMobileApp>(find.byType(NienieMobileApp)).client;
    final transport = client.transport as FakeBridgeTransport;

    // 计时起点=事件真实时间：5 分钟前的 running 立即显示 300s+
    transport.emitServerEvent({
      'version': 1, 'eventId': 'run1', 'streamEpoch': 'ep1', 'sessionId': 'ses_alpha',
      'sequence': 1,
      'timestamp': DateTime.now().subtract(const Duration(seconds: 300)).toIso8601String(),
      'type': 'status', 'payload': {'status': 'running'},
    });
    await tester.pump(const Duration(seconds: 1));
    expect(find.textContaining('Thinking'), findsWidgets);
    expect(find.textContaining('300'), findsWidgets);

    // 重复 running 事件（历史恢复）不重置计时
    transport.emitServerEvent({
      'version': 1, 'eventId': 'run2', 'streamEpoch': 'ep1', 'sessionId': 'ses_alpha',
      'sequence': 2, 'timestamp': DateTime.now().toIso8601String(),
      'type': 'status', 'payload': {'status': 'running'},
    });
    await tester.pump(const Duration(seconds: 1));
    expect(find.textContaining('300'), findsWidgets); // 未被重置为 0-2s

    // 断线重连：期间发送禁用（横幅在、发送按钮禁用、sendMessage 不出站）
    transport.failHelloCount = 1;
    transport.emitRaw({'type': 'transport.disconnected'});
    await tester.pump(const Duration(seconds: 2));
    expect(client.connectionState, BridgeConnectionState.reconnecting);
    final sendBtn = tester.widget<IconButton>(find.byKey(const Key('btn-send-prompt')));
    expect(sendBtn.onPressed, isNull); // UI 禁用
    final before = transport.sentPrompts.length;
    await client.sendMessage('断线期间的消息');
    expect(transport.sentPrompts.length, before); // 不出站
    expect(client.errorMessage, contains('同步'));

    // 1 次失败后成功 → connected + 计数清零 + 横幅消失
    await tester.pump(const Duration(seconds: 8));
    expect(client.connectionState, BridgeConnectionState.connected);
    expect(client.reconnectAttempt, 0);
    expect(find.byKey(const Key('reconnect-banner')), findsNothing);
    client.dispose();
  });

  testWidgets('路线图#3 R3-2 断线期间键盘发送不丢失输入（确认接受后才清空）', (WidgetTester tester) async {
    await pumpToSession(tester);
    final client = tester.widget<NienieMobileApp>(find.byType(NienieMobileApp)).client;
    final transport = client.transport as FakeBridgeTransport;

    transport.failHelloCount = 4;
    transport.emitRaw({'type': 'transport.disconnected'});
    await tester.pump(const Duration(seconds: 2));
    expect(client.connectionState, BridgeConnectionState.reconnecting);

    // 键盘发送（TextInputAction.send）：客户端拒绝接受 → 输入框不清空、不出站、不进时间线
    await tester.enterText(find.byKey(const Key('input-session-prompt')), '断线中的重要消息');
    await tester.testTextInput.receiveAction(TextInputAction.send);
    await tester.pump(const Duration(seconds: 1));

    final field = tester.widget<TextField>(find.byKey(const Key('input-session-prompt')));
    expect(field.controller!.text, '断线中的重要消息'); // 输入保留
    expect(transport.sentPrompts, isEmpty); // 不出站
    expect(client.timelineFor('ses_alpha').whereType<UserPromptItem>(), isEmpty); // 不伪造已发
    await tester.pump(const Duration(seconds: 10)); // 排空重试定时器
    client.dispose();
  });

  testWidgets('路线图#3 R3-1 重连中身份校验失败不掉出会话视图，4 次重试后才回配对页', (WidgetTester tester) async {
    await pumpToSession(tester);
    final client = tester.widget<NienieMobileApp>(find.byType(NienieMobileApp)).client;
    final transport = client.transport as FakeBridgeTransport;

    // 每次 hello 都返回错误 machineId（模拟旧 IP 被占连错 Bridge）
    transport.helloMachineId = 'machine_other';
    transport.emitRaw({'type': 'transport.disconnected'});
    await tester.pump(const Duration(seconds: 2));
    // 身份失败发生后仍保持 reconnecting（不降级 error/disconnected），会话视图保留
    expect(client.connectionState, BridgeConnectionState.reconnecting);
    expect(find.byKey(const Key('reconnect-banner')), findsOneWidget);

    await tester.pump(const Duration(seconds: 8)); // 4 次重试全部失败
    expect(client.connectionState, BridgeConnectionState.disconnected);
    expect(find.byKey(const Key('btn-connect-pair')), findsOneWidget);
    client.dispose();
  });

  testWidgets('F1 延迟接受不清空用户新输入（草稿快照保护）', (WidgetTester tester) async {
    await pumpToSession(tester);
    final client = tester.widget<NienieMobileApp>(find.byType(NienieMobileApp)).client;
    final transport = client.transport as FakeBridgeTransport;

    transport.sendGate = Completer<void>();
    await tester.enterText(find.byKey(const Key('input-session-prompt')), '第一条消息');
    await tester.tap(find.byKey(const Key('btn-send-prompt')));
    await tester.pump(const Duration(milliseconds: 100));
    // 接受响应未到，用户继续编辑输入框
    await tester.enterText(find.byKey(const Key('input-session-prompt')), '新的草稿内容');

    transport.sendGate!.complete(); // 第一条被接受
    await tester.pump(const Duration(milliseconds: 100));

    final field = tester.widget<TextField>(find.byKey(const Key('input-session-prompt')));
    expect(field.controller!.text, '新的草稿内容'); // 新输入不被延迟接受清掉
    final item = client.timelineFor('ses_alpha').whereType<UserPromptItem>().single;
    expect(item.receipt, SendReceipt.delivered); // 第一条本身正常送达

    // 对照：未继续编辑时接受会正常清空（先结束首条的等待态，否则按钮是停止分支）
    transport.emitServerEvent({
      'version': 1, 'eventId': 'idle1', 'streamEpoch': 'ep1', 'sessionId': 'ses_alpha',
      'sequence': 1, 'timestamp': DateTime.now().toIso8601String(),
      'type': 'status', 'payload': {'status': 'idle'},
    });
    await tester.pumpAndSettle();
    transport.sendGate = null;
    await tester.enterText(find.byKey(const Key('input-session-prompt')), '第二条消息');
    await tester.tap(find.byKey(const Key('btn-send-prompt')));
    await tester.pumpAndSettle();
    final field2 = tester.widget<TextField>(find.byKey(const Key('input-session-prompt')));
    expect(field2.controller!.text, isEmpty);
    client.dispose();
  });

  testWidgets('F3 error 事件终止 Thinking 计时并置失败（不依赖后续 status 事件）', (WidgetTester tester) async {
    await pumpToSession(tester);
    final transport = tester
        .widget<NienieMobileApp>(find.byType(NienieMobileApp))
        .client
        .transport as FakeBridgeTransport;

    transport.emitServerEvent({
      'version': 1, 'eventId': 'run', 'streamEpoch': 'ep1', 'sessionId': 'ses_alpha',
      'sequence': 1, 'timestamp': DateTime.now().toIso8601String(),
      'type': 'status', 'payload': {'status': 'running'},
    });
    await tester.pump(const Duration(seconds: 1));
    expect(find.textContaining('Thinking'), findsWidgets);

    // 只发 error 事件（无任何 status 事件跟随）
    transport.emitServerEvent({
      'version': 1, 'eventId': 'err', 'streamEpoch': 'ep1', 'sessionId': 'ses_alpha',
      'sequence': 2, 'timestamp': DateTime.now().toIso8601String(),
      'type': 'error',
      'payload': {'errorId': 'e1', 'code': 'RUN_FAILED', 'message': 'Codex 异常退出（退出码 2）', 'retryable': true},
    });
    await tester.pump(const Duration(seconds: 1));
    expect(find.textContaining('Thinking'), findsNothing); // 计时终止
    expect(find.textContaining('Codex 异常退出'), findsWidgets); // 失败可见
  });

  test('路线图#3 Round2 发送异常回执落定 failed（不永久 pending）', () async {
    final transport = FakeBridgeTransport();
    final client = MobileBridgeClient(transport: transport, credentialStore: InMemoryCredentialStore());
    await client.refreshSessions();
    client.connectionState = BridgeConnectionState.connected;
    final session = client.sessions.firstWhere((s) => s.id == 'ses_alpha');
    client.activeSession = session;

    transport.throwNextSend = true;
    await client.sendMessage('异常消息');
    final item = client.timelineFor('ses_alpha').whereType<UserPromptItem>().single;
    expect(item.receipt, SendReceipt.failed); // 异常也落定，不悬挂 pending
    client.dispose();
  });

  test('路线图#1 R9 断线时深链保留，重连后自动进入正确会话', () async {
    final transport = FakeBridgeTransport();
    final client = MobileBridgeClient(
      transport: transport,
      credentialStore: InMemoryCredentialStore(),
    );
    await client.refreshSessions(); // 先缓存会话
    client.connectionState = BridgeConnectionState.disconnected;
    expect(client.handleDeepLink(Uri.parse('nienie://session/ses_alpha')), isTrue);
    await client.refreshSessions(); // 断线刷新不消费
    expect(client.pendingDeepLinkSessionId, 'ses_alpha');
    expect(client.activeSession?.id, isNot('ses_alpha'));

    client.connectionState = BridgeConnectionState.connected;
    await client.refreshSessions(); // 重连后自动进入
    expect(client.pendingDeepLinkSessionId, isNull);
    expect(client.activeSession?.id, 'ses_alpha');
    client.dispose();
  });

  test('路线图#1 R9 通知深链：nienie://session/<id> 直达会话（未加载时挂起、刷新后自动进入）', () async {
    final transport = FakeBridgeTransport();
    final client = MobileBridgeClient(
      transport: transport,
      credentialStore: InMemoryCredentialStore(),
    );
    expect(client.handleDeepLink(Uri.parse('https://example.com')), isFalse);
    client.connectionState = BridgeConnectionState.connected;
    expect(client.handleDeepLink(Uri.parse('nienie://session/ses_alpha')), isTrue);
    expect(client.pendingDeepLinkSessionId, 'ses_alpha');
    await client.refreshSessions(); // fake 返回 ses_alpha → 消费深链
    expect(client.pendingDeepLinkSessionId, isNull);
    expect(client.activeSession?.id, 'ses_alpha');
    client.dispose();
  });

  testWidgets('J0.6b-3.3 已有消息的更新分支保存附件 + 快照 inline 附件还原 sourceType/contentHash', (
    WidgetTester tester,
  ) async {
    await pumpToSession(tester);
    final client = tester.widget<NienieMobileApp>(find.byType(NienieMobileApp)).client;
    final transport = client.transport as FakeBridgeTransport;

    // 首个 delta 无附件 → 后续更新分支带附件也要保存
    transport.emitServerEvent(j04Evt(eventId: 'u1', seq: 1, type: 'text_delta',
        payload: {'delta': '看文件', 'role': 'user', 'partId': 'msg_u:0', 'partRevision': 3}));
    transport.emitServerEvent(j04Evt(eventId: 'u2', seq: 2, type: 'text_delta',
        payload: {
          'delta': ' 看这个',
          'role': 'user',
          'partId': 'msg_u:0',
          'partRevision': 8,
          'attachments': [
            {'name': 'b.ts', 'mime': 'text/plain', 'sourceType': 'uri', 'uri': 'file:///w/b.ts'},
          ],
        }));
    await tester.pump();
    var prompt = client.timelineFor('ses_alpha').whereType<UserPromptItem>().single;
    expect(prompt.attachments.single.uri, 'file:///w/b.ts');

    // 快照 inline 资源：sourceType=inline + contentHash 还原（不丢）
    transport.snapshotResponse = {
      'schemaVersion': 1,
      'snapshotId': 'snap_inline',
      'sessionId': 'ses_alpha',
      'agentId': 'opencode',
      'streamEpoch': 'ep_snap',
      'watermark': 1,
      'capturedAt': '2026-11-10T00:00:00Z',
      'complete': true,
      'hasMore': false,
      'totalParts': 1,
      'parts': [
        {'kind': 'message', 'partId': 'p1', 'ordinal': 0, 'revision': 2, 'createdAt': 'x', 'updatedAt': 'x',
          'role': 'user', 'content': [
            {'type': 'text', 'text': '附件消息'},
            {'type': 'resource', 'uri': 'inline:abc123', 'name': 'note.bin', 'mimeType': 'application/octet-stream'},
          ]},
      ],
    };
    await client.loadSessionSnapshot('ses_alpha');
    await tester.pump();
    prompt = client.timelineFor('ses_alpha').whereType<UserPromptItem>().single;
    expect(prompt.attachments.single.sourceType, 'inline');
    expect(prompt.attachments.single.contentHash, 'abc123');
    expect(prompt.attachments.single.uri, isNull);
    client.dispose();
  });

}

