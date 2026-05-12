# Extension ↔ Main Page Bridge

## The Problem

VS Code web extensions run inside a **cross-origin web worker**:

```
Main Window (your origin, e.g., localhost:3000)
  └── iframe (CDN origin, e.g., raw.esm.sh)          ← CROSS-ORIGIN
        └── Web Worker (inherits CDN origin)
              └── your extension.ts runs here
```

Your extension code has:
- **No `window` object** — the global is `DedicatedWorkerGlobalScope`
- **No DOM access** — no `document`, no `createElement`
- **No `navigator.serviceWorker`** — not available in workers (cross-browser)
- **No `BroadcastChannel` to the main page** — different origins
- **No `localStorage` / `sessionStorage` access** on the main page's origin

Yet many libraries and use cases require main-thread window APIs: service workers, WebRTC with cookies, clipboard, geolocation, Web Bluetooth, etc.

## Solutions

VS Code provides two mechanisms in `IWorkbenchConstructionOptions` that bridge this gap:

| Mechanism | Best For | Complexity | Status |
|-----------|----------|------------|--------|
| [`commands`](#commands) | RPC-style calls (request/response) | Simple | **Stable, recommended** |
| [`messagePorts`](#messageports) | Streaming, high-frequency, binary data | Moderate | Extension-side API is **proposed** |

Both are defined in `index.html` (the hosting page) and transparently bridge the cross-origin boundary via VS Code's internal IPC.

---

## `commands`

### How It Works

```
Extension Worker                    VS Code IPC                    Main Window
     │                                  │                              │
     │  executeCommand('host.foo', a)   │                              │
     │ ─────────────────────────────────>│                              │
     │                                  │  calls handler(a)            │
     │                                  │ ─────────────────────────────>│
     │                                  │                              │
     │                                  │  returns result              │
     │                                  │ <─────────────────────────────│
     │  resolves with result            │                              │
     │ <─────────────────────────────────│                              │
```

1. You register command handlers in `init()` options — they run on the **main window thread**
2. Extensions call `vscode.commands.executeCommand(id, ...args)` — this goes through VS Code's binary protocol across the iframe boundary
3. The handler executes with full `window` access and returns a result
4. The result is serialized back to the extension

### Definition (in `index.html`)

```javascript
import init from "https://raw.esm.sh/code-oss@1.119.0/workbench.js";

init(document.body, {
  // ... other options ...

  commands: [
    {
      id: 'host.registerServiceWorker',
      handler: async (scriptUrl, options) => {
        if (!('serviceWorker' in navigator)) {
          throw new Error('Service workers not supported in this browser');
        }
        const reg = await navigator.serviceWorker.register(scriptUrl, options);
        await navigator.serviceWorker.ready;
        return {
          scope: reg.scope,
          state: reg.active?.state ?? 'installing',
        };
      }
    },
    {
      id: 'host.postToServiceWorker',
      handler: (message) => {
        if (!navigator.serviceWorker.controller) {
          throw new Error('No active service worker controller');
        }
        navigator.serviceWorker.controller.postMessage(message);
        return true;
      }
    },
    {
      id: 'host.getGeolocation',
      handler: () => new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(
          (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
          (err) => reject(new Error(err.message))
        );
      })
    },
    {
      id: 'host.openPopup',
      label: 'Open OAuth Popup',  // appears in Command Palette
      handler: async (url) => {
        const popup = window.open(url, '_blank', 'width=600,height=800');
        // ... OAuth flow handling ...
        return { token: '...' };
      }
    },
  ],
});
```

### Usage (in extension code)

```typescript
// extension.ts
import * as vscode from 'vscode';

export async function activate(context: vscode.ExtensionContext) {
  // Register a service worker on the MAIN PAGE's origin
  const result = await vscode.commands.executeCommand<{ scope: string; state: string }>(
    'host.registerServiceWorker',
    '/sw.js',
    { scope: '/' }
  );
  console.log('Service worker registered:', result);

  // Send data to the service worker
  await vscode.commands.executeCommand(
    'host.postToServiceWorker',
    { type: 'CACHE_URLS', urls: ['/index.html', '/assets/main.css'] }
  );

  // Get geolocation
  const location = await vscode.commands.executeCommand<{ lat: number; lng: number }>(
    'host.getGeolocation'
  );
}
```

### Serialization Rules

Arguments and return values cross VS Code's IPC boundary using **structured clone**. This means:

| Supported | Not Supported |
|-----------|---------------|
| Primitives (string, number, boolean, null) | Functions |
| Plain objects / arrays | DOM nodes / elements |
| `Date`, `RegExp`, `Map`, `Set` | `WeakMap`, `WeakSet` |
| `ArrayBuffer`, `TypedArray` | Streams (`ReadableStream`) |
| `Blob` | Class instances (lose prototype) |
| Nested combinations of above | Circular references |

If you need to return complex objects, serialize them to JSON or a plain object first.

### Error Handling

Errors thrown in the handler propagate back to the extension as rejected promises:

```javascript
// index.html
commands: [{
  id: 'host.riskyOperation',
  handler: async () => {
    throw new Error('Something went wrong on the main page');
  }
}]
```

```typescript
// extension.ts
try {
  await vscode.commands.executeCommand('host.riskyOperation');
} catch (err) {
  // err.message === 'Something went wrong on the main page'
  vscode.window.showErrorMessage(`Host error: ${err.message}`);
}
```

### Command Palette Integration

Commands with a `label` appear in the Command Palette (Ctrl+Shift+P):

```javascript
commands: [{
  id: 'host.clearCache',
  label: 'Clear Service Worker Cache',
  menu: 0,  // Menu.CommandPalette (the enum value)
  handler: async () => {
    const cacheNames = await caches.keys();
    await Promise.all(cacheNames.map(name => caches.delete(name)));
    return { cleared: cacheNames.length };
  }
}]
```

---

## `messagePorts`

### How It Works

```
Main Window                         VS Code                        Extension Worker
     │                                  │                              │
     │  new MessageChannel()            │                              │
     │  port1 → init(messagePorts)      │                              │
     │ ─────────────────────────────────>│                              │
     │                                  │  transfers port1 → iframe    │
     │                                  │  iframe transfers → worker   │
     │                                  │ ─────────────────────────────>│
     │                                  │                              │
     │  port2.postMessage(data)         │         (direct)             │
     │ ════════════════════════════════════════════════════════════════>│
     │                                  │                              │
     │                     port1.postMessage(response)                  │
     │ <════════════════════════════════════════════════════════════════│
```

Unlike `commands`, `messagePorts` provide a **direct** channel that bypasses VS Code's command serialization. After the initial setup, messages flow directly between the main page and the extension worker (through the iframe relay, but without VS Code protocol overhead).

### Definition (in `index.html`)

```javascript
// Create a channel pair
const channel = new MessageChannel();
const hostPort = channel.port2;  // stays on main page

// Define the host-side API
hostPort.onmessage = async (event) => {
  const { id, method, args } = event.data;

  try {
    let result;
    switch (method) {
      case 'registerServiceWorker':
        const reg = await navigator.serviceWorker.register(...args);
        await navigator.serviceWorker.ready;
        result = { scope: reg.scope, state: reg.active?.state };
        break;

      case 'fetchWithCookies':
        // Fetch with credentials (cookies) — not possible from a cross-origin worker
        const resp = await fetch(args[0], { credentials: 'include' });
        result = { status: resp.status, body: await resp.text() };
        break;

      default:
        throw new Error(`Unknown method: ${method}`);
    }

    hostPort.postMessage({ id, result });
  } catch (err) {
    hostPort.postMessage({ id, error: err.message });
  }
};

init(document.body, {
  // port1 is transferred to the extension
  messagePorts: new Map([
    ['your-publisher.your-extension', channel.port1]
  ]),
  // ...
});
```

### Usage (in extension code — proposed API)

```typescript
// extension.ts
// Requires "extensionEnabledApiProposals": { "your-publisher.your-extension": ["..."] }

export async function activate(context: vscode.ExtensionContext) {
  // Proposed API — not stable yet
  const port = await vscode.env.getMessagePort('your-publisher.your-extension');
  if (!port) {
    console.warn('MessagePort not available — falling back to commands');
    return;
  }

  // RPC helper
  let nextId = 0;
  const pending = new Map<number, { resolve: Function; reject: Function }>();

  port.onmessage = (event) => {
    const { id, result, error } = event.data;
    const p = pending.get(id);
    if (p) {
      pending.delete(id);
      error ? p.reject(new Error(error)) : p.resolve(result);
    }
  };

  function callHost(method: string, ...args: unknown[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      port.postMessage({ id, method, args });
    });
  }

  // Use it
  const swResult = await callHost('registerServiceWorker', '/sw.js', { scope: '/' });
  console.log('SW:', swResult);
}
```

### When to Use `messagePorts` vs `commands`

| Criterion | Use `commands` | Use `messagePorts` |
|-----------|---------------|-------------------|
| API stability | Stable | Proposed (may change) |
| Setup complexity | Zero | Moderate (channel pair + RPC protocol) |
| Latency | ~1-5ms per call | ~0.1-1ms per message |
| Throughput | Suitable for occasional calls | Suitable for streaming/bulk data |
| Binary data | Serialized (overhead) | Transferable (`ArrayBuffer`) |
| Bidirectional | No (request-response only) | Yes (either side can initiate) |
| Multiple extensions | All share the command namespace | Each extension gets its own port |

**Recommendation:** Start with `commands`. Only move to `messagePorts` if you need streaming, bidirectional push, or high-frequency communication (>100 messages/sec).

---

## Common Patterns

### Pattern: Service Worker Registration

```javascript
// index.html — commands approach
commands: [{
  id: 'host.sw.register',
  handler: async (scriptUrl, options = {}) => {
    const reg = await navigator.serviceWorker.register(scriptUrl, options);
    await navigator.serviceWorker.ready;
    return { scope: reg.scope, active: !!reg.active };
  }
}, {
  id: 'host.sw.unregister',
  handler: async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    if (reg) await reg.unregister();
    return true;
  }
}, {
  id: 'host.sw.postMessage',
  handler: (message) => {
    navigator.serviceWorker.controller?.postMessage(message);
  }
}]
```

### Pattern: Main-Page Fetch with Cookies

Extensions in a cross-origin worker cannot send cookies for the hosting page's origin. Bridge it:

```javascript
// index.html
commands: [{
  id: 'host.fetch',
  handler: async (url, options = {}) => {
    const resp = await fetch(url, { ...options, credentials: 'include' });
    const body = await resp.text();
    return {
      status: resp.status,
      statusText: resp.statusText,
      headers: Object.fromEntries(resp.headers.entries()),
      body,
    };
  }
}]
```

### Pattern: Clipboard Access

```javascript
// index.html
commands: [
  { id: 'host.clipboard.read', handler: () => navigator.clipboard.readText() },
  { id: 'host.clipboard.write', handler: (text) => navigator.clipboard.writeText(text) },
]
```

### Pattern: Notification API

```javascript
// index.html
commands: [{
  id: 'host.notification',
  handler: async (title, options) => {
    if (Notification.permission !== 'granted') {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') return { denied: true };
    }
    new Notification(title, options);
    return { shown: true };
  }
}]
```

### Pattern: LocalStorage Bridge

The extension worker cannot access the main page's `localStorage`. Bridge it:

```javascript
// index.html
commands: [
  { id: 'host.storage.get', handler: (key) => localStorage.getItem(key) },
  { id: 'host.storage.set', handler: (key, value) => localStorage.setItem(key, value) },
  { id: 'host.storage.remove', handler: (key) => localStorage.removeItem(key) },
]
```

---

## Limitations

### Serialization Boundary

All data crossing the bridge must be serializable. You **cannot**:
- Pass DOM elements
- Pass functions or callbacks
- Return `ReadableStream` or event emitters
- Share object references (everything is copied, not shared)

For streaming data, use `messagePorts` with chunked messages.

### No Synchronous Calls

Both `commands` and `messagePorts` are **asynchronous**. There is no way to synchronously call the main page from an extension. If a library requires a synchronous API (e.g., `fs.readFileSync`), it cannot be directly bridged.

### Timing: Commands Available After Init

Commands registered via the `commands` option are available **immediately** when the workbench starts — they don't wait for extension activation. However, the extension must wait for its own activation before calling `executeCommand`.

### Security Considerations

Commands registered in `index.html` are callable by **any** extension. There's no built-in access control. If you expose sensitive operations (e.g., `fetch` with credentials), be aware that:
- Any installed extension can call your command
- Validate arguments in the handler
- Consider restricting to known callers via a shared secret or nonce

---

## Debugging

### Verify Commands Are Registered

In the browser DevTools console (main window context):

```javascript
// After VS Code loads, commands are in the internal registry.
// You can test directly:
vscode.commands.executeCommand('host.registerServiceWorker', '/sw.js', {})
```

### Check IPC Flow

1. Open DevTools → Network tab → Filter by "WS" to see the MessagePort traffic
2. Add `console.log` in your command handler — it runs on the main page, so logs appear in the main window console
3. Extension-side `console.log` appears in the Output panel → "Extension Host" channel

### Common Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `command 'host.foo' not found` | Typo in command ID, or init() hasn't completed | Verify the ID matches exactly; ensure command is in the `commands` array |
| `Cannot structured clone` | Non-serializable argument or return value | Convert to plain object/array first |
| Handler never executes | Extension is calling before workbench fully initializes | Ensure extension awaits activation properly |
| Timeout on executeCommand | Handler throws but error isn't propagated | Wrap handler body in try/catch, log errors |
