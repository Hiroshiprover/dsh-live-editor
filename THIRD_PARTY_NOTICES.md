# Third-Party Notices

This repository contains original DSH Live Editor source and original synthetic fixtures. It does
not vendor third-party source trees or a built client bundle. Third-party packages are installed
from npm and keep their own license and copyright files in the installed package tree.

## Direct dependencies

| Package / project | Copyright / maintainer (as stated by the package) | License |
| --- | --- | --- |
| React, React DOM | Meta Platforms, Inc. and affiliates | MIT |
| CodeMirror 6 (`@codemirror/*`) | Marijn Haverbeke and contributors | MIT |
| Lezer (`@lezer/*`) | Marijn Haverbeke and contributors | MIT |
| Docusaurus (`@docusaurus/core`, preset-classic, theme-mermaid, faster, pinned 3.10.1) | Meta Platforms, Inc. and affiliates | MIT |
| unified / remark / rehype packages | unified collective and contributors | MIT |
| remark-math-extended 6.1.1 | duz52 and contributors | MIT |
| remark-math (test fixture dependency) | Titus Wormer and contributors | MIT |
| KaTeX / rehype-katex | Khan Academy and contributors | MIT |
| esbuild | Evan Wallace and contributors | MIT |
| Mermaid / `@docusaurus/theme-mermaid` | Knut Sveidqvist and contributors | MIT |
| prism-react-renderer | prism-react-renderer contributors | MIT |
| `@mdx-js/react` | MDX contributors | MIT |
| clsx | Luke Edwards and contributors | MIT |
| react-test-renderer (test-only) | Meta Platforms, Inc. and affiliates | MIT |
| TypeScript | Microsoft Corporation | Apache-2.0 |
| `@swc/core` (transitive development/build dependency) | SWC project contributors | Apache-2.0 |

Transitive dependencies are not exhaustively listed here. Their licenses are present in the
installed package trees and resolved versions are recorded in the lockfiles. The MPL-2.0 license in
this repository applies to original project code; third-party files remain under the licenses above.

## Built artifacts and future releases

The generated `prototypes/phase2/dsh-bundle/lib/client.js` bundle is deliberately excluded from this
repository. If a future release distributes a built bundle, that release must preserve the license
and copyright notices for every bundled package, including CodeMirror, Lezer, React, Docusaurus and
the other dependencies above. The present repository does not distribute such a bundle.

Design acknowledgements and links to the projects that informed the implementation are in the
README. They are not additional license grants and do not imply endorsement by those projects.
