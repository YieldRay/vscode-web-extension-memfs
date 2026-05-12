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

## Other Useful Options

### `workspaceProvider`

**Type:** `IWorkspaceProvider`

Controls workspace/folder opening behavior. If not provided, VS Code derives one from `folderUri`/`workspaceUri`.

### `settingsSyncOptions`

**Type:** `{ enabled: boolean }`

Enable/disable Settings Sync.

### `configurationDefaults`

**Type:** `Record<string, unknown>`

Override default settings values. Useful for pre-configuring the editor:

```javascript
configurationDefaults: {
  "editor.fontSize": 14,
  "workbench.colorTheme": "Default Dark+",
  "terminal.integrated.fontSize": 12,
}
```

### `defaultLayout`

**Type:** `IDefaultLayout`

Defines which editors/views to open on first launch:

```javascript
defaultLayout: {
  editors: [
    { uri: { scheme: "memfs", path: "/README.md" }, label: "README" }
  ],
}
```

### `welcomeBanner`

**Type:** `{ message: string; icon?: string }`

Shows a banner at the top of the workbench on first open.

### `additionalTrustedDomains`

**Type:** `string[]`

Domains that VS Code should treat as trusted (won't show "open external" confirmation):

```javascript
additionalTrustedDomains: ["https://your-api.example.com"]
```

### `commands`

**Type:** `readonly ICommand[]`

Pre-register commands that will be available immediately:

```typescript
commands: [
  { id: "myapp.doSomething", handler: (accessor, ...args) => { /* ... */ } }
]
```

### `developmentOptions`

**Type:** `IDevelopmentOptions`

Development-time options:

```javascript
developmentOptions: {
  logLevel: "debug",         // Log verbosity
  extensionTestsPath: "...", // For running extension integration tests
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
});
```
