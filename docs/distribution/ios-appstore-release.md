# iOS App Store 上架准备与发布清单

> 适用范围：`apps/mobile` 的 Flutter iOS 端（`ios/Runner.xcworkspace`）。
> Mac 端是独立的 Electron + DMG 链路，见 `macos-dmg-release.md`，不在本文范围内。
> 首版地区策略：**只发美国等海外地区，排除中国大陆和欧盟**。

---

## 0. 前提结论

- **开发者账号已有**：项目里的 macOS 公证链路已经使用 App Store Connect API Key（Team ID 等凭据见 `macos-dmg-release.md` §7），说明已是付费 Apple Developer Program 会员（99 USD/年）。不用重新注册，不用等 D-U-N-S 验证，这是最耗时的一步，已经省掉了。
- **但证书不能复用**：`Developer ID Application` 是给 macOS 官网分发做签名/公证的，**不能签 iOS App Store 包**。iOS 需要 `Apple Distribution` 证书 + App Store 类型的 provisioning profile。用 Xcode 自动签名可自动生成，不用手工折腾。
- **一个包覆盖所有地区**：地区只是 App Store Connect「价格与销售范围」里的一组勾选，不需要为每个地区单独打包、单独建 App 记录、单独审核。
- **免费 App 无需税务/银行**：首版无 IAP、无付费下载 → 不需要签 Paid Apps Agreement、不用填 W-9/银行账号。但仍需 Account Holder 接受最新的 Developer Program 协议，否则提交会卡住。

---

## 1. 2026 年的硬门槛（不满足会直接被上传拦截）

| 要求 | 生效日期 | 本项目状态 |
| --- | --- | --- |
| 必须用 **Xcode 26 + iOS 26 SDK** 构建上传 | 2026-04-28 | 需确认构建机 Xcode 版本；现有 CI 是 `ubuntu-latest`，iOS job 必须跑 `macos` runner |
| 最低 deployment target ≥ iOS 13 | 2026-09-09 | `IPHONEOS_DEPLOYMENT_TARGET = 15.0`，通过 |
| 新版年龄分级问卷（含 13+/16+/18+） | 2026-01-31 | 新 App 必答，见 App Information |
| `PrivacyInfo.xcprivacy` + required reason API 声明 | 2024-05-01 | **缺失**，且需逐个确认 SDK 自带清单与签名 |
| 第三方 AI 数据共享需披露 + 明确同意（Guideline 5.1.2(i)） | 2025-11-13 | **缺失**，见 §4.2 |
| EU DSA trader status | 2025-02-17 | 首版不勾欧盟 → 不适用；将来扩 EU 再补 |

---

## 2. 地区设置：只发美国、不发中国大陆

App Store Connect → **我的 App** → 选中 App → 侧栏 **价格与销售范围** → 先设定价格（选择 Free）→ 下滑到 **App 供应情况** → **设置销售范围 / 管理** → 选择 **「特定国家或地区」** → 勾选 `United States`（按需追加 Canada / United Kingdom / Japan / 新加坡等）→ **确认取消勾选 `中国大陆`，也不要勾任何欧盟国家** → 下一步 → 确认。

要点：

- 默认值是「所有国家或地区」（175 个），**其中含中国大陆**。中国大陆 storefront 需要有效的 **ICP 备案号**（Apple 官方 App 信息页明确要求），不勾就完全绕开这项资质，也不受 PIPL 本地化审查约束。
- 不勾欧盟 → 不需要 DSA trader 验证。韩国/越南的分级号主要针对游戏，本项目非游戏。
- 用户能看到哪个区的 App Store 由 **Apple 账户的国家/地区设置** 决定，与 IP、系统语言无关。
- 必须在**提交审核之前**设置好。之后随时可增减地区，改动即时生效（最多 24h 同步）；从某地区下架后，已下载用户仍能继续收到更新。
- 主要语言建议 `English (U.S.)`，名称/副标题/描述/关键词/审核备注至少备一份英文。

---

## 3. 需要准备的材料

### A. 账号与协议（已完成）
付费会员有效、2FA 开启、Account Holder 已接受最新协议、操作者具备 Admin / App Manager 权限。

