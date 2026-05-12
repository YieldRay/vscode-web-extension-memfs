# Workbench `init()` Options

The `workbench.js` module exported by `code-oss` exposes a default function (commonly called `init` or `create`) that bootstraps the VS Code web workbench.

```typescript
import init from "code-oss/workbench.js";
init(domElement: HTMLElement, options: IWorkbenchConstructionOptions): IDisposable;
```

## Full Options Interface

The options object conforms to `IWorkbenchConstructionOptions` from VS Code's source (`src/vs/workbench/browser/web.api.ts`). Below are the fields most relevant to self-hosting.

---

## `productConfiguration`

**Type:** `Partial<IProductConfiguration>`

Overrides VS Code's built-in product configuration at runtime. This is the primary way to configure branding, marketplace, and quality settings.

### Key Fields

```typescript
productConfiguration: {
  // Extension marketplace (required for browsing/installing extensions)
  extensionsGallery: {
    serviceUrl: string;        // Gallery API endpoint
    itemUrl: string;           // Extension detail page URL
    resourceUrlTemplate: string; // Template for extension asset downloads
  },

  // Extension host iframe origin template (security-critical)
  webEndpointUrlTemplate: string;

  // Quality tier: "stable" | "insider" | "exploration"
  quality: string;

  // API proposals enabled for specific extensions
  extensionEnabledApiProposals: Record<string, string[]>;

  // Optional overrides
  commit?: string;      // Build commit hash (used in webEndpointUrlTemplate)
  version?: string;     // VS Code version string
  nameShort?: string;   // Product name in title bar
  nameLong?: string;    // Full product name
}
```

### Example: Open VSX Marketplace

```javascript
productConfiguration: {
  extensionsGallery: {
    serviceUrl: "https://open-vsx.org/vscode/gallery",
    itemUrl: "https://open-vsx.org/vscode/item",
    resourceUrlTemplate:
      "https://openvsxorg.blob.core.windows.net/resources/{publisher}/{name}/{version}/{path}",
  },
  quality: "stable",
}
```

### Marketplace Options

| Marketplace | `serviceUrl` | Notes |
|-------------|-------------|-------|
| Open VSX | `https://open-vsx.org/vscode/gallery` | Open-source, community-run |
| Eclipse Open VSX | `https://open-vsx.org/vscode/gallery` | Same as above |
| Microsoft (blocked) | `https://marketplace.visualstudio.com/_apis/public/gallery` | Only available to official VS Code builds |

---

## `folderUri`

**Type:** `UriComponents`

Specifies the initial folder/workspace to open. This is a URI object (not a string) following VS Code's `UriComponents` shape:

```typescript
folderUri: {
  scheme: string;      // e.g., "memfs", "file", "vscode-vfs"
  authority: string;   // e.g., location.host, "github"
  path: string;        // e.g., "/"
  query?: string;
  fragment?: string;
}
```

### Examples

```javascript
// In-memory filesystem (custom scheme registered by your extension)
folderUri: {
  scheme: "memfs",
  authority: location.host,
  path: "/",
  query: "",
}
```

The `folderUri` triggers the `onFileSystem:<scheme>` activation event, which loads any extension registered to handle that scheme.

**Important**: The scheme must have a corresponding `FileSystemProvider` registered by an extension. If no provider exists for the scheme, VS Code throws `ENOPRO: No file system provider found for resource`. Make sure the extension that registers the provider is included in `additionalBuiltinExtensions` or installed from the marketplace.

---

## `additionalBuiltinExtensions`

**Type:** `readonly (MarketplaceExtension | UriComponents)[]`

Registers extra built-in extensions that cannot be uninstalled (only disabled). Accepts two forms:

1. **URI location** — points to where the extension is hosted (must serve `package.json` at root)
2. **Marketplace ID** — string like `"publisher.extensionName"` or `{ id: "publisher.extensionName", preRelease?: boolean }`

```javascript
additionalBuiltinExtensions: [
  // URI form: points to a directory containing package.json + dist/
  {
    scheme: location.protocol.replace(":", ""),  // "http" or "https"
    authority: location.host,
    path: location.pathname + "extension/dist",
  },
  // Marketplace form: installs from gallery
  "ms-python.python",
  { id: "esbenp.prettier-vscode", preRelease: false },
]
```

