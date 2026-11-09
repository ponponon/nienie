import 'dart:io';

import 'package:device_info_plus/device_info_plus.dart';

/// 设备身份：用于配对时上报给 Bridge 的「设备名」和「平台」。
class DeviceIdentity {
  final String name;
  final String platform;
  const DeviceIdentity({required this.name, required this.platform});
}

/// 解析本机设备身份。
/// - 设备名优先用手机型号（Android: brand + model；iOS: 用户设置的设备名），
///   让桌面端「已连接设备」列表有真实区分度，而非千篇一律的 "Nienie Flutter Mobile"。
/// - 平台按实际运行系统上报（修正此前 Android 也硬编码 "ios" 的问题）。
Future<DeviceIdentity> resolveDeviceIdentity() async {
  final platform = Platform.isIOS
      ? 'ios'
      : Platform.isAndroid
          ? 'android'
          : 'unknown';
  String name = Platform.isIOS
      ? 'iPhone'
      : Platform.isAndroid
          ? 'Android 设备'
          : 'Nienie 设备';

  try {
    final plugin = DeviceInfoPlugin();
    if (Platform.isAndroid) {
      final info = await plugin.androidInfo;
      final brand = info.brand.trim();
      final model = info.model.trim();
      final combined = <String>[brand, model]
          .where((s) => s.isNotEmpty && s.toLowerCase() != 'unknown')
          .join(' ')
          .trim();
      if (combined.isNotEmpty) name = combined;
    } else if (Platform.isIOS) {
      final info = await plugin.iosInfo;
      // name 是用户在 iOS 设置里起的设备名（如「小明的 iPhone」），最易识别
      final deviceName = info.name.trim();
      if (deviceName.isNotEmpty) name = deviceName;
    }
  } catch (_) {
    // 取设备信息失败时使用回退名
  }

  return DeviceIdentity(name: name, platform: platform);
}
