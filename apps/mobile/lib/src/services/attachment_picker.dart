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
    final result = await FilePicker.pickFiles(type: type, allowMultiple: true);
    if (result == null) return [];
    return [
      for (final f in result.files)
        if (f.path != null) (name: f.name, path: f.path!),
    ];
  }
}
