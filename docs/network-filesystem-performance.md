# Network Filesystem Performance

When your `FileSystemProvider` is backed by a network service (WebDAV, S3, SFTP, REST API, etc.), VS Code's automatic configuration probing at startup becomes a performance concern. This document explains the problem and practical mitigation strategies.

## The Problem

When VS Code opens a folder, the workbench immediately issues `stat()` calls against the `FileSystemProvider` for a set of well-known paths. This behavior is hardcoded in VS Code's configuration service, SCM system, debug service, and any active extensions. There is no API or setting to disable it.

### Paths Probed at Startup

| Path | Component | Probed When |
|------|-----------|-------------|
| `/` | File Explorer | Always (root listing) |
| `/.vscode` | Configuration Service | Always |
| `/.vscode/settings.json` | Configuration Service | Always |
| `/.vscode/tasks.json` | Task Service | Always |
| `/.vscode/launch.json` | Debug Service | Always |
| `/.vscode/extensions.json` | Extension Recommendations | Always |
| `/.git` or `/.git/HEAD` | Git/SCM Extension | When Git extension is active |
| `/.editorconfig` | EditorConfig Extension | When EditorConfig extension is active |
| `/.claude/settings.json` | Claude Extension | When Claude extension is installed |
| `/.github/copilot-instructions.md` | GitHub Copilot | When Copilot extension is installed |

With an in-memory or IndexedDB-backed filesystem, each probe is a fast local lookup. With a network backend, each probe is an HTTP round-trip — potentially **10-15 sequential requests** before the editor is usable.

### Impact

```
In-memory filesystem:  ~1ms  total (all probes)
Network filesystem:    ~50-150ms per probe x 12 probes = 600-1800ms added startup time
High-latency backend:  ~200-500ms per probe x 12 probes = 2400-6000ms added startup time
```

---

## Mitigation Strategies

### Strategy 1: Negative Cache

Cache `FileNotFound` results in memory so repeated probes for non-existent paths return instantly.

```typescript
class NetworkFs implements vscode.FileSystemProvider {
  // path -> timestamp of when the negative entry was cached
  private negativeCache = new Map<string, number>();
  private negativeCacheTTL = 30_000; // 30 seconds

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const key = uri.path;
    const cached = this.negativeCache.get(key);
    if (cached && Date.now() - cached < this.negativeCacheTTL) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }

    try {
      return await this.networkStat(uri);
    } catch (e) {
      if (isNotFoundError(e)) {
        this.negativeCache.set(key, Date.now());
        throw vscode.FileSystemError.FileNotFound(uri);
      }
      throw e;
    }
  }

  // Invalidate on file changes
  private invalidateCache(uri: vscode.Uri) {
    this.negativeCache.delete(uri.path);
    // Also invalidate parent directory
    const parent = uri.path.substring(0, uri.path.lastIndexOf("/")) || "/";
    this.negativeCache.delete(parent);
  }
}
```

**Effectiveness**: Eliminates redundant probes after the first cold miss. Does not help with initial startup.

### Strategy 2: Root Directory Prefetch

Issue a single batch request to list the root directory at activation time. Use the result to answer all subsequent `stat()` calls for root-level entries without additional network calls.

This is the **most effective single strategy** because it collapses ~12 network calls into 1.

```typescript
class NetworkFs implements vscode.FileSystemProvider {
  // Stores known entries at each directory level
  private dirCache = new Map<string, Map<string, vscode.FileType>>();

  async prefetchRoot(): Promise<void> {
    // Single network call — e.g., WebDAV PROPFIND with Depth:1
    const entries = await this.networkReadDirectory("/");
    const entryMap = new Map<string, vscode.FileType>();
    for (const [name, type] of entries) {
      entryMap.set(name, type);
    }
    this.dirCache.set("/", entryMap);
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    // For root-level paths, check the prefetched directory listing
    const parts = uri.path.split("/").filter(Boolean);
    if (parts.length === 1) {
      const rootEntries = this.dirCache.get("/");
      if (rootEntries && !rootEntries.has(parts[0])) {
        // We know this entry doesn't exist — no network call needed
        throw vscode.FileSystemError.FileNotFound(uri);
      }
    }

    return await this.networkStat(uri);
  }
}

// In activate():
async function activate(context: vscode.ExtensionContext) {
  const fs = new NetworkFs(/* ... */);
  await fs.prefetchRoot();
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider("webdav", fs)
  );
}
```

**Effectiveness**: One network call instead of ~12. Handles all the `.vscode`, `.git`, `.claude` probes from cache.

**Prerequisite**: Your backend must support directory listing in a single call (WebDAV `PROPFIND`, S3 `ListObjectsV2`, etc.).

### Strategy 3: Positive + Negative Stat Cache

Cache both hits and misses for `stat()` to avoid repeated round-trips for the same file:

```typescript
interface CachedStat {
  result: vscode.FileStat | null; // null = FileNotFound
  timestamp: number;
}

class NetworkFs implements vscode.FileSystemProvider {
  private statCache = new Map<string, CachedStat>();
  private statCacheTTL = 10_000; // 10 seconds

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const key = uri.path;
    const cached = this.statCache.get(key);

    if (cached && Date.now() - cached.timestamp < this.statCacheTTL) {
      if (cached.result === null) {
        throw vscode.FileSystemError.FileNotFound(uri);
      }
      return cached.result;
    }

    try {
      const result = await this.networkStat(uri);
      this.statCache.set(key, { result, timestamp: Date.now() });
      return result;
    } catch (e) {
      if (isNotFoundError(e)) {
        this.statCache.set(key, { result: null, timestamp: Date.now() });
        throw vscode.FileSystemError.FileNotFound(uri);
      }
      throw e;
    }
  }

  // Fire onDidChangeFile and invalidate cache together
  private onFileChanged(uri: vscode.Uri) {
    this.statCache.delete(uri.path);
    this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }
}
```

