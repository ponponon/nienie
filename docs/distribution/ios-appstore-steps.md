# iOS App Store 上架 —— 逐步执行手册（one by one）

> 适用：`apps/mobile` Flutter iOS 端，首版**只发美国**（不勾中国大陆、不勾欧盟）。
> 配套背景与规则见 `ios-appstore-release.md`。本手册只写「照着做」的动作顺序。
> 时间标注是完成该步骤本身所需，总周期约 **5–7 个工作日 + 审核 24–48 小时**。
> 规则：**带 ⏳ 的是等待项，必须最先启动**，让它和干活并行。

---

## Phase 0 · 账号侧检查（0.5 天）⏳ 等待项优先

| # | 动作 | 怎么做 | 完成标志 |
| --- | --- | --- | --- |
| 0.1 | 确认会员有效 | App Store Connect → Business（商务）→ 看会员状态 | 无「过期/待处理」 |
| 0.2 | ⏳ 接受最新协议 | 同页若有「查看并接受条款」提示，必须由 **Account Holder 本人**点同意 | 横幅消失，Free Apps 显示 Active |
| 0.3 | 确认操作权限 | App Store Connect → 用户和访问 → 你自己的角色 | 至少 Admin 或 App Manager |
| 0.4 | 确认构建工具链 | 本机跑 `xcodebuild -version` | **Xcode ≥ 26**（2026-04-28 起强制 iOS 26 SDK）；Flutter 仍是 3.47.9 |
| 0.5 | 定稿 Bundle ID | 二选一：`cn.quniv.nienieMobile`（现 iOS）或改成下划线版与 Android 一致 | 记下来，后面所有步骤用同一个 |
| 0.6 | 定稿商店名 | 打开美区 App Store 搜一下候选名（≤30 字符，全商店唯一） | 无重名 |

---

## Phase 1 · 代码侧合规改动（1–2 天）

| # | 动作 | 改哪里 | 怎么做 |
| --- | --- | --- | --- |
| 1.1 | 补本地网络用途说明 | `apps/mobile/ios/Runner/Info.plist` | 加 `NSLocalNetworkUsageDescription`，文案写明「连接同网段电脑上的 Bridge 以配对和控制」 |
| 1.2 | 补 ATS 明文例外 | 同上 | 加 `NSAppTransportSecurity` → `NSAllowsLocalNetworking = YES`（`ws://127.0.0.1` 走这条），可照抄 `apps/desktop/dist-release/out/mac-arm64/Nienie.app/Contents/Info.plist` 的写法 |
| 1.3 | 声明加密用途 | 同上 | 加 `ITSAppUsesNonExemptEncryption`；先复核所有链接库只用系统 TLS/WSS 则填 `NO`，否则填 `YES` 并去 App Store Connect 申请 `ITSEncryptionExportComplianceCode` |
| 1.4 | 新建隐私清单 | 新增 `apps/mobile/ios/Runner/PrivacyInfo.xcprivacy` | 声明 UserDefaults、文件时间戳等 required reason API 的 approved reason |
| 1.5 | 核对 SDK 清单 | Xcode → Product → Generate Privacy Report | 逐个确认 `device_info_plus` / `file_picker` / `mobile_scanner` / `url_launcher` / `app_links` 的清单与签名齐全，缺的换库或让上游补 |
| 1.6 | 加 AI 数据外发同意弹窗 | `apps/mobile/lib/src/ui/` 新增弹窗，接入首次外发前 | 说明「发送什么 / 发给谁 / 用途 / 留存 / 如何撤回」，用户主动确认才放行；不能默认勾选 |
| 1.7 | 改版本号 | `apps/mobile/pubspec.yaml` | `version: 1.0.0+1` |
| 1.8 | 首版只投 iPhone | `ios/Runner.xcodeproj/project.pbxproj` | `TARGETED_DEVICE_FAMILY` 由 `"1,2"` 改成 `"1"`（省掉 iPad 截图与 iPad 审核） |
| 1.9 | 凭据不再明文落盘 | `lib/main.dart`、`lib/src/storage/credential_store.dart` | 从 `Directory.systemTemp` 改到应用支持目录，并加 `NSFileProtection` / Keychain 保护 `deviceToken` |
| 1.10 | 真机自测一遍 | iPhone 真机 | 冷启动、扫码配对、发消息收回复、断网、权限弹窗、杀进程重启后凭据仍在 |

---

## Phase 2 · 签名（0.5 天）

| # | 动作 | 怎么做 | 完成标志 |
| --- | --- | --- | --- |
| 2.1 | 配自动签名 | 打开 `apps/mobile/ios/Runner.xcworkspace`（注意不是 .xcodeproj）→ Runner target → Signing & Capabilities → 勾 `Automatically manage signing` → Team 选你的团队 | 红色报错消失 |
| 2.2 | 真机跑通 Release | Xcode 选真机设备 → Product → Run（Scheme 用 Runner/Release） | 装到手机上能用 |
| 2.3 | Archive 并 Validate | Product → Archive → Organizer 里选 archive → **Validate App** → App Store Connect → 选自动签名 | 校验通过、无 warning |
| 2.4 | （可选）把 Team ID 走本地注入 | CI 用 `ios/Flutter/Local.xcconfig`（已在 .gitignore）或 `--export-options-plist` | 不要把 Team ID 提交进 pbxproj |

---

## Phase 3 · 商店素材（1–2 天，可与 Phase 1 并行）

