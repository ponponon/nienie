import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import '../state/mobile_bridge_client.dart';

class QrScannerSheet extends StatefulWidget {
  final MobileBridgeClient client;
  final void Function(String qrUri) onDetected;

  const QrScannerSheet({
    super.key,
    required this.client,
    required this.onDetected,
  });

  @override
  State<QrScannerSheet> createState() => _QrScannerSheetState();
}

class _QrScannerSheetState extends State<QrScannerSheet> {
  final MobileScannerController _controller = MobileScannerController();
  bool _handled = false;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final s = widget.client.strings;
    return SafeArea(
      child: Container(
        height: 440,
        padding: const EdgeInsets.all(16),
        decoration: const BoxDecoration(
          color: Color(0xFFFFFFFF),
          borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                const Icon(Icons.qr_code_scanner, size: 18, color: Color(0xFF07C160)),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    s.scanQrBtn,
                    style: const TextStyle(
                      fontSize: 15,
                      fontWeight: FontWeight.w600,
                      color: Color(0xFF181818),
                    ),
                  ),
                ),
                IconButton(
                  visualDensity: VisualDensity.compact,
                  onPressed: () => Navigator.of(context).pop(),
                  icon: const Icon(Icons.close, size: 20),
                ),
              ],
            ),
            const SizedBox(height: 6),
            Text(
              s.scanQrHint,
              style: const TextStyle(fontSize: 12, color: Color(0xFF8E8E93)),
            ),
            const SizedBox(height: 12),
            Expanded(
              child: ClipRRect(
                borderRadius: BorderRadius.circular(12),
                child: MobileScanner(
                  controller: _controller,
                  onDetect: (capture) {
                    if (_handled) return;
                    for (final barcode in capture.barcodes) {
                      final raw = barcode.rawValue?.trim();
                      if (raw != null && raw.startsWith('nienie://')) {
                        _handled = true;
                        Navigator.of(context).pop();
                        widget.onDetected(raw);
                        break;
                      }
                    }
                  },
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