### Strategy 4: Prefetch Well-Known Paths

If your backend doesn't support directory listing but does support batch/parallel requests, prefetch the known set of paths VS Code will probe:

```typescript
const WELL_KNOWN_PATHS = [
  "/.vscode",
  "/.vscode/settings.json",
  "/.vscode/tasks.json",
  "/.vscode/launch.json",
  "/.vscode/extensions.json",
  "/.git",
  "/.git/HEAD",
  "/.editorconfig",
];

async function prefetchWellKnown(fs: NetworkFs): Promise<void> {
  // Fire all stat() calls in parallel
  const results = await Promise.allSettled(
    WELL_KNOWN_PATHS.map(async (path) => {
      try {
        const stat = await fs.networkStat(path);
        return { path, stat };
      } catch {
        return { path, stat: null };
      }
    })
  );

  // Populate the cache
  for (const result of results) {
    if (result.status === "fulfilled") {
      fs.cacheStatResult(result.value.path, result.value.stat);
    }
  }
}
```

**Effectiveness**: Parallel requests cut wall-clock time from `N * latency` to `~1 * latency`. Still issues N requests (more bandwidth), but the user-perceived delay is much lower.

### Strategy 5: Register as Readonly

If your network filesystem is read-only, declare it:

```typescript
vscode.workspace.registerFileSystemProvider("webdav", provider, {
  isCaseSensitive: true,
  isReadonly: true,
  // Or with a message:
  // isReadonly: { message: "This WebDAV share is read-only" },
});
```

This doesn't reduce `stat()` probes, but it prevents VS Code from issuing `writeFile()` or `createDirectory()` calls — avoiding network round-trips for operations like "save workspace settings" that would fail anyway.

---

## Recommended Combination

For most network filesystems, combine strategies 2 + 1 + 5:

```typescript
class WebDavFs implements vscode.FileSystemProvider {
  private dirCache = new Map<string, Map<string, vscode.FileType>>();
  private negativeCache = new Map<string, number>();
  private negativeCacheTTL = 30_000;

  async prefetchRoot(): Promise<void> {
    const entries = await this.propfind("/", 1);
    const entryMap = new Map<string, vscode.FileType>();
    for (const [name, type] of entries) {
      entryMap.set(name, type);
    }
    this.dirCache.set("/", entryMap);
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const path = uri.path;

    // 1. Check negative cache
    const neg = this.negativeCache.get(path);
    if (neg && Date.now() - neg < this.negativeCacheTTL) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }

    // 2. For root-level entries, check directory cache
    const parts = path.split("/").filter(Boolean);
    if (parts.length >= 1) {
      const parentPath = "/" + parts.slice(0, -1).join("/");
      const parentNormalized = parentPath === "/" ? "/" : parentPath;
      const parentEntries = this.dirCache.get(parentNormalized);
      if (parentEntries && !parentEntries.has(parts[parts.length - 1])) {
        this.negativeCache.set(path, Date.now());
        throw vscode.FileSystemError.FileNotFound(uri);
      }
    }

    // 3. Network call (cache miss)
    try {
      return await this.propfindStat(uri);
    } catch (e) {
      if (isNotFoundError(e)) {
        this.negativeCache.set(path, Date.now());
        throw vscode.FileSystemError.FileNotFound(uri);
      }
      throw e;
    }
  }
}

// Activation
async function activate(context: vscode.ExtensionContext) {
  const fs = new WebDavFs(/* config */);
  await fs.prefetchRoot();

  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider("webdav", fs, {
      isCaseSensitive: true,
      isReadonly: true,
    })
  );
}
```

**Result**: 1 network call at startup instead of ~12. All subsequent probes for missing dotfiles are served from cache.

---

## Cache Invalidation

The hardest part of caching is knowing when to invalidate. Approaches:

| Trigger | Invalidate |
|---------|-----------|
| `onDidChangeFile` event | Clear stat + directory cache for the changed path and its parent |
| TTL expiry | Automatic — entries older than TTL are re-fetched |
| User action (e.g., "Refresh Explorer") | Clear all caches via a command |
| WebSocket/SSE from backend | Real-time invalidation (best for collaborative editing) |

For a WebDAV backend, a reasonable approach is TTL-based expiry (10-30 seconds) plus invalidation on any write operation your provider performs.

---

## Reducing Extension-Driven Probes

Some probes come from extensions (Git, Claude, Copilot) rather than VS Code core. To reduce these:

1. **Don't install unnecessary extensions** — if you don't need Git integration over WebDAV, don't include the Git extension
2. **Use `configurationDefaults`** to disable extension features that probe the filesystem:
   ```javascript
   configurationDefaults: {
     "git.enabled": false,            // Disables Git extension filesystem scanning
     "git.autoRepositoryDetection": false,
   }
   ```
3. **Limit `additionalBuiltinExtensions`** to only what you need

---

## Performance Budget

| Scenario | Startup Overhead | Strategy |
|----------|-----------------|----------|
| In-memory (IndexedDB) | ~1ms | No caching needed |
| Fast network (<50ms RTT) | ~50ms with prefetch | Root prefetch only |
| Medium network (50-200ms RTT) | ~200ms with prefetch | Root prefetch + negative cache |
| High latency (>200ms RTT) | ~500ms+ with prefetch | All strategies combined |
| Offline-capable | ~0ms after first load | Full stat + content cache with persistence |
