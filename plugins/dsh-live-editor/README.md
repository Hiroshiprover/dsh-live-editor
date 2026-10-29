# docusaurus-plugin-dsh-live-editor

Dev-only Docusaurus plugin used by DSH Live Editor. It exposes the current document identity and
MDX source-line annotations to the DSH iframe bridge. Production builds must not include it.

## Files

| File | Responsibility |
| --- | --- |
| `src/index.mjs` | Docusaurus plugin: theme path, client modules, content map |
| `src/client/index.js` | Activates the bridge only for an iframe with the bridge query/nonce |
| `src/client/bridge.js` | Handshake, validation, block-click and reveal-line messages |
| `src/theme/DocItem/index.tsx` | Wraps DocItem and publishes document identity/map/navigation |
| `src/rehype/annotate.mjs` | Adds source-line data attributes to block elements |
| `src/rehype/annotate-math.mjs` | Wraps display math before KaTeX |

## Wiring

The Docusaurus fixture site imports the plugin only in development mode and resolves the plugin
path relative to the site config. The site config also installs the preview docs instance and
annotation rehype plugins only in development.

## Compatibility notes (Docusaurus 3.10.1)

- Plugins are loaded through jiti in a CJS wrapper; use the supported plugin lifecycle.
- `allContentLoaded` is not a public documented lifecycle; treat it as a pinned-version dependency
  and re-test after any Docusaurus upgrade.
- The `DocItem` wrapper imports `@theme-init/DocItem`; this is the previous provider in
  theme-classic 3.10.1. There is intentionally no automatic fallback.
- Re-run the project test suite after any Docusaurus upgrade.

## Test-site cache note

The synthetic test site has its own `node_modules`. Rspack's persistent cache is disabled in the
fixture config, and the start/build scripts set `DOCUSAURUS_NO_PERSISTENT_CACHE=1`, so generated
cache state stays local to the fixture.

## Protocol (v1)

Parent → child: `ready`, `theme`, `reveal-line`.
Child → parent: `hello`, `ready-ack`, `route-begin`, `route-change`, `block-click`.

Every message carries `{ source: 'dsh-live-editor-bridge', v: 1, nonce }`; the child accepts parent
messages only from the DSH app origin with `event.source === window.parent`.
