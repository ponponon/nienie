import 'dart:io';
import 'package:app_links/app_links.dart';
import 'package:flutter/material.dart';
import 'src/i18n/app_strings.dart';
import 'src/state/mobile_bridge_client.dart';
import 'src/storage/credential_store.dart';
import 'src/transport/bridge_transport.dart';
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

void main() {
  final client = MobileBridgeClient(
    transport: IoBridgeTransport(),
    credentialStore: FileCredentialStore(
      File('${Directory.systemTemp.path}/nienie_mobile_state.json'),
    ),
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
  runApp(NienieMobileApp(client: client));
}
