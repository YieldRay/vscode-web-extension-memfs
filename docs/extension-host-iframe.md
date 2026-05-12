# Extension Host Iframe & `webEndpointUrlTemplate`

## Overview

VS Code web runs extensions inside a **sandboxed iframe** that is loaded from a different origin than the main workbench page. This provides security isolation — even if an extension has a vulnerability, it cannot directly access the parent page's DOM, cookies, or storage.

## How It Works

```
┌──────────────────────────────────────────────────────────────┐
│  Main Page (your origin: http://localhost:3000)               │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  VS Code Workbench UI                                  │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  <iframe sandbox="allow-scripts allow-same-origin"     │  │
│  │          src="https://cdn.../webWorkerExtensionHost...">│  │
│  │                                                        │  │
│  │   Web Worker (actual extension code runs here)         │  │
│  │     ├── Your extension (additionalBuiltinExtensions)   │  │
│  │     └── Marketplace extensions                         │  │
│  │                                                        │  │
│  │   Communication: MessagePort (postMessage)             │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

1. The main page creates a hidden `<iframe>` for the extension host
2. The iframe loads `webWorkerExtensionHostIframe.html` from the `webEndpointUrlTemplate` origin
3. Inside the iframe, a Web Worker is spawned to actually run extension code
4. The parent and iframe communicate via `MessagePort` (structured clone, not same-origin access)

## `webEndpointUrlTemplate`

This is the template URL that VS Code uses to compute the iframe's source. Set it in `productConfiguration`:

```javascript
productConfiguration: {
  webEndpointUrlTemplate: "https://raw.esm.sh/code-oss@1.119.0",
  quality: "stable",
  commit: "abc123...",  // optional, but needed for template placeholders
}
```

### Template Placeholders

| Placeholder | Replaced With | Purpose |
|-------------|---------------|---------|
| `{{uuid}}` | `v--<sha256_hash>` | Unique per-workspace origin to isolate extension storage |
| `{{commit}}` | `productConfiguration.commit` | Pin to specific VS Code build |
| `{{quality}}` | `productConfiguration.quality` | "stable" / "insider" |

### Resolution Logic (from VS Code source)

```typescript
// src/vs/workbench/services/extensions/browser/webWorkerExtensionHost.ts
const webEndpointUrlTemplate = this._productService.webEndpointUrlTemplate;
const commit = this._productService.commit;
const quality = this._productService.quality;

if (webEndpointUrlTemplate && commit && quality) {
  const hash = await parentOriginHash(mainWindow.origin, stableOriginUUID);
  const baseUrl = webEndpointUrlTemplate
    .replace('{{uuid}}', `v--${hash}`)
    .replace('{{commit}}', commit)
    .replace('{{quality}}', quality);

  const res = new URL(`${baseUrl}/out/vs/workbench/services/extensions/worker/webWorkerExtensionHostIframe.html?...`);
  res.searchParams.set('parentOrigin', mainWindow.origin);
  res.searchParams.set('salt', stableOriginUUID);
  return res.toString();
}
```

### Simple CDN Usage (No Placeholders)

For self-hosting with a CDN like `raw.esm.sh`, you typically use a plain URL without placeholders:

```javascript
webEndpointUrlTemplate: "https://raw.esm.sh/code-oss@1.119.0"
```

**Important:** Even without `{{uuid}}`/`{{commit}}`/`{{quality}}` placeholders, this still creates a **cross-origin** iframe. The iframe loads from `raw.esm.sh`, which is a different origin from your hosting page (e.g., `localhost:3000`).

VS Code only falls back to **same-origin** when `webEndpointUrlTemplate` is completely absent (or when both `commit` and `quality` are unset alongside a template that uses those placeholders). In that case it logs:

```
The web worker extension host is started in a same-origin iframe!
```

With a plain CDN URL, the iframe runs on the CDN's origin. This means:
- `BroadcastChannel` between extension worker and main page **does not work** (different origins)
- `localStorage` / `sessionStorage` are isolated per origin
- To call main-page APIs from the extension, use the [`commands` bridge](./extension-main-page-bridge.md)

The downside of a plain CDN URL (vs. a template with `{{uuid}}`) is that all workspaces share the same iframe origin — extensions in different workspaces can access each other's IndexedDB and storage on that origin.

### Full Template Usage (Production)

For maximum security, use the full template with a CDN that supports path-based routing:

```javascript
productConfiguration: {
  webEndpointUrlTemplate: "https://{{uuid}}.your-cdn.example.com/code-oss/{{quality}}/{{commit}}",
  quality: "stable",
  commit: "a1b2c3d4e5f6...",
}
```

This creates a unique origin per workspace, preventing extensions in one workspace from accessing IndexedDB/localStorage of another.

## Iframe Attributes

VS Code creates the iframe with these attributes:

```html
<iframe
  class="web-worker-ext-host-iframe"
  sandbox="allow-scripts allow-same-origin"
  allow="usb; serial; hid; cross-origin-isolated; local-network-access;"
  aria-hidden="true"
  style="display: none"
  src="...">
