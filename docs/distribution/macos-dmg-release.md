# macOS DMG 打包、签名、公证与 GitHub Actions 自动化指南

> 目标：把 `apps/desktop` 的 Electron 桌面端打成 `.dmg` 安装包，用 Apple Developer 账号完成
> **签名（Code Signing）+ 公证（Notarization）**，让下载用户双击安装不弹
> 「无法验证开发者 / 已损坏」；且全流程在 GitHub Actions 里自动完成。
>
> 一次性配置好之后，以后发版只需要 `git tag v0.x.y && git push --tags`。

---

## 0. 一图看懂全流程

```
┌─ Apple 开发者网站（一次性，网页操作）────────────────┐
│  ① 钥匙串生成 CSR（本机操作）                          │
│  ② 创建 Developer ID Application 证书 → 下载 .cer     │
│  ③ 导入钥匙串 → 导出 .p12（含私钥，设密码）            │
│  ④ App Store Connect 创建 API Key → 下载 .p8（仅一次） │
│  ⑤ 记录 Team ID / Key ID / Issuer ID                  │
└──────────────────┬───────────────────────────────────┘
                   ▼
┌─ GitHub 仓库 Settings → Secrets and variables ───────┐
│  CSC_LINK / CSC_KEY_PASSWORD（签名）                  │
│  APPLE_API_KEY / APPLE_API_KEY_ID / APPLE_API_ISSUER  │
│  （公证）                                             │
└──────────────────┬───────────────────────────────────┘
                   ▼
┌─ 仓库代码改造（一次性）──────────────────────────────┐
│  electron-builder 配置 + entitlements + 打包脚本      │
│  release workflow（tag 触发）                         │
└──────────────────┬───────────────────────────────────┘
                   ▼
        git tag v0.1.0 && git push --tags
                   ▼
   GitHub Actions 自动：构建 → 签名 → 公证 → DMG → Release
```

**核心概念**（分发外部下载的 Mac 应用必须做前两件）：

| 概念 | 作用 | 用什么 |
| --- | --- | --- |
| 签名 Code Signing | 证明应用是谁发布的、未被篡改 | **Developer ID Application** 证书 |
| 公证 Notarization | Apple 服务器扫描恶意软件，打上可信票据 | App Store Connect API Key |
| 装订 Stapling | 把公证票据贴回应用，离线也能通过 Gatekeeper | electron-builder 自动完成 |

---

## 1. Apple 开发者后台：操作什么 → 得到什么

### 1.1 本机生成 CSR（证书签名请求）

1. 打开「钥匙串访问」（Keychain Access）
2. 菜单栏 → 证书助理 → 从证书颁发机构请求证书…
3. 填入开发者账号邮箱、常用名称（如 `ponponon`），选「存储到磁盘」
4. 得到文件：`CertificateSigningRequest.certSigningRequest`

### 1.2 创建 Developer ID Application 证书

1. 打开 <https://developer.apple.com/account> → Certificates, Identifiers & Profiles
2. Certificates → 右上角 **+**
3. 证书类型选 **Software Distribution 分组下的 `Developer ID Application`**
   - ⚠️ 不要选错：`Apple Development`（真机调试用）、`Mac App Distribution`（上架 App Store 用）
     都不能用于官网下载分发
4. 上传刚才的 CSR → 创建 → 下载 `developerID_application.cer`
5. 双击 .cer 导入「钥匙串访问」（会和本机私钥配对）

> 注意：`Developer ID Application` 证书每个团队上限 5 个，只有 Account Holder（你自己）能创建。

### 1.3 导出 .p12（给 CI 用的签名凭据）

1. 钥匙串访问 → 左侧「我的证书」→ 找到 `Developer ID Application: 你的名字 (TEAMID)`
2. 展开确认下面挂着**私钥**（没有私钥说明导出的不能用）
3. 右键该证书 → 导出… → 文件格式选 **`.p12`** → 设置一个密码（记住它）
4. 得到文件：`xxx.p12`

**至此你拿到：`.p12` 文件 + p12 密码。这就是签名需要的全部东西。**

### 1.4 创建 App Store Connect API Key（公证凭据，推荐）

