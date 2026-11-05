import 'package:flutter/material.dart';
import '../models/protocol_models.dart';
import '../state/mobile_bridge_client.dart';
import 'qr_scanner_sheet.dart';

class PairingPanel extends StatefulWidget {
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

  @override
  State<PairingPanel> createState() => _PairingPanelState();
}

class _PairingPanelState extends State<PairingPanel> {
  bool _showAdvanced = false;

  void _openCameraScanner(BuildContext context) {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (sheetCtx) => QrScannerSheet(
        client: widget.client,
        onDetected: (rawUri) {
          widget.qrUriController.text = rawUri;
          try {
            final decoded = PairingQrPayload.decode(rawUri);
            widget.wsUrlController.text = decoded.wsUrl;
            widget.pairingCodeController.text = decoded.pairingCode;
          } catch (_) {}
          widget.client.pairWithQrUri(rawUri);
        },
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final client = widget.client;
    final s = client.strings;
    return ListView(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
      children: [
        // 1. Saved Computers (Top priority when present)
        if (client.savedMachines.isNotEmpty)
          Container(
            margin: const EdgeInsets.only(bottom: 12),
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
            decoration: BoxDecoration(
              color: const Color(0xFFFFFFFF),
              borderRadius: BorderRadius.circular(14),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  s.savedComputersTitle,
                  style: const TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                    color: Color(0xFF6E6E73),
                  ),
                ),
                const SizedBox(height: 8),
                for (final machine in client.savedMachines)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 4),
                    child: Row(
                      children: [
                        const Icon(Icons.laptop_mac, size: 18, color: Color(0xFF07C160)),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Row(
                            children: [
                              Text(
                                machine.machineId,
                                style: const TextStyle(
                                  fontSize: 13,
                                  fontWeight: FontWeight.w600,
                                  color: Color(0xFF1D1D1F),
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
                          height: 32,
                          child: FilledButton.tonal(
                            key: Key('btn-reconnect-machine-${machine.machineId}'),
                            style: FilledButton.styleFrom(
                              backgroundColor: const Color(0xFF07C160).withValues(alpha: 0.12),
                              foregroundColor: const Color(0xFF07C160),
                              padding: const EdgeInsets.symmetric(horizontal: 12),
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
                            size: 17,
                            color: Color(0xFF8E8E93),
                          ),
                        ),
                      ],
                    ),
                  ),
              ],
            ),
          ),

        // 2. Clean Apple/WeChat Style Hero Card: Scan QR + 6-Digit Code Only
        Container(
          padding: const EdgeInsets.all(20),
          decoration: BoxDecoration(
            color: const Color(0xFFFFFFFF),
            borderRadius: BorderRadius.circular(14),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                s.connectTitle,
                textAlign: TextAlign.center,
                style: const TextStyle(
                  fontSize: 17,
                  fontWeight: FontWeight.w600,
                  color: Color(0xFF1D1D1F),
                ),
              ),
              const SizedBox(height: 16),
              // Primary Action: Big WeChat Green Camera Scan Button
              SizedBox(
                height: 46,
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
              const SizedBox(height: 14),
              // Secondary Simple Action: 6-Digit Code + Connect
              Row(
                children: [
                  Expanded(
                    child: TextField(
                      key: const Key('input-pairing-code'),
                      controller: widget.pairingCodeController,
                      keyboardType: TextInputType.number,
                      style: const TextStyle(
                        fontSize: 16,
                        fontWeight: FontWeight.w700,
                        letterSpacing: 2,
                        color: Color(0xFF1D1D1F),
                      ),
                      decoration: InputDecoration(
                        hintText: s.pairingCodeLabel,
                        hintStyle: const TextStyle(
                          fontSize: 13,
                          fontWeight: FontWeight.w400,
                          letterSpacing: 0,
                          color: Color(0xFF8E8E93),
                        ),
                        filled: true,
                        fillColor: const Color(0xFFF7F7FA),
                        isDense: true,
                        contentPadding: const EdgeInsets.symmetric(
                          horizontal: 14,
                          vertical: 11,
                        ),
                        border: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(10),
                          borderSide: BorderSide.none,
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  SizedBox(
                    height: 42,
                    child: OutlinedButton(
                      key: const Key('btn-connect-pair'),
                      style: OutlinedButton.styleFrom(
                        foregroundColor: const Color(0xFF07C160),
                        side: const BorderSide(color: Color(0xFF07C160)),
                        padding: const EdgeInsets.symmetric(horizontal: 14),
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(10),
                        ),
                      ),
                      onPressed: () {
                        client.pairAndConnect(
                          wsUrl: widget.wsUrlController.text,
                          pairingCode: widget.pairingCodeController.text,
                        );
                      },
                      child: Text(
                        s.pairAndConnectBtn,
                        style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13),
                      ),
                    ),
                  ),
                ],
              ),
              if (client.errorMessage != null) ...[
                const SizedBox(height: 10),
                Text(
                  client.errorMessage!,
                  textAlign: TextAlign.center,
                  style: const TextStyle(color: Color(0xFFFF3B30), fontSize: 12),
                ),
              ],
            ],
          ),
        ),

        // 3. Progressive Disclosure: Advanced Options tucked cleanly at the bottom
        const SizedBox(height: 8),
        Center(
          child: TextButton.icon(
            key: const Key('btn-toggle-advanced'),
            onPressed: () => setState(() => _showAdvanced = !_showAdvanced),
            icon: Icon(
              _showAdvanced ? Icons.expand_less : Icons.expand_more,
              size: 16,
              color: const Color(0xFF8E8E93),
            ),
            label: Text(
              s.advancedOptionsLabel,
              style: const TextStyle(fontSize: 12, color: Color(0xFF8E8E93)),
            ),
          ),
        ),
        if (_showAdvanced)
          Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              color: const Color(0xFFFFFFFF),
              borderRadius: BorderRadius.circular(14),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                TextField(
                  key: const Key('input-ws-url'),
                  controller: widget.wsUrlController,
                  style: const TextStyle(fontSize: 12, color: Color(0xFF1D1D1F)),
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
                Row(
                  children: [
                    Expanded(
                      child: TextField(
                        key: const Key('input-qr-uri'),
                        controller: widget.qrUriController,
                        style: const TextStyle(fontSize: 12, color: Color(0xFF1D1D1F)),
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
                      child: TextButton(
                        key: const Key('btn-pair-qr-uri'),
                        onPressed: () {
                          client.pairWithQrUri(widget.qrUriController.text);
                        },
                        child: Text(s.pairWithQrBtn, style: const TextStyle(fontSize: 12)),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
      ],
    );
  }
}
