# 社区插件发行包与一键安装

首次投稿请先在插件自己的公开 GitHub 仓库发布正式 Release，附上 WhaleLife 工具生成的 `.wlpkg.gz`。在投稿表中填写仓库链接、安装包附件的下载链接和一句话介绍；图标可选。附件直链示例为 `https://github.com/作者/插件仓库/releases/download/v1.2.0/my-plugin-1.2.0.wlpkg.gz`。

尚未提供发行包的申请保留在原 Issue 待补件。发包后在原帖回复附件直链，维护者下载同一文件，试装、审核通过后收录。已有的历史手动安装条目仍提供「安装说明」。维护者回读公开条目并告知作者后关闭本轮 Issue。

用户手动点「检查插件更新」时，只会看到适合本机的已审核新版。旧版控制台可能根据作者的最新 Release 显示「有更新」。可在商店查看一键安装版本，也可核对[公开目录](catalog.json)中对应插件的 `verifiedReleases` 记录。

## 已收录插件发布新版

在原插件仓库发布与 `plugin.yaml` 版本对应的正式 Release，附上 `.wlpkg.gz`，再由作者在 WhaleLife 主仓为该版本开新的复审 Issue。维护者从开放的审核帖接单。[填写新版复审表单](https://github.com/iinukami/whalelife/issues/new?template=review-plugin-update.yml)

标题示例为 `[复审] 日程 v1.2.0`。表单必填项目为插件的公开 GitHub 仓库、商店中的完整插件 ID（子插件如 `surf/douyin`）、本次版本、Release 页面链接和安装包附件直链。首次投稿 Issue 的链接可选。

同一插件的同一版本已有开放审核帖时，在该帖补充资料或更正链接。修改已发布的附件内容时须升版、重新打包并发布新的正式 Release，再开对应版本的复审帖。原投稿帖可以保持关闭。

## 社区插件图标

首次投稿可在表单的「插件图标链接」中填写自己插件仓库里的 PNG 文件链接，建议使用 256 × 256 像素的方图，最大 1 MiB，每边不超过 1024 像素。留空时使用默认图标。已收录插件要添加或更换图标，请在主仓提交图标审核 Issue，填写仓库、完整插件 ID 和新图链接。如果已有开放的图标审核帖，就在该帖补充。仅换图标无需修改插件版本或重新发包。[提交图标审核](https://github.com/iinukami/whalelife/issues/new?template=review-plugin-icon.yml)

维护者先核对图片来自条目 `repository` 指向的仓库，再打开图片文件并取得固定到具体提交的 GitHub 永久链接。首次收录时，先在目录草稿中建立插件条目。在主仓根目录运行检查命令，将 `sample` 替换为插件 ID，并将 `$url` 设为图片的永久链接。

```sh
node market/tools/review-community-icon.mjs sample "$url"
```

查看该提交的原图，确认内容适合作为这个插件的图标。通过后，用同一条命令加上 `--apply` 保存已审图片。目录条目的 `icon` 指向商店里的静态副本，路径为 `assets/community-icons/<sha256>.png`。运行 `node market/tools/generate-catalog.mjs` 并用 `--check` 核对，将图片、目录和生成的展示文件一起发布。只换图时保留现有的发行包审核记录。

## 作者打包

1. 在插件仓库固定本次发布的提交。检查根目录的 `plugin.yaml` 和 `index.ts`，确认 ID 和版本正确。包内子插件放在 `sub/<子插件 ID>/`，每个子插件均需自己的 `plugin.yaml` 和入口。安装时需要的模板、静态文件和运行依赖要一并准备好。
2. 在 WhaleLife 主仓安装 Node.js 24 或更新版本，运行一次 `npm ci` 获得主仓工具依赖。以下命令从主仓根目录运行。示例插件仓库位于同级的 `my-plugin`，输出目录选在插件目录之外。

   ```sh
   node tools/build-community-package.mjs ../my-plugin ../release-output
   ```

   如果插件 ID 是 `my-plugin`、`plugin.yaml` 中的版本是 `1.2.0`，生成的附件就是 `../release-output/my-plugin-1.2.0.wlpkg.gz`。终端同时输出 `filename`、`sizeBytes` 和 `sha256`，可直接复制到发行说明。

   `.wlpkg.gz` 使用 WhaleLife 发行包格式。gzip 解压后，首行是 UTF-8 JSON 文件清单，含 `format: 1` 和按顺序排列的 `files`。每项记录相对路径 `path`、字节数 `size` 和该文件的 `sha256`。换行后紧接各文件的原始字节，顺序与清单一致。GitHub 自动生成的 `Source code (zip)` 和 `Source code (tar.gz)` 是供手动安装使用的源码归档。请将工具生成的 `.wlpkg.gz` 作为商店安装附件。

   默认使用 Git 跟踪的文件，要求已跟踪文件与所选提交一致。如果需要构建或捆绑运行依赖，先按照插件自己的发布流程生成干净的发行目录，再将这个目录交给工具。可以使用实际运行 ID 为子插件命名。

   ```sh
   node tools/build-community-package.mjs ../my-plugin/dist ../release-output --from-dir
   node tools/build-community-package.mjs ../douyin/dist ../release-output --from-dir --id surf/douyin
   ```

3. 核对输出文件列表。工具会过滤插件和子插件的 `data/`、用户配置、隐藏文件和常见凭据文件，遇到私钥内容标记会终止。请从清单中逐项确认只有公开程序、必要依赖与授权材料，检查源码或其他命名的文件内是否嵌入了账号资料。用户安装时无需运行作者机器上的构建步骤。
4. 在**插件自己的公开 GitHub 仓库**创建 Release 草稿。标签与 `plugin.yaml` 的新版本对应，例如插件 `1.2.0` 使用 `v1.2.0`。把生成的 `.wlpkg.gz` 附到草稿。GitHub 自动生成的源码归档可用于手动安装。
5. 在发行说明里写出附件名、打包工具输出的 `sizeBytes` 和 `sha256`、适用的 WhaleLife 版本、已测试的操作系统与架构，以及必需插件的完整 ID 和版本。子插件请同时写明父插件及版本，可选集成单独说明。核对附件后发布正式 Release，复制发行页及附件直链，填写主仓对应的投稿或复审表单。建议在作者仓库开启不可变发行版，保护今后发布的标签和附件。[GitHub 不可变发行版说明](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)

## 维护者审核

1. 从 WhaleLife 主仓开放的投稿或新版复审 Issue 取单。交叉核对帖中的插件仓库、完整 ID 和版本，与首次投稿或目录条目对应。检查该帖指定的 Release 已正式发布，核对标签、附件名、源码提交与 `plugin.yaml`。对照代码、构建步骤和打包清单，核对文件读写、网络、账号访问、子插件和随包依赖的用途。
2. 从该 Release 下载**将给用户安装的同一附件**。核对压缩文件字节数和 SHA-256，与作者提交的信息和 GitHub 的附件元数据交叉验证。Windows 上可用 `Get-FileHash -Algorithm SHA256 <附件路径>` 计算摘要。文件清单内每个文件的摘要与整个压缩包的摘要用途不同，两者均需正确。
3. 在与登记版本、平台和架构相符的独立测试环境，用本地目录草稿试装。复制 `market/catalog.json` 为草稿，按下表填入待审记录。主仓带有以下试装命令，从空实例、空缓存读取草稿，安装时使用与商店相同的下载、校验和依赖处理流程。可在提交收录前完成验证。

   ```sh
   node tools/trial-community-package.mjs ../draft-catalog.json sample 1.2.0
   node tools/trial-community-package.mjs ../draft-catalog.json sample 1.2.0 --install --serve
   ```

   第一条输出安装计划。第二条会实际安装并启用插件，打印随机的本机控制台地址。打开临时控制台的「插件管理」验证已安装插件的功能，回到终端按回车结束试用。本地草稿仅用于命令行的试装计划；控制台商店仍使用公开目录。对于涉及真实账号、外部程序或系统文件的插件，请使用专用测试环境和合成资料。另检查依赖已安装或停用时如何复用或启用，验证安装失败后的撤回情况，记录所用宿主、平台、附件版本及提交。
4. 通过后，维护者在主仓 `market/catalog.json` 的 `community` 条目登记 `verifiedReleases`。新收录插件至少需要一条已实测的附件记录。每条记录包含对应的兼容条件，商店据此向兼容的用户提供安装入口。[商店目录](catalog.json)

   | 字段 | 登记内容 |
   | --- | --- |
   | `version`、`hostRange` | 插件正式版本和最低实测宿主，例如 `1.2.0`、`0.1.0`。宿主有上限时填 `>=0.1.0 <0.2.0` 或 `>=0.1.0 <=0.1.1`，仅适配单一版本时填 `=0.1.0`。 |
   | `platform`、`arch` | 对应 Node 的平台和架构，例如 `win32`、`x64`。该维度确实通用时可填 `any` |
   | `assetUrl` | 同一作者仓库下的 `/releases/download/v1.2.0/<文件名>.wlpkg.gz` 附件直链 |
   | `sizeBytes`、`sha256` | 实际压缩文件的字节数和 64 位小写十六进制摘要 |
   | `dependencies` | 必需插件完整运行 ID 对应实测精确版本，如 `{"surf":"0.1.1"}`。没有时填 `{}`；条目的 `dependencies` 列表与这些 ID 对应 |
   | `bundledPluginIds` | 可选，随同该附件安装的子插件完整 ID，例如 `["sample/calendar"]` |

5. 在主仓根目录运行 `node market/tools/generate-catalog.mjs` 生成展示文件，再运行 `node market/tools/generate-catalog.mjs --check` 核对。发布后在控制台回读条目，核对安装版本、依赖提示和作者链接。在本轮审核 Issue 通知作者，公开条目回读成功后关闭该帖。缺件或未通过时在本轮 Issue 说明原因，保持开放以接收资料或修订说明。后续版本由作者另开复审帖。

每个新版附件都独立审核。即使只修打包内容，也要提高版本号并发布新的 Release。已登记附件如被替换，大小或摘要不匹配会中止安装。新附件审核通过前，商店继续提供先前已审核且兼容的版本。