See [Builtin Extensions & folderUri](./builtin-extensions.md) for full details.

---

## `webEndpointUrlTemplate`

**Type:** `string`

Template URL for the extension host iframe's origin. VS Code replaces these placeholders:

| Placeholder | Replaced With |
|-------------|---------------|
| `{{uuid}}` | `v--<hash>` where hash is derived from parent origin + a stable UUID |
| `{{commit}}` | Value of `productConfiguration.commit` |
| `{{quality}}` | Value of `productConfiguration.quality` |

When this is a simple URL without placeholders (e.g., a CDN base), VS Code uses it directly.

See [Extension Host Iframe](./extension-host-iframe.md) for full details.

---

## Extension ↔ Main Page Bridge

These options are the **primary mechanism** for extensions (running in a cross-origin web worker) to execute code on the main page. See [Extension ↔ Main Page Bridge](./extension-main-page-bridge.md) for full details.

### `commands`

**Type:** `readonly ICommand[]`

Registers command handlers that **run on the main window thread**. Extensions call them via `vscode.commands.executeCommand(id, ...args)` — VS Code's IPC bridges the cross-origin gap automatically.

```typescript
interface ICommand {
  /** Unique identifier. Extensions call via executeCommand(id). */
  id: string;
  /** If set, command appears in the Command Palette. */
  label?: string;
  /** Menus to show the command in. Only valid when label is set. */
  menu?: Menu | Menu[];  // Menu.CommandPalette | Menu.StatusBarWindowIndicatorMenu
  /** Handler receives caller's arguments. Return value is sent back. */
  handler: (...args: unknown[]) => unknown;
}
```

```javascript
// index.html
commands: [
  {
    id: 'host.registerServiceWorker',
    handler: async (scriptUrl, options) => {
      const reg = await navigator.serviceWorker.register(scriptUrl, options);
      await navigator.serviceWorker.ready;
      return { scope: reg.scope, state: reg.active?.state };
    }
  },
  {
    id: 'host.getClipboard',
    handler: async () => navigator.clipboard.readText(),
  }
],
```

```typescript
// extension.ts — calls execute on the main window
const result = await vscode.commands.executeCommand('host.registerServiceWorker', '/sw.js', { scope: '/' });
```

**Key facts:**
- Handlers do **NOT** receive a `ServicesAccessor` — that's internal only. They receive only the args passed by the caller.
- Arguments and return values must be **serializable** (structured clone across the IPC boundary). No functions, DOM nodes, or class instances.
- Commands registered here coexist with extension-contributed commands in the same registry.

### `messagePorts`

**Type:** `ReadonlyMap<ExtensionId, MessagePort>`

Delivers a `MessagePort` directly to a specific extension, enabling high-throughput binary communication between the hosting page and the extension worker — bypassing the VS Code command serialization overhead.

```javascript
// index.html
const channel = new MessageChannel();
const hostPort = channel.port2;

// Listen for messages from the extension
hostPort.onmessage = (event) => {
  const { id, method, args } = event.data;
  if (method === 'registerServiceWorker') {
    navigator.serviceWorker.register(...args).then(reg => {
      hostPort.postMessage({ id, result: { scope: reg.scope } });
    });
  }
};

init(document.body, {
  // port1 is transferred to the extension host worker
  messagePorts: new Map([
    ['your-publisher.your-extension', channel.port1]
  ]),
  // ... other options
});
```

**Delivery mechanism:** VS Code transfers the port through the iframe relay to the extension host worker. The port travels:
1. Main page → iframe (via `postMessage` with transfer)
2. Iframe → Worker (via `worker.postMessage` with transfer)

**Extension-side access:** Currently requires the **proposed** `vscode.env.getMessagePort()` API. This is not yet stable — use `commands` unless you specifically need streaming or high-frequency communication.

---

## Workspace & Layout

### `workspaceProvider`

**Type:** `IWorkspaceProvider`

Controls how workspaces are opened and provides the initial workspace state.

```typescript
interface IWorkspaceProvider {
  /** The initial workspace to open (folder, multi-root, or undefined for empty). */
  readonly workspace: IWorkspace;
  /** Arbitrary payload from the open call. */
  readonly payload?: object;
  /** Whether the workspace is trusted. */
  readonly trusted: boolean | undefined;
  /** Opens a workspace. Returns true if successful. */
  open(workspace: IWorkspace, options?: { reuse?: boolean; payload?: object }): Promise<boolean>;
}

// IWorkspace is one of:
type IWorkspace = IWorkspaceToOpen | IFolderToOpen | undefined;
```

