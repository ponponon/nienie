import 'dart:io';
import 'package:app_links/app_links.dart';
import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';
import 'src/i18n/app_strings.dart';
import 'src/demo/demo_mode.dart';
import 'src/state/mobile_bridge_client.dart';
import 'src/storage/credential_store.dart';
import 'src/transport/bridge_transport.dart';
import 'src/ui/ai_consent_gate.dart';
import 'src/ui/nienie_mobile_app.dart';

export 'src/i18n/app_strings.dart';
export 'src/models/protocol_models.dart';
export 'src/models/timeline_items.dart';
export 'src/state/mobile_bridge_client.dart';
export 'src/storage/credential_store.dart';
export 'src/transport/bridge_transport.dart';
export 'src/transport/fake_bridge_transport.dart';
export 'src/ui/nienie_mobile_app.dart';
export 'src/ui/pairing_panel.dart';
export 'src/ui/qr_scanner_sheet.dart';
export 'src/ui/timeline_card_list.dart';

/// 状态文件（含 deviceToken 等凭据）落在应用支持目录，属于 App 沙盒，
/// 不再写系统临时目录（tmp 可被系统清理且无保护）。
/// 旧版写在 systemTemp，首启迁移到新位置并删除旧文件，避免凭据明文残留。
Future<File> _resolveStateFile() async {
  final dir = await getApplicationSupportDirectory();
  final target = File('${dir.path}/nienie_mobile_state.json');
  final legacy = File('${Directory.systemTemp.path}/nienie_mobile_state.json');
  try {
    if (!await target.exists() && await legacy.exists()) {
      await target.parent.create(recursive: true);
      await legacy.copy(target.path);
      await legacy.delete();
    }
  } catch (_) {
    // 迁移失败不阻塞启动：下次配对会重新写入新位置
  }
  return target;
}

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // 商店截图 / 演示构建：--dart-define=NIE_DEMO=true 时用种子数据跑真实 UI，
  // 正式构建该常量为 false，demo 链路（含 FakeBridgeTransport）不会进入调用图。
  const demo = bool.fromEnvironment('NIE_DEMO');
  if (demo) {
    // 截图语言跟随 --dart-define=NIE_DEMO_LANG=en（美区商店）/ zh（本地预览）
    const demoLang = String.fromEnvironment('NIE_DEMO_LANG', defaultValue: 'zh');
    final demoStore = InMemoryCredentialStore();
    await demoStore.saveAiConsent(true);
    final demoClient = await createDemoClient(
      credentialStore: demoStore,
      language: demoLang == 'en' ? AppLanguage.en : AppLanguage.zh,
    );
    runApp(NienieMobileApp(client: demoClient));
    return;
  }
  final credentialStore = FileCredentialStore(await _resolveStateFile());
  final client = MobileBridgeClient(
    transport: IoBridgeTransport(),
    credentialStore: credentialStore,
    language: AppLanguage.zh,
  );
  client.loadSavedPreferences(autoReconnect: true);
  // 通知深链（R9）：nienie://session/<id> 点击直达会话
  try {
    final appLinks = AppLinks();
    appLinks.getInitialLink().then((uri) {
      if (uri != null) client.handleDeepLink(uri);
    });
    appLinks.uriLinkStream.listen((uri) {
      client.handleDeepLink(uri);
    });
  } catch (_) {
    // 测试环境或平台不支持时忽略；深链为增强能力不影响主流程
  }
  runApp(
    AiConsentGate(
      store: credentialStore,
      language: client.language,
      child: NienieMobileApp(client: client),
    ),
  );
}
