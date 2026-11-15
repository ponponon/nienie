# Release 说明格式

格式对齐 `ponponon/openctrlc`，由 `scripts/release-notes.mjs` 统一渲染，
CI 的 `release-notes` job 在两端资产上传完成后自动写回 body。

## 1. 结构

```markdown
<一段话概述这一版是什么>

## 亮点

- **一句话结论。** 具体做了什么、带来什么可感知的变化。
- ...

## 已知限制

- ...

## Downloads

### Desktop

#### macOS

- [Apple Silicon DMG](下载链接) (137.2 MB)

### Android

- [ARM64 APK](下载链接) (14.7 MB)

## Full Changelog

[Compare changes](https://github.com/ponponon/nienie/compare/v上一版...v本版)
```

约定：

| 区块 | 谁写 | 说明 |
| --- | --- | --- |
| 概述 + 亮点 + 已知限制 | **人写** | 放在 `docs/release-notes/<tag>.md`，随 tag 一起提交 |
| `## Downloads` | 脚本自动 | 按产物扩展名归组，含体积 |
| `## Full Changelog` | 脚本自动 | 取 git tag 排序里的上一个版本作 compare |

Downloads 的分组规则（`classify()`）：`.dmg`/`.zip`/`.exe`/`.deb`/`.AppImage` → `### Desktop`，
`.apk`/`.aab` → `### Android`；`.sha256`、`SHA256SUMS` 等辅助文件不进 Downloads。
同一平台多个产物用 ` | ` 分隔成一行，和 openctrlc 一致。

体积用**十进制 MB**（1 MB = 1000²B），和 GitHub 资产列表显示的口径一致——
用 MiB 会出现「说明写 130.8 MB、页面显示 137 MB」的错位。

## 2. 发版流程

```bash
# 1. 写亮点（必须先提交，CI 里读的是仓库里的文件）
$EDITOR docs/release-notes/v0.2.0.md

# 2. 打 tag 即发版，说明会自动生成
git tag v0.2.0 && git push origin v0.2.0
```

CI 里 `release-notes` job 的行为：

1. `needs: [macos-dmg, android-apk]`，两端跑完才执行（`always()` + 至少一端成功）；
2. `actions/download-artifact` 拉全部产物到 `release-assets/`；
3. 渲染时取 **Release API 上的真实资产列表 ∪ 本地产物目录** 的并集——
   所以只重跑单端（比如只重打 APK）也不会把另一端的下载链接弄丢；
4. `gh release edit <tag> --notes-file` 写回 body，并把最终 body 打到 job summary。

## 3. 本地预览与补救

```bash
# 只渲染不发布（读 Release API 上已有的资产）
node scripts/release-notes.mjs --tag v0.1.0 --out /tmp/notes.md

# 带上本地刚构建的产物一起算（同名以本地为准）
node scripts/release-notes.mjs --tag v0.2.0 --dir /path/to/artifacts --out /tmp/notes.md

# 改完说明线上写回
gh release edit v0.1.0 --notes-file /tmp/notes.md
```

产物文件名要和 Release 上的资产名一致，否则生成的下载链接会 404。
CI 里由 workflow 的改名步骤保证（`Nienie-v<version>-android.apk` 等）。