If not provided, VS Code derives a workspace provider from `folderUri` / `workspaceUri`. Override this to control:
- How "Open Folder" / "Open Workspace" dialogs behave
- Whether to reload or reuse the current window
- Custom workspace resolution logic

### `configurationDefaults`

**Type:** `Record<string, unknown>`

Override default settings values. Applied before user settings load:

```javascript
configurationDefaults: {
  "editor.fontSize": 14,
  "workbench.colorTheme": "Default Dark+",
  "terminal.integrated.fontSize": 12,
  "git.enabled": false,  // Disable Git probing for virtual filesystems
}
```

### `defaultLayout`

**Type:** `IDefaultLayout`

Defines which editors/views to open on first launch:

```typescript
interface IDefaultLayout {
  readonly views?: IDefaultView[];        // { id: string }
  readonly editors?: IDefaultEditor[];    // { uri, viewColumn?, options?, openOnlyIfExists? }
  readonly layout?: { editors?: EditorGroupLayout };
  readonly force?: boolean;               // Apply even if not first-time open
}
```

```javascript
defaultLayout: {
  editors: [
    {
      uri: { scheme: "memfs", path: "/README.md" },
      openOnlyIfExists: true,
    }
  ],
  views: [
    { id: "workbench.explorer.fileView" }
  ],
}
```

### `enableWorkspaceTrust`

**Type:** `boolean`

Enable/disable the Workspace Trust feature. When disabled, all workspaces are implicitly trusted.

---

## Branding & UI

### `welcomeBanner`

**Type:** `IWelcomeBanner`

Shows a dismissible banner above the workbench:

```javascript
welcomeBanner: {
  message: "Welcome to MyApp! [Get started](command:myapp.gettingStarted).",
}
```

The message supports markdown links including `command:` URIs.

### `windowIndicator`

**Type:** `IWindowIndicator`

Customizes the remote indicator in the bottom-left status bar:

```typescript
interface IWindowIndicator {
  readonly onDidChange?: Event<void>;  // fires when label/tooltip change
  label: string;                        // supports octicons: "$(globe) My Server"
  tooltip: string;
  command?: string;                     // command to run on click
}
```

```javascript
windowIndicator: {
  label: "$(globe) MemFS",
  tooltip: "Connected to in-memory filesystem",
  command: "memfs.showInfo",
}
```

### `initialColorTheme`

**Type:** `IInitialColorTheme`

Prevents the "flash of unstyled content" by providing initial theme colors before the full theme loads:

```typescript
interface IInitialColorTheme {
  readonly themeType: 'dark' | 'light' | 'hcDark' | 'hcLight';
  readonly colors?: { [colorId: string]: string };
}
```

```javascript
initialColorTheme: {
  themeType: "dark",
  colors: {
    "editor.background": "#1e1e1e",
    "sideBar.background": "#252526",
    "activityBar.background": "#333333",
  },
}
```

---

## Authentication & Secrets

### `secretStorageProvider`

**Type:** `ISecretStorageProvider`

Provides persistent secret storage for extensions (tokens, API keys):

```typescript
interface ISecretStorageProvider {
  type: 'in-memory' | 'persisted' | 'unknown';
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}
```

If not provided, VS Code uses an in-memory store (secrets lost on reload). For persistence, back this with IndexedDB or a server endpoint.

### `authenticationProviders`

**Type:** `readonly IAuthenticationProvider[]`

Registers authentication providers that take precedence over extension-contributed ones. Useful for embedding OAuth flows without requiring separate auth extensions.

### `settingsSyncOptions`

**Type:** `ISettingsSyncOptions`

```typescript
interface ISettingsSyncOptions {
  readonly enabled: boolean;
  readonly authenticationProvider?: { id: string };
  readonly enablementHandler?(enablement: boolean): void;
}
```

---

## Networking & Tunneling

### `remoteAuthority`

**Type:** `string`

The IP:PORT the workbench connects to for remote operations. When set, VS Code establishes a WebSocket connection to the remote server.

### `serverBasePath`

