# Android APK 签名与体积优化（发布到官网 / GitHub Release）

> 目标：官网直接发 APK 给用户下载，体积尽量小、签名可追溯、CI 全自动。
>
> 与 macOS 那套（`macos-dmg-release.md`）完全独立：Android 用自己的 keystore，不涉及 Apple 的 p12/p8。

---

## 1. 签名体系：三样东西

| 东西 | 用途 | 存放位置 |
| --- | --- | --- |
| `nienie-release.jks` | 签名密钥库（PKCS12） | `~/.nienie-signing/`（本地）/ GitHub Secret `ANDROID_KEYSTORE_BASE64` |
| storePassword / keyPassword | 解锁密钥库与密钥 | `~/.nienie-signing/keystore-password.txt` / Secrets |
| keyAlias | 密钥别名（`nienie`） | Secrets `ANDROID_KEY_ALIAS` |

生成命令（已执行，如密钥丢失需重建，但**重建会导致老用户无法覆盖安装**）：

```bash
keytool -genkeypair -v -keystore nienie-release.jks -storetype PKCS12 \
  -alias nienie -keyalg RSA -keysize 2048 -validity 10950 \
  -storepass "$PW" -keypass "$PW" \
  -dname "CN=Nienie, OU=Mobile, O=ponponon, L=Shenzhen, ST=Guangdong, C=CN"
```

证书指纹（SHA-256，用于核对线上包是否为同一把钥匙）：

```
62:4E:45:39:1E:B7:FD:B5:82:1B:37:BD:38:3B:48:C4:04:DC:C7:12:72:01:F7:A8:66:DA:05:D7:04:FD:A5:03
```

> **务必备份** `nienie-release.jks` + 密码。丢了就只能换包名重新发（相当于新 App）。

---

## 2. 体积优化（参考 audio_cut 的实践）

nieenie 首版 APK 曾达 **66.5 MB**（全 ABI + 未优化），优化后 **14.7 MB**，降幅 **78%**。

| 手段 | 位置 | 效果 |
| --- | --- | --- |
| `abiFilters` 只留 `arm64-v8a` | `apps/mobile/android/app/build.gradle.kts` | 砍掉 armeabi-v7a / x86_64 三份 Flutter 引擎，最大头 |
| `jniLibs.useLegacyPackaging = true` | 同上（`packagingOptions`） | `.so` 以压缩形式进 APK（仅影响独立 APK，不影响 AAB） |
| `--obfuscate` | `flutter build` 参数 | Dart 符号混淆 |
| `--split-debug-info=build/symbols` | 同上 | 符号表移出包体，崩溃时用它反混淆 |
| `--extra-gen-snapshot-options=--strip` | 同上 | 剥离 ELF 里的 DWARF 调试信息 |
| 图标字体 tree-shaking | Flutter 默认 | `MaterialIcons` 1.6 MB→1.7 KB，`lucide.ttf` 0.98 MB→19 KB |

代价：**只支持 64 位设备**（2016 年后的 Android 基本都是 arm64）。如果确实要照顾老设备，
可另出一条 `armeabi-v7a` 的包，但体积会翻倍。

---

## 3. 构建与验证

```bash
cd apps/mobile
flutter pub get
flutter build apk --release \
  --target-platform android-arm64 \
  --obfuscate \
  --split-debug-info=build/symbols \
  --extra-gen-snapshot-options=--strip

# 验签（确认不是 debug 签名）
"$HOME/Library/Android/sdk"/build-tools/*/apksigner verify --print-certs \
  build/app/outputs/flutter-apk/app-release.apk
```

`apps/mobile/android/app/build.gradle.kts` 里有一条硬性约束：**发布构建（`assembleRelease` /
`bundleRelease`）必须能找到 `key.properties`，否则直接 `GradleException` 失败**——不允许静默
产出 debug 签名的包。本地跑 `flutter run --release` 同理，需要先准备 `key.properties`：

```properties
storeFile=/absolute/path/to/nienie-release.jks
storePassword=...
keyAlias=nienie
keyPassword=...
```

（该文件已在 `.gitignore`，CI 由 Secrets 现场生成。）

---

## 4. CI 发布

`.github/workflows/release.yml` 的 `android-apk` job：

1. Java 17 + Flutter 3.47.9
2. `flutter pub get`
3. 解 `ANDROID_KEYSTORE_BASE64` → 写 `key.properties`
4. 构建 APK + AAB（带上面全部优化参数）
5. `apksigner` 验签，检测到 `Android Debug` 直接失败
6. 产物改名 `Nienie-v<version>-android.apk` / `.aab`，符号表一起作为 artifact 上传
7. tag 触发时挂到同一个 GitHub Release（和 macOS 的 DMG 并列）

手动只跑 Android 端、并挂到指定 Release：

```bash
gh workflow run "Release (macOS DMG + Android APK)" --repo ponponon/nienie \
  -f targets=android -f release_tag=v0.1.0
```

---

## 5. 与 Google Play 的关系

- 上架 Play 用 **AAB**（`flutter build appbundle`），不要传 APK 给 Play。
- Play 会启用 **Play App Signing**：你上传用的其实是「上传密钥」，最终对用户签名的密钥由 Google 托管。
  这套 keystore 正好可以当上传密钥用，不需要额外生成。
- 官网直发的 APK 必须由你自己的 keystore 签名——和 Play 版本并存时，两者签名不同会导致
  「同一包名不能互相覆盖安装」，需要用户卸载旧包。
