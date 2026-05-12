# AGENTS.md

## Overview

VS Code **Web Extension** providing a browser-only in-memory filesystem (`memfs://` scheme) backed by `almostnode` (virtual Node.js runtime for browsers). The filesystem is persisted to IndexedDB across page reloads. The terminal runs commands via `almostnode`'s shell. HTTP servers started inside the terminal are accessible via Service Worker interception. Intended as a reference/example project.

## Commands

```sh
pnpm install          # install all workspace deps
pnpm run dev          # starts static server + webpack watch (via mprocs)
pnpm run build        # production webpack build → extension/dist/
```

There is **no test suite, linter, or formatter** configured.

## Workspace Structure

- **Root** — dev tooling only (`serve`, `mprocs`); hosts `index.html` that loads VS Code web
- **`extension/`** — the actual VS Code extension (separate workspace package)
  - `src/extension.ts` — entrypoint; registers `FileSystemProvider`, terminal, and server preview
  - `src/terminal.ts` — `Pseudoterminal` with line editor, history, and `almostnode` command execution
  - `src/host-bridge.ts` — `createHostFunction()` / `runOnHost()` helpers for cross-origin bridge
  - `src/host-globals.d.ts` — type declarations for `globalThis.container` / `globalThis.almostnode`
  - `dist/` — webpack output (gitignored)
  - `webpack.config.ts` — bundles for `webworker` target with esbuild-loader

## Architecture

```
Main Page (index.html)                    Extension Worker (raw.esm.sh)
┌─────────────────────────┐               ┌──────────────────────────────┐
│ almostnode module        │  host.eval    │ MemFS (FileSystemProvider)    │
│ ├── VirtualFS            │◄────────────►│   calls createHostFunction() │
│ ├── container.run()      │  host.promise │                              │
│ ├── ServerBridge + SW    │               │ Terminal (Pseudoterminal)     │
│ └── IndexedDB persist    │               │   calls createHostFunction() │
└─────────────────────────┘               └──────────────────────────────┘
```

- **`almostnode`** is loaded on the main page via `esm.sh` and exposed as `globalThis.almostnode`
- The extension host runs in a **cross-origin web worker** (origin: `raw.esm.sh`)
- Communication uses the VS Code `commands` bridge (`host.eval`, `host.promise`)
- `createHostFunction(fn)` serializes a function and its arguments, evals on the main page
- The Service Worker (`__sw__.js`) intercepts `/__virtual__/{port}/*` URLs for virtual HTTP servers

## Build Details

- **pnpm 10.33.4** workspace monorepo (`pnpm-workspace.yaml`)
- `prebuild`/`predev` scripts copy `node_modules/almostnode/dist/__sw__.js` to serve root
- Webpack targets `webworker`; polyfills `path`, `buffer`, `process` for browser
- `vscode` is an external (`commonjs vscode`)
- Webpack config is TypeScript (uses `esbuild-register` to load)
- Build copies `package.json` and `package.nls.json` into `dist/` via custom plugin

## Key Conventions

- Extension activates on `onFileSystem:memfs`
- All file operations go through the host bridge to `almostnode`'s `VirtualFS` on the main page
- VFS is persisted to IndexedDB (debounced 2s save); restored on startup
- Terminal commands run via `container.run(cmd)` with `AbortSignal` for Ctrl+C support
- HTTP servers auto-detected via `onServerReady`; user notified to open preview in browser tab
- VFS change tracking uses `vfs.watch('/', { recursive: true })` + `vfs.on('delete')` for precise file explorer updates
- TypeScript strict mode enabled; target ES2024

## CI

GitHub Actions deploys to GitHub Pages on push to `main`. The workflow builds and assembles `dist/` with extension output + `index.html`.

## Dev Workflow

`pnpm run dev` uses `mprocs` to run two processes in parallel:
1. `serve` — static file server for `index.html` + `__sw__.js` (with CORS headers via `serve.json`)
2. `pnpm run --filter=./extension watch-web` — webpack watch

Open the served URL in a browser to get a full VS Code web instance with the extension loaded.