**Type:** `string`

Absolute path where the workbench is served from. Used for constructing WebSocket URLs.

### `connectionToken`

**Type:** `string | Promise<string>`

Authentication token for the remote server connection.

### `webSocketFactory`

**Type:** `IWebSocketFactory`

Factory for creating WebSocket connections. Override to use custom WebSocket implementations, add auth headers, or proxy connections.

### `resolveExternalUri`

**Type:** `(uri: URI) => Promise<URI>`

Transforms a URI before it's opened externally. Used to map `localhost:PORT` to publicly-accessible tunnel URLs:

```javascript
resolveExternalUri: async (uri) => {
  if (uri.scheme === 'http' && uri.authority.startsWith('localhost')) {
    return URI.parse(`https://my-tunnel.example.com${uri.path}`);
  }
  return uri;
}
```

### `tunnelProvider`

**Type:** `ITunnelProvider`

Provides port forwarding / tunneling capability:

```typescript
interface ITunnelProvider {
  tunnelFactory?: (options: ITunnelOptions) => Promise<ITunnel> | undefined;
  showPortCandidate?: (host: string, port: number, detail: string) => Promise<boolean>;
  features?: TunnelProviderFeatures;
}
```

### `resourceUriProvider`

**Type:** `(uri: URI) => URI`

Maps resource URIs (e.g., for loading extension assets). Called after `connectionToken` resolves.

### `remoteResourceProvider`

**Type:** `IRemoteResourceProvider`

Alternative to `resourceUriProvider` — handles resource loading via a delegation pattern rather than URI rewriting. Mutually exclusive with `resourceUriProvider`.

---

## URL & Protocol Handling

### `urlCallbackProvider`

**Type:** `IURLCallbackProvider`

Integrates with protocol handler callbacks (e.g., OAuth redirects via `vscode://` URIs):

```typescript
interface IURLCallbackProvider {
  /** Creates a callback URI. */
  create(options?: Partial<UriComponents>): URI;
  /** Fires when a callback URI is triggered. */
  readonly onCallback: Event<URI>;
}
```

Used by `vscode.env.asExternalUri` for OAuth flows. VS Code's default implementation uses `localStorage` polling.

### `additionalTrustedDomains`

**Type:** `string[]`

Domains that VS Code treats as trusted (no "open external" confirmation dialog):

```javascript
additionalTrustedDomains: ["https://your-api.example.com", "https://oauth.provider.com"]
```

### `openerAllowedExternalUrlPrefixes`

**Type:** `string[]`

URL prefixes allowed access to the opener window (used for `window.close()` flows in OAuth popups).

### `codeExchangeProxyEndpoints`

**Type:** `{ [providerId: string]: string }`

Endpoints for proxying OAuth code exchange calls in the browser (since the browser cannot safely make code-exchange requests that require client secrets):

```javascript
codeExchangeProxyEndpoints: {
  "github": "https://your-backend.com/auth/github/exchange",
}
```

---

## Profiles

### `profile`

**Type:** `{ name: string; contents?: string | UriComponents }`

Specifies a named profile for the workbench session. Profiles isolate settings, extensions, and UI state.

### `profileToPreview`

**Type:** `UriComponents`

URI of a profile to preview (read-only inspection).

---

## Telemetry & Development

### `resolveCommonTelemetryProperties`

**Type:** `() => { [key: string]: unknown }`

Adds custom properties to all telemetry events.

### `developmentOptions`

**Type:** `IDevelopmentOptions`

Development-time options:

```javascript
developmentOptions: {
  logLevel: "debug",         // Log verbosity
  extensionTestsPath: "...", // For running extension integration tests
}
```

### `updateProvider`

**Type:** `IUpdateProvider`

Supports reporting available updates to the user.

### `productQualityChangeHandler`

**Type:** `(newQuality: 'insider' | 'stable') => void`

Called when the user wants to switch between Insider and Stable builds.

---

## Extensions

### `enabledExtensions`

**Type:** `readonly ExtensionId[]`

Extensions to enable if already installed. Does NOT auto-install — only enables previously-disabled extensions.

### `extensionEnabledApiProposals`

**Type:** `Record<string, string[]>` (inside `productConfiguration`)

Enables proposed VS Code APIs for specific extensions:

