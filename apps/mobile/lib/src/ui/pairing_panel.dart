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

  static const Color _weTypeGreen = Color(0xFF17B378);
  static const Color _textPrimary = Color(0xFF1A1A1A);
  static const Color _textSecondary = Color(0xFF888888);
  static const Color _dividerColor = Color(0xFFF0F0F0);
  static const Color _btnBorderColor = Color(0xFFDCDCDC);

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
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
      children: [
        Padding(
          padding: const EdgeInsets.only(left: 4, bottom: 12),
          child: Text(
            s.connectTitle,
            style: const TextStyle(
              fontSize: 16,
              fontWeight: FontWeight.w600,
              color: _textPrimary,
            ),
          ),
        ),

        // Group 1: Saved Computers (WeType Grouped List Style)
        if (client.savedMachines.isNotEmpty)
          Container(
            margin: const EdgeInsets.only(bottom: 14),
            padding: const EdgeInsets.symmetric(horizontal: 18),
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(12),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                for (int i = 0; i < client.savedMachines.length; i++) ...[
                  if (i > 0) const Divider(height: 1, color: _dividerColor),
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 14),
                    child: Row(
                      children: [
                        Container(
                          width: 18,
                          height: 18,
                          decoration: const BoxDecoration(
                            color: _weTypeGreen,
                            shape: BoxShape.circle,
                          ),
                          alignment: Alignment.center,
                          child: Container(
                            width: 6,
                            height: 6,
                            decoration: const BoxDecoration(
                              color: Colors.white,
                              shape: BoxShape.circle,
                            ),
                          ),
                        ),
                        const SizedBox(width: 10),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                client.savedMachines[i].machineId,
                                style: const TextStyle(
                                  fontSize: 14,
                                  fontWeight: FontWeight.w500,
                                  color: _textPrimary,
                                ),
                              ),
                              const SizedBox(height: 2),
                              Text(
                                client.savedMachines[i].wsUrl,
                                style: const TextStyle(
                                  fontSize: 12,
                                  color: _textSecondary,
                                ),
                                overflow: TextOverflow.ellipsis,
                              ),
                            ],
                          ),
                        ),
                        SizedBox(
                          height: 28,
                          child: OutlinedButton(
                            key: Key(
                              'btn-reconnect-machine-${client.savedMachines[i].machineId}',
                            ),
                            style: OutlinedButton.styleFrom(
                              foregroundColor: _textPrimary,
                              side: const BorderSide(color: _btnBorderColor),
                              padding: const EdgeInsets.symmetric(horizontal: 12),
                              shape: RoundedRectangleBorder(
                                borderRadius: BorderRadius.circular(6),
                              ),
                            ),
                            onPressed: () => client.reconnectWithSavedCredential(
                              client.savedMachines[i].machineId,
                            ),
                            child: Text(
                              s.reconnectBtn,
                              style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w400),
                            ),
                          ),
                        ),
                        IconButton(
                          key: Key('btn-remove-machine-${client.savedMachines[i].machineId}'),
                          visualDensity: VisualDensity.compact,
                          tooltip: 'Remove Machine',
                          onPressed: () => client.removeSavedMachine(
                            client.savedMachines[i].machineId,
                          ),
                          icon: const Icon(
                            Icons.close,
                            size: 16,
                            color: _textSecondary,
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ],
            ),
          ),

        // Group 2: Primary Pairing Card (WeType Clean Grouped Rows)
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 18),
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(12),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              // Row 1: Camera QR Scan
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 16),
                child: Row(
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            s.scanQrBtn,
                            style: const TextStyle(
                              fontSize: 14,
                              fontWeight: FontWeight.w500,
                              color: _textPrimary,
                            ),
                          ),
                          const SizedBox(height: 3),
                          Text(
                            s.scanQrHint,
                            style: const TextStyle(
                              fontSize: 12,
                              color: _textSecondary,
                            ),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(width: 12),
                    SizedBox(
                      height: 34,
                      child: FilledButton.icon(
                        key: const Key('btn-open-qr-scanner'),
                        style: FilledButton.styleFrom(
                          backgroundColor: _weTypeGreen,
                          foregroundColor: Colors.white,
                          padding: const EdgeInsets.symmetric(horizontal: 14),
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(8),
                          ),
                        ),
                        onPressed: () => _openCameraScanner(context),
                        icon: const Icon(Icons.qr_code_scanner, size: 16),
                        label: const Text(
                          'QR',
                          style: TextStyle(fontSize: 12, fontWeight: FontWeight.w500),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
              const Divider(height: 1, color: _dividerColor),
              // Row 2: 6-Digit Pairing Code
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 14),
                child: Row(
                  children: [
                    Expanded(
                      child: TextField(
                        key: const Key('input-pairing-code'),
                        controller: widget.pairingCodeController,
                        keyboardType: TextInputType.number,
                        style: const TextStyle(
                          fontSize: 15,
                          fontWeight: FontWeight.w600,
                          letterSpacing: 1.5,
                          color: _textPrimary,
                        ),
                        decoration: InputDecoration(
                          hintText: s.pairingCodeLabel,
                          hintStyle: const TextStyle(
                            fontSize: 13,
                            fontWeight: FontWeight.w400,
                            letterSpacing: 0,
                            color: _textSecondary,
                          ),
                          isDense: true,
                          border: InputBorder.none,
                          contentPadding: const EdgeInsets.symmetric(vertical: 6),
                        ),
                      ),
                    ),
                    const SizedBox(width: 10),
                    SizedBox(
                      height: 30,
                      child: OutlinedButton(
                        key: const Key('btn-connect-pair'),
                        style: OutlinedButton.styleFrom(
                          foregroundColor: _textPrimary,
                          side: const BorderSide(color: _btnBorderColor),
                          padding: const EdgeInsets.symmetric(horizontal: 14),
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(6),
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
                          style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w400),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
              if (client.errorMessage != null)
                Padding(
                  padding: const EdgeInsets.only(bottom: 12),
                  child: Text(
                    client.errorMessage!,
                    style: const TextStyle(color: Color(0xFFFF3B30), fontSize: 12),
                  ),
                ),
            ],
          ),
        ),

        // Progressive Disclosure: Advanced Options
        const SizedBox(height: 8),
        Center(
          child: TextButton.icon(
            key: const Key('btn-toggle-advanced'),
            onPressed: () => setState(() => _showAdvanced = !_showAdvanced),
            icon: Icon(
              _showAdvanced ? Icons.expand_less : Icons.expand_more,
              size: 16,
              color: _textSecondary,
            ),
            label: Text(
              s.advancedOptionsLabel,
              style: const TextStyle(fontSize: 12, color: _textSecondary),
            ),
          ),
        ),
        if (_showAdvanced)
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 6),
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(12),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                TextField(
                  key: const Key('input-ws-url'),
                  controller: widget.wsUrlController,
                  style: const TextStyle(fontSize: 13, color: _textPrimary),
                  decoration: InputDecoration(
                    labelText: s.wsUrlLabel,
                    labelStyle: const TextStyle(fontSize: 12, color: _textSecondary),
                    border: InputBorder.none,
                    isDense: true,
                  ),
                ),
                const Divider(height: 1, color: _dividerColor),
                Row(
                  children: [
                    Expanded(
                      child: TextField(
                        key: const Key('input-qr-uri'),
                        controller: widget.qrUriController,
                        style: const TextStyle(fontSize: 12, color: _textPrimary),
                        decoration: InputDecoration(
                          hintText: s.qrUriLabel,
                          hintStyle: const TextStyle(fontSize: 12, color: _textSecondary),
                          border: InputBorder.none,
                          isDense: true,
                        ),
                      ),
                    ),
                    SizedBox(
                      height: 28,
                      child: OutlinedButton(
                        key: const Key('btn-pair-qr-uri'),
                        style: OutlinedButton.styleFrom(
                          foregroundColor: _textPrimary,
                          side: const BorderSide(color: _btnBorderColor),
                          padding: const EdgeInsets.symmetric(horizontal: 12),
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(6),
                          ),
                        ),
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
