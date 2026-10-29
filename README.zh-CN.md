# DSH Live Editor

[English](README.md) | 简体中文

DSH Live Editor 是一个基于 [Docusaurus](https://docusaurus.io/) 的 [DeepSeek Harness（DSH）](https://www.deepseek.com/harness/) 插件，用于在 DSH 中编辑和维护个人网站。

它将 MDX/Markdown 源码编辑器与 Docusaurus 页面预览放在同一界面中。你可以直接编辑网站内容、查看实际渲染效果，并在需要时保存修改，无须频繁切换编辑器和浏览器。

项目最初是为维护个人物理笔记网站而开发的，目前仍在持续完善中。

## 适用人群

本项目主要面向有个人网站需求的数学、物理及其他理工科专业学生和科研工作者，尤其适合希望使用 Docusaurus 整理、展示课程笔记、数学推导、研究记录等内容的用户。

Docusaurus 本身支持 Markdown、MDX、LaTeX 数学公式和 React 组件，适合构建内容较多、需要长期维护的个人网站。

DSH Live Editor 希望在保留这些能力的同时，简化日常内容编辑与预览的过程。其他使用 Docusaurus 的用户也可以尝试本项目。

目前本项目主要用于编辑已有的 Docusaurus 站点，尚不提供完整的网站初始化或自动部署功能。

## 主要功能

### 源码编辑与实时预览

在 DSH 中使用 CodeMirror 6 编辑 MDX/Markdown 文件，并在旁边查看 Docusaurus 的页面预览。

预览使用站点自身的 Docusaurus 渲染环境，包括主题、样式、数学公式和 MDX 组件，尽可能保持与实际网站一致。

编辑过程中，未保存的内容也可以实时反映在预览中。**预览不会直接修改原始 MDX 文件，只有主动保存才会写入正式文档。**

### 源码与页面定位

编辑器能够根据当前打开的文件切换预览页面。点击预览中支持定位的标题、段落等内容块，也可以跳转到源码中的对应位置。

目前已经实现基本的页面与源码定位，但连续滚动同步、任意源码行到预览块的双向定位仍有待完善。部分情况下，定位与滚动效果还不够流畅。

### 草稿保存与恢复

编辑器会在本地保存未正式写入的草稿，并提供草稿历史与恢复功能。

正式保存需要主动按下 `Cmd+S`。为降低意外覆盖和数据丢失的风险，保存流程包含版本检查、原文件备份和写入后校验；检测到冲突时会在界面中提示。

不同站点的草稿也会分别管理，避免在切换项目时混淆内容。

### 图片导入（实验性）

支持将单张图片导入编辑器，尝试识别并转换其中的文字、公式等内容，供用户检查和编辑。

目前仅完成初步单图流程与有限样本验证。识别速度、准确性和操作体验仍有改进空间，转换结果需要人工检查。

多图片批量导入与 PDF 转换尚未实现。

## 安装与使用

**当前仅在 macOS 上完成开发和测试，尚未提供正式安装包。** Windows 和 Linux 的兼容性尚未验证。

目前需要自行准备 DSH 与 Docusaurus 环境，并手动配置插件。如果你只是希望直接安装并使用，建议关注后续版本。

### 环境要求

- macOS
- 可加载本地插件的 DeepSeek Harness
- Node.js 20 或更新版本、npm
- Docusaurus 3.10.1（当前测试版本）
- 一个已有的 Docusaurus 网站

当前预览需要站点开发服务器运行在 `http://localhost:3000`，暂不支持从界面配置其他端口。

### 下载源码

从 [GitHub 仓库](https://github.com/Hiroshiprover/dsh-live-editor) 下载源码，或者使用 Git：

```bash
git clone https://github.com/Hiroshiprover/dsh-live-editor.git
cd dsh-live-editor
```

如果仓库仍为 Private，则需要拥有相应访问权限。

### 构建编辑器

```bash
cd prototypes/phase2
npm ci
npm run build
```

生成的客户端需要通过本地 DSH profile 的插件加载机制接入。由于目前还没有统一的安装脚本，具体配置需要参考 DSH 版本和本地插件环境。

### 运行测试站点

仓库提供一个使用原创测试内容构建的 Docusaurus 站点，用于开发和功能验证。

```bash
cd prototypes/phase2/site
npm ci
npm start -- --port 3000 --no-open
```

测试站点不包含作者的私人笔记、教材扫描图片或其他个人资料。

自动测试可以在 `prototypes/phase2` 目录执行：

```bash
npm test
```

### 接入自己的 Docusaurus 网站

本项目包含两个需要配合使用的部分：

- DSH 侧的编辑器及 Host，源码位于 `prototypes/phase2/`。
- Docusaurus 侧的开发插件，位于 `plugins/dsh-live-editor/`。

目前需要参考 `prototypes/phase2/site/docusaurus.config.ts`，将开发插件、预览实例及相关 MDX 配置接入自己的 Docusaurus 站点，同时保留已有的导航栏、侧边栏和文档设置。

接入后仍需为 DSH Host 显式配置站点路径与写入权限。默认不允许直接写入任意外部站点。

**目前尚无经过验证的通用安装流程。** 上述内容主要提供源码构建和测试入口；不同 DSH 环境下的完整接入步骤仍待整理。

## 已知局限

项目目前仍处于早期开发阶段，存在以下限制：

- **平台兼容性：** 目前仅验证 macOS，Windows 和 Linux 尚未适配及测试。
- **页面与文档实例：** 当前可编辑文件树主要支持默认的 `docs` 实例；`proj` 等其他文档实例和 `blog` 暂时只能通过预览查看。编辑器目前也只支持单个编辑视图，尚不能自由拆分多个源码或预览窗口。
- **源码与预览定位：** 基本定位已经可用，但同步滚动和双向定位尚不完整，部分交互仍不够流畅。
- **Better Sidebar 兼容性：** DSH Better Sidebar 的内置编辑器/文件树与 Live Editor 的编辑入口存在重叠；当前建议关闭 Better Sidebar 的编辑器功能（`tabsEnabled.editor = false`），完整兼容性仍需进一步验证。
- **图片导入：** 当前仅支持实验性的单张图片转换，处理耗时较长，识别结果需要人工检查。
- **运行环境：** 预览依赖本地 Docusaurus 开发服务器，当前还需要手动启动和配置。尚未提供通用的一键安装、启动和部署流程。

对于正式笔记，建议保留独立备份，并在首次使用时先通过少量文件验证编辑与保存行为。

## 后续计划

项目计划继续完善以下方向，具体顺序和实现方式可能根据实际使用情况调整。

- **编辑体验：** 改善源码与预览之间的定位、滚动同步，以及文件和多窗口管理。
- **草稿与保存：** 进一步完善草稿恢复、冲突处理、撤销与重做功能。
- **图片和文档导入：** 优化单图识别的速度和准确性，研究多图导入、PDF 解析与其他文档格式转换。
- **AI 辅助编辑：** 探索 Ghost Text、修改建议与 Diff 审阅等能力。
- **安装与兼容性：** 简化插件配置、开发服务器管理与站点接入，逐步研究 Windows 等平台的支持。

目前优先保证已有编辑与保存功能的可靠性，再逐步扩展其他能力。

## 开源项目与致谢

DSH Live Editor 的开发参考并使用了多个优秀的开源项目。感谢这些项目的作者和贡献者。

- **[Docusaurus](https://github.com/facebook/docusaurus)**：提供网站与 MDX 文档渲染的基础。项目开发也参考了其文档插件及 [PR #10185](https://github.com/facebook/docusaurus/pull/10185) 的相关实现思路。
- **[DSH Better Sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)**：为 DSH 侧栏、工作台和插件交互设计提供了重要参考。
- **[VS Code Markdown Preview](https://github.com/microsoft/vscode/blob/main/extensions/markdown-language-features/src/preview/preview.ts)**：其预览更新与文档状态管理方式为本项目提供了设计参考。
- **[CodeMirror 6](https://codemirror.net/) / [Lezer](https://lezer.codemirror.net/)**：提供源码编辑与语法解析能力。
- **[remark-math-extended](https://github.com/duz52/remark-math-extended)**：用于支持 MDX 中不同形式的数学公式定界符。

以上致谢不代表相关项目作者参与开发或认可本项目。第三方代码及依赖仍遵循各自的许可证，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 许可证

本项目原创代码采用 [Mozilla Public License 2.0（MPL-2.0）](LICENSE) 发布。

你可以在许可证允许的范围内使用、修改和再分发本项目，包括商业用途。对 MPL 所覆盖源文件的修改，在对外分发时需要遵守相应的源码提供和许可要求。

对于未经修改的版本，建议直接引用本项目仓库，方便使用者获取最新版本和相关说明。

Copyright © 2026 Hiroshiprover.
