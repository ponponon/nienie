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
export 'src/ui/timeline_card_list.dart';

void main() {
  runApp(
    NienieMobileApp(
      client: MobileBridgeClient(
        transport: IoBridgeTransport(),
        credentialStore: InMemoryCredentialStore(),
        language: AppLanguage.zh,
      ),
    ),
  );
}