### B. 商店展示素材
| 材料 | 要求 | 现状 |
| --- | --- | --- |
| App 名称 / 副标题 | ≤30 字符，全商店唯一；**先去美区 App Store 搜一下有没有重名** | 待定（`CFBundleDisplayName` 现为 `Nienie Mobile`） |
| 描述、关键词 | 关键词 ≤100 字符，描述不被索引 | 待写（英文） |
| **Support URL** | 必填，公开可访问 | **缺失**，需在 `website/` 新建支持页 |
| **Privacy Policy URL** | 必填，公开 HTTPS，且 App 内也要能找到 | **缺失**，桌面端 `apps/desktop/src/i18n.ts` 的 `privacyContent` 只是弹窗文案，不是 URL |
| App 图标 | 1024×1024、PNG、无 alpha、无预置圆角 | 已有全套 19 张，`AppIcon.appiconset` 合格 |
| iPhone 截图 | 6.9″ 必需（或 6.5″），其余尺寸自动缩放 | 待制作 |
| iPad 截图 | **支持 iPad 就必须提供** | 见 §4.7：建议首版改成只支持 iPhone |
| App Preview 视频 | 可选 | 建议做一段配对+使用的短录屏，兼作审核演示 |

### C. 合规与审核信息
- **App Privacy 营养标签**：如实申报设备名/设备标识（`device_info_plus`）、相机（扫码配对）、本地网络、用户选择的文件、以及发送给 AI/Agent 的对话与附件内容；包括第三方 SDK 的行为。
- **App 审核信息**：联系人姓名/电话/邮箱、演示账号或配对凭据、Review Notes、附件（演示视频、二维码）。
- **年龄分级问卷**、内容版权声明、**出口合规问卷**（见 §4.4）。
- 无账号体系 → 不需要「App 内账号删除」入口；无 IAP → 不需要商品配置。

---

## 4. 本项目上架前必须改的东西（按风险排序）

### 4.1 审核员打不开 App —— 最高拒审风险
这个 App 必须扫码配对一台运行 Bridge 的桌面端才能工作。审核员只有一部 iPhone，若打开后卡在配对页，会按 **Guideline 2.1（无法完整测试）/ 4.2（最低功能）** 直接拒。必须准备：

1. 一台**审核期间常开**的桌面 Bridge，连到公网 Relay `wss://nienie-replay.quniv.cn`；
2. 生成**固定有效**的配对二维码/6 位配对码，写进 Review Notes（附二维码图片 + 文字版凭据）；
3. 录一段**真机屏幕录制**（非动画演示），展示配对 → 发消息 → Agent 回复 → 断开重连；
4. Review Notes 里逐条写清：外部服务清单（自建 Relay / 桌面 Bridge / AI 提供商）、为什么需要相机和本地网络、地区差异、测试设备与 iOS 版本；
5. 保证 Relay 与 AI 后端在整个审核窗口内可用，且 demo 环境里有真实可演示的内容。

### 4.2 第三方 AI 数据共享的明确同意（Guideline 5.1.2(i)）
2025-11 起规则明确：把用户个人数据（prompt、对话、文件、截图、设备标识等）分享给第三方 AI 之前，必须**在 App 内清楚披露接收方并取得明确许可**，仅靠隐私政策链接不够。需要：
- 首次发生数据外发前，弹窗说明「发送什么 / 发给谁（点名模型或服务商）/ 用途 / 留存 / 如何撤回」，需用户主动确认，不能默认勾选；
- 隐私政策 URL 里同步写明接收方、数据类型、留存与删除；
- App Privacy 问卷的申报必须与真实网络行为一致（审核会用抓包比对）。

### 4.3 隐私清单与 SDK
新建 `ios/Runner/PrivacyInfo.xcprivacy`，声明 `NSPrivacyAccessedAPICategoryUserDefaults`、文件时间戳/磁盘空间等 required reason API 的 approved reason；逐个确认 `device_info_plus`、`file_picker`、`mobile_scanner`、`url_launcher`、`app_links` 等 SDK 自带隐私清单与签名（缺失会报 ITMS-91053 / 91061 / 91065）。

### 4.4 `ios/Runner/Info.plist` 补齐
- `NSLocalNetworkUsageDescription`：连局域网 `ws://127.0.0.1:4100` 必需；
- `NSAppTransportSecurity`：`NSAllowsLocalNetworking` + 明文 `ws://` 例外（可直接参照 `apps/desktop/dist-release/out/mac-arm64/Nienie.app/Contents/Info.plist` 里已配好的那份）；
- `ITSAppUsesNonExemptEncryption`：**不写这个键，每次上传都会被追问出口合规问卷**。判断依据：若 iOS 二进制（含所链接 SDK）只用系统内置 TLS/WSS 加密 → 设 `NO`；若链接了自有/专有加密实现 → 设 `YES` 并走 App Store Connect 文档审核拿 `ITSEncryptionExportComplianceCode`。本项目 AES-256-GCM 在 Node/TS 侧（`@nienie/protocol`），Dart 侧走明文 JSON 信封，**初判可设 NO，但上传前需复核所有链接库**。

