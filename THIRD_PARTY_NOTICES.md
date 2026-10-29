# Third-Party Notices

This repository contains original DSH Live Editor source and synthetic test fixtures. It does not
vendor a built client bundle or third-party source trees. Third-party packages are installed from
npm and retain their own license files in `node_modules`.

The following direct dependencies are used. Versions are pinned in the relevant package manifests
and lockfiles; copyright and full license text are shipped in each package.

| Project | Typical use | License |
| --- | --- | --- |
| React / React DOM | editor and preview UI | MIT |
| CodeMirror 6 (`@codemirror/*`) | source editor and Markdown language support | MIT |
| Lezer (`@lezer/*`) | grammar/parser support | MIT |
| Docusaurus (`@docusaurus/*`, pinned 3.10.1) | local dev preview and synthetic fixture site | MIT |
| unified / remark / rehype packages | MDX/Markdown parsing and rendering | MIT |
| remark-math-extended 6.1.1 | TeX delimiters in MDX | MIT |
| KaTeX / rehype-katex | math rendering | MIT |
| esbuild | client bundle build | MIT |
| Mermaid / `@docusaurus/theme-mermaid` | synthetic-site diagram support | MIT |
| prism-react-renderer | code highlighting in the fixture site | MIT |
| `@mdx-js/react` | MDX React runtime in the fixture site | MIT |
| TypeScript / `@swc/core` | development/build tooling (transitive/dev) | Apache-2.0 |

Transitive dependencies are not exhaustively enumerated here; their licenses are available in the
installed package trees and lockfiles. If a future release distributes a bundled `client.js` or
other build artifact, the release process must preserve the license banners/notices for every
bundled package, including CodeMirror, Lezer, React and Docusaurus components. The current
repository deliberately excludes the generated bundle.

## Research and design acknowledgements (not bundled code)

- **DSH Better Sidebar** 0.28.1 (MIT source used locally): sidebar/workbench integration and UX
  reference. No source copied into this repository. Marketplace packaging metadata has differed
  from the upstream source license; no GPL-licensed package code is included here.
- **Docusaurus PR #10185** and the Docusaurus docs plugin: reload/content-map design reference.
  The project uses Docusaurus as a dependency; no PR source was copied.
- **VS Code Markdown Preview** (MIT): document identity and stale-preview design reference; no source
  copied.
- **`duz52/remark-math-extended`** (MIT): direct dependency for math delimiters.
- **`Yurzi/dsh-pdf-mineru`**, **MinerU**, **Docling**, **PaddleOCR**, **PDF.js** and related OCR/PDF
  projects: research only, not bundled. MinerU and any OCR models/services have their own licenses;
  consult those projects before any future integration.

No third-party project has endorsed this repository. If you believe a required notice is missing,
please open an issue rather than assuming an endorsement.
