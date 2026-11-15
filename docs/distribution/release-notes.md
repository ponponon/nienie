# Release 说明格式

英文单一正文，结构对齐 `ponponon/openctrlc` 与 `ponponon/aivplayer`。
手写部分放 `docs/release-notes/<tag>.md`，Downloads 与 Full Changelog 由
`scripts/release-notes.mjs` 生成，CI 的 `release-notes` job 写回 Release body。

## 1. 结构

```markdown
## Features

- **一句话结论。** 做了什么、带来什么可感知的变化。

## Known Limitations

- ...

## Downloads

### macOS

- [Apple Silicon DMG](下载链接) (121.2 MB)

### Android

- [ARM64 APK](下载链接) (14.7 MB)

**Full Changelog**: https://github.com/ponponon/nienie/compare/v上一版...v本版
```

| 区块 | 谁写 | 说明 |
| --- | --- | --- |
| `## Features` / `## Known Limitations` | **人写** | `docs/release-notes/<tag>.md`，随 tag 一起提交 |
| `## Downloads` | 脚本 | 按扩展名归组成 `### macOS` / `### Windows` / `### Linux` / `### Android`，带体积 |
| `**Full Changelog**` | 脚本 | git tag 排序里的上一版做 compare，没有上一版则指向 commits |

## 2. 英文唯一正文（硬性要求）

Release 正文**只写英文**，同一条 Release 里不重复放中文翻译。需要本地化就放到
README 或官网对应语言页面。`scripts/release-notes.mjs` 会检查手写部分是否含中日韩字符，
命中直接失败并退出：

```
release notes must be English only; found CJK characters in docs/release-notes/v0.2.0.md.
```

历史和已有版本不回溯改写，新增文案一律遵守。

体积用**十进制 MB**（1 MB = 1000²B），和 GitHub 资产列表显示的口径一致——
用 MiB 会出现「说明写 130.8 MB、页面显示 137 MB」的错位。

Downloads 里不列 `.aab`（不能直接安装）和 `SHA256SUMS`（不是下载项）。

## 3. 发版流程

```bash
# 1. 写英文亮点（必须先提交，CI 读的是仓库里的文件）
$EDITOR docs/release-notes/v0.2.0.md

# 2. 打 tag 即发版
git tag v0.2.0 && git push origin v0.2.0
```

CI 里 `release-notes` job 的行为：

1. `needs: [macos-dmg, android-apk]`，两端跑完才执行（`always()` + 至少一端成功）；
2. 下载全部 artifact 到 `release-assets/`；
3. 渲染时取 **Release API 真实资产 ∪ 本地产物目录** 的并集——只重跑单端也不会丢另一端的链接；
4. `gh release edit <tag> --notes-file` 写回 body，并把最终 body 打到 job summary。

## 4. 本地预览与补救

```bash
# 下载链接指向 GitHub（默认）
node scripts/release-notes.mjs --tag v0.1.0 --out /tmp/notes.md

# 下载链接指向 R2 镜像（R2 同步完成后再用这版）
node scripts/release-notes.mjs --tag v0.1.0 --r2 --out /tmp/notes.md

# 线上写回
gh release edit v0.1.0 --notes-file /tmp/notes.md
```

产物文件名必须和 Release 上的资产名一致，否则链接 404。CI 里由改名步骤保证
（`Nienie-<version>-arm64.dmg`、`Nienie-v<version>-android.apk`）。
