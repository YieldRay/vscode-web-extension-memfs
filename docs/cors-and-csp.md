# CORS & Content-Security-Policy

Self-hosted VS Code web loads resources from multiple origins — your static server, a CDN for VS Code assets, and potentially extension marketplaces. Both CORS headers and Content-Security-Policy must be configured correctly.

## CORS (Cross-Origin Resource Sharing)

### Why CORS Is Required

The VS Code workbench running on your origin (e.g., `http://localhost:3000`) needs to fetch:

1. **Extension code** from your local server (loaded by the extension host iframe, which may be on a different origin)
2. **VS Code modules** from the CDN (`raw.esm.sh`)
3. **Extension resources** from the marketplace CDN (`openvsxorg.blob.core.windows.net`)

Without CORS headers, the browser blocks these cross-origin fetches.

### `serve.json` Configuration

This project uses the [`serve`](https://www.npmjs.com/package/serve) static file server. CORS is configured in `serve.json`:

```json
{
  "headers": [
    {
      "source": "**/*",
      "headers": [
        {
          "key": "Access-Control-Allow-Origin",
          "value": "*"
        }
      ]
    }
  ]
}
```

This adds `Access-Control-Allow-Origin: *` to **every** response from your static server.

### Why `*` (Wildcard)?

The extension host iframe may run on a different origin (see [Extension Host Iframe](./extension-host-iframe.md)). Since the iframe's origin varies (based on `webEndpointUrlTemplate` and a per-workspace UUID hash), a wildcard is the simplest way to allow all origins.

For production, you could restrict to known origins:

```json
{
  "headers": [
    {
      "source": "**/*",
      "headers": [
        {
          "key": "Access-Control-Allow-Origin",
          "value": "https://your-specific-origin.example.com"
        }
      ]
    }
  ]
}
```

### Other Static Servers

| Server | CORS Configuration |
|--------|-------------------|
| `serve` | `serve.json` (as shown above) |
| `nginx` | `add_header Access-Control-Allow-Origin *;` in the `location` block |
| `caddy` | `header Access-Control-Allow-Origin *` in the Caddyfile |
| `express` | `app.use(cors())` with the `cors` npm package |
| `python -m http.server` | Does not support CORS — use a different server |
| GitHub Pages | Adds CORS headers automatically |

### Required CORS Headers

At minimum, your server must return:

```
Access-Control-Allow-Origin: *
```

For extension marketplaces that require credentials, you may also need:

```
Access-Control-Allow-Methods: GET, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization
```

---

## Content-Security-Policy (CSP)

CSP controls which resources the browser is allowed to load. VS Code web needs a permissive policy due to its dynamic module loading architecture.

### Recommended CSP Header

If you choose to set a CSP header (it is optional — not having one means no restrictions), here is a policy that works with CDN-hosted VS Code:

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self' https://raw.esm.sh 'unsafe-eval' 'unsafe-inline';
  style-src 'self' https://raw.esm.sh 'unsafe-inline';
  font-src 'self' https://raw.esm.sh data:;
  img-src 'self' https: data: blob:;
  connect-src 'self' https: wss:;
  frame-src 'self' https://raw.esm.sh blob:;
  worker-src 'self' blob:;
  child-src 'self' blob:;
  require-trusted-types-for 'script';
  trusted-types amdLoader;
```

### CSP Directives Explained

| Directive | Value | Why |
|-----------|-------|-----|
| `script-src` | `'self' https://raw.esm.sh 'unsafe-eval'` | VS Code loads scripts from CDN; uses `eval` for some dynamic code |
| `style-src` | `'self' https://raw.esm.sh 'unsafe-inline'` | Workbench CSS from CDN; inline styles for theming |
| `font-src` | `'self' https://raw.esm.sh data:` | Codicons font from CDN; `data:` URIs for embedded fonts |
| `img-src` | `https: data: blob:` | Extension icons, theme images, data URIs |
| `connect-src` | `'self' https: wss:` | Marketplace API, WebSocket connections |
| `frame-src` | `'self' https://raw.esm.sh blob:` | Extension host iframe from CDN; blob URLs for workers |
| `worker-src` | `'self' blob:` | Web Workers use blob URLs |
| `trusted-types` | `amdLoader` | The Trusted Types policy name VS Code expects |

### `unsafe-eval` Consideration

VS Code uses `new Function()` and similar constructs internally. The `'unsafe-eval'` directive is currently required. If you have strict CSP requirements, you may need to evaluate whether your use case can tolerate this.

### `unsafe-inline` for Styles

VS Code dynamically injects inline styles for theming (color tokens, layout). `'unsafe-inline'` in `style-src` is required unless you configure nonce-based style injection (VS Code does not support this out of the box).

### Trusted Types in CSP

If you add `require-trusted-types-for 'script'` to your CSP, you **must** also:

1. Set `trusted-types amdLoader` to allow VS Code's policy name
2. Configure `_VSCODE_WEB_PACKAGE_TTP` (see [Trusted Types](./trusted-types.md))

Without both, script loading will fail.

---

## Common Issues

### Extensions Not Loading

**Symptom**: Extensions listed in `additionalBuiltinExtensions` don't activate.

**Check**:
1. Open DevTools Network tab — look for failed requests to `package.json`
2. Verify CORS headers on the response: `Access-Control-Allow-Origin: *`
3. Verify the URL resolves to a directory containing `package.json`

### CDN Scripts Blocked

**Symptom**: Blank page or console errors like `Refused to load the script`.

**Check**:
1. If you have a CSP, ensure `script-src` includes the CDN origin
2. If Trusted Types are enforced, ensure `_VSCODE_WEB_PACKAGE_TTP` allows the CDN
3. Check that `_VSCODE_FILE_ROOT` points to the correct `out/` URL

### Extension Host Iframe Blocked

**Symptom**: Extensions don't run; console shows `Refused to frame`.

**Check**:
1. `frame-src` in CSP must include the `webEndpointUrlTemplate` origin
2. If using same-origin fallback, `frame-src 'self'` is sufficient

### Mixed Content

**Symptom**: Resources blocked on HTTPS pages loading from HTTP.

**Fix**: Serve everything over HTTPS, or use a CDN that supports HTTPS. The `raw.esm.sh` CDN is HTTPS by default.

---

## Development vs. Production

| Concern | Development | Production |
|---------|-------------|------------|
| CORS | `Access-Control-Allow-Origin: *` | Restrict to known origins |
| CSP | Omit (no restrictions) | Set restrictive policy |
| Trusted Types | Optional | Recommended with `_VSCODE_WEB_PACKAGE_TTP` |
| HTTPS | Not required (`http://localhost`) | Required |
| Extension host origin | Same-origin fallback is fine | Configure `webEndpointUrlTemplate` with `{{uuid}}` |

## Full `serve.json` Example

For development with `serve`:

```json
{
  "headers": [
    {
      "source": "**/*",
      "headers": [
        {
          "key": "Access-Control-Allow-Origin",
          "value": "*"
        }
      ]
    }
  ]
}
```

For production with `nginx`:

```nginx
server {
    listen 443 ssl;
    server_name example.com;

    # CORS
    add_header Access-Control-Allow-Origin *;

    # CSP
    add_header Content-Security-Policy "
        default-src 'self';
        script-src 'self' https://raw.esm.sh 'unsafe-eval' 'unsafe-inline';
        style-src 'self' https://raw.esm.sh 'unsafe-inline';
        font-src 'self' https://raw.esm.sh data:;
        img-src 'self' https: data: blob:;
        connect-src 'self' https: wss:;
        frame-src 'self' https://raw.esm.sh blob:;
        worker-src 'self' blob:;
        trusted-types amdLoader;
        require-trusted-types-for 'script';
    ";

    location / {
        root /var/www/vscode-web;
        try_files $uri $uri/ /index.html;
    }
}
```
