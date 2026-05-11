# AGENTS.md

## Overview

VS Code **Web Extension** providing a browser-only in-memory filesystem (`memfs://` scheme) backed by IndexedDB via `@zenfs/core`. Intended as a reference/example project.

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
  - `src/extension.ts` — entrypoint; registers `FileSystemProvider` + opens bash terminal
  - `src/zenfs-adapter.ts` — implements `just-bash`'s `IFileSystem` over `@zenfs/core`
  - `src/terminal.ts` — `Pseudoterminal` with line editor, history, and `just-bash` exec loop
  - `dist/` — webpack output (gitignored)
  - `webpack.config.ts` — bundles for `webworker` target with esbuild-loader

## Build Details

- **pnpm 10.33.4** workspace monorepo (`pnpm-workspace.yaml`)
- Webpack targets `webworker`; polyfills `path`, `buffer`, `process` for browser
- `vscode` is an external (`commonjs vscode`); `node:*` imports are stubbed for browser
- ESM modules in node_modules need `fullySpecified: false` rule (already configured)
- Webpack config is TypeScript (uses `esbuild-register` to load)
- Build copies `package.json` and `package.nls.json` into `dist/` via custom plugin

## Key Conventions

- Extension activates on `onFileSystem:memfs`
- All file operations use `@zenfs/core` promises API with `IndexedDB` backend (from `@zenfs/dom`)
- Paths are posix-style (`path.posix`)
- TypeScript strict mode enabled; target ES2024

## CI

GitHub Actions deploys to GitHub Pages on push to `main`. The workflow builds and assembles `dist/` with extension output + `index.html`.

## Dev Workflow

`pnpm run dev` uses `mprocs` to run two processes in parallel:
1. `serve` — static file server for `index.html` (with CORS headers via `serve.json`)
2. `pnpm run --filter=./extension watch-web` — webpack watch

Open the served URL in a browser to get a full VS Code web instance with the extension loaded.