1. 打开 <https://appstoreconnect.apple.com> → 用户和访问 → **集成（Integrations）** → App Store Connect API
2. 「团队密钥」→ 生成 API 密钥
   - 名称随意（如 `nienie-ci-notarize`）
   - 权限选 **Developer**（够用）或 Admin
3. **立即下载 `.p8` 文件 —— 只能下载一次**，丢了只能删掉重建
4. 记下页面上的 **Key ID** 和 **Issuer ID**

**至此你拿到：`.p8` 文件 + Key ID + Issuer ID。这就是公证需要的全部东西。**

> 备选方案（不推荐）：用 Apple ID + 「App 专用密码」（account.apple.com → 登录与安全 → App 专用密码）。
> 缺点是绑定个人 Apple ID、开了两步验证才给生成、换密码要跟着改 CI。API Key 是 CI 的标准做法。

### 1.5 记下 Team ID

developer.apple.com → Account → **Membership** → Team ID（10 位字符串）。

---

## 2. GitHub 仓库配置 Secrets

仓库 → **Settings → Secrets and variables → Actions → New repository secret**，共 6 个：

| Secret 名称 | 值 | 来源 |
| --- | --- | --- |
| `CSC_LINK` | `base64 -i xxx.p12 \| pbcopy` 的输出 | 1.3 的 .p12（base64 编码后粘贴） |
| `CSC_KEY_PASSWORD` | 导出 p12 时设的密码 | 1.3 |
| `APPLE_API_KEY` | `base64 -i AuthKey_xxx.p8 \| pbcopy` 的输出 | 1.4 的 .p8（base64 编码后粘贴） |
| `APPLE_API_KEY_ID` | 如 `ABC123DEFG` | 1.4 |
| `APPLE_API_ISSUER` | 如 `12345678-aaaa-…` | 1.4 |
| `APPLE_TEAM_ID` | 10 位 Team ID | 1.5 |

> base64 命令在 macOS 自带终端执行即可，输出直接是纯文本，粘进 Secret 值框。
> .p12 / .p8 原文件自己本地留底（存进密码管理器），**不要提交进 git**。

---

## 3. 仓库代码改造清单（打包链路接入）

现状：项目用 esbuild 打包（`scripts/start-mac.mjs`）+ `pnpm start` 直接拉起，没有任何安装包工具。
需要接入 **electron-builder**（Mac DMG 生态最成熟）：

### 3.1 `apps/desktop` 增加打包入口

- `apps/desktop/package.json` 补 `"main": "dist/electron-main.cjs"`（electron-builder 依赖它定位主进程）
- 新增 `apps/desktop/electron-builder.yml`，关键字段：

```yaml
appId: cn.quniv.nienie
productName: Nienie
directories:
  output: dist-release
  buildResources: assets
files:
  - dist/**
  - package.json
asarUnpack:
  - '**/*.node'          # 原生绑定必须解包（@matrixai/quic）
mac:
  category: public.app-category.developer-tools
  icon: assets/nienie.icns
  target:
    - target: dmg
      arch: [arm64, x64]  # 分别出两个 DMG，不做 universal（见坑 3）
  hardenedRuntime: true   # 公证硬性要求
  gatekeeperAssess: false
  entitlements: build/entitlements.mac.plist
  entitlementsInherit: build/entitlements.mac.inherit.plist
  notarize: true          # electron-builder 读 APPLE_* 环境变量自动公证
dmg:
  title: Nienie
```

### 3.2 新增 `apps/desktop/build/entitlements.mac.plist`

公证要求 Hardened Runtime，Electron 需要 JIT 权限（两个 plist 内容相同）：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key>
  <true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
  <true/>
