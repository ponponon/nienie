import 'package:file_picker/file_picker.dart';
import 'package:flutter/foundation.dart';

/// 附件选择网关：包装系统文件选择器，测试可注入结果（F1 附件竞态测试）。
class AttachmentPicker {
  /// 测试注入：设置后跳过系统文件选择器。
  @visibleForTesting
  static List<({String name, String path})>? debugOverrideFiles;

  static Future<List<({String name, String path})>> pick({required FileType type}) async {
    final override = debugOverrideFiles;
    if (override != null) {
      debugOverrideFiles = null;
      return override;
    }
    // file_picker 13.x：pickFiles 直接返回 List<PlatformFile>（默认支持多选，无 allowMultiple 参数）
    try {
      final files = await FilePicker.pickFiles(type: type);
      return [
        for (final f in files)
          if (f.path != null) (name: f.name, path: f.path!),
      ];
    } catch (_) {
      // 平台实现缺失（widget 测试环境）或系统选择器异常一律视作“用户取消”，
      // 不让 UI 因选择器故障崩溃。
      return [];
    }
  }
}
