# R2 下载镜像

官网的安装包走 Cloudflare R2，GitHub Release 是权威源与历史版本仓库。
R2 里**只保留最新一个版本**，历史版本一律删除——存储费按量计，堆历史版本纯烧钱。

参考实现：`ponponon/openctrlc` 的 `script/publish-release-downloads.mjs`。

## 1. 拓扑

| 项 | 值 |
| --- | --- |
| Bucket | `nienie-releases` |
| Key 前缀 | `nienie/releases` |
| 公共域名 | `https://nienie-releases.quniv.cn` |
| 版本化路径 | `nienie/releases/<version>/<assetName>` |
| 稳定别名 | `nienie/releases/latest/Nienie-android.apk`、`.../Nienie-mac-arm64.dmg` |
| 清单 | `nienie/releases/download-manifest.json` |

约定与 openctrlc 一致：**每个 bucket 绑一个独立自定义域**（`<bucket>.quniv.cn`），
key 前缀重复一次应用名。所以新建 bucket 不会自动有地址，需要在 Cloudflare 后台
给 `nienie-releases` 加自定义域 `nienie-releases.quniv.cn`（一次性操作）。

### 为什么还要 `latest/` 别名

版本化 URL 每次发版都变，而官网上的 APK 二维码是静态 SVG，URL 一变二维码就废。
`latest/` 下文件名固定、内容指向最新一次上传，缓存时间压到 5 分钟，
于是二维码和永久链接都不用再改。

## 2. 存储占用

| 对象 | 体积 |
| --- | --- |
| `0.1.0/Nienie-0.1.0-arm64.dmg` | 121 MB |
| `0.1.0/Nienie-v0.1.0-android.apk` | 14.7 MB |
| `latest/Nienie-mac-arm64.dmg` | 121 MB |
| `latest/Nienie-android.apk` | 14.7 MB |
| `download-manifest.json` | ~1 KB |

合计约 272 MB。R2 标准存储 $0.015/GB/月 ≈ **$0.004/月**，出口流量免费。
如果连别名都省掉，是 136 MB；多出来的 136 MB 换来二维码永久有效，值。

## 3. 同步方式

```bash
# 发布 Release 时自动触发（.github/workflows/sync-downloads.yml，release: published）
# 或手动补跑：
gh workflow run sync-downloads.yml
```

需要仓库配置（与 aivplayer / openctrlc 一致）：

| 类型 | 名称 | 说明 |
| --- | --- | --- |
| secret | `CLOUDFLARE_API_TOKEN` | R2 读写 |
| variable | `CLOUDFLARE_ACCOUNT_ID` | 账号 ID |

本地跑：

```bash
CLOUDFLARE_ACCOUNT_ID=xxx CLOUDFLARE_API_TOKEN=yyy \
  GITHUB_TOKEN=$(gh auth token) \
  node scripts/publish-r2.mjs --repository ponponon/nienie --artifacts-dir /path/to/artifacts
```

`--artifacts-dir` 指向已构建好的产物目录（文件名必须和 Release 资产名一致），
命中本地文件就直接上传，不再走 GitHub 下载。CI 上不传，走下载路径。

**网络注意**：脚本里所有 GitHub 调用（API 元数据 + 资产下载）一律用 `curl`，
因为 Node 原生 fetch（undici）不读 `HTTPS_PROXY`，在需要代理的机器上会直接失败或卡死。
Cloudflare API 走 Node fetch 是直连可达的。

脚本行为：

1. 只接受 **GitHub 上最新的正式 Release**，tag 与之不符直接报错（防止误推旧版本）；
2. 从 Release 资产下载并校验 GitHub 给的 `digest`（SHA-256 不一致就失败）；
3. 上传 `nienie/releases/<version>/...`（`immutable`，一年缓存）与 `latest/` 别名（5 分钟）；
4. 写 `download-manifest.json`（`retention: 1`）；
5. 列出前缀下所有对象，删除不属于本次上传的 key，再列一次确认删干净；
6. 顺带给 bucket 应用只读 CORS（`GET`/`HEAD`，任意来源）——官网用 HEAD 探测镜像是否就绪，
   没有 CORS 头会一直回退到 GitHub。CORS 失败只警告，不中断发布。

单文件超过 300 MB（R2 REST 单次 PUT 上限）时自动跳过镜像，清单里记 GitHub 直链。

## 4. 官网如何消费

`website/index.html` 的下载按钮直接指向 `latest/` 别名，无需 JS 参与。
`website/scripts/main.js` 额外做一次 HEAD 探测：镜像不可达时把 href 换成
`https://github.com/ponponon/nienie/releases/latest`，避免出现 404 死链。

历史版本入口固定在页脚与下载区：`https://github.com/ponponon/nienie/releases`。

## 5. 排查

| 现象 | 原因 |
| --- | --- |
| 官网链接跳到了 GitHub | R2 未同步、域名未绑、或 bucket 缺 CORS（看 `main.js` 探测结果） |
| 官网链接走到 `pub-*.r2.dev` | 自定义域还没绑，走了 `main.js` 的第二优先级后备地址 |
| `403` on custom domain | 自定义域还没生效，或 DNS 未指向 R2 |
| 下载到旧版本 | `latest/` 有 5 分钟缓存，等一会儿或加时间戳验证 |
| 同步报 `Only the latest GitHub release` | 该 tag 不是最新正式 Release，先确认没有更新的版本 |
| 同步报 `fetch failed` 或下载卡在 0% | Node fetch 不走代理导致，确认脚本里 GitHub 调用走的是 curl |

### 关于自定义域绑定

R2 的自定义域绑定要求 Token 具备 **Zone 作用域**（`Zone → Zone → Read` + `Zone → DNS → Edit`）。
只有 R2 权限的 Token 会拿到 `GET /zones` 空列表，绑定接口返回
`10040 The JSON you provided was not well formed`（其实是权限不够，报错文案有误导性）。
两条路：

1. 建一个带 Zone 权限的 Token，我用 API 绑；
2. Cloudflare 后台 → R2 → `nienie-releases` → Settings → Custom Domains → Connect Domain
   → 填 `nienie-releases.quniv.cn`（30 秒）。

在绑好之前，官网自动用 bucket 自带的 r2.dev 托管域
`pub-12775a075761492a81c649227f63c1dd.r2.dev`（Cloudflare 明确说它不适合生产、有限流），
绑好后 `main.js` 会自动切回自定义域，不用改代码。
