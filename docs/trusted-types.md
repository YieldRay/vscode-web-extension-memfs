# Trusted Types: `_VSCODE_WEB_PACKAGE_TTP`

## What Are Trusted Types?

[Trusted Types](https://developer.mozilla.org/en-US/docs/Web/API/Trusted_Types_API) is a browser security API that prevents DOM XSS by requiring that values passed to injection sinks (like `script.src`) are created through auditable policy functions rather than raw strings.

VS Code's web workbench uses dynamic script loading (e.g., for xterm.js terminal, language services, and extension host scripts). Without a Trusted Types policy, browsers that enforce Trusted Types will block these loads.

## The `_VSCODE_WEB_PACKAGE_TTP` Global

VS Code checks for a global `_VSCODE_WEB_PACKAGE_TTP` policy before creating its own. This allows the embedder (your `index.html`) to control which script URLs are permitted.

### TypeScript Declaration (from VS Code source)

```typescript
// src/typings/vscode-globals-ttp.d.ts
declare global {
  var _VSCODE_WEB_PACKAGE_TTP:
    | Pick<TrustedTypePolicy, 'name' | 'createScriptURL'>
    | undefined;
}
```

The global must provide:
- **`name`** — policy name (conventionally `'amdLoader'`)
- **`createScriptURL(value: string): string`** — validates and returns allowed script URLs

## How VS Code Uses It

In `src/vs/amdX.ts`, VS Code's module loader resolves the Trusted Types policy in this order:

1. **Use `_VSCODE_WEB_PACKAGE_TTP`** if the embedder already created it
2. **Otherwise**, create a default `'amdLoader'` policy that only allows scripts from `window.location.origin`

```typescript
// Simplified from VS Code source:
this._amdPolicy =
  globalThis._VSCODE_WEB_PACKAGE_TTP ??
  window.trustedTypes?.createPolicy('amdLoader', {
    createScriptURL(value) {
      if (value.startsWith(window.location.origin)) return value;
      throw new Error(`Invalid script url: ${value}`);
    }
  });
```

**Problem**: When loading VS Code from a CDN (e.g., `raw.esm.sh`), the CDN's origin differs from `window.location.origin`. The default policy would reject CDN scripts.

**Solution**: Set `_VSCODE_WEB_PACKAGE_TTP` before any VS Code scripts load, allowing both your origin and the CDN origin.

## Implementation

This **must** be set in a `<script>` block before `workbench.js` is loaded:

```html
<script>
  const baseUrl = new URL("https://raw.esm.sh/code-oss@1.119.0/out/", window.location.href);
  globalThis._VSCODE_FILE_ROOT = baseUrl.origin + baseUrl.pathname;

  // Allow scripts from both our origin and the CDN
  const cdnOrigin = new URL(baseUrl).origin;
  if (window.trustedTypes) {
    globalThis._VSCODE_WEB_PACKAGE_TTP = window.trustedTypes.createPolicy('amdLoader', {
      createScriptURL(value) {
        if (value.startsWith(window.location.origin) || value.startsWith(cdnOrigin)) {
          return value;
        }
        throw new Error(`[trusted_script_src] Invalid script url: ${value}`);
      }
    });
  }
</script>
```

### Key Points

1. **Policy name must be `'amdLoader'`** — VS Code's Trusted Types CSP expects this name. Using a different name can cause a `TrustedTypePolicyFactory: policy already created` error.

2. **Guard with `if (window.trustedTypes)`** — Not all browsers support Trusted Types. Firefox and older browsers don't have the API.

3. **Must run before any `<script type="module">` that imports VS Code** — The policy must exist by the time VS Code's module loader first tries to create script URLs.

4. **Allow both origins** — Your page's origin (for locally-served extensions) and the CDN origin (for VS Code's own scripts).

## Allowing Additional Origins

If you load extensions or scripts from other origins, add them to the policy:

```javascript
const allowedOrigins = [
  window.location.origin,
  cdnOrigin,
  "https://my-extension-cdn.example.com",
];

globalThis._VSCODE_WEB_PACKAGE_TTP = window.trustedTypes.createPolicy('amdLoader', {
  createScriptURL(value) {
    if (allowedOrigins.some(origin => value.startsWith(origin))) {
      return value;
    }
    throw new Error(`[trusted_script_src] Invalid script url: ${value}`);
  }
});
```

## What Happens Without It

| Scenario | Result |
|----------|--------|
| No `_VSCODE_WEB_PACKAGE_TTP`, no CSP Trusted Types header | Works fine — Trusted Types are not enforced |
| No `_VSCODE_WEB_PACKAGE_TTP`, with CSP `require-trusted-types-for 'script'` | VS Code creates its own policy, but rejects CDN scripts |
| `_VSCODE_WEB_PACKAGE_TTP` set, CDN origin allowed | Works correctly |
| `_VSCODE_WEB_PACKAGE_TTP` set with wrong policy name | Fails with policy conflict error |

## Web Worker Context

Inside web workers (including the extension host worker), VS Code also checks `_VSCODE_WEB_PACKAGE_TTP`. In the worker context, the default fallback is more permissive — it allows all URLs. The embedder-provided policy, if present, is propagated into the worker iframe via script injection.

## Relationship to `_VSCODE_FILE_ROOT`

These two globals work together:

- **`_VSCODE_FILE_ROOT`** tells VS Code's module system *where* to find files (the `out/` directory URL)
- **`_VSCODE_WEB_PACKAGE_TTP`** tells the Trusted Types system *which URLs are allowed* to be loaded as scripts

Both must point to / allow the same CDN origin.
