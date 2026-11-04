import 'package:flutter/material.dart';
import '../state/mobile_bridge_client.dart';
import 'qr_scanner_sheet.dart';

class PairingPanel extends StatelessWidget {
  final MobileBridgeClient client;
  final TextEditingController wsUrlController;
  final TextEditingController pairingCodeController;
  final TextEditingController qrUriController;

  const PairingPanel({
    super.key,
    required this.client,
    required this.wsUrlController,
    required this.pairingCodeController,
    required this.qrUriController,
  });

  void _openCameraScanner(BuildContext context) {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (sheetCtx) => QrScannerSheet(
        client: client,
        onDetected: (rawUri) {
          qrUriController.text = rawUri;
          client.pairWithQrUri(rawUri);
        },
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final s = client.strings;
    return ListView(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      children: [
        // 1. Top Priority if available: One-tap reconnect to saved computers
        if (client.savedMachines.isNotEmpty)
          Container(
            margin: const EdgeInsets.only(bottom: 10),
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            decoration: BoxDecoration(
              color: const Color(0xFFFFFFFF),
              borderRadius: BorderRadius.circular(12),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  s.savedComputersTitle,
                  style: const TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                    color: Color(0xFF181818),
                  ),
                ),
                const SizedBox(height: 6),
                for (final machine in client.savedMachines)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 3),
                    child: Row(
                      children: [
                        const Icon(Icons.laptop_mac, size: 16, color: Color(0xFF07C160)),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Row(
                            children: [
                              Text(
                                machine.machineId,
                                style: const TextStyle(
                                  fontSize: 12,
                                  fontWeight: FontWeight.w600,
                                  color: Color(0xFF181818),
                                ),
                              ),
                              const SizedBox(width: 6),
                              Flexible(
                                child: Text(
                                  machine.wsUrl,
                                  style: const TextStyle(
                                    fontSize: 11,
                                    color: Color(0xFF8E8E93),
                                  ),
                                  overflow: TextOverflow.ellipsis,
                                ),
                              ),
                            ],
                          ),
                        ),
                        SizedBox(
                          height: 30,
                          child: FilledButton.tonal(
                            key: Key('btn-reconnect-machine-${machine.machineId}'),
                            style: FilledButton.styleFrom(
                              backgroundColor: const Color(0xFF07C160).withValues(alpha: 0.12),
                              foregroundColor: const Color(0xFF07C160),
                              padding: const EdgeInsets.symmetric(horizontal: 10),
                            ),
                            onPressed: () =>
                                client.reconnectWithSavedCredential(machine.machineId),
                            child: Text(s.reconnectBtn, style: const TextStyle(fontSize: 12)),
                          ),
                        ),
                        IconButton(
                          key: Key('btn-remove-machine-${machine.machineId}'),
                          visualDensity: VisualDensity.compact,
                          tooltip: 'Remove Machine',
                          onPressed: () => client.removeSavedMachine(machine.machineId),
                          icon: const Icon(
                            Icons.delete_outline,
                            size: 16,
                            color: Color(0xFF8E8E93),
                          ),
                        ),
                      ],
                    ),
                  ),
              ],
            ),
          ),

        // 2. Primary Action Card: Camera QR Scan + Manual 6-Digit Pairing
        Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: const Color(0xFFFFFFFF),
            borderRadius: BorderRadius.circular(12),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  const Icon(Icons.phonelink_ring, size: 17, color: Color(0xFF07C160)),
                  const SizedBox(width: 6),
                  Text(
                    s.connectTitle,
                    style: const TextStyle(
                      fontSize: 15,
                      fontWeight: FontWeight.w600,
                      color: Color(0xFF181818),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              // Hero Button: Camera QR Code Scanner
              SizedBox(
                height: 44,
                child: FilledButton.icon(
                  key: const Key('btn-open-qr-scanner'),
                  style: FilledButton.styleFrom(
                    backgroundColor: const Color(0xFF07C160),
                    foregroundColor: Colors.white,
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(10),
                    ),
                  ),
                  onPressed: () => _openCameraScanner(context),
                  icon: const Icon(Icons.qr_code_scanner, size: 20),
                  label: Text(
                    s.scanQrBtn,
                    style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
                  ),
                ),
              ),
              const SizedBox(height: 12),
              // Manual WS URL Row (full width, never truncated)
              TextField(
                key: const Key('input-ws-url'),
                controller: wsUrlController,
                style: const TextStyle(fontSize: 13, color: Color(0xFF181818)),
                decoration: InputDecoration(
                  labelText: s.wsUrlLabel,
                  isDense: true,
                  contentPadding: const EdgeInsets.symmetric(
                    horizontal: 12,
                    vertical: 10,
                  ),
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(8),
                  ),
                ),
              ),
              const SizedBox(height: 10),
              // 6-Digit Pairing Code + Pair Button Row
              Row(
                children: [
                  Expanded(
                    child: TextField(
                      key: const Key('input-pairing-code'),
                      controller: pairingCodeController,
                      keyboardType: TextInputType.number,
                      style: const TextStyle(
                        fontSize: 15,
                        fontWeight: FontWeight.w700,
                        letterSpacing: 2,
                        color: Color(0xFF07C160),
                      ),
                      decoration: InputDecoration(
                        labelText: s.pairingCodeLabel,
                        isDense: true,
                        contentPadding: const EdgeInsets.symmetric(
                          horizontal: 12,
                          vertical: 10,
                        ),
                        border: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(8),
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  SizedBox(
                    height: 40,
                    child: OutlinedButton.icon(
                      key: const Key('btn-connect-pair'),
                      style: OutlinedButton.styleFrom(
                        foregroundColor: const Color(0xFF07C160),
                        side: const BorderSide(color: Color(0xFF07C160)),
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(8),
                        ),
                      ),
                      onPressed: () {
                        client.pairAndConnect(
                          wsUrl: wsUrlController.text,
                          pairingCode: pairingCodeController.text,
                        );
                      },
                      icon: const Icon(Icons.link, size: 16),
                      label: Text(
                        s.pairAndConnectBtn,
                        style: const TextStyle(fontWeight: FontWeight.w600),
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 10),
              // Secondary Action: Paste QR URI
              Row(
                children: [
                  Expanded(
                    child: TextField(
                      key: const Key('input-qr-uri'),
                      controller: qrUriController,
                      style: const TextStyle(fontSize: 12, color: Color(0xFF181818)),
                      decoration: InputDecoration(
                        hintText: s.qrUriLabel,
                        isDense: true,
                        contentPadding: const EdgeInsets.symmetric(
                          horizontal: 12,
                          vertical: 9,
                        ),
                        border: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(8),
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  SizedBox(
                    height: 36,
                    child: TextButton.icon(
                      key: const Key('btn-pair-qr-uri'),
                      style: TextButton.styleFrom(
                        foregroundColor: const Color(0xFF007AFF),
                        padding: const EdgeInsets.symmetric(horizontal: 8),
                      ),
                      onPressed: () {
                        client.pairWithQrUri(qrUriController.text);
                      },
                      icon: const Icon(Icons.content_paste_go, size: 15),
                      label: Text(s.pairWithQrBtn, style: const TextStyle(fontSize: 12)),
                    ),
                  ),
                ],
              ),
              if (client.errorMessage != null) ...[
                const SizedBox(height: 8),
                Text(
                  client.errorMessage!,
                  style: const TextStyle(color: Color(0xFFFA5151), fontSize: 12),
                ),
              ],
            ],
          ),
        ),
      ],
    );
  }
}
