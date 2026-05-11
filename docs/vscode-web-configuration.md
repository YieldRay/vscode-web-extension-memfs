# Self-Hosting VS Code Web (code-oss) Configuration Guide

This guide documents how to configure a self-hosted VS Code web instance using the [`code-oss`](https://www.npmjs.com/package/code-oss) npm package served via a static HTML page.

## Quick Start

A minimal self-hosted VS Code web setup requires:

1. An `index.html` that loads the workbench CSS, sets global configuration, and calls `init()`
2. A static file server with CORS headers (`serve.json`)
3. Optionally, your own extensions served alongside

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <link rel="stylesheet" href="https://esm.sh/code-oss@1.119.0/out/vs/workbench/workbench.web.main.internal.css" />
</head>
<body aria-label=""></body>
<script>
  const baseUrl = new URL("https://esm.sh/code-oss@1.119.0/out/", window.location.href);
  globalThis._VSCODE_FILE_ROOT = baseUrl.origin + baseUrl.pathname;
</script>
<script type="module">
  import init from "https://esm.sh/code-oss@1.119.0/workbench.js";
  init(document.body, {
    productConfiguration: { /* ... */ },
    folderUri: { scheme: "memfs", path: "/" },
    additionalBuiltinExtensions: [ /* ... */ ],
  });
</script>
</html>
```

## Document Index

| Document | Covers |
|----------|--------|
| [Workbench init() Options](./workbench-init-options.md) | Full `init()` / `create()` API reference |
| [Trusted Types](./trusted-types.md) | `_VSCODE_WEB_PACKAGE_TTP` policy setup |
| [Extension Host Iframe](./extension-host-iframe.md) | `webEndpointUrlTemplate`, iframe sandbox, security model |
| [Builtin Extensions & folderUri](./builtin-extensions.md) | `additionalBuiltinExtensions`, `folderUri`, workspace config |
| [CORS & CSP](./cors-and-csp.md) | `serve.json`, Content-Security-Policy headers, cross-origin setup |

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│  Browser Tab (your origin: localhost:3000)               │
│                                                         │
│  index.html                                             │
│    ├── Sets _VSCODE_FILE_ROOT (CDN base path)           │
│    ├── Sets _VSCODE_WEB_PACKAGE_TTP (Trusted Types)     │
│    ├── Loads workbench CSS from CDN                      │
│    └── Calls init(body, options)                         │
│         ├── productConfiguration (gallery, quality)     │
│         ├── folderUri (initial workspace)               │
│         └── additionalBuiltinExtensions (your exts)    │
│                                                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │  Extension Host Iframe (sandboxed, cross-origin)  │  │
│  │  Origin: webEndpointUrlTemplate resolved URL      │  │
│  │  sandbox="allow-scripts allow-same-origin"        │  │
│  │  Runs web worker extensions in isolation          │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
         │                    │
         ▼                    ▼
┌─────────────────┐  ┌─────────────────────────┐
│  CDN (esm.sh)   │  │  Your Static Server     │
│  code-oss pkg   │  │  extension/dist/        │
│  VS Code assets │  │  (additionalBuiltins)   │
└─────────────────┘  └─────────────────────────┘
```

## Boot Sequence

1. Browser loads `index.html`
2. `performance.mark("code/didStartRenderer")` — timing marker
3. Workbench CSS loads from CDN
4. First `<script>` block:
   - Computes `_VSCODE_FILE_ROOT` (tells VS Code where to find its modules)
   - Creates `_VSCODE_WEB_PACKAGE_TTP` Trusted Types policy
5. NLS (localization) messages load
6. `workbench.js` is imported as an ES module
7. `init(document.body, options)` creates the workbench
8. VS Code resolves `folderUri`, scans `additionalBuiltinExtensions`, and activates

## Key Globals

| Global | Purpose |
|--------|---------|
| `_VSCODE_FILE_ROOT` | Base URL for VS Code's module resolution (must point to the `out/` directory) |
| `_VSCODE_WEB_PACKAGE_TTP` | Trusted Types policy for dynamic script loading |

## CDN Choice

This project uses `raw.esm.sh/code-oss@<version>` as the CDN. The `code-oss` npm package bundles the VS Code web build output. Alternative CDN options:

- `esm.sh/code-oss@<version>` — ESM CDN (may rewrite imports)
- `raw.esm.sh/code-oss@<version>` — serves files as-is without transform
- `unpkg.com/code-oss@<version>` — another option
- Self-hosted — copy the package contents to your own static server

The `raw.esm.sh` variant is preferred because VS Code's internal module loader expects files to be served without any ESM rewriting.