```javascript
productConfiguration: {
  extensionEnabledApiProposals: {
    "your-publisher.your-extension": ["fileSearchProvider", "textSearchProvider"]
  }
}
```

---

## Complete Example

```javascript
import init from "https://raw.esm.sh/code-oss@1.119.0/workbench.js";

init(document.body, {
  productConfiguration: {
    extensionsGallery: {
      serviceUrl: "https://open-vsx.org/vscode/gallery",
      itemUrl: "https://open-vsx.org/vscode/item",
      resourceUrlTemplate:
        "https://openvsxorg.blob.core.windows.net/resources/{publisher}/{name}/{version}/{path}",
    },
    webEndpointUrlTemplate: "https://raw.esm.sh/code-oss@1.119.0",
    extensionEnabledApiProposals: {},
    quality: "stable",
  },
  folderUri: {
    scheme: "memfs",
    authority: location.host,
    path: "/",
    query: "",
  },
  additionalBuiltinExtensions: [
    {
      scheme: location.protocol.replace(":", ""),
      authority: location.host,
      path: location.pathname + "extension/dist",
    },
  ],
  configurationDefaults: {
    "workbench.colorTheme": "Default Dark+",
  },

  // Bridge: expose main-page APIs to extensions
  commands: [
    {
      id: "host.registerServiceWorker",
      handler: async (scriptUrl, options) => {
        const reg = await navigator.serviceWorker.register(scriptUrl, options);
        await navigator.serviceWorker.ready;
        return { scope: reg.scope, state: reg.active?.state };
      },
    },
  ],

  // Prevent theme flash
  initialColorTheme: {
    themeType: "dark",
  },

  // Status bar indicator
  windowIndicator: {
    label: "$(globe) MemFS",
    tooltip: "In-memory filesystem backed by IndexedDB",
  },
});
```

---

## All Options At a Glance

| Option | Category | Purpose |
|--------|----------|---------|
| `productConfiguration` | Core | Marketplace, quality, commit, branding |
| `folderUri` | Core | Initial folder to open |
| `workspaceUri` | Core | Initial multi-root workspace to open |
| `additionalBuiltinExtensions` | Extensions | Built-in extensions (URI or marketplace) |
| `enabledExtensions` | Extensions | Enable already-installed extensions |
| `commands` | **Bridge** | Register main-page handlers callable from extensions |
| `messagePorts` | **Bridge** | Deliver MessagePorts directly to extensions |
| `workspaceProvider` | Workspace | Custom workspace open behavior |
| `configurationDefaults` | Workspace | Default settings overrides |
| `defaultLayout` | Workspace | Initial editors/views on first open |
| `enableWorkspaceTrust` | Workspace | Enable/disable Workspace Trust |
| `welcomeBanner` | Branding | Dismissible banner message |
| `windowIndicator` | Branding | Status bar remote indicator |
| `initialColorTheme` | Branding | Prevent theme flash on load |
| `profile` | Profiles | Named profile for session isolation |
| `profileToPreview` | Profiles | Preview a profile (read-only) |
| `secretStorageProvider` | Auth | Persistent secret storage |
| `authenticationProviders` | Auth | Built-in auth providers |
| `settingsSyncOptions` | Auth | Settings Sync configuration |
| `codeExchangeProxyEndpoints` | Auth | OAuth code exchange proxy |
| `remoteAuthority` | Networking | Remote server address |
| `serverBasePath` | Networking | Server base path |
| `connectionToken` | Networking | Remote connection auth token |
| `webSocketFactory` | Networking | Custom WebSocket implementation |
| `resolveExternalUri` | Networking | URI rewriting for tunnels |
| `tunnelProvider` | Networking | Port forwarding support |
| `resourceUriProvider` | Networking | Resource URI mapping |
| `remoteResourceProvider` | Networking | Resource delegation |
| `urlCallbackProvider` | URL handling | Protocol handler integration |
| `additionalTrustedDomains` | URL handling | Skip "open external" dialog |
| `openerAllowedExternalUrlPrefixes` | URL handling | Allow opener window access |
| `resolveCommonTelemetryProperties` | Telemetry | Custom telemetry properties |
| `developmentOptions` | Development | Log level, test paths |
| `updateProvider` | Updates | Report available updates |
| `productQualityChangeHandler` | Updates | Handle quality tier switching |
