# DSH Live Editor

English | [简体中文](README.zh-CN.md)

DSH Live Editor is a [DeepSeek Harness (DSH)](https://www.deepseek.com/en/harness/) plugin for editing and maintaining personal websites built with [Docusaurus](https://docusaurus.io/).

It brings MDX/Markdown source editing and a live Docusaurus preview into one workspace, allowing you to work on your site's content and see the rendered result side by side. Unsaved changes can appear in the preview without modifying the original files; writing to the site remains an explicit action.

The project began as a tool for maintaining a personal physics notes website and is still under active development.

## Who is it for?

DSH Live Editor is primarily intended for students and researchers in mathematics, physics, and related fields who use Docusaurus to maintain personal websites, course notes, mathematical derivations, or research records.

Docusaurus provides Markdown, MDX, LaTeX math, and React component support, making it useful for content-heavy academic websites. This project aims to make everyday editing and previewing more convenient while preserving those capabilities.

Other Docusaurus users are welcome to try it as well.

For now, the editor focuses on maintaining existing Docusaurus sites. It does not yet provide a complete website setup or deployment workflow.

## Features

### Source editing and live preview

Edit MDX and Markdown files with CodeMirror 6 while viewing the corresponding Docusaurus page alongside the source.

The preview uses the site's own Docusaurus rendering environment, including its theme, styles, mathematical expressions, and MDX components.

Unsaved changes can be reflected in the preview as you type. **Previewing a draft does not modify the original MDX file. Changes are written to the site only when you explicitly save them.**

### Source–preview navigation

Opening a document navigates the preview to its corresponding page. Clicking supported elements in the preview, such as annotated headings or paragraphs, can take you to the matching location in the source editor.

Basic navigation is available, although smooth scroll synchronization and arbitrary source-line-to-preview-block mapping are still under development. Some navigation interactions may feel rough.

### Local drafts and recovery

Unsaved drafts and local history are retained across editing sessions.

Saving the actual MDX file requires `Cmd+S`. The save process includes version checks, a backup of the previous file, and readback verification to reduce the risk of accidental overwrites or data loss. Conflicts are surfaced in the interface.

Drafts are also separated by site identity to avoid mixing content from different Docusaurus projects.

### Image import (experimental)

The editor includes an experimental workflow for importing a single image and converting its contents, including text and mathematical expressions, into editable source.

This feature has only undergone limited sample testing. Processing speed, recognition accuracy, and the overall workflow still need improvement. Results should be reviewed manually.

Batch image import and PDF conversion are not yet implemented.

## Installation and usage

**The project has currently been developed and tested on macOS only.** Windows and Linux compatibility has not yet been verified.

There is no packaged release or one-click installer. Running the editor currently requires a local DSH installation, a Docusaurus environment, and some manual configuration.

### Requirements

- macOS
- A local DeepSeek Harness installation capable of loading plugins
- Node.js 22.12 or later and npm (currently verified with Node.js 24.22.1)
- Docusaurus 3.10.1 (the currently tested version)
- An existing Docusaurus website

The preview currently expects the site's development server at `http://localhost:3000`. Custom ports are not yet configurable through the UI.

### Get the source

Clone the [GitHub repository](https://github.com/Hiroshiprover/dsh-live-editor):

```bash
git clone https://github.com/Hiroshiprover/dsh-live-editor.git
cd dsh-live-editor
```


### Build the editor

```bash
cd prototypes/phase2
npm ci
npm run build
```

The built client must be connected to a local DSH profile using DSH's plugin-loading mechanism. A universal installation script is not yet available, and the exact setup depends on the DSH environment.

### Run the test site

The repository includes a small Docusaurus fixture site containing original sample documents for development and testing.

```bash
cd prototypes/phase2/site
npm ci
npm start -- --port 3000 --no-open
```

The fixture site does not contain the author's private notes, textbook scans, or personal documents.

To run the automated tests from `prototypes/phase2`:

```bash
npm test
```

### Use it with your own Docusaurus site

Two components work together:

- The DSH-side editor and Host, located under `prototypes/phase2/`.
- The Docusaurus development plugin, located under `plugins/dsh-live-editor/`.

The current reference configuration is `prototypes/phase2/site/docusaurus.config.ts`. It demonstrates how to add the development plugin, preview instance, and related MDX configuration while preserving the site's existing navigation and documentation structure.

The DSH Host must also be explicitly configured with the target site path and write permissions. Access to arbitrary external sites is not enabled by default.

**A complete, generally tested installation procedure is not available yet.** The steps above cover the source build and development fixture; manual integration is still required for an existing DSH/Docusaurus setup.

## Known limitations

DSH Live Editor is still an early-stage project. Its current limitations include:

- **Platform support:** Only macOS has been tested. Windows and Linux support remain unverified.
- **Documents and views:** Editing currently focuses on the default Docusaurus `docs` instance. Other documentation instances, such as `proj`, and blog content can be viewed through the preview but are not available for editing in the file tree. Multiple independent source or preview windows are not supported.
- **Navigation:** Basic source–preview navigation works, but continuous scrolling and fully bidirectional positioning are incomplete.
- **Better Sidebar compatibility:** Better Sidebar's built-in editor and file tree overlap with the Live Editor's editing surface. The current recommended configuration disables Better Sidebar's editor; full compatibility has not been verified.
- **Image import:** Only experimental single-image conversion is available. Processing can be slow, and converted content requires manual review.
- **Setup and operation:** A local Docusaurus development server must be started and configured manually. A streamlined installer, startup process, and deployment workflow have not yet been provided.

For important documents, keep independent backups and begin with small edits when testing the plugin in a new environment.

## Development & Maintenance

I'm an undergraduate student with a background in physics, and I haven't received formal training in software engineering. My understanding of some technical details is also limited.

This project started as a spontaneous idea. As of October 29, 2026, it has undergone only about a week of local testing and has been developed primarily through *vibe coding*. Most of the code has been written with the help of **DeepSeek Harness**, while **ChatGPT** has assisted with code reviews and security checks, and **Codex** has been used to tackle implementation problems that DeepSeek Harness couldn't resolve.

For these reasons, I cannot guarantee that the project will work reliably in every environment. Bug reports, suggestions, and contributions are very welcome through GitHub Issues. However, given my limited time and experience, I cannot promise to resolve every issue. Please keep independent backups before using this project to edit important documents.

Thank you to everyone who is willing to give this project a try and help make it better!

## Data and security notes

- Single-image recognition uses the model service currently configured in DSH; image content may be sent to an external provider and may incur charges.
- Drafts, save backups, and runtime state are stored locally; exact storage locations and cleanup behavior depend on the implementation, so review them before important use.
- The Docusaurus development server is intended for local use only and should not be exposed to untrusted networks.
- MDX can contain executable components or code; only edit site content from trusted sources.
- The synthetic test site's development and build dependencies currently have unresolved security advisories. This project does not claim that they have been proven unexploitable.

## Roadmap

The following areas are planned for future development. Their order and scope may change based on actual usage.

- **Editing experience:** Improve source–preview navigation, scroll synchronization, document management, and multi-window layouts.
- **Drafts and saving:** Strengthen draft recovery, conflict handling, and undo/redo behavior.
- **Image and document import:** Improve single-image recognition and explore batch imports, PDF parsing, and conversion from other document formats.
- **AI-assisted editing:** Explore Ghost Text, suggested edits, and diff review.
- **Installation and compatibility:** Simplify plugin setup, development-server management, and Docusaurus integration, with future investigation of Windows support.

The immediate priority is to make the existing editing and saving workflow reliable for everyday use.

## Acknowledgements

DSH Live Editor has benefited from several open-source projects. Many thanks to their authors and contributors.

- **[Docusaurus](https://github.com/facebook/docusaurus)** provides the website and MDX rendering foundation. Its documentation plugin and the work discussed in [PR #10185](https://github.com/facebook/docusaurus/pull/10185) also informed parts of the preview design.
- **[DSH Better Sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)** was an important reference for DSH sidebar, workbench, and plugin interaction design.
- **[VS Code Markdown Preview](https://github.com/microsoft/vscode/blob/main/extensions/markdown-language-features/src/preview/preview.ts)** provided useful design references for preview updates and document state management.
- **[CodeMirror 6](https://codemirror.net/) / [Lezer](https://lezer.codemirror.net/)** provide the source editing and parsing components.
- **[remark-math-extended](https://github.com/duz52/remark-math-extended)** supports additional TeX math delimiters in MDX.

These acknowledgements do not imply endorsement or involvement by the respective projects or their authors. Third-party software remains subject to its own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

Original project code is released under the [Mozilla Public License 2.0 (MPL-2.0)](LICENSE).

The license allows use, modification, and redistribution, including commercial use. When distributing modifications to MPL-covered source files, the corresponding source and licensing requirements apply.

For unmodified versions, please consider linking to this repository so users can find current releases and documentation.

Copyright © 2026 Hiroshiprover.