</dict>
</plist>
```

### 3.3 打包脚本

`package.json`（root 或 desktop）加：

```json
"package:mac": "node scripts/package-mac.mjs && electron-builder --mac --config apps/desktop/electron-builder.yml"
```

`scripts/package-mac.mjs` 职责：用 esbuild 产出生产 `dist/*`（复用 `start-mac.mjs` 的打包逻辑，
注意 `--define:process.env.NODE_ENV=\"production\"`），并把 external 的 `@matrixai/*`
拷进打包目录（pnpm 符号链接 node_modules 不被 electron-builder 正确收集，见坑 2）。

### 3.4 `.gitignore` 补 `dist-release/`

---

## 4. GitHub Actions Release workflow

新增 `.github/workflows/release.yml`（与现有 `ci.yml` 独立）：

```yaml
name: Release macOS DMG

on:
  push:
    tags: ['v*']
  workflow_dispatch:

jobs:
  build-mac:
    strategy:
      matrix:
        include:
          - os: macos-latest      # Apple Silicon (arm64)
            arch: arm64
          - os: macos-15-intel    # Intel (x64)
            arch: x64
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'pnpm'

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Build workspace
        run: pnpm build

      - name: Package, sign & notarize
        run: pnpm package:mac -- --arch=${{ matrix.arch }}
        env:
          CSC_LINK: ${{ secrets.CSC_LINK }}
          CSC_KEY_PASSWORD: ${{ secrets.CSC_KEY_PASSWORD }}
          APPLE_API_KEY: ${{ secrets.APPLE_API_KEY }}
          APPLE_API_KEY_ID: ${{ secrets.APPLE_API_KEY_ID }}
          APPLE_API_ISSUER: ${{ secrets.APPLE_API_ISSUER }}
          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - name: Verify signature & notarization
        run: |
          APP=$(ls -d apps/desktop/dist-release/mac*/Nienie.app | head -1)
          codesign --verify --deep --strict --verbose=2 "$APP"
          spctl --assess --type exec -vv "$APP"
          xcrun stapler validate "$APP"

      - name: Upload to GitHub Release
        if: startsWith(github.ref, 'refs/tags/')
        uses: softprops/action-gh-release@v2
        with:
          files: apps/desktop/dist-release/*.dmg
          generate_release_notes: true
```

**触发方式**：打 tag 推送即自动发版：

```bash
git tag v0.1.0
git push origin v0.1.0
```

---

## 5. 验证与排错

打包产物本地验证（三连，全过才算合格）：

```bash
codesign --verify --deep --strict --verbose=2 dist-release/mac/Nienie.app
spctl --assess --type exec -vv dist-release/mac/Nienie.app   # 应输出 source=Notarized Developer ID
xcrun stapler validate dist-release/mac/Nienie.app            # 应输出 The validate action worked!
```

公证被拒时拉取 Apple 的详细原因：

```bash
xcrun notarytool log <submission-id> --key ~/.appstoreconnect/private_keys/AuthKey.p8 \
  --key-id <KEY_ID> --issuer <ISSUER_ID>
```

| 常见报错 | 原因与解法 |
| --- | --- |
| "not signed with a valid Developer ID certificate" | 证书类型选成了 Apple Development / Mac App Distribution，重做 1.2 |
| "does not have the Hardened Runtime enabled" | `hardenedRuntime: true` 没配，或 entitlements 缺 allow-jit |
| "Invalid Info.plist … wrong format" | 有二进制没被签名 → 确认 `asarUnpack: '**/*.node'`，原生模块都在 unpack 名单 |
| 公证卡住不动 | Apple 公证服务慢，electron-builder 会轮询等待，一般 2–10 分钟属正常 |
| 打开应用闪退（无报错） | 多为原生模块签名/加载问题，`log show --predicate 'process == "Nienie"' --last 2m` 查看 |

---

## 6. 本项目的特殊坑（务必注意）

1. **`@matrixai/quic` 是 ESM-only + 原生 `.node` 绑定**（`FailureExperience.md` 2026-11-08 有记录）：
   严禁被 esbuild 内联，必须 `--external:@matrixai/*`；打包进 DMG 时必须
   `asarUnpack` 解包 `.node` 文件，且这些二进制会被 electron-builder 用同一证书签名。
2. **pnpm workspace 的 node_modules 是符号链接结构**，electron-builder 收集依赖时可能断链。
   实用做法：打包脚本把 external 依赖（`@matrixai/quic*` 等）真实拷贝进
   `apps/desktop/node_modules/` 再打包；或在 `.npmrc` 对该子包用 `node-linker=hoisted`。
3. **不做 universal 包**：universal 需要 `.node` 文件同时含 arm64+x64 二进制（lipo 合并），
   原生依赖不一定提供。用 matrix 出 `arm64` 和 `x64` 两个 DMG 最稳。
