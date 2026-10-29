# DSH Live Editor

DSH Live Editor is a local development editor for Docusaurus MDX/Markdown notes. It runs as a
DeepSeek Harness (DSH) plugin: the left pane is a CodeMirror 6 source editor and the right pane is a
faithful local Docusaurus page preview. Draft text can flow into the preview without saving the real
document; only an explicit `Cmd+S` writes the formal MDX file.

This repository is a **development snapshot**, not a stable installable product or a hosted service.
It requires a local DSH environment and a Docusaurus site.

## Current capabilities

- Edit `.md` / `.mdx` documents and open the matching local Docusaurus page.
- Preview unsaved draft text in a generated staging copy; the real note is not written by preview.
- Formal save with expected-version checks, a recoverable pre-write backup, readback verification,
  and conflict/recovery UI.
- File tree, quick open, source/page navigation, drafts/history, and structural preview updates.
- Dev-only Docusaurus integration; production builds do not include source-line annotations or the
  preview plugin.
- Local site-identity isolation for drafts and import review results.

## Known limitations

- The local test site in this repository is a **synthetic fixture site**; it is not the author's
  real notebook and contains no textbook scans, personal PDFs, or private notes.
- The editable file tree covers the default `docs` instance. Additional `proj` and `blog` instances
  are read-only preview surfaces.
- The editor preview depends on a running Docusaurus dev server. It is a local development tool,
  not a production deployment path.
- PDF import, batch image import, automatic Git commit/deploy, multi-window layouts, and Ghost Text
  are **not** implemented here.
- Docusaurus is pinned to 3.10.1 in this snapshot. Do not assume compatibility with newer majors or
  unsupported DSH versions.
- The project has not been packaged for general installation, has no release artifact, and makes no
  stability or support promise.

## Development

Requirements: Node.js 20+, npm, and a local DSH checkout/profile that can load a local plugin.

```bash
# Build the client bundle used by the DSH plugin
cd prototypes/phase2
npm ci
npm run build

# Install and start the synthetic Docusaurus fixture site
cd site
npm install
npm start -- --port 3000 --no-open
```

The DSH plugin lives in `plugins/dsh-live-editor`. The test-site configuration imports it only in
development mode. The Host/bundle source is in `prototypes/phase2/dsh-bundle`.

Run the automated suite from `prototypes/phase2`:

```bash
npm test
```

The snapshot currently has 319 passing tests. The tests use the original synthetic fixture site and
do not depend on any private notebook or external local site.

## Security and data boundaries

- The Docusaurus development server and Host routes are intended for loopback/local use only.
- Origin/Host checks, path containment, expected-version checks and explicit save operations are part
  of the current implementation.
- Drafts and generated staging live in local runtime state; `.dsh-live-editor/` and `.docusaurus/`
  are generated directories.
- This repository does not include a bundled `client.js` or any npm dependencies. Install from the
  public registry and review the resulting dependency licenses.

## Roadmap

These are directions, not committed dates or promises:

1. Stabilize daily local editing: save/conflict/recovery UX, structural edits, and clearer dev-server
   startup/health handling.
2. Finish draft reliability and undo/redo coverage before expanding the editing surface.
3. Measure and improve the existing single-image import path; then consider multi-image and PDF
   research without claiming production OCR quality.
4. Explore block-level source/page navigation and other editor affordances.
5. Evaluate Ghost Text/AI assistance only after the editing and save path is stable.

## Acknowledgements

Development benefited from studying and using these open-source projects. This list distinguishes
design inspiration from direct dependencies; it does not imply endorsement by their authors.

- **DSH Better Sidebar** (`https://github.com/omdsh-dev/DSH-better-sidebar`) — MIT at the version
  used/tested (0.28.1). It informed the DSH sidebar/workbench integration and plugin experience. No
  Better Sidebar source is copied into this repository. Some third-party marketplace packaging has
  been described as GPL-3.0; that is separate from the upstream source snapshot used here and was
  not copied or redistributed.
- **Docusaurus** (`https://github.com/facebook/docusaurus`) — MIT. Its docs plugin, MDX pipeline and
  PR #10185 discussion informed the preview/reload design; the project depends on Docusaurus rather
  than copying that code.
- **VS Code Markdown Preview** (`https://github.com/microsoft/vscode`) — MIT. Its document/preview
  identity and stale-result handling were design references; no VS Code source is included.
- **CodeMirror 6 and Lezer** (`https://codemirror.net/`) — MIT; direct dependencies.
- **remark-math-extended** (`https://github.com/duz52/remark-math-extended`) — MIT; direct dependency.
- The wider DSH plugin ecosystem, including `dsh-pdf-mineru`, `dsh-undo-savepoint` and `dshmarket`,
  was studied during research; no code from those projects is included. MinerU and OCR research
  projects retain their own licenses and are not bundled here.

## License

Original project code is licensed under the Mozilla Public License 2.0 (MPL-2.0).

Copyright © 2026 Hiroshiprover.

Third-party components remain under their respective licenses; see `THIRD_PARTY_NOTICES.md`. MPL-2.0 applies at
the file level and does not require unrelated files or larger works to use MPL.
