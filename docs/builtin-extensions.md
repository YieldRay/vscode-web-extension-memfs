# Builtin Extensions & `folderUri`

## `additionalBuiltinExtensions`

This option registers extensions that ship with your self-hosted VS Code instance. They appear as "built-in" — users can disable but not uninstall them.

### Type Definition

```typescript
// From src/vs/workbench/browser/web.api.ts
readonly additionalBuiltinExtensions?: readonly (MarketplaceExtension | UriComponents)[];

// Where:
type MarketplaceExtension =
  | string                              // "publisher.extensionName"
  | {
      id: string;                       // "publisher.extensionName"
      preRelease?: boolean;
      migrateStorageFrom?: string;
    };

interface UriComponents {
  scheme: string;
  authority: string;
  path: string;
  query?: string;
  fragment?: string;
}
```

### Two Forms of Declaration

#### 1. URI Form (self-hosted extension)

Points to a directory on your static server that contains the extension's `package.json`:

```javascript
additionalBuiltinExtensions: [
  {
    scheme: location.protocol.replace(":", ""),  // "http" or "https"
    authority: location.host,                     // "localhost:3000"
    path: location.pathname + "extension/dist",   // "/extension/dist"
  },
]
```

**Directory structure expected by VS Code:**

```
extension/dist/
  ├── package.json        ← VS Code reads this to discover the extension
  ├── package.nls.json    ← Localization strings (optional)
  └── extension.js        ← Main entry point (from package.json "browser" field)
```

VS Code fetches `<uri>/package.json` to read the extension manifest, then loads the `browser` or `main` entry point specified in it.

#### 2. Marketplace Form (from gallery)

References an extension by its marketplace ID:

```javascript
additionalBuiltinExtensions: [
  // Simple string form
  "ms-python.python",

  // Object form (with options)
  { id: "esbenp.prettier-vscode", preRelease: false },
]
```

These are downloaded from the marketplace configured in `productConfiguration.extensionsGallery`.

### How VS Code Discovers URI Extensions

1. VS Code constructs the full URL from the `UriComponents`
2. It fetches `<url>/package.json` via HTTP GET
3. It reads the manifest to find:
   - `"browser"` field — entry point for web extensions
   - `"main"` field — fallback (but may not work in web context)
   - `"activationEvents"` — when to activate
   - `"contributes"` — commands, views, file system providers, etc.
4. The extension is registered as a "builtin" extension

### Example: Serving Your Extension

In this project, webpack outputs to `extension/dist/`:

```
extension/dist/
  ├── package.json        ← Copied by CopyFilesPlugin in webpack config
  ├── package.nls.json    ← Copied by CopyFilesPlugin
  └── extension.js        ← Webpack bundle output
```

The `package.json` has `"browser": "./extension.js"`, so VS Code loads `extension/dist/extension.js` as the entry point.

The `additionalBuiltinExtensions` URI must resolve to the directory containing `package.json` — NOT to the `.js` file directly.

### Dynamic Path Construction

Use `location.*` properties to build paths that work regardless of where the page is served:

```javascript
{
  scheme: location.protocol.replace(":", ""),  // strips the trailing ":"
  authority: location.host,                     // includes port if non-default
  path: location.pathname + "extension/dist",   // relative to index.html
}
```

If `index.html` is at `http://localhost:3000/`, this produces:
`http://localhost:3000/extension/dist`

If deployed to `https://example.com/my-app/`, this produces:
`https://example.com/my-app/extension/dist`

---

## `folderUri`

The initial folder that VS Code opens. This is the workspace root.

### Type

```typescript
folderUri: UriComponents;  // { scheme, authority, path, query?, fragment? }
```

### How It Triggers Extension Activation

When VS Code opens a folder with a given scheme, it fires the `onFileSystem:<scheme>` activation event. Extensions that declare this event in their `activationEvents` will be activated.

```jsonc
// extension/package.json
{
  "activationEvents": ["onFileSystem:memfs"]
}
```

```javascript
// index.html
folderUri: {
  scheme: "memfs",          // ← triggers "onFileSystem:memfs"
  authority: location.host,
  path: "/",
}
```

### Common Schemes

| Scheme | Use Case | Requires |
|--------|----------|----------|
| `memfs` | Custom in-memory filesystem (this project) | Your extension registering a `FileSystemProvider` for `memfs` |
| `vscode-vfs` | GitHub/Azure repos (used by `vscode.dev`) | `github.remotehub` extension installed and active |
| `file` | Local files | A remote server backend (`remoteAuthority`) |
| Custom | Any scheme you define | Your extension calling `registerFileSystemProvider` for that scheme |

**Important**: A `folderUri` with a given scheme only works if a `FileSystemProvider` is registered for that scheme. Otherwise VS Code throws `ENOPRO: No file system provider found for resource`. The provider must either be:
- A builtin extension loaded via `additionalBuiltinExtensions`
- A marketplace extension that activates on `onFileSystem:<scheme>`
- Registered programmatically before VS Code tries to open the folder

### `authority` Field

The `authority` is typically set to `location.host` for custom schemes. It acts as a namespace — different authorities can host different "virtual drives" under the same scheme.

### `path` Field

The root path within the filesystem. Usually `"/"` to open the filesystem root.

---

## Putting It Together

```javascript
init(document.body, {
  // Open the memfs:// root, which triggers our extension
  folderUri: {
    scheme: "memfs",
    authority: location.host,
    path: "/",
    query: "",
  },
  // Load our extension as a builtin
  additionalBuiltinExtensions: [
    {
      scheme: location.protocol.replace(":", ""),
      authority: location.host,
      path: location.pathname + "extension/dist",
    },
  ],
});
```

**Sequence:**
1. VS Code opens the `memfs://localhost:3000/` folder
2. This fires the `onFileSystem:memfs` activation event
3. VS Code scans `additionalBuiltinExtensions`, finds our extension
4. Our extension's `package.json` declares `"activationEvents": ["onFileSystem:memfs"]`
5. VS Code activates our extension, which registers a `FileSystemProvider` for the `memfs` scheme
6. The file explorer populates with the filesystem contents

### Multiple Extensions

You can register multiple built-in extensions:

```javascript
additionalBuiltinExtensions: [
  // Your filesystem extension
  {
    scheme: "https",
    authority: "your-cdn.com",
    path: "/extensions/memfs-ext/dist",
  },
  // A theme extension
  {
    scheme: "https",
    authority: "your-cdn.com",
    path: "/extensions/my-theme/dist",
  },
  // A marketplace extension
  "dbaeumer.vscode-eslint",
]
```