4. **macOS runner 计费**：公开仓库 GitHub 托管 macOS runner 免费；
   **私有仓库 macOS runner 按分钟计费（约 $0.08/分钟）**，比 Linux 贵很多。
   建议此仓库保持 public，或仅在打 tag 时构建（上面 workflow 已按此设计）。
5. `.p12`/`.p8`/密码绝不能进 git，只进 GitHub Secrets。本地留底建议放密码管理器。

---

## 7. 公证凭据的两条路（常见疑问：还要不要 Apple ID 专用密码？）

notarytool 支持两种认证方式，**二选一即可**：

| 方式 | 需要什么 | 在哪里生成 | 适用场景 |
| --- | --- | --- | --- |
| **App Store Connect API Key（本仓库采用）** | `.p8` 私钥 + Key ID + Issuer ID | App Store Connect → 用户和访问 → 集成 → App Store Connect API | CI 首选，可轮换、不绑定个人密码 |
| Apple ID + App 专用密码 | Apple ID、App 专用密码、Team ID | appleid.apple.com → 登录与安全 → App 专用密码 | 个人临时脚本；需要把账号密码类凭据放进环境变量 |

本项目 2026-11-15 已按**第一条**完成：`APPLE_API_KEY`（.p8）、`APPLE_API_KEY_ID`（8ZBV7KZM96）、
`APPLE_API_ISSUER`、`APPLE_TEAM_ID`（GZR99DMBA2）。**因此不需要再去普通 Apple 账号生成 App 专用密码。**

> 记住分工：developer.apple.com 出的是**签名证书**（Developer ID Application → .p12），
> App Store Connect 出的是**公证凭据**（API Key → .p8）。两者缺一不可，但都不涉及 Apple ID 密码。

---

## 8. 落地实录（2026-11-15 实测通过）

### 8.1 本地一键出包

```bash
node scripts/package-mac.mjs --arch=arm64              # 签名 + 公证 + DMG
node scripts/package-mac.mjs --arch=arm64 --skip-notarize   # 只验证打包链路
```

凭据优先级：环境变量 → `~/.nienie-signing/`（`nienie-developer-id.p12` + `p12-password.txt` +
`AuthKey_*.p8` + `issuer-id.txt` + `team-id.txt`）。CI 上只用环境变量，同一条脚本可直接复用。

产物：`apps/desktop/dist-release/out/Nienie-<version>-<arch>.dmg`（arm64 约 131 MB）。

### 8.2 验收三连（缺一不可）

```bash
codesign --verify --deep --strict --verbose=2 Nienie.app      # 签名完整
spctl -a -vvv -t exec Nienie.app                              # 期望 source=Notarized Developer ID
xcrun stapler validate Nienie.app                             # 票根已钉入
spctl -a -vvv -t open --context context:primary-signature Nienie-*.dmg
hdiutil attach -nobrowse -readonly Nienie-*.dmg && ls /Volumes/Nienie/
```

### 8.3 实测耗时与注意

- 首包完整链路约 30–40 分钟：esbuild + staging 秒级，**签名嵌套 framework 约 15–20 分钟**，
  **首次公证 40 分钟**（团队首次提交 Apple 会慢，之后同一 App 的提交约 1 分钟）。
- `.app` 先公证 + staple，再打 DMG；**DMG 本身也要单独签名 + 公证 + staple**，否则用户首次挂载仍可能被拦。
- 生成 `.p12` 时必须加 `-macalg SHA1 -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES`
  （OpenSSL 4 默认 SHA256 MAC + PBES2 会被 macOS `security` 以 "wrong password" 拒绝，
  详见 `FailureExperience.md` 2026-11-15 条目）。
- GUI 验收不要直接 `./Nienie.app/Contents/MacOS/Nienie`：环境里若存在 `ELECTRON_RUN_AS_NODE=1`
  会让 Electron 以纯 Node 运行而"静默假死"。用 `open Nienie.app` 走真实启动路径，
  以「4100/4101 监听 + 预览页 200 + `~/Library/Application Support/Nienie` 生成」三项判断成功。