| # | 动作 | 产出 |
| --- | --- | --- |
| 3.1 | 写英文文案 | 名称、副标题（各 ≤30）、描述、关键词（≤100 字符） |
| 3.2 | 做 6.9″ iPhone 截图 3–5 张 | 真实界面，非营销合成图；首屏讲清「手机遥控电脑上的 AI 助手」 |
| 3.3 | 🔴 建隐私政策页 | `website/` 新增可公开访问的 HTTPS 页面；内容可改写 `apps/desktop/src/i18n.ts` 的 `privacyContent`，但必须点名：收集哪些数据、发给哪些 AI 提供商、留存与删除、如何联系 |
| 3.4 | 🔴 建支持页 | `website/` 新增 Support/Contact 页（邮箱或表单） |
| 3.5 | 官网页脚加链接 | `website/index.html` 页脚挂上 Privacy / Support，并预留 App Store 下载按钮位 |
| 3.6 | 拍演示录屏 | 真机录 30–60 秒：打开 → 扫码配对 → 发指令 → Agent 回复 → 断开重连 |

---

## Phase 4 · App Store Connect 建记录（0.5 天）

| # | 动作 | 路径 |
| --- | --- | --- |
| 4.1 | 注册 Bundle ID | developer.apple.com → Certificates, Identifiers & Profiles → Identifiers → `+` → App IDs → App → 填 Phase 0.5 定稿的 ID |
| 4.2 | 新建 App 记录 | App Store Connect → 我的 App → `+` → 新建 App → 平台勾 iOS → 名称 / 主要语言 `English (U.S.)` / Bundle ID / SKU（随便一个内部代号） |
| 4.3 | 🔴 锁定地区 | **价格与销售范围** → 设价格 Free → 「App 供应情况」→ 设置销售范围 → 选**特定国家或地区** → 勾 `United States`（按需加）→ **取消勾选「中国大陆」，欧盟一个都别勾** → 确认 |
| 4.4 | 填 App 信息 | 类别、副标题、Support URL、Privacy Policy URL（Phase 3.3/3.4 的链接）、年龄分级问卷（新题型，含 13+/16+/18+） |
| 4.5 | 填 App Privacy | 逐项申报：设备标识（`device_info_plus`）、相机（扫码）、本地网络、用户选择的文件、**发送给 AI 服务的对话与内容**、是否与第三方共享 → 填「否追踪」 |
| 4.6 | 填版本元数据 | 版本页：描述/关键词/截图（Phase 3.1/3.2）、What's New |

---

## Phase 5 · 构建上传（0.5 天）

| # | 动作 | 命令 / 操作 |
| --- | --- | --- |
| 5.1 | 构建 ipa | `cd apps/mobile && flutter build ipa --release --build-name 1.0.0 --build-number 1` |
| 5.2 | 上传 | 三选一：Xcode Organizer → Distribute App → App Store Connect；或 Transporter 拖 `build/ios/ipa/*.ipa`；或 `xcrun altool --upload-app --type ios -f build/ios/ipa/*.ipa --apiKey <KEY_ID> --apiIssuer <ISSUER_ID>` |
| 5.3 | 等处理 | 15–30 分钟，收邮件；App Store Connect → TestFlight 里能看到 build |
| 5.4 | TestFlight 真机验一遍 | 装到真机，重点测配对、断网、权限弹窗、冷启动 —— 审核员测的就是这些 |

---

## Phase 6 · 提交审核（0.5 天 + 等待 24–48h）

| # | 动作 | 说明 |
| --- | --- | --- |
| 6.1 | 挂 build | 版本页 → 构建版本 → 选 5.3 处理完的那个 |
| 6.2 | 答出口合规问卷 | 与 1.3 的判断保持一致；若设了 `ITSAppUsesNonExemptEncryption` 可直接跳过追问 |
| 6.3 | 答内容版权 | 有第三方受保护内容才需要证明；如实选 |
| 6.4 | 🔴 填 App 审核信息 | 联系人（电话+邮箱，审核期间能接通）；**备注栏写清**：演示二维码/配对码、外部服务清单（自建 Relay `wss://nienie-replay.quniv.cn` + 桌面 Bridge + AI 提供商）、为什么需要相机与本地网络、地区差异、测试机型与 iOS 版本 |
| 6.5 | 附演示材料 | 上传二维码图片 + Phase 3.6 的录屏 |
| 6.6 | 选发布方式 | **Manual**（审核通过后由你手动放榜） |
| 6.7 | 点 Submit for Review | 盯邮箱和 Resolution Center，24–48 小时；被拒就照引的条款改，别只加说明重传 |

---

## Phase 7 · 上线后（0.5 天）

| # | 动作 |
| --- | --- |
| 7.1 | 通过后手动发布；等状态变 `Ready for Distribution` |
| 7.2 | 自己从**美区 App Store** 下载安装，全流程走一遍（生产环境和开发构建行为可能不同） |
| 7.3 | 官网 `website/index.html` 下载区加 App Store 入口，发 release notes |
| 7.4 | 记录本次 build number，下一个版本从 `1.0.1+2` 起 |

---

## 常见卡点速查

| 症状 | 多半是 | 看哪一步 |
| --- | --- | --- |
| 上传时报 ITMS-91053/91061/91065 | 隐私清单或 SDK 签名缺失 | 1.4 / 1.5 |
| 上传报加密问卷反复追问 | Info.plist 没写 `ITSAppUsesNonExemptEncryption` | 1.3 |
| 提交按钮点不动 | 协议没接受 / 地区或价格没设 / 截图尺寸不对 | 0.2 / 4.3 / 3.2 |
| 拒审 2.1「无法测试」 | 审核员打不开 App，配对卡住 | 6.4 / 6.5 |
| 拒审 5.1.2「数据未披露」 | AI 数据外发没有同意弹窗，或隐私政策没点名接收方 | 1.6 / 3.3 |
| 找不到 build | 上传后还没处理完，或 build number 与历史重复 | 5.3 / 1.7 |