</iframe>
```

### Sandbox Permissions

| Permission | Why |
|-----------|-----|
| `allow-scripts` | Extension code must execute JavaScript |
| `allow-same-origin` | Required for the Web Worker inside the iframe to function and for `MessagePort` communication |

### Feature Policy (`allow` attribute)

| Feature | Why |
|---------|-----|
| `usb` | Extensions using WebUSB API |
| `serial` | Extensions using Web Serial API |
| `hid` | Extensions using WebHID API |
| `cross-origin-isolated` | Enables `SharedArrayBuffer` for extensions that need it |
| `local-network-access` | Allows extensions to make local network requests |

## Same-Origin Fallback

When `webEndpointUrlTemplate` is not fully configured (missing `commit` or `quality`), VS Code falls back to loading the extension host iframe from the **same origin** as the workbench. This means:

- Extensions can access parent page's origin storage (localStorage, IndexedDB)
- Less security isolation
- VS Code logs a warning: `The web worker extension host is started in a same-origin iframe!`

For development this is fine. For production deployments, configure the full template.

## Communication Protocol

The parent workbench and extension host iframe communicate via:

1. **Initial handshake**: The parent creates a `MessageChannel` and transfers one port to the iframe via `postMessage`
2. **Extension host protocol**: All subsequent communication uses VS Code's binary protocol over the `MessagePort`
3. **No DOM access**: Extensions cannot touch the main workbench DOM — all VS Code API calls are proxied through the message channel

### Calling Main-Page APIs from Extensions

Because extensions run in a cross-origin worker, they cannot directly access `window`, `navigator.serviceWorker`, `localStorage`, or any other main-page API. VS Code provides two bridge mechanisms:

- **`commands`** (in `init()` options) — register handlers on the main page, call them from extensions via `executeCommand`. Stable and recommended.
- **`messagePorts`** (in `init()` options) — deliver a `MessagePort` directly to an extension for high-throughput bidirectional communication. Proposed API.

See [Extension ↔ Main Page Bridge](./extension-main-page-bridge.md) for full documentation and examples.

## CORS Requirements

The extension host iframe fetches resources from:
- The CDN (VS Code's `out/` directory)
- Your local server (extension code from `additionalBuiltinExtensions`)

Both servers must return `Access-Control-Allow-Origin: *` (or the specific requesting origin) to allow cross-origin fetches from the iframe's origin.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Extensions don't activate | Iframe blocked by CSP | Add CDN origin to `frame-src` in CSP |
| Console warning about same-origin iframe | `webEndpointUrlTemplate` not resolving | Set `commit` and `quality` in productConfiguration |
| Extension host crash on startup | Trusted Types blocking script in iframe | Ensure `_VSCODE_WEB_PACKAGE_TTP` allows the CDN origin |
| "SecurityError" in iframe | CORS headers missing | Add `Access-Control-Allow-Origin` to your static server |
| Extensions can't fetch local resources | Mixed content or CORS | Serve everything over HTTPS or configure CORS headers |
