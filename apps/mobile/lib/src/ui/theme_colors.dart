import 'package:flutter/material.dart';

/// 7.2：深色模式亮度映射——系统暗色下关键容器/文字不刺眼（浅色值=既有设计 token）。
bool isDark(BuildContext context) => Theme.of(context).brightness == Brightness.dark;

/// 页面背景
Color appBgColor(BuildContext context) =>
    isDark(context) ? const Color(0xFF121212) : Colors.white;

/// 卡片/容器底
Color cardBgColor(BuildContext context) =>
    isDark(context) ? const Color(0xFF1C1C1E) : const Color(0xFFF7F8FA);

/// 胶囊/输入区底
Color chipBgColor(BuildContext context) =>
    isDark(context) ? const Color(0xFF2C2C2E) : const Color(0xFFF3F4F6);

/// 主文字
Color primaryTextColor(BuildContext context) =>
    isDark(context) ? const Color(0xFFE5E5EA) : const Color(0xFF141416);

/// 次级文字
Color secondaryTextColor(BuildContext context) =>
    isDark(context) ? const Color(0xFF989BA3) : const Color(0xFF686C75);

/// 弱化文字（暗色提亮至 ≥4.5:1 对比）
Color mutedTextColor(BuildContext context) =>
    isDark(context) ? const Color(0xFF8A8F98) : const Color(0xFF989CA5);

/// 警示文字（暗色底上专用亮橙，≥4.5:1）
Color warnTextColor(BuildContext context) =>
    isDark(context) ? const Color(0xFFF8C47C) : const Color(0xFFB45309);

/// 选中态浅底（会话行/Agent 胶囊）
Color selectedBgColor(BuildContext context) =>
    isDark(context) ? const Color(0xFF2C2C2E) : const Color(0xFFF2F4F7);

/// 输入框底
Color inputBgColor(BuildContext context) =>
    isDark(context) ? const Color(0xFF2C2C2E) : const Color(0xFFF6F7F9);

/// 非激活图标
Color inactiveIconColor(BuildContext context) =>
    isDark(context) ? const Color(0xFF989BA3) : const Color(0xFF52555D);

/// 描边
Color subtleBorderColor(BuildContext context) =>
    isDark(context) ? const Color(0x22FFFFFF) : const Color(0x12000000);

/// 用户气泡底
Color userBubbleBgColor(BuildContext context) =>
    isDark(context) ? const Color(0xFF2C2C2E) : const Color(0xFFF3F4F6);

/// 附件胶囊底（浅色为白 70% 透明）
Color attachChipBgColor(BuildContext context) =>
    isDark(context)
        ? const Color(0xFF3A3A3C).withValues(alpha: 0.8)
        : Colors.white.withValues(alpha: 0.7);

/// 提示/警告类卡片底（保留语义色相，暗色降亮度）
Color warnBgColor(BuildContext context) =>
    isDark(context) ? const Color(0xFF3A2E14) : const Color(0xFFFFF7ED);

Color dangerBgColor(BuildContext context) =>
    isDark(context) ? const Color(0xFF3A1717) : const Color(0xFFFEF2F2);

Color infoBgColor(BuildContext context) =>
    isDark(context) ? const Color(0xFF16283F) : const Color(0xFFEFF6FF);

Color cautionBgColor(BuildContext context) =>
    isDark(context) ? const Color(0xFF3A331A) : const Color(0xFFFFFDF7);

/// 面板/抽屉浅灰底
Color panelBgColor(BuildContext context) =>
    isDark(context) ? const Color(0xFF1C1C1E) : const Color(0xFFF5F6F8);