### 4.5 签名配置
`ios/Runner.xcodeproj/project.pbxproj` 里 `DEVELOPMENT_TEAM` / `CODE_SIGN_STYLE` 被主动清理过（见 `FailureExperience.md` §2026-11-04，为避免个人 Team ID 进公开仓库）。上架时需要：
- 在 Xcode 打开 `Runner.xcworkspace` → Runner target → **Signing & Capabilities** → 勾 `Automatically manage signing` + 选 Team；
- 或用**本地不提交**的 xcconfig / `--export-options-plist` 注入 Team ID 做手动签名（CI 推荐）。

### 4.6 Bundle ID / 版本号
- iOS 是 `cn.quniv.nienieMobile`，Android 是 `cn.quniv.nienie_mobile`，**先定稿**；App Store Connect 注册的 Bundle ID 必须与 pbxproj **完全一致**。
- `pubspec.yaml` 的 `0.1.0+1` 改成 `1.0.0+1`；每次上传 build number 必须递增，重复会被拒收。

### 4.7 建议首版只投 iPhone
`TARGETED_DEVICE_FAMILY = "1,2"` 表示同时支持 iPad，**就必须提供 iPad 截图并通过 iPad 上的审核**。首版建议改成 `1`（仅 iPhone），省掉 iPad 适配与截图；等 UI 适配好了再加回来。

### 4.8 其他
- 凭据明文写在系统临时目录的 `nienie_mobile_state.json`（`lib/main.dart`、`lib/src/storage/credential_store.dart`）→ 改到应用支持目录 + Keychain / `NSFileProtection`，`deviceToken` 不该明文落盘。
- iOS 端**未接 APNs**（无 entitlement、无 token 上报），首版不要在商店文案里宣称推送；现有 Bark/ntfy 属用户自备通道，在 Review Notes 里说明即可。
- 官网 `website/index.html` 页脚需要补 Privacy / Support 链接和 App Store 下载入口。

---

## 5. 构建与上传

```bash
cd apps/mobile
flutter pub get
flutter build ipa --release --build-name 1.0.0 --build-number 1
```

产物：`build/ios/archive/Runner.xcarchive`、`build/ios/ipa/*.ipa`。

上传三选一：
- Xcode 打开 `.xcarchive` → **Validate App** → **Distribute App** → App Store Connect；
- **Transporter**（Mac App Store 免费）拖入 `.ipa`；
- `xcrun altool --upload-app --type ios -f build/ios/ipa/*.ipa --apiKey <KEY_ID> --apiIssuer <ISSUER_ID>`（用现有 `.p8`，密钥放 `~/.appstoreconnect/private_keys/`）。

处理约 15–30 分钟 → 在 **TestFlight** 真机验证冷启动、配对、断网、权限弹窗 → 在版本页挂上该 build → 填完所有问卷 → **Submit for Review**（建议选手动发布 Manual）。审核通常 24–48h，重大节假日前会变慢。

后续可补：`ios/ExportOptions.plist`（`method = app-store-connect`）、`release.yml` 里的 macOS runner iOS job、`docs/distribution/` 本文档的自动化脚本。

---

## 6. 提交前最终勾检

- [ ] Xcode 26 + iOS 26 SDK 构建，deployment target ≥ 13
- [ ] Bundle ID 定稿、版本号/构建号正确、签名通过 Validate App
- [ ] `PrivacyInfo.xcprivacy` + SDK 清单/签名齐全
- [ ] Info.plist 五个键齐全（本地网络、ATS、加密声明等）
- [ ] AI 数据外发同意弹窗 + 隐私政策 URL + Support URL 全部公开可访问
- [ ] App Privacy 申报 = 真实网络行为；年龄分级问卷已答
- [ ] 价格 = Free；**销售范围只勾美国（及指定地区），中国大陆与欧盟未勾**
- [ ] 6.9″ iPhone 截图；首版已改为仅 iPhone 或已备 iPad 截图
- [ ] 演示 Bridge + Relay 常开，配对二维码、Review Notes、演示录屏齐备
- [ ] 商店文案不含未实现的功能（推送、端到端加密等）
- [ ] 版本发布方式 = Manual，审核通过后再手动放榜

---

## 7. 官方参考

- 即将生效的要求：https://developer.apple.com/news/upcoming-requirements/
- 管理 App 销售范围：https://developer.apple.com/cn/help/app-store-connect/manage-your-apps-availability/manage-availability-for-your-app-on-the-app-store/
- 计划注册（会员/年费）：https://developer.apple.com/cn/programs/enroll/
- 中国大陆 ICP 备案等要求：https://developer.apple.com/cn/help/app-store-connect/reference/app-information/
- 加密出口合规：https://developer.apple.com/cn/documentation/security/complying-with-encryption-export-regulations
- 审核前需提供的信息：https://developer.apple.com/cn/help/app-review/before-submitting-for-review/complete-review
- Flutter 官方 iOS 发布指南：https://flutter.dev/to/ios-app-signing
