# 维护与发布

仓库位于 [haoning-Chen226/zotero-retainpdf](https://github.com/haoning-Chen226/zotero-retainpdf)。这是自用插件的源码和安装包发布目录。

## 构建

在项目根目录运行。

```bash
node --test tests/retain.test.js
python3 scripts/build.py --repo haoning-Chen226/zotero-retainpdf
```

默认生成以下文件。

```text
dist/Zotero-RetainPDF-Bridge-1.0.2.xpi
updates.json
```

版本号取自根目录 `manifest.json`。后续更新时，先修改 `version` 并补充 `CHANGELOG.md`，再构建。

构建脚本将真实仓库的更新地址写入 XPI 内的 `manifest.json`，同时生成安装包的 SHA-256 更新校验值。

## 上传源码

将源码和 `updates.json` 提交到 `main`，让 `README.md` 与 `manifest.json` 位于仓库根目录。构建安装包、运行状态和本地配置由 `.gitignore` 排除。

已有本地克隆时可使用以下命令。

```bash
git status
git add README.md PUBLISH.md CHANGELOG.md manifest.json src scripts tests .gitignore updates.json
git commit -m "Prepare Zotero RetainPDF v1.0.2"
git push origin main
```

## 发布安装包

1. 进入仓库的「Releases → Draft a new release」。
2. 创建与插件版本一致的标签，例如 `v1.0.2`。
3. 标题填写 `Zotero → RetainPDF v1.0.2`。
4. 简单说明本次改动和已验证环境。
5. 上传 `dist/` 中生成的 `.xpi`，然后发布 Release。

Release 附件名和标签须与 `updates.json` 中的链接完全一致。

## 自动更新

当前仓库使用以下更新清单地址。

```text
https://raw.githubusercontent.com/haoning-Chen226/zotero-retainpdf/main/updates.json
```

以 v1.0.2 为例，安装包从下列地址下载。

```text
https://github.com/haoning-Chen226/zotero-retainpdf/releases/download/v1.0.2/Zotero-RetainPDF-Bridge-1.0.2.xpi
```

发布后检查上述下载链接，并下载 Release 安装包试装一次。先前本机 v1.0.1 使用 `.invalid` 占位更新地址，需要手动安装一次带真实地址的版本，之后才会通过新地址检查更新。

插件 ID `retainpdf-bridge@local.invalid` 用于识别已安装的同一插件，维护时保持稳定。

## 维护说明

- README 中的环境与限制按实际测试结果更新。
- RetainPDF 下载入口采用官方 Release，固定版本直链与实测环境对应。
- 增加截图时，使用示例论文并检查个人信息。
- 许可证由仓库所有者选定后，再补充 `LICENSE` 文件和相应说明。

## 参考

- [GitHub Release 官方说明](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository)
- [Zotero 更新清单官方说明](https://www.zotero.org/support/dev/zotero_7_for_developers#updaterdf_updatesjson)
