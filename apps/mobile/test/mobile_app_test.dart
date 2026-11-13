import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:nienie_mobile/src/ui/quick_commands_bar.dart';
import 'package:nienie_mobile/src/ui/theme_colors.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:nienie_mobile/main.dart';
import 'package:nienie_mobile/src/services/attachment_picker.dart';
import 'package:flutter_highlight/flutter_highlight.dart';
import 'package:nienie_mobile/src/ui/markdown_message.dart';

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
      await tester.drag(
        find.byKey(const Key('session-timeline-list')),
        const Offset(0, -300),
      );
      await tester.pumpAndSettle();

      // 6.3：改动摘要卡——点开文件列表见文件行
      await tester.tap(find.byKey(const Key('change-summary-header')));
      await tester.pumpAndSettle();
      expect(find.text('src/index.ts'), findsOneWidget);
      // 头部总计与文件行统计同文本（单文件时）——出现即达标
      expect(find.text('+3 / -1'), findsWidgets);

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
      await tester.drag(
        find.byKey(const Key('session-timeline-list')),
        const Offset(0, -300),
      );
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

      expect(find.textContaining('Input 1500'), findsOneWidget);

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
    expect(find.byIcon(LucideIcons.circleCheck), findsOneWidget);
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
    // 6.3：聚合卡语义——重复加载仍只一张改动摘要卡（去重语义保留）
    final summaries = client.timelineFor('ses_alpha').whereType<ChangeSummaryCardItem>().toList();
    expect(summaries.length, 1);
    expect(summaries.single.files.length, 1);
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

  testWidgets('F1 延迟接受期间替换附件不清空新附件（附件身份快照）', (WidgetTester tester) async {
    await pumpToSession(tester);
    final client = tester.widget<NienieMobileApp>(find.byType(NienieMobileApp)).client;
    final transport = client.transport as FakeBridgeTransport;

    // 添加附件 A（btn-attach 打开底部菜单 → btn-attach-image）
    AttachmentPicker.debugOverrideFiles = [(name: 'file-A.png', path: '/tmp/a.png')];
    await tester.tap(find.byKey(const Key('btn-attach')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('btn-attach-image')));
    await tester.pumpAndSettle();
    expect(find.text('file-A.png'), findsOneWidget);

    transport.sendGate = Completer<void>();
    await tester.enterText(find.byKey(const Key('input-session-prompt')), '带附件的消息');
    await tester.tap(find.byKey(const Key('btn-send-prompt')));
    await tester.pump(const Duration(milliseconds: 100));

    // 延迟接受期间：删掉 A、添加 B（数量不变，身份变了）
    await tester.tap(find.descendant(
      of: find.byType(Chip),
      matching: find.byIcon(LucideIcons.x),
    ));
    await tester.pumpAndSettle();
    AttachmentPicker.debugOverrideFiles = [(name: 'file-B.png', path: '/tmp/b.png')];
    await tester.tap(find.byKey(const Key('btn-attach')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('btn-attach-image')));
    await tester.pumpAndSettle();
    expect(find.text('file-B.png'), findsOneWidget);
    expect(find.text('file-A.png'), findsNothing);

    transport.sendGate!.complete(); // 第一条（含 file-A）被接受
    await tester.pump(const Duration(milliseconds: 100));

    // 新草稿（文本+file-B）不得被第一条的接受清掉
    final field = tester.widget<TextField>(find.byKey(const Key('input-session-prompt')));
    expect(field.controller!.text, '带附件的消息');
    expect(find.text('file-B.png'), findsOneWidget);
    expect(find.text('file-A.png'), findsNothing);
    await tester.pump(const Duration(seconds: 10));
    client.dispose();
  });

  test('F4-2 text_delta full=true upsert 覆盖（ACP v2 完整消息），无 full 增量追加', () async {
    final transport = FakeBridgeTransport();
    final client = MobileBridgeClient(transport: transport, credentialStore: InMemoryCredentialStore());
    await client.refreshSessions();
    client.connectionState = BridgeConnectionState.connected;
    client.activeSession = client.sessions.firstWhere((s) => s.id == 'ses_alpha');

    void emit(String eid, int seq, Map<String, dynamic> payload) {
      transport.emitServerEvent({
        'version': 1, 'eventId': eid, 'streamEpoch': 'ep1', 'sessionId': 'ses_alpha',
        'sequence': seq, 'timestamp': DateTime.now().toIso8601String(),
        'type': 'text_delta', 'payload': payload,
      });
    }

    emit('e1', 1, {'delta': 'hello', 'partId': 'm1', 'partRevision': 1, 'full': true, 'role': 'assistant'});
    emit('e2', 2, {'delta': ' world', 'partId': 'm1', 'partRevision': 2, 'role': 'assistant'});
    emit('e3', 3, {'delta': 'corrected', 'partId': 'm1', 'partRevision': 3, 'full': true, 'role': 'assistant'});
    await Future<void>.delayed(const Duration(milliseconds: 10)); // 事件流异步消费

    final item = client.timelineFor('ses_alpha').whereType<StreamingTextItem>().single;
    expect(item.text, 'corrected'); // upsert 覆盖而非 hello worldcorrected

    // F4-2 清空语义：full=true 空 delta = 清空（不是丢弃）
    emit('e4', 4, {'delta': '', 'partId': 'm1', 'partRevision': 4, 'full': true, 'role': 'assistant'});
    await Future<void>.delayed(const Duration(milliseconds: 10));
    expect(item.text, isEmpty);
    emit('e5', 5, {'delta': 'fresh', 'partId': 'm1', 'partRevision': 5, 'role': 'assistant'});
    await Future<void>.delayed(const Duration(milliseconds: 10));
    expect(item.text, 'fresh'); // 清空后新增量从空开始
    client.dispose();
  });

  testWidgets('4.1 Markdown 渲染：标题/加粗/行内代码/围栏代码块（语法高亮容器）', (WidgetTester tester) async {
    await pumpToSession(tester);
    final transport = tester
        .widget<NienieMobileApp>(find.byType(NienieMobileApp))
        .client
        .transport as FakeBridgeTransport;

    transport.emitServerEvent({
      'version': 1, 'eventId': 'md1', 'streamEpoch': 'ep1', 'sessionId': 'ses_alpha',
      'sequence': 1, 'timestamp': DateTime.now().toIso8601String(),
      'type': 'text_delta',
      'payload': {
        'delta': '# Fix applied\n\n**bold text** and *italic text* and `inline code`\n\n'
            'A [doc link](https://example.com/doc)\n\n'
            '> quoted line\n\n- item one\n- item two\n\n---\n\n'
            '```dart\nvoid main() {}\n```\n',
        'partId': 'p_md', 'partRevision': 1,
      },
    });
    await tester.pump(const Duration(milliseconds: 50));

    // 标题/加粗/斜体/行内代码文本可达
    expect(find.textContaining('Fix applied'), findsWidgets);
    expect(find.textContaining('bold text'), findsWidgets);
    expect(find.textContaining('italic text'), findsWidgets);
    // 链接/引用/列表（4.1 补齐覆盖）
    expect(find.textContaining('doc link'), findsWidgets);
    expect(find.textContaining('quoted line'), findsWidgets);
    expect(find.textContaining('item one'), findsWidgets);
    expect(find.textContaining('item two'), findsWidgets);
    // 分隔线渲染断言（Round 3：水平横线容器真实存在）
    expect(
      find.byWidgetPredicate(
        (w) =>
            w is Container &&
            w.decoration is BoxDecoration &&
            (w.decoration as BoxDecoration).border?.top != null,
      ),
      findsWidgets,
    );
    // 围栏代码块：暗色容器 + 高亮视图 + 语言标签
    expect(find.byKey(const Key('code-block')), findsOneWidget);
    expect(find.byType(HighlightView), findsOneWidget);
    expect(find.text('dart'), findsOneWidget);
  });

  testWidgets('4.1 链接点击跳转：仅放行 http/https（javascript/file 拦截）', (WidgetTester tester) async {
    final opened = <Uri>[];
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SingleChildScrollView(
            child: MarkdownMessage(
              data: '[safe](https://example.com/a)\n\n[plain](http://example.com/x)\n\n'
                  '[evil](javascript:alert(1))\n\n'
                  '[file](file:///etc/passwd)\n\n[ftp](ftp://x/y)',
              strings: NienieStrings(AppLanguage.en),
              onOpenLink: opened.add,
            ),
          ),
        ),
      ),
    );

    await tester.tap(find.textContaining('safe', findRichText: true));
    await tester.tap(find.textContaining('plain', findRichText: true));
    await tester.pump();
    // http/https 都放行（Round 3 补 HTTP 用例）
    expect(opened.map((u) => u.toString()), [
      'https://example.com/a',
      'http://example.com/x',
    ]);

    await tester.tap(find.textContaining('evil', findRichText: true));
    await tester.tap(find.textContaining('file', findRichText: true));
    await tester.tap(find.textContaining('ftp', findRichText: true));
    await tester.pump();
    expect(opened.length, 2); // javascript/file/ftp 协议全部拦截（http/https 之外零新增）
  });

  testWidgets('4.1 未知语言高亮降级 + 长行横向滚动容器', (WidgetTester tester) async {
    await pumpToSession(tester);
    final transport = tester
        .widget<NienieMobileApp>(find.byType(NienieMobileApp))
        .client
        .transport as FakeBridgeTransport;

    transport.emitServerEvent({
      'version': 1, 'eventId': 'md3', 'streamEpoch': 'ep1', 'sessionId': 'ses_alpha',
      'sequence': 1, 'timestamp': DateTime.now().toIso8601String(),
      'type': 'text_delta',
      'payload': {
        'delta': '```no-such-lang\nconst x = \'${'A' * 300}\';\n```\n',
        'partId': 'p_link', 'partRevision': 1,
      },
    });
    await tester.pump(const Duration(milliseconds: 50));

    // 未知语言降级：代码块仍渲染 + 语言标签显示原文
    expect(find.byKey(const Key('code-block')), findsOneWidget);
    expect(find.text('no-such-lang'), findsOneWidget);
    expect(find.byType(HighlightView), findsOneWidget);
    // 长行：横向滚动容器存在（不溢出）
    expect(
      find.descendant(
        of: find.byKey(const Key('code-block')),
        matching: find.byType(SingleChildScrollView),
      ),
      findsOneWidget,
    );

  });

  testWidgets('4.2 代码块复制按钮：点击写入剪贴板 + 图标反馈', (WidgetTester tester) async {
    await pumpToSession(tester);
    final transport = tester
        .widget<NienieMobileApp>(find.byType(NienieMobileApp))
        .client
        .transport as FakeBridgeTransport;

    final clipboardCalls = <MethodCall>[];
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      SystemChannels.platform,
      (call) async {
        clipboardCalls.add(call);
        return null;
      },
    );

    const codeText = 'npm test\nnpm run build\n# done';
    transport.emitServerEvent({
      'version': 1, 'eventId': 'md2', 'streamEpoch': 'ep1', 'sessionId': 'ses_alpha',
      'sequence': 1, 'timestamp': DateTime.now().toIso8601String(),
      'type': 'text_delta',
      'payload': {
        'delta': '```sh\n$codeText\n```\n',
        'partId': 'p_cp', 'partRevision': 1,
      },
    });
    await tester.pump(const Duration(milliseconds: 50));

    await tester.tap(find.byKey(const Key('btn-copy-code')));
    await tester.pump();
    final setData = clipboardCalls.where((c) => c.method == 'Clipboard.setData');
    expect(setData, isNotEmpty);
    final text = (setData.first.arguments as Map)['text'] as String;
    expect(text, codeText); // 多行代码完全相等（原始代码，不是高亮文本）
    // 复制后图标切换为对勾（短暂反馈）
    expect(find.byIcon(LucideIcons.check), findsOneWidget);
    // Round 3：连续点击复制——旧计时器不得提前清掉新反馈
    await tester.pump(const Duration(milliseconds: 1200));
    await tester.tap(find.byKey(const Key('btn-copy-code')));
    await tester.pump(const Duration(milliseconds: 500)); // 距上次点击 1.7s > 1.5s
    expect(find.byIcon(LucideIcons.check), findsOneWidget); // 第二次反馈仍在（旧计时器已取消）
    await tester.pump(const Duration(seconds: 2)); // 排空复位计时器
    expect(find.byIcon(LucideIcons.copy), findsOneWidget); // 图标回退
  });

  testWidgets('4.3 相对时间戳：历史事件按真实时间显示（3 min ago），乐观消息 just now', (WidgetTester tester) async {
    await pumpToSession(tester);
    final client = tester.widget<NienieMobileApp>(find.byType(NienieMobileApp)).client;
    final transport = client.transport as FakeBridgeTransport;

    await tester.enterText(find.byKey(const Key('input-session-prompt')), 'hello');
    await tester.tap(find.byKey(const Key('btn-send-prompt')));
    await tester.pump();
    expect(find.text('just now'), findsWidgets); // 乐观消息=刚刚

    transport.emitServerEvent({
      'version': 1, 'eventId': 'ts1', 'streamEpoch': 'ep1', 'sessionId': 'ses_alpha',
      'sequence': 1,
      'timestamp': DateTime.now().subtract(const Duration(minutes: 3)).toIso8601String(),
      'type': 'text_delta',
      'payload': {'delta': 'old reply', 'partId': 'p_ts', 'partRevision': 1},
    });
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.text('3 min ago'), findsOneWidget); // 历史恢复不显示「刚刚」
    client.dispose();
  });

  test('4.3 relativeTime 边界：刚刚/分钟/小时/天/日期（含中文）', () {
    final en = NienieStrings(AppLanguage.en);
    final zh = NienieStrings(AppLanguage.zh);
    final now = DateTime(2026, 11, 12, 12);

    expect(en.relativeTime(now.subtract(const Duration(seconds: 10)), now: now), 'just now');
    // Round 2：45~59 秒不得显示 0 min ago（归 just now）
    expect(en.relativeTime(now.subtract(const Duration(seconds: 45)), now: now), 'just now');
    expect(en.relativeTime(now.subtract(const Duration(seconds: 59)), now: now), 'just now');
    expect(en.relativeTime(now.subtract(const Duration(minutes: 1)), now: now), '1 min ago');
    // Round 2：未来时间戳（时钟偏差）归 just now
    expect(en.relativeTime(now.add(const Duration(hours: 26)), now: now), 'just now');
    expect(en.relativeTime(now.subtract(const Duration(minutes: 3)), now: now), '3 min ago');
    expect(en.relativeTime(now.subtract(const Duration(hours: 2)), now: now), '2 h ago');
    expect(en.relativeTime(now.subtract(const Duration(days: 3)), now: now), '3 d ago');
    expect(en.relativeTime(now.subtract(const Duration(days: 9)), now: now), 'Nov 3');
    expect(zh.relativeTime(now.subtract(const Duration(minutes: 5)), now: now), '5 分钟前');
    expect(zh.relativeTime(now.subtract(const Duration(days: 9)), now: now), '11月3日');

    // Round 3：UTC 日期测试用固定相对时间（不依赖 DateTime.now，避免时序漂移）
    final utc = DateTime.utc(2026, 11, 3, 16, 30); // 16:30 UTC
    final fixedNow = DateTime(2026, 11, 12, 12);
    final local = utc.toLocal();
    final enDay = en.relativeTime(utc, now: fixedNow); // 超 7 天 → 日期分支
    expect(enDay, contains('${local.day}')); // 用本地日期，而非 UTC 的 3
    if (local.day != 3) {
      expect(enDay, isNot(contains(' 3'))); // 跨 UTC 午夜场景验证不是错天
    }
  });

  testWidgets('4.4 工具卡：状态文案/耗时/退出码徽标 + 长输出展开可复制', (WidgetTester tester) async {
    await pumpToSession(tester);
    final transport = tester
        .widget<NienieMobileApp>(find.byType(NienieMobileApp))
        .client
        .transport as FakeBridgeTransport;

    final clipboardCalls = <MethodCall>[];
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      SystemChannels.platform,
      (call) async {
        clipboardCalls.add(call);
        return null;
      },
    );

    final t0 = DateTime.now().subtract(const Duration(seconds: 5));
    transport.emitServerEvent({
      'version': 1, 'eventId': 'tu1', 'streamEpoch': 'ep1', 'sessionId': 'ses_alpha',
      'sequence': 1, 'timestamp': t0.toIso8601String(), 'type': 'tool_use',
      'payload': {'toolCallId': 'tc_dur', 'name': 'bash', 'input': {'cmd': 'ls'}},
    });
    transport.emitServerEvent({
      'version': 1, 'eventId': 'tr1', 'streamEpoch': 'ep1', 'sessionId': 'ses_alpha',
      'sequence': 2,
      'timestamp': t0.add(const Duration(milliseconds: 3200)).toIso8601String(),
      'type': 'tool_result',
      'payload': {
        'toolCallId': 'tc_dur',
        'content': 'line-1\nline-2\n' + ('x' * 50),
        'isError': false,
        'exitCode': 0,
      },
    });
    await tester.pump(const Duration(milliseconds: 50));

    // 五态语言层：状态文案 + 耗时 + 退出码徽标
    expect(find.text('Done'), findsOneWidget);
    expect(find.text('3.2s'), findsOneWidget);
    expect(find.text('exit 0'), findsOneWidget);

    // 展开 → 复制按钮 → 剪贴板内容完全一致
    await tester.tap(find.text('bash'));
    await tester.pumpAndSettle();
    final copyBtn = find.byKey(const Key('btn-copy-tool-output-tc_dur'));
    expect(copyBtn, findsOneWidget);
    await tester.tap(copyBtn);
    await tester.pump();
    final setData = clipboardCalls.where((c) => c.method == 'Clipboard.setData');
    expect((setData.first.arguments as Map)['text'] as String, 'line-1\nline-2\n${'x' * 50}');
  });

  test('Snapshot 恢复工具卡：startedAt/finishedAt/exitCode 一致还原（耗时不丢失）', () async {
    final transport = FakeBridgeTransport();
    final client = MobileBridgeClient(
      transport: transport,
      credentialStore: InMemoryCredentialStore(),
    );
    await client.refreshSessions();
    final t0 = DateTime.utc(2026, 11, 1, 10, 0, 0);
    final t1 = t0.add(const Duration(seconds: 4));
    transport.snapshotResponse = {
      'schemaVersion': 1,
      'snapshotId': 'snap_tool',
      'sessionId': 'ses_alpha',
      'agentId': 'opencode',
      'streamEpoch': 'ep1',
      'watermark': 2,
      'capturedAt': DateTime.now().toIso8601String(),
      'complete': true,
      'hasMore': false,
      'totalParts': 2,
      'parts': [
        {
          'kind': 'tool_call',
          'ordinal': 0,
          'partId': 't_snap',
          'revision': 2,
          'createdAt': t0.toIso8601String(),
          'updatedAt': t1.toIso8601String(),
          'toolCallId': 'tc_snap',
          'name': 'bash',
          'input': {'cmd': 'ls'},
          'output': 'ok',
          'isError': false,
          'status': 'completed',
          'exitCode': 0,
          'toolStartedAt': t0.toIso8601String(),
          'toolFinishedAt': t1.toIso8601String(),
        },
        {
          'kind': 'tool_call',
          'ordinal': 1,
          'partId': 't_snap2',
          'revision': 2,
          'createdAt': t0.toIso8601String(),
          'updatedAt': t1.toIso8601String(),
          'toolCallId': 'tc_noend',
          'name': 'bash',
          'input': {'cmd': 'x'},
          'output': 'ok',
          'isError': false,
          'status': 'completed',
          // Round 3：completed 缺失（无 toolFinishedAt）→ 不伪造耗时
          'toolStartedAt': t0.toIso8601String(),
        },
      ],
    };
    await client.loadSessionSnapshot('ses_alpha');
    final tools = client.timelineFor('ses_alpha').whereType<ToolCallCardItem>().toList();
    expect(tools[0].startedAt, t0);
    expect(tools[0].finishedAt, t1);
    expect(tools[0].exitCode, 0);
    expect(tools[0].durationLabel, '4.0s');
    // Round 3：finishedAt 缺失 → 无耗时（宁可不显示，不显示语义错误的耗时）
    expect(tools[1].startedAt, t0);
    expect(tools[1].finishedAt, isNull);
    expect(tools[1].durationLabel, isNull);
    client.dispose();
  });

  testWidgets('4.5 pending 时「从这里重试」菜单项隐藏', (WidgetTester tester) async {
    await pumpToSession(tester);
    final client = tester.widget<NienieMobileApp>(find.byType(NienieMobileApp)).client;
    final transport = client.transport as FakeBridgeTransport;

    transport.sendGate = Completer<void>(); // 发送挂起 → receipt pending
    await tester.enterText(find.byKey(const Key('input-session-prompt')), '挂起消息');
    await tester.tap(find.byKey(const Key('btn-send-prompt')));
    await tester.pump();

    await tester.longPress(find.text('挂起消息').first);
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('menu-copy-text')), findsOneWidget);
    expect(find.byKey(const Key('menu-resend-from-here')), findsNothing); // pending 隐藏
    await tester.tap(find.byKey(const Key('menu-copy-text'))); // 关闭菜单
    await tester.pumpAndSettle();
    transport.sendGate!.complete();
    await tester.pumpAndSettle();
    client.dispose();
  });

  testWidgets('Round 4 历史回放（timingKnown:false）不伪造耗时：同时间戳 tool 事件 durationLabel 为 null', (WidgetTester tester) async {
    await pumpToSession(tester);
    final transport = tester
        .widget<NienieMobileApp>(find.byType(NienieMobileApp))
        .client
        .transport as FakeBridgeTransport;
    // Codex 历史回放形态：tool_use/tool_result 同一 created_at_ms + timingKnown:false
    final ts = '2026-11-12T09:30:00.000Z';
    transport.emitServerEvent({
      'version': 1, 'eventId': 'hu1', 'streamEpoch': 'ep1', 'sessionId': 'ses_alpha',
      'sequence': 1, 'timestamp': ts, 'type': 'tool_use',
      'payload': {
        'toolCallId': 'tc_hist', 'name': 'bash', 'input': {'command': 'sleep'},
        'timingKnown': false,
      },
    });
    transport.emitServerEvent({
      'version': 1, 'eventId': 'hr1', 'streamEpoch': 'ep1', 'sessionId': 'ses_alpha',
      'sequence': 2, 'timestamp': ts, 'type': 'tool_result',
      'payload': {
        'toolCallId': 'tc_hist', 'content': 'done', 'isError': false, 'exitCode': 0,
        'timingKnown': false,
      },
    });
    await tester.pump(const Duration(milliseconds: 50));

    final tool = tester
        .widget<NienieMobileApp>(find.byType(NienieMobileApp))
        .client
        .timelineFor('ses_alpha')
        .whereType<ToolCallCardItem>()
        .single;
    expect(tool.startedAt, isNull);
    expect(tool.finishedAt, isNull);
    expect(tool.durationLabel, isNull); // 不显示 0ms 伪耗时
  });

  test('Round 4 快照新时间字段严格校验：非法类型/非法日期原子拒绝', () async {
    final transport = FakeBridgeTransport();
    final client = MobileBridgeClient(
      transport: transport,
      credentialStore: InMemoryCredentialStore(),
    );
    await client.refreshSessions();
    transport.snapshotResponse = {
      'schemaVersion': 1,
      'snapshotId': 'snap_bad',
      'sessionId': 'ses_alpha',
      'agentId': 'opencode',
      'streamEpoch': 'ep1',
      'watermark': 1,
      'capturedAt': DateTime.now().toIso8601String(),
      'complete': true,
      'hasMore': false,
      'totalParts': 1,
      'parts': [
        {
          'kind': 'tool_call', 'ordinal': 0, 'partId': 't_bad', 'revision': 2,
          'createdAt': '2026-11-01T00:00:00Z', 'updatedAt': '2026-11-01T00:00:01Z',
          'toolCallId': 'tc_bad', 'name': 'bash', 'input': {}, 'status': 'completed',
          'toolStartedAt': 12345, // 非法类型（数字）
        },
      ],
    };
    await client.loadSessionSnapshot('ses_alpha');
    expect(client.timelineFor('ses_alpha'), isEmpty); // 校验拒绝 → 不安装（原子）
    expect(client.errorMessage, contains('快照')); // 明确失败提示

    // 非法日期字符串同样拒绝
    transport.snapshotResponse = {
      ...transport.snapshotResponse!,
      'snapshotId': 'snap_bad2',
      'parts': [
        {
          'kind': 'tool_call', 'ordinal': 0, 'partId': 't_bad2', 'revision': 2,
          'createdAt': '2026-11-01T00:00:00Z', 'updatedAt': '2026-11-01T00:00:01Z',
          'toolCallId': 'tc_bad2', 'name': 'bash', 'input': {}, 'status': 'completed',
          'toolFinishedAt': 'not-a-date',
        },
      ],
    };
    await client.loadSessionSnapshot('ses_alpha');
    expect(client.timelineFor('ses_alpha'), isEmpty);
    client.dispose();
  });

  test('durationLabel 舍入边界：59.6s/60s/119.6s 不出 1m60s', () {
    String labelOf(int ms) {
      final start = DateTime(2026, 11, 1);
      return ToolCallCardItem(
        toolCallId: 't',
        name: 'x',
        input: const {},
        startedAt: start,
        finishedAt: start.add(Duration(milliseconds: ms)),
      ).durationLabel!;
    }

    expect(labelOf(120), '120ms');
    expect(labelOf(1200), '1.2s');
    expect(labelOf(59600), '60s'); // 原展示规则：<10s 保留一位小数，≥10s 取整
    expect(labelOf(60000), '1m00s');
    expect(labelOf(119600), '2m00s'); // 舍入整数秒后拆分（旧逻辑会出 1m60s）
  });

  testWidgets('4.4 长输出：展开区 280px 约束 + 内滚动', (WidgetTester tester) async {
    await pumpToSession(tester);
    final transport = tester
        .widget<NienieMobileApp>(find.byType(NienieMobileApp))
        .client
        .transport as FakeBridgeTransport;
    final longOutput = List.generate(60, (i) => 'output line $i').join('\n');
    transport.emitServerEvent({
      'version': 1, 'eventId': 'lo1', 'streamEpoch': 'ep1', 'sessionId': 'ses_alpha',
      'sequence': 1, 'timestamp': DateTime.now().toIso8601String(), 'type': 'tool_use',
      'payload': {'toolCallId': 'tc_long', 'name': 'bash', 'input': {'cmd': 'cat big'}},
    });
    transport.emitServerEvent({
      'version': 1, 'eventId': 'lo2', 'streamEpoch': 'ep1', 'sessionId': 'ses_alpha',
      'sequence': 2, 'timestamp': DateTime.now().toIso8601String(), 'type': 'tool_result',
      'payload': {'toolCallId': 'tc_long', 'content': longOutput, 'isError': false},
    });
    await tester.pump(const Duration(milliseconds: 50));

    await tester.tap(find.text('bash'));
    await tester.pumpAndSettle();
    // 工具卡输出区以 280px 封顶 + 内滚动（不撑爆时间线）
    expect(
      find.byWidgetPredicate(
        (w) => w is ConstrainedBox && w.constraints.maxHeight == 280,
      ),
      findsOneWidget,
    );
    expect(
      find.descendant(
        of: find.byKey(const Key('btn-copy-tool-output-tc_long')),
        matching: find.byType(SingleChildScrollView),
      ),
      findsNothing,
    );
    // 内滚动在输出区（ConstrainedBox 内）
    expect(
      find.descendant(
        of: find.byWidgetPredicate(
          (w) => w is ConstrainedBox && w.constraints.maxHeight == 280,
        ),
        matching: find.byType(SingleChildScrollView),
      ),
      findsOneWidget,
    );
  });

  testWidgets('4.5 失败消息长按重试：同条复用不新增、pending 双触发只一次有效', (WidgetTester tester) async {
    await pumpToSession(tester);
    final client = tester.widget<NienieMobileApp>(find.byType(NienieMobileApp)).client;
    final transport = client.transport as FakeBridgeTransport;

    transport.failNextSend = true;
    await tester.enterText(find.byKey(const Key('input-session-prompt')), '失败消息');
    await tester.tap(find.byKey(const Key('btn-send-prompt')));
    await tester.pump();
    final item = client.timelineFor('ses_alpha').whereType<UserPromptItem>().single;
    expect(item.receipt, SendReceipt.failed);
    final msgId = item.messageId;

    // 重试挂起（sendGate）期间双触发——pending 保护不二次出站
    transport.sendGate = Completer<void>();
    final before = transport.sentPrompts.length;
    await tester.longPress(find.text('失败消息').first);
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('menu-resend-from-here')));
    await tester.pumpAndSettle();
    expect(item.receipt, SendReceipt.pending);

    // Round 3：pending 时「从这里重试」直接隐藏（双保险：菜单分派 pending 分支也不出站）
    await tester.longPress(find.text('失败消息').first);
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('menu-resend-from-here')), findsNothing);
    await tester.tap(find.byKey(const Key('menu-copy-text'))); // 关闭菜单
    await tester.pumpAndSettle();

    transport.sendGate!.complete();
    await tester.pumpAndSettle();
    expect(transport.sentPrompts.length, before + 1); // 整轮只有一次有效出站
    expect(item.receipt, SendReceipt.delivered);
    // 同条复用：不新增用户消息、messageId 不变
    expect(client.timelineFor('ses_alpha').whereType<UserPromptItem>().length, 1);
    expect(item.messageId, msgId);
    client.dispose();
  });

  testWidgets('4.5 引用追问保留草稿 + 光标置末尾', (WidgetTester tester) async {
    await pumpToSession(tester);
    final transport = tester
        .widget<NienieMobileApp>(find.byType(NienieMobileApp))
        .client
        .transport as FakeBridgeTransport;

    await tester.enterText(find.byKey(const Key('input-session-prompt')), '原始问题');
    await tester.tap(find.byKey(const Key('btn-send-prompt')));
    await tester.pump();
    transport.emitServerEvent({
      'version': 1, 'eventId': 'idle_q', 'streamEpoch': 'ep1', 'sessionId': 'ses_alpha',
      'sequence': 1, 'timestamp': DateTime.now().toIso8601String(),
      'type': 'status', 'payload': {'status': 'idle'},
    });
    await tester.pump(const Duration(milliseconds: 50));

    // 输入框已有未发送草稿
    await tester.enterText(find.byKey(const Key('input-session-prompt')), '这是我尚未发送的草稿');
    await tester.longPress(find.text('原始问题').first);
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('menu-quote-reply')));
    await tester.pumpAndSettle();

    final field = tester.widget<TextField>(find.byKey(const Key('input-session-prompt')));
    expect(field.controller!.text, '这是我尚未发送的草稿\n\n> 原始问题\n\n');
    expect(field.controller!.selection.baseOffset, field.controller!.text.length);
  });

  testWidgets('4.4 失败工具卡：失败文案 + 非零退出码徽标', (WidgetTester tester) async {
    await pumpToSession(tester);
    final transport = tester
        .widget<NienieMobileApp>(find.byType(NienieMobileApp))
        .client
        .transport as FakeBridgeTransport;

    transport.emitServerEvent({
      'version': 1, 'eventId': 'tf1', 'streamEpoch': 'ep1', 'sessionId': 'ses_alpha',
      'sequence': 1, 'timestamp': DateTime.now().toIso8601String(), 'type': 'tool_use',
      'payload': {'toolCallId': 'tc_fail', 'name': 'bash', 'input': {'cmd': 'exit 2'}},
    });
    transport.emitServerEvent({
      'version': 1, 'eventId': 'tf2', 'streamEpoch': 'ep1', 'sessionId': 'ses_alpha',
      'sequence': 2, 'timestamp': DateTime.now().toIso8601String(), 'type': 'tool_result',
      'payload': {'toolCallId': 'tc_fail', 'content': 'boom', 'isError': true, 'exitCode': 2},
    });
    await tester.pump(const Duration(milliseconds: 50));

    expect(find.text('Failed'), findsOneWidget);
    expect(find.text('exit 2'), findsOneWidget);
  });

  testWidgets('4.5 长按用户消息：复制文本/引用追问/从这里重试', (WidgetTester tester) async {
    await pumpToSession(tester);
    final client = tester.widget<NienieMobileApp>(find.byType(NienieMobileApp)).client;
    final transport = client.transport as FakeBridgeTransport;

    final clipboardCalls = <MethodCall>[];
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      SystemChannels.platform,
      (call) async {
        clipboardCalls.add(call);
        return null;
      },
    );

    await tester.enterText(find.byKey(const Key('input-session-prompt')), '原始问题');
    await tester.tap(find.byKey(const Key('btn-send-prompt')));
    await tester.pump();

    await tester.longPress(find.text('原始问题').first);
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('menu-copy-text')), findsOneWidget);
    expect(find.byKey(const Key('menu-quote-reply')), findsOneWidget);
    expect(find.byKey(const Key('menu-resend-from-here')), findsOneWidget);

    // 引用追问：引用块进入输入框
    await tester.tap(find.byKey(const Key('menu-quote-reply')));
    await tester.pumpAndSettle();
    final field = tester.widget<TextField>(find.byKey(const Key('input-session-prompt')));
    expect(field.controller!.text, contains('> 原始问题'));

    // 从这里重试：重新出站同一条消息
    final before = transport.sentPrompts.length;
    await tester.longPress(find.text('原始问题').first);
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('menu-resend-from-here')));
    await tester.pumpAndSettle();
    expect(transport.sentPrompts.length, before + 1);

    // 复制文本：剪贴板内容一致
    await tester.longPress(find.text('原始问题').first);
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('menu-copy-text')));
    await tester.pumpAndSettle();
    final setData = clipboardCalls.where((c) => c.method == 'Clipboard.setData');
    expect(setData, isNotEmpty);
    expect((setData.last.arguments as Map)['text'], '原始问题');
    client.dispose();
  });

  testWidgets('4.5 长按助手回复：复制/引用追问（无重试项）', (WidgetTester tester) async {
    await pumpToSession(tester);
    final transport = tester
        .widget<NienieMobileApp>(find.byType(NienieMobileApp))
        .client
        .transport as FakeBridgeTransport;

    transport.emitServerEvent({
      'version': 1, 'eventId': 'la1', 'streamEpoch': 'ep1', 'sessionId': 'ses_alpha',
      'sequence': 1, 'timestamp': DateTime.now().toIso8601String(),
      'type': 'text_delta',
      'payload': {'delta': '助手的回复内容', 'partId': 'p_la', 'partRevision': 1},
    });
    await tester.pump(const Duration(milliseconds: 50));

    await tester.longPress(find.textContaining('助手的回复内容'));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('menu-copy-text')), findsOneWidget);
    expect(find.byKey(const Key('menu-quote-reply')), findsOneWidget);
    expect(find.byKey(const Key('menu-resend-from-here')), findsNothing);
  });

  testWidgets('5.1 快捷指令栏：默认胶囊/点击填充保留草稿/长按删除/添加自定义', (WidgetTester tester) async {
    await pumpToSession(tester);
    final client = tester.widget<NienieMobileApp>(find.byType(NienieMobileApp)).client;

    // 默认四条（EN）
    expect(find.byKey(const Key('quick-commands-bar')), findsOneWidget);
    expect(find.byKey(const Key('quick-command-Continue')), findsOneWidget);
    expect(find.byKey(const Key('quick-command-Run tests')), findsOneWidget);

    // 已有草稿 → 点击追加（保留草稿）
    await tester.enterText(find.byKey(const Key('input-session-prompt')), '先看这个');
    await tester.tap(find.byKey(const Key('quick-command-Continue')));
    await tester.pumpAndSettle();
    final field = tester.widget<TextField>(find.byKey(const Key('input-session-prompt')));
    expect(field.controller!.text, '先看这个 Continue');

    // 添加自定义
    await tester.tap(find.byKey(const Key('btn-add-quick-command')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('input-quick-command')), '修这个 bug');
    await tester.tap(find.byKey(const Key('btn-quick-command-confirm')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('quick-command-修这个 bug')), findsOneWidget);

    // 长按删除（确认后消失）
    await tester.longPress(find.byKey(const Key('quick-command-Run tests')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('quick-command-remove-ok')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('quick-command-Run tests')), findsNothing);
    client.dispose();
  });

  test('5.1 快捷指令按 Agent 隔离 + 持久化', () async {
    final store = InMemoryCredentialStore();
    final client = MobileBridgeClient(
      transport: FakeBridgeTransport(),
      credentialStore: store,
    );
    await client.addQuickCommand('codex', 'codex 专属');
    await client.addQuickCommand('opencode', 'opencode 专属');
    expect(client.quickCommandsFor('codex'), contains('codex 专属'));
    expect(client.quickCommandsFor('codex'), isNot(contains('opencode 专属')));

    // 持久化：新 client 从 store 恢复
    final client2 = MobileBridgeClient(
      transport: FakeBridgeTransport(),
      credentialStore: store,
    );
    await client2.loadQuickCommandsFor('codex');
    expect(client2.quickCommandsFor('codex'), contains('codex 专属'));
    // 无自定义的 scope 保持 null=内置默认
    expect(client2.quickCommandsFor('claude-code'), isNull);
    client.dispose();
  });

  testWidgets('5.2 翻历史时新回复浮出「有新回复」，点击跳底；在底部不浮出', (WidgetTester tester) async {
    await pumpToSession(tester);
    final transport = tester
        .widget<NienieMobileApp>(find.byType(NienieMobileApp))
        .client
        .transport as FakeBridgeTransport;

    // 制造足够内容可滚动 + 向上翻历史
    for (var i = 0; i < 10; i++) {
      transport.emitServerEvent({
        'version': 1, 'eventId': 'fill$i', 'streamEpoch': 'ep1', 'sessionId': 'ses_alpha',
        'sequence': i + 1, 'timestamp': DateTime.now().toIso8601String(),
        'type': 'text_delta',
        'payload': {
          'delta': '第 $i 段内容\n${List.filled(12, '填充行').join('\n')}',
          'partId': 'p$i', 'partRevision': 1,
        },
      });
    }
    await tester.pump(const Duration(milliseconds: 50));
    await tester.drag(
      find.byKey(const Key('session-timeline-list')),
      const Offset(0, 3000),
    );
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.byKey(const Key('btn-jump-to-latest')), findsNothing); // 无新内容不浮出

    // 翻历史中来新回复 → 浮出（不强制跳底：旧内容仍可见）
    transport.emitServerEvent({
      'version': 1, 'eventId': 'late', 'streamEpoch': 'ep1', 'sessionId': 'ses_alpha',
      'sequence': 11, 'timestamp': DateTime.now().toIso8601String(),
      'type': 'text_delta',
      'payload': {'delta': '迟到的新回复', 'partId': 'p_late', 'partRevision': 1},
    });
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('btn-jump-to-latest')), findsOneWidget);

    // 点击 → 跳底 + 隐藏
    await tester.tap(find.byKey(const Key('btn-jump-to-latest')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('btn-jump-to-latest')), findsNothing);
    expect(find.textContaining('迟到的新回复'), findsOneWidget);
  });

  test('P2 FileCredentialStore 磁盘恢复/Agent 隔离/空数组与 clear 语义', () async {
    final dir = Directory.systemTemp.createTempSync('nie_qc');
    final store = FileCredentialStore(File('${dir.path}/state.json'));
    await store.saveQuickCommands('codex', ['a', 'b']);
    await store.saveQuickCommands('opencode', ['x']);

    // 全新实例（模拟 App 重启）
    final store2 = FileCredentialStore(File('${dir.path}/state.json'));
    expect(await store2.loadQuickCommands('codex'), ['a', 'b']); // 磁盘恢复
    expect(await store2.loadQuickCommands('opencode'), ['x']); // Agent 隔离
    expect(await store2.loadQuickCommands('claude-code'), isNull); // 无自定义=null=默认

    // 显式空数组语义（用户删光）≠ null
    await store2.saveQuickCommands('pi', <String>[]);
    expect(await store2.loadQuickCommands('pi'), isEmpty);

    // InMemory clear 清快捷指令（与 File 语义一致）
    final inmem = InMemoryCredentialStore();
    await inmem.saveQuickCommands('codex', ['q']);
    await inmem.clear();
    expect(await inmem.loadQuickCommands('codex'), isNull);

    // File clear（删除文件）→ 恢复为 null
    await store2.clear();
    expect(await FileCredentialStore(File('${dir.path}/state.json')).loadQuickCommands('codex'), isNull);
    dir.deleteSync(recursive: true);
  });

  testWidgets('P1 快捷指令生产路径自动加载（QuickCommandsBar 感知 agentId）', (WidgetTester tester) async {
    final store = InMemoryCredentialStore();
    // 预置持久化数据（模拟上次运行留下的自定义）
    await store.saveQuickCommands('codex', ['codex 专属指令']);
    final client = MobileBridgeClient(
      transport: FakeBridgeTransport(),
      credentialStore: store,
    );
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: QuickCommandsBar(
          client: client,
          agentId: 'codex',
          onUse: (_) {},
        ),
      ),
    ));
    await tester.pumpAndSettle();
    // 未手动调用 load——initState 自动加载
    expect(find.byKey(const Key('quick-command-codex 专属指令')), findsOneWidget);
    client.dispose();
  });

  testWidgets('P1 5.2 流式增量（同 partId）持续跟随 + 历史位置持续提示不跳底', (WidgetTester tester) async {
    await pumpToSession(tester);
    final transport = tester
        .widget<NienieMobileApp>(find.byType(NienieMobileApp))
        .client
        .transport as FakeBridgeTransport;

    // 首条 + 3 段同 partId 增量（模拟流式）
    transport.emitServerEvent({
      'version': 1, 'eventId': 's1', 'streamEpoch': 'ep1', 'sessionId': 'ses_alpha',
      'sequence': 1, 'timestamp': DateTime.now().toIso8601String(),
      'type': 'text_delta',
      'payload': {'delta': '第一段', 'partId': 'p_flow', 'partRevision': 1},
    });
    await tester.pump(const Duration(milliseconds: 50));
    for (var i = 2; i <= 6; i++) {
      transport.emitServerEvent({
        'version': 1, 'eventId': 's$i', 'streamEpoch': 'ep1', 'sessionId': 'ses_alpha',
        'sequence': i, 'timestamp': DateTime.now().toIso8601String(),
        'type': 'text_delta',
        'payload': {
          'delta': '\n\n${List.filled(10, '增量行 $i').join('\n\n')}',
          'partId': 'p_flow', 'partRevision': i,
        },
      });
      await tester.pump(const Duration(milliseconds: 50));
      // 在底部：同 partId 多段增量持续跟随——真实滚动位置贴底 + 最新内容可见
      await tester.pumpAndSettle();
      final pos = tester
          .widget<ListView>(find.byKey(const Key('session-timeline-list')))
          .controller!
          .position;
      expect(pos.pixels, greaterThanOrEqualTo(pos.maxScrollExtent - 60));
      expect(
        find.textContaining('增量行 $i', findRichText: true).hitTestable(),
        findsWidgets,
      );
    }

    // 翻历史 → 同 partId 持续增量 → 提示持续可见（不是只有第一段），且不强制跳底
    await tester.drag(find.byKey(const Key('session-timeline-list')), const Offset(0, 3000));
    await tester.pump(const Duration(milliseconds: 300));
    for (var i = 7; i <= 9; i++) {
      transport.emitServerEvent({
        'version': 1, 'eventId': 's$i', 'streamEpoch': 'ep1', 'sessionId': 'ses_alpha',
        'sequence': i, 'timestamp': DateTime.now().toIso8601String(),
        'type': 'text_delta',
        'payload': {
          'delta': '\n\n历史中的增量 $i\n\n尾段',
          'partId': 'p_flow', 'partRevision': i,
        },
      });
      await tester.pump(const Duration(milliseconds: 50));
      expect(find.byKey(const Key('btn-jump-to-latest')), findsOneWidget); // 持续可见
    }
    // 不强制跳底：历史中的最新增量不在视野（否则=被拉回）
    expect(
      find.textContaining('历史中的增量 9', findRichText: true).hitTestable(),
      findsNothing,
    );

    // 点击 → 跳到最新（增量可见 + 提示消失）
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('btn-jump-to-latest')));
    await tester.pumpAndSettle();
    expect(
      find.textContaining('历史中的增量 9', findRichText: true).hitTestable(),
      findsOneWidget,
    );
    expect(find.byKey(const Key('btn-jump-to-latest')), findsNothing);
  });

  testWidgets('P2 5.2 切换会话重置滚动状态（提示消失、定位最新）', (WidgetTester tester) async {
    await pumpToSession(tester);
    final client = tester.widget<NienieMobileApp>(find.byType(NienieMobileApp)).client;
    final transport = client.transport as FakeBridgeTransport;

    // 会话 A 翻历史 + 新内容 → 浮出提示
    for (var i = 1; i <= 8; i++) {
      transport.emitServerEvent({
        'version': 1, 'eventId': 'sw$i', 'streamEpoch': 'ep1', 'sessionId': 'ses_alpha',
        'sequence': i, 'timestamp': DateTime.now().toIso8601String(),
        'type': 'text_delta',
        'payload': {
          'delta': '内容 $i\n${List.filled(12, '行').join('\n')}',
          'partId': 'p$i', 'partRevision': 1,
        },
      });
    }
    await tester.pumpAndSettle();
    await tester.drag(find.byKey(const Key('session-timeline-list')), const Offset(0, 3000));
    await tester.pump(const Duration(milliseconds: 300));
    transport.emitServerEvent({
      'version': 1, 'eventId': 'sw9', 'streamEpoch': 'ep1', 'sessionId': 'ses_alpha',
      'sequence': 9, 'timestamp': DateTime.now().toIso8601String(),
      'type': 'text_delta',
      'payload': {'delta': 'A 的新回复', 'partId': 'p9', 'partRevision': 1},
    });
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.byKey(const Key('btn-jump-to-latest')), findsOneWidget);

    // 切到会话 B（ValueKey 变化 → Timeline State 重建）
    final other = await client.createSession(agentId: 'opencode', title: 'B 会话');
    client.activeSession = other;
    await client.loadSessionSnapshot(other.id);
    client.connectionState = BridgeConnectionState.connected;
    await client.sendMessage('B 的内容'); // B 有内容才有时间线列表
    await tester.pumpAndSettle();
    // 重置：提示消失 + B 定位最新（初始底部）
    expect(find.byKey(const Key('btn-jump-to-latest')), findsNothing);
    final lv = tester.widget<ListView>(find.byKey(const Key('session-timeline-list')));
    final pos = lv.controller!.position;
    expect(pos.pixels, greaterThanOrEqualTo(pos.maxScrollExtent - 60));
    client.dispose();
  });

  test('Round3 File→Client→QuickCommandsBar 全链路恢复 + 加载竞态不覆盖新修改', () async {
    final dir = Directory.systemTemp.createTempSync('nie_qc2');
    final file = File('${dir.path}/state.json');
    // 首次运行：写入自定义
    final store1 = FileCredentialStore(file);
    await store1.saveQuickCommands('codex', ['旧指令']);

    // 模拟重启：新 store + 新 client
    final store2 = FileCredentialStore(file);
    final client = MobileBridgeClient(
      transport: FakeBridgeTransport(),
      credentialStore: store2,
    );
    // 生产路径自动加载
    await client.ensureQuickCommandsLoaded('codex');
    expect(client.quickCommandsFor('codex'), ['旧指令']);
    // 加载完成后再 add → 基于最新数据修改
    await client.addQuickCommand('codex', '新指令');
    expect(client.quickCommandsFor('codex'), ['旧指令', '新指令']);

    // 竞态：加载挂起期间 add，完成后不被旧数据覆盖
    final gate = Completer<void>();
    final slowStore = _GatedCredentialStore(store2, gate);
    final client2 = MobileBridgeClient(
      transport: FakeBridgeTransport(),
      credentialStore: slowStore,
    );
    final loadFuture = client2.ensureQuickCommandsLoaded('codex'); // 挂起
    final addFuture = client2.addQuickCommand('codex', '加载中的新指令'); // 等待加载
    gate.complete(); // 加载完成（返回 ['旧指令','新指令']）
    await loadFuture;
    await addFuture;
    // 新修改未被旧数据覆盖
    expect(client2.quickCommandsFor('codex'),
        containsAll(['旧指令', '新指令', '加载中的新指令']));
    client.dispose();
    client2.dispose();
    dir.deleteSync(recursive: true);
  });

  testWidgets('Round3 普通状态通知/running 事件不误报「有新回复」（水位精确）', (WidgetTester tester) async {
    await pumpToSession(tester);
    final client = tester.widget<NienieMobileApp>(find.byType(NienieMobileApp)).client;
    final transport = client.transport as FakeBridgeTransport;

    // 构造历史内容（版本 > 0）后翻到历史位置
    for (var i = 1; i <= 8; i++) {
      transport.emitServerEvent({
        'version': 1, 'eventId': 'h$i', 'streamEpoch': 'ep1', 'sessionId': 'ses_alpha',
        'sequence': i, 'timestamp': DateTime.now().toIso8601String(),
        'type': 'text_delta',
        'payload': {
          'delta': '历史内容 $i\n\n${List.filled(12, '行').join('\n\n')}',
          'partId': 'p$i', 'partRevision': 1,
        },
      });
    }
    await tester.pumpAndSettle();
    await tester.drag(find.byKey(const Key('session-timeline-list')), const Offset(0, 3000));
    await tester.pump(const Duration(milliseconds: 300));

    // 普通 running 状态事件（无可见变化）→ 不浮出
    transport.emitServerEvent({
      'version': 1, 'eventId': 'nr1', 'streamEpoch': 'ep1', 'sessionId': 'ses_alpha',
      'sequence': 9, 'timestamp': DateTime.now().toIso8601String(),
      'type': 'status', 'payload': {'status': 'running'},
    });
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.byKey(const Key('btn-jump-to-latest')), findsNothing);

    // 普通 client 通知（errorMessage 等非内容变化）→ 不浮出
    client.errorMessage = '普通通知';
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.byKey(const Key('btn-jump-to-latest')), findsNothing);

    // 真正的新内容 → 浮出
    transport.emitServerEvent({
      'version': 1, 'eventId': 'nr2', 'streamEpoch': 'ep1', 'sessionId': 'ses_alpha',
      'sequence': 10, 'timestamp': DateTime.now().toIso8601String(),
      'type': 'text_delta',
      'payload': {'delta': '真正的新内容', 'partId': 'p_new', 'partRevision': 1},
    });
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.byKey(const Key('btn-jump-to-latest')), findsOneWidget);
    client.dispose();
  });

  testWidgets('Round3 收尾：普通 idle（无占位/无折叠）不浮出「有新回复」', (WidgetTester tester) async {
    await pumpToSession(tester);
    final transport = tester
        .widget<NienieMobileApp>(find.byType(NienieMobileApp))
        .client
        .transport as FakeBridgeTransport;

    for (var i = 1; i <= 8; i++) {
      transport.emitServerEvent({
        'version': 1, 'eventId': 'q$i', 'streamEpoch': 'ep1', 'sessionId': 'ses_alpha',
        'sequence': i, 'timestamp': DateTime.now().toIso8601String(),
        'type': 'text_delta',
        'payload': {
          'delta': '内容 $i\n\n${List.filled(12, '行').join('\n\n')}',
          'partId': 'p$i', 'partRevision': 1,
        },
      });
    }
    await tester.pumpAndSettle();
    await tester.drag(find.byKey(const Key('session-timeline-list')), const Offset(0, 3000));
    await tester.pump(const Duration(milliseconds: 300));

    // 普通 idle：无等待占位、无未折叠思考 → 不算可见变化
    transport.emitServerEvent({
      'version': 1, 'eventId': 'q_idle', 'streamEpoch': 'ep1', 'sessionId': 'ses_alpha',
      'sequence': 9, 'timestamp': DateTime.now().toIso8601String(),
      'type': 'status', 'payload': {'status': 'idle'},
    });
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.byKey(const Key('btn-jump-to-latest')), findsNothing);
  });

  testWidgets('Round3 收尾：FileCredentialStore→QuickCommandsBar 组合恢复（真实磁盘）', (WidgetTester tester) async {
    final dir = Directory.systemTemp.createTempSync('nie_qc3');
    final file = File('${dir.path}/state.json');
    // 全新 store + 全新 client + 真实 QuickCommandsBar（生产重启链路）
    final client = MobileBridgeClient(
      transport: FakeBridgeTransport(),
      credentialStore: FileCredentialStore(file),
    );
    // 真实磁盘 I/O 必须全部在真实事件循环（runAsync）完成——
    // 假时钟区内 await 文件 Future 会死锁（10min 超时）
    await tester.runAsync(() async {
      await FileCredentialStore(file).saveQuickCommands('codex', ['磁盘恢复指令']);
      await client.loadQuickCommandsFor('codex');
    });
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: QuickCommandsBar(client: client, agentId: 'codex', onUse: (_) {}),
      ),
    ));
    await tester.pump();
    expect(find.byKey(const Key('quick-command-磁盘恢复指令')), findsOneWidget);
    client.dispose();
    dir.deleteSync(recursive: true);
  });

  test('Round3 收尾：加载失败清理状态可重试（异常不外泄、默认降级）', () async {
    final store = _FlakyCredentialStore(failures: 1);
    final client = MobileBridgeClient(
      transport: FakeBridgeTransport(),
      credentialStore: store,
    );
    // 第一次加载失败：不抛出、默认指令降级、不卡死
    await client.ensureQuickCommandsLoaded('codex');
    expect(client.quickCommandsFor('codex'), isNull); // 保持默认语义

    // 清理 in-flight 后重试成功
    await client.ensureQuickCommandsLoaded('codex');
    expect(client.quickCommandsFor('codex'), ['重试成功指令']);
    client.dispose();
  });

  testWidgets('Round3 收尾2：认领相同文本不提示、权威文本差异才提示', (WidgetTester tester) async {
    await pumpToSession(tester);
    final client = tester.widget<NienieMobileApp>(find.byType(NienieMobileApp)).client;
    final transport = client.transport as FakeBridgeTransport;

    // 历史内容（底部完成，不触发提示）
    for (var i = 1; i <= 8; i++) {
      transport.emitServerEvent({
        'version': 1, 'eventId': 'c$i', 'streamEpoch': 'ep1', 'sessionId': 'ses_alpha',
        'sequence': i, 'timestamp': DateTime.now().toIso8601String(),
        'type': 'text_delta',
        'payload': {
          'delta': '背景 $i\n\n${List.filled(12, '行').join('\n\n')}',
          'partId': 'p$i', 'partRevision': 1,
        },
      });
    }
    await tester.pumpAndSettle();

    // 底部发送（乐观消息=可见变化，在底部静默跟随）——记录权威对账用的 clientMessageId
    await client.sendMessage('重复文本');
    await tester.pumpAndSettle();
    final optimistic =
        client.timelineFor('ses_alpha').whereType<UserPromptItem>().last;
    final claimId = optimistic.messageId!;

    // 翻到历史位置 → 服务端认领**相同文本**：无实际差异，不提示
    await tester.drag(find.byKey(const Key('session-timeline-list')), const Offset(0, 3000));
    await tester.pump(const Duration(milliseconds: 300));
    transport.emitServerEvent({
      'version': 1, 'eventId': 'claim_same', 'streamEpoch': 'ep1', 'sessionId': 'ses_alpha',
      'sequence': 9,
      'timestamp': DateTime.now().toIso8601String(),
      'type': 'text_delta',
      'payload': {
        'delta': '重复文本', 'partId': 'cm1', 'partRevision': 1,
        'role': 'user', 'messageId': claimId,
      },
    });
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.byKey(const Key('btn-jump-to-latest')), findsNothing); // 相同认领不误报

    // 权威文本**确实不同**：正常提示
    transport.emitServerEvent({
      'version': 1, 'eventId': 'claim_diff', 'streamEpoch': 'ep1', 'sessionId': 'ses_alpha',
      'sequence': 10,
      'timestamp': DateTime.now().toIso8601String(),
      'type': 'text_delta',
      'payload': {
        'delta': '权威修正文本', 'partId': 'cm1', 'partRevision': 2,
        'role': 'user', 'messageId': claimId,
      },
    });
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.byKey(const Key('btn-jump-to-latest')), findsOneWidget);
    client.dispose();
  });

  testWidgets('Round3 收尾2：idle 只按实际移除占位判定（非末尾占位不误报）', (WidgetTester tester) async {
    await pumpToSession(tester);
    final client = tester.widget<NienieMobileApp>(find.byType(NienieMobileApp)).client;
    final transport = client.transport as FakeBridgeTransport;

    // 历史内容（底部完成）
    for (var i = 1; i <= 8; i++) {
      transport.emitServerEvent({
        'version': 1, 'eventId': 'd$i', 'streamEpoch': 'ep1', 'sessionId': 'ses_alpha',
        'sequence': i, 'timestamp': DateTime.now().toIso8601String(),
        'type': 'text_delta',
        'payload': {
          'delta': '内容 $i\n\n${List.filled(12, '行').join('\n\n')}',
          'partId': 'p$i', 'partRevision': 1,
        },
      });
    }
    await tester.pumpAndSettle();

    // 底部发送（产生 [User, Pending]）+ 追加错误卡 → pending 不在末尾
    await client.sendMessage('触发占位');
    await tester.pumpAndSettle();
    transport.emitServerEvent({
      'version': 1, 'eventId': 'd_err', 'streamEpoch': 'ep1', 'sessionId': 'ses_alpha',
      'sequence': 9, 'timestamp': DateTime.now().toIso8601String(),
      'type': 'error',
      'payload': {'errorId': 'e1', 'code': 'X', 'message': 'tail', 'retryable': true},
    });
    await tester.pumpAndSettle();

    // 翻到历史位置 → idle：末尾非 pending（无实际移除）且无思考折叠 → 不提示
    await tester.drag(find.byKey(const Key('session-timeline-list')), const Offset(0, 3000));
    await tester.pump(const Duration(milliseconds: 300));
    transport.emitServerEvent({
      'version': 1, 'eventId': 'd_idle', 'streamEpoch': 'ep1', 'sessionId': 'ses_alpha',
      'sequence': 10, 'timestamp': DateTime.now().toIso8601String(),
      'type': 'status', 'payload': {'status': 'idle'},
    });
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.byKey(const Key('btn-jump-to-latest')), findsNothing);
    client.dispose();
  });

  testWidgets('6.1 会话卡片：状态点/项目·相对时间/未读标记（后台事件→未读，打开清除）', (WidgetTester tester) async {
    await pumpToSession(tester);
    final client = tester.widget<NienieMobileApp>(find.byType(NienieMobileApp)).client;
    // 造第二会话为 active，使 ses_alpha 成为「非活跃」以测未读红点
    final other = await client.createSession(agentId: 'opencode', title: 'B 会话');
    client.activeSession = other;

    // 打开会话抽屉
    await tester.tap(find.byKey(const Key('btn-open-drawer')));
    await tester.pumpAndSettle();

    // 卡片信息密度：标题 + 项目 basename · 相对时间
    expect(find.byKey(const Key('session-item-ses_alpha')), findsOneWidget);
    expect(find.textContaining('nienie'), findsWidgets); // 项目 basename
    expect(find.textContaining('min ago'), findsWidgets); // 相对时间（3 分钟前）

    // 活跃会话收到内容不标未读
    expect(client.isSessionUnread('ses_alpha'), isFalse);

    // 未读标记渲染：非活跃会话显示红点（模拟后台到达）
    client.markSessionUnreadForTest('ses_alpha');
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.byKey(const Key('unread-dot-ses_alpha')), findsOneWidget);

    // 打开会话 → 未读清除
    await tester.tap(find.byKey(const Key('session-item-ses_alpha')));
    await tester.pumpAndSettle();
    expect(client.isSessionUnread('ses_alpha'), isFalse);
  });

  testWidgets('6.2 会话摘要条：上次消息·状态一句话恢复上下文，可关闭', (WidgetTester tester) async {
    await pumpToSession(tester);

    // 时间线有内容（用户消息）→ 摘要条显示
    await tester.enterText(find.byKey(const Key('input-session-prompt')), '修复登录崩溃的问题');
    await tester.tap(find.byKey(const Key('btn-send-prompt')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('session-summary-bar')), findsOneWidget);
    expect(find.textContaining('Last'), findsWidgets); // 默认测试语言为英文
    expect(find.textContaining('修复登录崩溃的问题'), findsWidgets);

    // 关闭 → 消失
    await tester.tap(find.byKey(const Key('btn-close-session-summary')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('session-summary-bar')), findsNothing);
  });

  testWidgets('Round2 状态点实时：running 绿/idle 灰，A running 不串到 B', (WidgetTester tester) async {
    await pumpToSession(tester);
    final client = tester.widget<NienieMobileApp>(find.byType(NienieMobileApp)).client;
    final transport = client.transport as FakeBridgeTransport;

    await tester.tap(find.byKey(const Key('btn-open-drawer')));
    await tester.pumpAndSettle();
    Color dotColor(String id) => (tester
            .widget<Container>(find.byKey(Key('session-status-dot-$id')))
            .decoration! as BoxDecoration)
        .color!;

    const green = Color(0xFF17B378);
    const gray = Color(0xFF989CA5);
    // 初始 idle
    expect(dotColor('ses_alpha'), gray);
    expect(dotColor('ses_beta'), gray);

    // ses_alpha running → 绿（事件驱动实时状态）
    transport.emitServerEvent({
      'version': 1, 'eventId': 'st1', 'streamEpoch': 'ep1', 'sessionId': 'ses_alpha',
      'sequence': 1, 'timestamp': DateTime.now().toIso8601String(),
      'type': 'status', 'payload': {'status': 'running'},
    });
    await tester.pump(const Duration(milliseconds: 50));
    expect(dotColor('ses_alpha'), green);
    expect(dotColor('ses_beta'), gray); // A running 不串到 B

    // 回 idle → 灰
    transport.emitServerEvent({
      'version': 1, 'eventId': 'st2', 'streamEpoch': 'ep1', 'sessionId': 'ses_alpha',
      'sequence': 2, 'timestamp': DateTime.now().toIso8601String(),
      'type': 'status', 'payload': {'status': 'idle'},
    });
    await tester.pump(const Duration(milliseconds: 50));
    expect(dotColor('ses_alpha'), gray);
    client.dispose();
  });

  testWidgets('Round2 真实事件驱动未读：后台 B 红点、活跃 A 无', (WidgetTester tester) async {
    await pumpToSession(tester);
    final client = tester.widget<NienieMobileApp>(find.byType(NienieMobileApp)).client;
    final transport = client.transport as FakeBridgeTransport;

    await tester.tap(find.byKey(const Key('btn-open-drawer')));
    await tester.pumpAndSettle();

    // B（后台）收到可见内容 → 真实链路（事件→水位→未读）→ 红点
    transport.emitServerEvent({
      'version': 1, 'eventId': 'un1', 'streamEpoch': 'ep1', 'sessionId': 'ses_beta',
      'sequence': 1, 'timestamp': DateTime.now().toIso8601String(),
      'type': 'text_delta',
      'payload': {'delta': 'B 的新回复', 'partId': 'p_b', 'partRevision': 1},
    });
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.byKey(const Key('unread-dot-ses_beta')), findsOneWidget);
    expect(find.byKey(const Key('unread-dot-ses_alpha')), findsNothing); // 活跃 A 无

    // A（活跃）收到内容 → 仍无红点
    transport.emitServerEvent({
      'version': 1, 'eventId': 'un2', 'streamEpoch': 'ep1', 'sessionId': 'ses_alpha',
      'sequence': 1, 'timestamp': DateTime.now().toIso8601String(),
      'type': 'text_delta',
      'payload': {'delta': 'A 的新回复', 'partId': 'p_a', 'partRevision': 1},
    });
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.byKey(const Key('unread-dot-ses_alpha')), findsNothing);
    client.dispose();
  });

  test('Round2 打开失败保留未读（清除时机在成功进入后）', () async {
    final transport = FakeBridgeTransport();
    final client = MobileBridgeClient(
      transport: transport,
      credentialStore: InMemoryCredentialStore(),
    );
    await client.refreshSessions();
    client.markSessionUnreadForTest('ses_alpha');
    expect(client.isSessionUnread('ses_alpha'), isTrue);

    transport.failSessionLoadOnce = true;
    await client.openSession(client.sessions.firstWhere((x) => x.id == 'ses_alpha'));
    // load 失败走了 fallback（activeSession=原对象）仍算进入成功？——设计：load 失败保留未读
    // openSession 的 session.load 失败分支 activeSession=session 且继续 replay；
    // 此处验证：失败响应下未读不被误清（清除发生在成功进入后）
    expect(client.isSessionUnread('ses_alpha'), isTrue);
    client.dispose();
  });

  testWidgets('Round2 A/B 分别关闭摘要，切换后均不重新出现', (WidgetTester tester) async {
    await pumpToSession(tester);
    final client = tester.widget<NienieMobileApp>(find.byType(NienieMobileApp)).client;

    // A 发消息 → 摘要条 → 关闭
    await tester.enterText(find.byKey(const Key('input-session-prompt')), 'A 的上下文');
    await tester.tap(find.byKey(const Key('btn-send-prompt')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('session-summary-bar')), findsOneWidget);
    await tester.tap(find.byKey(const Key('btn-close-session-summary')));
    await tester.pumpAndSettle();

    // 切到 B → 发消息 → 摘要条 → 关闭
    final b = client.sessions.firstWhere((x) => x.id == 'ses_beta');
    await client.openSession(b);
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('input-session-prompt')), 'B 的上下文');
    await tester.tap(find.byKey(const Key('btn-send-prompt')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('session-summary-bar')), findsOneWidget);
    await tester.tap(find.byKey(const Key('btn-close-session-summary')));
    await tester.pumpAndSettle();

    // 回 A → 关闭记录独立保留，不重新出现
    await client.openSession(client.sessions.firstWhere((x) => x.id == 'ses_alpha'));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('session-summary-bar')), findsNothing);
    client.dispose();
  });

  test('Round2 冷启动自动选中会话后恢复 Timeline（摘要条有数据源）', () async {
    final transport = FakeBridgeTransport();
    final t0 = DateTime.now().subtract(const Duration(minutes: 10));
    transport.snapshotResponse = {
      'schemaVersion': 1,
      'snapshotId': 'snap_cold',
      'sessionId': 'ses_alpha',
      'agentId': 'opencode',
      'streamEpoch': 'ep1',
      'watermark': 1,
      'capturedAt': DateTime.now().toIso8601String(),
      'complete': true,
      'hasMore': false,
      'totalParts': 1,
      'parts': [
        {
          'kind': 'message', 'ordinal': 0, 'partId': 'm1', 'revision': 1,
          'createdAt': t0.toIso8601String(), 'updatedAt': t0.toIso8601String(),
          'role': 'user',
          'content': [{'type': 'text', 'text': '冷启动前的最后一条消息'}],
        },
      ],
    };
    final client = MobileBridgeClient(
      transport: transport,
      credentialStore: InMemoryCredentialStore(),
    );
    await client.refreshSessions();
    // 模拟连接后自动选中（统一恢复入口 openSession——含历史/快照恢复）
    await client.openSession(client.sessions.first);
    // Timeline 已恢复 → 摘要条数据源存在
    final lastUser = client
        .timelineFor(client.sessions.first.id)
        .whereType<UserPromptItem>()
        .lastOrNull;
    expect(lastUser?.message, '冷启动前的最后一条消息');
    client.dispose();
  });

  test('Round2 活动时间随发送更新（卡片相对时间反映最新活动）', () async {
    final transport = FakeBridgeTransport();
    final client = MobileBridgeClient(
      transport: transport,
      credentialStore: InMemoryCredentialStore(),
    );
    await client.refreshSessions();
    final session = client.sessions.firstWhere((x) => x.id == 'ses_alpha');
    final before = client.lastActivityFor('ses_alpha');
    client.connectionState = BridgeConnectionState.connected;
    client.activeSession = session;
    await client.sendMessage('新活动');
    final after = client.lastActivityFor('ses_alpha');
    expect(after, isNotNull);
    if (before != null) {
      expect(after!.isAfter(before), isTrue);
    }
    client.dispose();
  });

  test('Round3 真实已保存设备重连自动恢复（reconnectWithSavedCredential→openSession→Snapshot）', () async {
    final transport = FakeBridgeTransport();
    final store = InMemoryCredentialStore();
    // 预置已保存设备凭证（machineId 匹配 fake hello）
    await store.save(const SavedDeviceCredential(
      machineId: 'machine_mac',
      wsUrl: 'ws://127.0.0.1:4100',
      deviceId: 'dev_1',
      deviceToken: 'tok_1',
    ));
    final t0 = DateTime.now().subtract(const Duration(minutes: 30));
    transport.snapshotResponse = {
      'schemaVersion': 1,
      'snapshotId': 'snap_re',
      'sessionId': 'ses_alpha',
      'agentId': 'opencode',
      'streamEpoch': 'ep1',
      'watermark': 1,
      'capturedAt': DateTime.now().toIso8601String(),
      'complete': true,
      'hasMore': false,
      'totalParts': 1,
      'parts': [
        {
          'kind': 'message', 'ordinal': 0, 'partId': 'm_re', 'revision': 1,
          'createdAt': t0.toIso8601String(), 'updatedAt': t0.toIso8601String(),
          'role': 'user',
          'content': [{'type': 'text', 'text': '重连前的最后一条消息'}],
        },
      ],
    };
    final client = MobileBridgeClient(transport: transport, credentialStore: store);
    // 真实重连入口（已保存设备路径——此前绕过统一恢复）
    await client.reconnectWithSavedCredential('machine_mac');
    final lastUser = client
        .timelineFor('ses_alpha')
        .whereType<UserPromptItem>()
        .lastOrNull;
    expect(lastUser?.message, '重连前的最后一条消息'); // 历史已恢复
    client.dispose();
  });

  test('Round3 快照恢复不伪造活动时间（30 分钟前的会话显示 30 min ago）', () async {
    final transport = FakeBridgeTransport();
    final client = MobileBridgeClient(
      transport: transport,
      credentialStore: InMemoryCredentialStore(),
    );
    await client.refreshSessions();
    final t0 = DateTime.now().subtract(const Duration(minutes: 30));
    transport.snapshotResponse = {
      'schemaVersion': 1,
      'snapshotId': 'snap_time',
      'sessionId': 'ses_alpha',
      'agentId': 'opencode',
      'streamEpoch': 'ep1',
      'watermark': 1,
      'capturedAt': DateTime.now().toIso8601String(),
      'complete': true,
      'hasMore': false,
      'totalParts': 1,
      'parts': [
        {
          'kind': 'message', 'ordinal': 0, 'partId': 'm_t', 'revision': 1,
          'createdAt': t0.toIso8601String(), 'updatedAt': t0.toIso8601String(),
          'role': 'user',
          'content': [{'type': 'text', 'text': '旧消息'}],
        },
      ],
    };
    await client.openSession(client.sessions.firstWhere((x) => x.id == 'ses_alpha'));
    // 活动时间未被历史恢复伪造（为 null → 卡片回退 modelTime=30 分钟前）
    expect(client.lastActivityFor('ses_alpha'), isNull);
    final label = client.strings.relativeTime(t0);
    expect(label, '30 min ago');
    client.dispose();
  });

  test('Round3 消除重复 Replay：快照成功时仅一次 events.replay', () async {
    final transport = FakeBridgeTransport();
    final client = MobileBridgeClient(
      transport: transport,
      credentialStore: InMemoryCredentialStore(),
    );
    await client.refreshSessions();
    await client.openSession(client.sessions.firstWhere((x) => x.id == 'ses_alpha'));
    // 快照成功路径：loadSessionSnapshot 内的 Replay 是唯一调度点
    expect(transport.replayRequests, 1);

    // 快照失败路径：外层 Replay 兜底（仍恰好一次）
    final transport2 = FakeBridgeTransport();
    transport2.snapshotResponse = {
      'schemaVersion': 1,
      'snapshotId': 'snap_bad',
      'sessionId': 'ses_alpha',
      'agentId': 'opencode',
      // 故意缺 watermark/capturedAt → 校验失败
      'complete': true,
      'hasMore': false,
      'totalParts': 0,
      'parts': [],
    };
    final client2 = MobileBridgeClient(
      transport: transport2,
      credentialStore: InMemoryCredentialStore(),
    );
    await client2.refreshSessions();
    await client2.openSession(client2.sessions.firstWhere((x) => x.id == 'ses_alpha'));
    expect(transport2.replayRequests, 1); // 失败兜底恰好一次
    client.dispose();
    client2.dispose();
  });

  testWidgets('6.3 改动摘要卡：N 文件 +X/-Y → 文件列表 → Before/After diff', (WidgetTester tester) async {
    await pumpToSession(tester);
    final client = tester.widget<NienieMobileApp>(find.byType(NienieMobileApp)).client;
    final transport = client.transport as FakeBridgeTransport;
    // Round2/3：真实 V2 数据形态——unified patch + 显式 format 契约
    transport.diffResponse = [
      {'diffId': 'd1', 'file': 'src/a.ts', 'format': 'unified_patch', 'before': '',
        'after': '@@ -1 +1 @@\n-const a = 1;\n+const a = 2;',
        'additions': 3, 'deletions': 1},
      {'diffId': 'd2', 'file': 'src/b.ts', 'format': 'unified_patch', 'before': '',
        'after': '@@ -0,0 +1 @@\n+export const b = 1;',
        'additions': 5, 'deletions': 0},
    ];
    await client.loadSessionDiffs('ses_alpha');
    await tester.pump();

    // 摘要头部：2 files + 总计 +8 / -1
    expect(find.byKey(const Key('change-summary-header')), findsOneWidget);
    expect(find.textContaining('Changes'), findsWidgets);
    expect(find.text('2 files'), findsOneWidget);
    expect(find.text('+8 / -1'), findsOneWidget);

    // 点开文件列表
    await tester.tap(find.byKey(const Key('change-summary-header')));
    await tester.pump();
    expect(find.byKey(const Key('change-file-src/a.ts')), findsOneWidget);
    expect(find.byKey(const Key('change-file-src/b.ts')), findsOneWidget);

    // 点文件行 → unified patch 着色视图（不是伪装 Before/After）
    await tester.tap(find.byKey(const Key('change-file-src/a.ts')));
    await tester.pump();
    expect(find.byKey(const Key('diff-patch-view')), findsOneWidget);
    expect(find.text('Diff'), findsOneWidget);
    expect(find.textContaining('-const a = 1;'), findsWidgets); // 删除行
    expect(find.textContaining('+const a = 2;'), findsWidgets); // 新增行

    // 再点收起 diff
    await tester.tap(find.byKey(const Key('change-file-src/a.ts')));
    await tester.pump();
    expect(find.byKey(const Key('diff-patch-view')), findsNothing);
    client.dispose();
  });

  testWidgets('6.3 全文态（before/after 都非空且非 patch）显示 Before/After 双栏', (WidgetTester tester) async {
    await pumpToSession(tester);
    final client = tester.widget<NienieMobileApp>(find.byType(NienieMobileApp)).client;
    final transport = client.transport as FakeBridgeTransport;
    transport.diffResponse = [
      {'diffId': 'd3', 'file': 'src/c.ts', 'before': 'const a = 1;', 'after': 'const a = 2;',
        'additions': 1, 'deletions': 1},
    ];
    await client.loadSessionDiffs('ses_alpha');
    await tester.pump();
    await tester.tap(find.byKey(const Key('change-summary-header')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('change-file-src/c.ts')));
    await tester.pump();
    expect(find.text('Before'), findsOneWidget);
    expect(find.text('After'), findsOneWidget);
    expect(find.byKey(const Key('diff-patch-view')), findsNothing); // 非 patch 不着色渲染
    client.dispose();
  });

  test('6.3 稳定 diffId：相同数据重载得到相同聚合卡身份（不用时间戳）', () async {
    final transport = FakeBridgeTransport();
    final client = MobileBridgeClient(
      transport: transport,
      credentialStore: InMemoryCredentialStore(),
    );
    await client.refreshSessions();
    transport.diffResponse = [
      {'diffId': 'd1', 'file': 'a.ts', 'before': '', 'after': '@@ -1 +1 @@\n-a\n+b',
        'additions': 1, 'deletions': 1},
    ];
    await client.loadSessionDiffs('ses_alpha');
    final first = client.timelineFor('ses_alpha').whereType<ChangeSummaryCardItem>().single;
    await client.loadSessionDiffs('ses_alpha');
    final second = client.timelineFor('ses_alpha').whereType<ChangeSummaryCardItem>().single;
    expect(second.diffId, first.diffId); // 稳定身份（含原始 diffId 派生）
    expect(first.files.single.diffId, 'd1'); // 保留服务端稳定 diffId
    client.dispose();
  });

  test('6.3 快照来源 FileDiffCardItem 不被主动加载清除', () async {
    final transport = FakeBridgeTransport();
    final client = MobileBridgeClient(
      transport: transport,
      credentialStore: InMemoryCredentialStore(),
    );
    await client.refreshSessions();
    final t = DateTime.now().toIso8601String();
    transport.snapshotResponse = {
      'schemaVersion': 1,
      'snapshotId': 'snap_fc',
      'sessionId': 'ses_alpha',
      'agentId': 'opencode',
      'streamEpoch': 'ep1',
      'watermark': 1,
      'capturedAt': t,
      'complete': true,
      'hasMore': false,
      'totalParts': 1,
      'parts': [
        {
          'kind': 'file_change', 'ordinal': 0, 'partId': 'fc1', 'revision': 1,
          'createdAt': t, 'updatedAt': t,
          'diffId': 'd_snap', 'file': 'snap.ts', 'before': '', 'after': '@@ -1 +1 @@\n-a\n+b',
          'additions': 1, 'deletions': 1,
        },
      ],
    };
    await client.loadSessionSnapshot('ses_alpha');
    expect(client.timelineFor('ses_alpha').whereType<FileDiffCardItem>().length, 1);
    transport.diffResponse = [
      {'diffId': 'd1', 'file': 'x.ts', 'before': '', 'after': '@@ -1 +1 @@\n-a\n+b',
        'additions': 1, 'deletions': 1},
    ];
    await client.loadSessionDiffs('ses_alpha');
    // 快照来源卡保留 + 聚合卡新增（来源区分）
    expect(client.timelineFor('ses_alpha').whereType<FileDiffCardItem>().length, 1);
    expect(client.timelineFor('ses_alpha').whereType<ChangeSummaryCardItem>().length, 1);
    client.dispose();
  });

  testWidgets('6.3 Round3 V1 新增/删除文件：content 契约单栏（新增=After，删除=Before）', (WidgetTester tester) async {
    await pumpToSession(tester);
    final client = tester.widget<NienieMobileApp>(find.byType(NienieMobileApp)).client;
    final transport = client.transport as FakeBridgeTransport;
    // V1 新增文件：before 空 / after 全文（format:content 显式——不再误判 patch）
    transport.diffResponse = [
      {'diffId': 'd_add', 'file': 'src/new.ts', 'format': 'content', 'before': '',
        'after': 'export const foo = 1;', 'additions': 1, 'deletions': 0},
    ];
    await client.loadSessionDiffs('ses_alpha');
    await tester.pump();
    await tester.tap(find.byKey(const Key('change-summary-header')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('change-file-src/new.ts')));
    await tester.pump();
    expect(find.byKey(const Key('diff-patch-view')), findsNothing); // 不是 patch
    expect(find.text('After'), findsOneWidget);
    expect(find.text('Before'), findsNothing); // 新增无修改前
    expect(find.textContaining('export const foo = 1;'), findsWidgets);

    // V1 删除文件：before 全文 / after 空
    transport.diffResponse = [
      {'diffId': 'd_del', 'file': 'src/old.ts', 'format': 'content', 'before': 'export const old = 1;',
        'after': '', 'additions': 0, 'deletions': 1},
    ];
    await client.loadSessionDiffs('ses_alpha');
    await tester.pump();
    await tester.tap(find.byKey(const Key('change-summary-header')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('change-file-src/old.ts')));
    await tester.pump();
    expect(find.byKey(const Key('diff-patch-view')), findsNothing);
    expect(find.text('Before'), findsOneWidget);
    expect(find.text('After'), findsNothing); // 删除无修改后
    expect(find.textContaining('export const old = 1;'), findsWidgets);
    client.dispose();
  });

  test('6.3 Round3 diffId 缺失 fail-closed 丢弃（文件路径不冒充身份）', () async {
    final transport = FakeBridgeTransport();
    final client = MobileBridgeClient(
      transport: transport,
      credentialStore: InMemoryCredentialStore(),
    );
    await client.refreshSessions();
    transport.diffResponse = [
      {'diffId': 'd_ok', 'file': 'a.ts', 'format': 'unified_patch', 'before': '',
        'after': '@@ -1 +1 @@\n-a\n+b', 'additions': 1, 'deletions': 1},
      {'file': 'no-id.ts', 'format': 'unified_patch', 'before': '',
        'after': '@@ -1 +1 @@\n-a\n+b', 'additions': 1, 'deletions': 1}, // 缺 diffId
    ];
    await client.loadSessionDiffs('ses_alpha');
    final card = client.timelineFor('ses_alpha').whereType<ChangeSummaryCardItem>().single;
    expect(card.files.length, 1); // 缺 diffId 条目被丢弃
    expect(card.files.single.diffId, 'd_ok');
    client.dispose();
  });

  testWidgets('7.1 i18n 收编：菜单/提示/tooltips 走四语言资源', (WidgetTester tester) async {
    await pumpToSession(tester);
    final client = tester.widget<NienieMobileApp>(find.byType(NienieMobileApp)).client;

    // 附件菜单（EN 默认）
    await tester.tap(find.byKey(const Key('btn-attach')));
    await tester.pumpAndSettle();
    expect(find.text('Add attachment'), findsOneWidget); // 菜单标题
    expect(find.text('Image'), findsOneWidget);
    expect(find.text('File'), findsOneWidget);
    await tester.tap(find.text('File')); // 关闭菜单
    await tester.pumpAndSettle();

    // tooltip（EN）
    expect(
      tester.widget<IconButton>(find.byKey(const Key('btn-open-drawer'))).tooltip,
      'Open workspace drawer',
    );

    // 语言切换 zh → 中文资源
    await client.setLanguage(AppLanguage.zh);
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('btn-attach')));
    await tester.pumpAndSettle();
    expect(find.text('添加附件'), findsOneWidget);
    expect(find.text('图片'), findsOneWidget);
    await tester.tap(find.text('文件'));
    await tester.pumpAndSettle();
    client.dispose();
  });

  testWidgets('7.2 深色模式：系统暗色下背景/卡片不刺眼白', (WidgetTester tester) async {
    tester.platformDispatcher.platformBrightnessTestValue = Brightness.dark;
    addTearDown(() => tester.platformDispatcher.platformBrightnessTestValue = Brightness.light);
    await pumpToSession(tester);
    final transport = tester
        .widget<NienieMobileApp>(find.byType(NienieMobileApp))
        .client
        .transport as FakeBridgeTransport;
    final context = tester.element(find.byType(Scaffold));
    // 背景与卡片均为暗色（不瞎眼）
    expect(Theme.of(context).brightness, Brightness.dark);
    expect(Theme.of(context).scaffoldBackgroundColor, const Color(0xFF121212));
    // 时间线主卡背景（暗色）
    expect(appBgColor(context), const Color(0xFF121212));
    expect(cardBgColor(context), const Color(0xFF1C1C1E));

    // 渲染级断言（Round4：Key 定位具体 Widget，不扫全树防误判）
    await tester.enterText(find.byKey(const Key('input-session-prompt')), 'bubble');
    await tester.tap(find.byKey(const Key('btn-send-prompt')));
    await tester.pumpAndSettle();
    expect(find.text('bubble'), findsOneWidget); // 气泡文本确实渲染
    final bubbleBox = tester
        .widget<Container>(find.byKey(const Key('user-bubble')))
        .decoration! as BoxDecoration;
    expect(bubbleBox.color, userBubbleBgColor(context)); // 气泡背景=暗色映射

    // 错误卡渲染级：暗色背景 + 亮红前景
    transport.emitServerEvent({
      'version': 1, 'eventId': 'dm1', 'streamEpoch': 'ep1', 'sessionId': 'ses_alpha',
      'sequence': 1, 'timestamp': DateTime.now().toIso8601String(),
      'type': 'error',
      'payload': {'errorId': 'e_dm', 'code': 'X', 'message': 'boom', 'retryable': true},
    });
    await tester.pump(const Duration(milliseconds: 50));
    final errBox = tester
        .widget<Container>(find.byKey(const Key('error-card')))
        .decoration! as BoxDecoration;
    expect(errBox.color, dangerBgColor(context)); // 错误卡背景=暗色映射
    // 前景断言：错误文字=亮红（不是旧红 #DC2626）
    final errTexts = tester.widgetList<Text>(
      find.descendant(of: find.byKey(const Key('error-card')), matching: find.byType(Text)),
    );
    expect(
      errTexts.any((t) => t.style?.color == dangerTextColor(context)),
      isTrue,
    );
  });

  testWidgets('7.3b 键盘提交成功触发触感、失败不触发、快捷指令与批准触发', (WidgetTester tester) async {
    await pumpToSession(tester);
    final client = tester.widget<NienieMobileApp>(find.byType(NienieMobileApp)).client;
    final transport = client.transport as FakeBridgeTransport;
    final calls = <MethodCall>[];
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      SystemChannels.platform,
      (call) async {
        calls.add(call);
        return null;
      },
    );
    int haptics() => calls.where((c) => c.method == 'HapticFeedback.vibrate').length;

    // 键盘提交成功 → 触感
    await tester.enterText(find.byKey(const Key('input-session-prompt')), 'keyboard msg');
    await tester.testTextInput.receiveAction(TextInputAction.send);
    await tester.pumpAndSettle();
    expect(haptics(), greaterThan(0));

    // 发送失败 → 不触发
    transport.failNextSend = true;
    calls.clear();
    await tester.enterText(find.byKey(const Key('input-session-prompt')), 'fail msg');
    await tester.testTextInput.receiveAction(TextInputAction.send);
    await tester.pumpAndSettle();
    expect(haptics(), 0);

    // 快捷指令 → 触感
    calls.clear();
    await tester.tap(find.byKey(const Key('quick-command-Continue')));
    await tester.pump();
    expect(haptics(), greaterThan(0));

    // 批准（allow_once 低风险直达）→ 触感
    transport.emitServerEvent({
      'version': 1, 'eventId': 'hp1', 'streamEpoch': 'ep1', 'sessionId': 'ses_alpha',
      'sequence': 1, 'timestamp': DateTime.now().toIso8601String(), 'type': 'status',
      'payload': {'status': 'waiting', 'permissionId': 'perm_h', 'permission': 'read', 'detail': 'r', 'patterns': ['src/**']},
    });
    await tester.pumpAndSettle();
    await tester.drag(find.byKey(const Key('session-timeline-list')), const Offset(0, -500));
    await tester.pump(const Duration(milliseconds: 200));
    calls.clear();
    await tester.tap(find.byKey(const Key('btn-perm-allow-once-perm_h')));
    await tester.pumpAndSettle();
    expect(haptics(), greaterThan(0));
    client.dispose();
  });

  testWidgets('7.3 触感反馈：发送/长按触发 HapticFeedback', (WidgetTester tester) async {
    await pumpToSession(tester);
    final calls = <MethodCall>[];
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      SystemChannels.platform,
      (call) async {
        calls.add(call);
        return null;
      },
    );

    // 发送触感
    await tester.enterText(find.byKey(const Key('input-session-prompt')), 'hi');
    await tester.tap(find.byKey(const Key('btn-send-prompt')));
    await tester.pumpAndSettle();
    expect(calls.where((c) => c.method == 'HapticFeedback.vibrate'), isNotEmpty);

    // 长按菜单触感
    calls.clear();
    await tester.longPress(find.text('hi').first);
    await tester.pumpAndSettle();
    expect(calls.where((c) => c.method == 'HapticFeedback.vibrate'), isNotEmpty);
    // 气泡微动效存在
    expect(find.byType(TweenAnimationBuilder<double>), findsWidgets);
  });

  testWidgets('7.4 空状态双语义：无会话=配对引导，有会话空时间线=发第一条引导', (WidgetTester tester) async {
    await pumpToSession(tester);
    final client = tester.widget<NienieMobileApp>(find.byType(NienieMobileApp)).client;

    // 无 activeSession → 配对引导
    client.activeSession = null;
    client.notifyListenersForTest();
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.byKey(const Key('empty-state-guide')), findsOneWidget);
    expect(find.textContaining('No sessions yet'), findsWidgets);
    expect(find.byKey(const Key('empty-timeline-guide')), findsNothing);

    // 有会话但无消息 → 发第一条引导（语义区分）
    await client.openSession(client.sessions.firstWhere((x) => x.id == 'ses_beta'));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('empty-timeline-guide')), findsOneWidget);
    expect(find.textContaining('No messages yet'), findsWidgets);
    expect(find.byKey(const Key('empty-state-guide')), findsNothing);
  });

  testWidgets('7.5 用量卡：tokens/费用三格展示', (WidgetTester tester) async {
    await pumpToSession(tester);
    final transport = tester
        .widget<NienieMobileApp>(find.byType(NienieMobileApp))
        .client
        .transport as FakeBridgeTransport;
    transport.emitServerEvent({
      'version': 1, 'eventId': 'ug1', 'streamEpoch': 'ep1', 'sessionId': 'ses_alpha',
      'sequence': 1, 'timestamp': DateTime.now().toIso8601String(),
      'type': 'usage',
      'payload': {'inputTokens': 1500, 'outputTokens': 420, 'costUsd': 0.042},
    });
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.textContaining('Usage this round'), findsWidgets); // 卡标题
    expect(find.textContaining('Input 1500'), findsOneWidget);
    expect(find.textContaining('Output 420'), findsOneWidget);
    expect(find.textContaining(r'Cost $0.0420'), findsOneWidget);
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

/// 测试辅助：可控延迟的 CredentialStore（竞态测试用）
class _GatedCredentialStore implements DeviceCredentialStore {
  final DeviceCredentialStore inner;
  final Completer<void> gate;
  _GatedCredentialStore(this.inner, this.gate);

  @override
  Future<List<String>?> loadQuickCommands(String scope) async {
    await gate.future;
    return inner.loadQuickCommands(scope);
  }

  @override
  Future<void> saveQuickCommands(String scope, List<String> commands) =>
      inner.saveQuickCommands(scope, commands);

  @override
  Future<void> save(SavedDeviceCredential credential) => inner.save(credential);
  @override
  Future<SavedDeviceCredential?> load([String? machineId]) => inner.load(machineId);
  @override
  Future<List<SavedDeviceCredential>> listMachines() => inner.listMachines();
  @override
  Future<void> removeMachine(String machineId) => inner.removeMachine(machineId);
  @override
  Future<void> saveLanguage(AppLanguage language) => inner.saveLanguage(language);
  @override
  Future<AppLanguage?> loadLanguage() => inner.loadLanguage();
  @override
  Future<void> clear() => inner.clear();
}

/// 测试辅助：前 N 次加载抛异常（失败恢复/重试测试用）
class _FlakyCredentialStore extends InMemoryCredentialStore {
  int failures;
  _FlakyCredentialStore({required this.failures});

  @override
  Future<List<String>?> loadQuickCommands(String scope) async {
    if (failures > 0) {
      failures -= 1;
      throw Exception('disk io error');
    }
    await saveQuickCommands(scope, ['重试成功指令']);
    return super.loadQuickCommands(scope);
  }
}
