/**
 * https://code.visualstudio.com/api/extension-guides/web-extensions
 * https://code.visualstudio.com/api/extension-guides/virtual-workspaces
 *
 * This extension uses `almostnode` (loaded on the main page via index.html)
 * for both the virtual filesystem and terminal command execution.
 * Communication with the main page happens through the `host.eval` / `host.promise`
 * commands bridge, since the extension host runs in a cross-origin web worker.
 */

import * as vscode from "vscode";
import { runOnHost, createHostFunction } from "./host-bridge";
import { AlmostNodeTerminal } from "./terminal";

// --- Host functions (reusable, executed on main page) ---

const initContainer = createHostFunction(() => {
  if (!globalThis.container) {
    globalThis.container = globalThis.almostnode.createContainer({
      cwd: "/",
      onServerReady: (port: number, url: string) => {
        globalThis._pendingServers.push({ port, url });
      },
    });

    // Track VFS changes for precise file explorer updates.
    // watch() catches writeFile (change/rename), unlink (rename), and rename (rename).
    // on('delete') catches unlink specifically.
    globalThis._vfsChanges = [];
    globalThis.container.vfs.watch("/", { recursive: true }, (eventType: string, filename: string | null) => {
      if (filename) {
        const fullPath = filename.startsWith("/") ? filename : "/" + filename;
        globalThis._vfsChanges.push({
          path: fullPath,
          type: eventType === "rename" ? "created" : "changed",
        });
      }
    });
    globalThis.container.vfs.on("delete", (path: string) => {
      globalThis._vfsChanges.push({ path, type: "deleted" });
    });
  }
  return "ok";
});

/** Restore VFS from IndexedDB snapshot (if one exists). */
const restoreVfs = createHostFunction(() => {
  return new Promise((resolve) => {
    const request = indexedDB.open("memfs-persist", 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("snapshots")) {
        db.createObjectStore("snapshots");
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction("snapshots", "readonly");
      const store = tx.objectStore("snapshots");
      const get = store.get("vfs");
      get.onsuccess = () => {
        const snapshot = get.result;
        if (snapshot && snapshot.files) {
          // Replay snapshot into existing VFS
          const vfs = globalThis.container.vfs;
          // Sort by depth so parents are created before children
          const sorted = snapshot.files
            .slice()
            .sort((a: any, b: any) => a.path.split("/").length - b.path.split("/").length);
          for (const entry of sorted) {
            if (entry.path === "/") continue;
            if (entry.type === "directory") {
              try { vfs.mkdirSync(entry.path, { recursive: true }); } catch {}
            } else if (entry.type === "file") {
              try {
                // entry.content is base64 encoded
                const binary = atob(entry.content || "");
                const bytes = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i++) {
                  bytes[i] = binary.charCodeAt(i);
                }
                vfs.writeFileSync(entry.path, bytes);
              } catch {}
            }
          }
          resolve(true);
        } else {
          resolve(false);
        }
        db.close();
      };
      get.onerror = () => { resolve(false); };
    };
    request.onerror = () => { resolve(false); };
  });
});

/** Save current VFS snapshot to IndexedDB. */
const saveVfs = createHostFunction(() => {
  return new Promise((resolve) => {
    const snapshot = globalThis.container.vfs.toSnapshot();
    const request = indexedDB.open("memfs-persist", 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("snapshots")) {
        db.createObjectStore("snapshots");
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction("snapshots", "readwrite");
      const store = tx.objectStore("snapshots");
      store.put(snapshot, "vfs");
      tx.oncomplete = () => { resolve("ok"); db.close(); };
      tx.onerror = () => { resolve("error"); db.close(); };
    };
    request.onerror = () => { resolve("error"); };
  });
});

const initServiceWorker = createHostFunction(() => {
  return globalThis.container.serverBridge.initServiceWorker();
});

/** Drain the pending servers queue and return any new servers. */
const drainPendingServers = createHostFunction(() => {
  const servers = globalThis._pendingServers.splice(0);
  return servers;
});

/** Drain accumulated VFS change events. */
const drainVfsChanges = createHostFunction(() => {
  const changes = globalThis._vfsChanges.splice(0);
  return changes;
});

const vfsStat = createHostFunction((fsPath: string) => {
  const s = globalThis.container.vfs.statSync(fsPath);
  return {
    isFile: s.isFile(),
    isDirectory: s.isDirectory(),
    ctimeMs: s.ctimeMs,
    mtimeMs: s.mtimeMs,
    size: s.size,
  };
});

const vfsReadDir = createHostFunction((fsPath: string) => {
  const vfs = globalThis.container.vfs;
  const entries = vfs.readdirSync(fsPath);
  return entries.map((name: string) => {
    const childPath = fsPath === "/" ? "/" + name : fsPath + "/" + name;
    const stat = vfs.statSync(childPath);
    return { name, isFile: stat.isFile(), isDirectory: stat.isDirectory() };
  });
});

const vfsReadFile = createHostFunction((fsPath: string) => {
  const vfs = globalThis.container.vfs;
  const data = vfs.readFileSync(fsPath);
  // Encode as base64 for safe binary transfer across the bridge
  let binary = "";
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]);
  }
  return btoa(binary);
});

const vfsWriteFile = createHostFunction((fsPath: string, base64: string, create: boolean, overwrite: boolean) => {
  const vfs = globalThis.container.vfs;
  const exists = vfs.existsSync(fsPath);
  if (!exists && !create) {
    const err: any = new Error("ENOENT: no such file or directory");
    err.code = "ENOENT";
    throw err;
  }
  if (exists && !overwrite) {
    const err: any = new Error("EEXIST: file already exists");
    err.code = "EEXIST";
    throw err;
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  vfs.writeFileSync(fsPath, bytes);
  return "ok";
});

const vfsDelete = createHostFunction((fsPath: string, recursive: boolean) => {
  const vfs = globalThis.container.vfs;
  const stat = vfs.statSync(fsPath);
  if (stat.isDirectory()) {
    if (recursive) {
      function rmrf(p: string) {
        const entries = vfs.readdirSync(p);
        for (const e of entries) {
          const child = p === "/" ? "/" + e : p + "/" + e;
          const s = vfs.statSync(child);
          if (s.isDirectory()) rmrf(child);
          else vfs.unlinkSync(child);
        }
        if (p !== "/") vfs.rmdirSync(p);
      }
      rmrf(fsPath);
    } else {
      vfs.rmdirSync(fsPath);
    }
  } else {
    vfs.unlinkSync(fsPath);
  }
  return "ok";
});

const vfsRename = createHostFunction((oldPath: string, newPath: string, overwrite: boolean) => {
  const vfs = globalThis.container.vfs;
  if (overwrite && vfs.existsSync(newPath)) {
    const stat = vfs.statSync(newPath);
    if (stat.isDirectory()) {
      function rmrf(p: string) {
        const entries = vfs.readdirSync(p);
        for (const e of entries) {
          const child = p === "/" ? "/" + e : p + "/" + e;
          const s = vfs.statSync(child);
          if (s.isDirectory()) rmrf(child);
          else vfs.unlinkSync(child);
        }
        if (p !== "/") vfs.rmdirSync(p);
      }
      rmrf(newPath);
    } else {
      vfs.unlinkSync(newPath);
    }
  }
  vfs.renameSync(oldPath, newPath);
  return "ok";
});

const vfsCopy = createHostFunction((sourcePath: string, destPath: string, overwrite: boolean) => {
  const vfs = globalThis.container.vfs;
  if (!vfs.existsSync(sourcePath)) {
    const err: any = new Error("ENOENT");
    err.code = "ENOENT";
    throw err;
  }
  if (vfs.existsSync(destPath) && !overwrite) {
    const err: any = new Error("EEXIST");
    err.code = "EEXIST";
    throw err;
  }
  const stat = vfs.statSync(sourcePath);
  if (stat.isDirectory()) {
    function copyDir(src: string, dest: string) {
      vfs.mkdirSync(dest, { recursive: true });
      const entries = vfs.readdirSync(src);
      for (const e of entries) {
        const childSrc = src === "/" ? "/" + e : src + "/" + e;
        const childDest = dest === "/" ? "/" + e : dest + "/" + e;
        const s = vfs.statSync(childSrc);
        if (s.isDirectory()) copyDir(childSrc, childDest);
        else vfs.copyFileSync(childSrc, childDest);
      }
    }
    copyDir(sourcePath, destPath);
  } else {
    vfs.copyFileSync(sourcePath, destPath);
  }
  return "ok";
});

const vfsMkdir = createHostFunction((fsPath: string) => {
  globalThis.container.vfs.mkdirSync(fsPath, { recursive: true });
  return "ok";
});

const vfsReset = createHostFunction(() => {
  const vfs = globalThis.container.vfs;
  const entries = vfs.readdirSync("/");
  function rmrf(p: string) {
    const children = vfs.readdirSync(p);
    for (const e of children) {
      const child = p === "/" ? "/" + e : p + "/" + e;
      const s = vfs.statSync(child);
      if (s.isDirectory()) rmrf(child);
      else vfs.unlinkSync(child);
    }
    if (p !== "/") vfs.rmdirSync(p);
  }
  for (const entry of entries) {
    const path = "/" + entry;
    const stat = vfs.statSync(path);
    if (stat.isDirectory()) rmrf(path);
    else vfs.unlinkSync(path);
  }
  return "ok";
});

// --- Preview ---

/** Track which ports we've already opened previews for (avoid duplicates). */
const openedPorts = new Set<number>();

/**
 * Notify the user that a server is ready and offer to open it.
 *
 * We use a notification with a button instead of auto-opening because:
 * 1. The Service Worker only intercepts in the main page's browsing context,
 *    so the URL must open in a new browser tab (not inside VS Code's webview).
 * 2. Browsers block window.open() unless triggered by a user gesture.
 *    A notification button click counts as a user gesture.
 */
async function openPreview(port: number, url: string) {
  if (openedPorts.has(port)) return;
  openedPorts.add(port);

  const previewUrl = url.endsWith("/") ? url : url + "/";
  const action = await vscode.window.showInformationMessage(
    `Server listening on port ${port}`,
    "Open in Browser",
  );
  if (action === "Open in Browser") {
    await vscode.env.openExternal(vscode.Uri.parse(previewUrl));
  }
}

/**
 * Check for newly started servers and open previews for them.
 */
async function checkForNewServers() {
  try {
    const servers: Array<{ port: number; url: string }> = await drainPendingServers();
    for (const { port, url } of servers) {
      console.log(`[MemFS] Server ready on port ${port}: ${url}`);
      openPreview(port, url);
    }
  } catch (err) {
    // Ignore errors — servers may not have started
  }
}

// --- Extension activation ---

export async function activate(context: vscode.ExtensionContext) {
  await initContainer();
  await restoreVfs();
  await initServiceWorker();

  console.log("Hello, MemFS! (powered by almostnode)");
  console.log("User agent:", await runOnHost(() => navigator.userAgent));

  const memFs = new MemFS("memfs");
  context.subscriptions.push(memFs);
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider("memfs", memFs, { isCaseSensitive: true }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("memfs.reset", async () => {
      await vfsReset();
      await flushVfsChanges();
      await saveVfs(); // Immediate save on reset since user may reload
      vscode.window.showInformationMessage("MemFS cleared, please reload the window.");
    }),
  );

  // Terminal
  const workspaceAuthority = vscode.workspace.workspaceFolders?.[0]?.uri.authority ?? "";

  /**
   * Drain VFS change events from the main page and fire precise
   * FileChangeEvents so the explorer updates immediately.
   *
   * The VFS emits 'change' for both new and modified files (no distinction),
   * so we fire both Created and Changed events. VS Code handles duplicates gracefully.
   * For deletions, we fire Deleted. Parent directories always get a Changed event
   * so the explorer re-reads their listing.
   */
  async function flushVfsChanges() {
    try {
      const changes: Array<{ path: string; type: string }> = await drainVfsChanges();
      if (changes.length === 0) return;

      // Deduplicate: keep last event per path
      const byPath = new Map<string, string>();
      for (const c of changes) {
        byPath.set(c.path, c.type);
      }

      const events: vscode.FileChangeEvent[] = [];
      const notifiedParents = new Set<string>();

      for (const [path, type] of byPath) {
        const uri = vscode.Uri.from({ scheme: "memfs", authority: workspaceAuthority, path });

        if (type === "deleted") {
          events.push({ type: vscode.FileChangeType.Deleted, uri });
        } else if (type === "created") {
          events.push({ type: vscode.FileChangeType.Created, uri });
        } else {
          events.push({ type: vscode.FileChangeType.Changed, uri });
        }

        // Notify parent directory so the explorer refreshes its listing
        const parent = path.substring(0, path.lastIndexOf("/")) || "/";
        if (!notifiedParents.has(parent)) {
          notifiedParents.add(parent);
          events.push({
            type: vscode.FileChangeType.Changed,
            uri: vscode.Uri.from({ scheme: "memfs", authority: workspaceAuthority, path: parent }),
          });
        }
      }

      memFs.fireChanges(events);
    } catch {
      // Fallback: broad refresh
      memFs.fireChanges([
        {
          type: vscode.FileChangeType.Changed,
          uri: vscode.Uri.from({ scheme: "memfs", authority: workspaceAuthority, path: "/" }),
        },
      ]);
    }
  }

  async function onCommandDone() {
    await flushVfsChanges();
    await checkForNewServers();
    // Persist VFS to IndexedDB (debounced to avoid excessive writes)
    scheduleSave();
  }

  function createTerminal() {
    const pty = new AlmostNodeTerminal(onCommandDone);
    return vscode.window.createTerminal({ name: "bash", pty });
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("memfs.newTerminal", () => {
      createTerminal().show();
    }),
  );

  context.subscriptions.push(
    vscode.window.registerTerminalProfileProvider("memfs.bash", {
      provideTerminalProfile(): vscode.TerminalProfile {
        return new vscode.TerminalProfile({
          name: "bash",
          pty: new AlmostNodeTerminal(onCommandDone),
        });
      },
    }),
  );

  // Auto-open the first terminal
  try {
    createTerminal().show();
  } catch (err) {
    console.error("[MemFS] Failed to create terminal:", err);
  }
}

// --- FileSystemProvider ---

/** Debounced VFS persistence — coalesces rapid writes into a single save. */
let _saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSave() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => { _saveTimer = null; saveVfs(); }, 2000);
}

class MemFS implements vscode.FileSystemProvider, vscode.Disposable {
  private _changeEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._changeEmitter.event;

  constructor(public readonly scheme: string) {}

  fireChanges(events: vscode.FileChangeEvent[]): void {
    if (events.length > 0) {
      this._changeEmitter.fire(events);
    }
  }

  dispose(): void {
    this._changeEmitter.dispose();
  }

  watch(_uri: vscode.Uri, _options: { recursive: boolean; excludes: string[] }): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const fsPath = this.asFsPath(uri);
    try {
      const stats = await vfsStat(fsPath);
      return {
        type: stats.isFile
          ? vscode.FileType.File
          : stats.isDirectory
            ? vscode.FileType.Directory
            : vscode.FileType.Unknown,
        ctime: stats.ctimeMs ?? 0,
        mtime: stats.mtimeMs ?? 0,
        size: stats.size ?? 0,
      };
    } catch (error: any) {
      throw this.toFileSystemError(error, uri);
    }
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const fsPath = this.asFsPath(uri);
    try {
      const entries = await vfsReadDir(fsPath);
      return entries.map((e: any) => [
        e.name,
        e.isFile ? vscode.FileType.File : e.isDirectory ? vscode.FileType.Directory : vscode.FileType.Unknown,
      ]);
    } catch (error: any) {
      throw this.toFileSystemError(error, uri);
    }
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const fsPath = this.asFsPath(uri);
    try {
      const base64 = await vfsReadFile(fsPath);
      const binaryStr = atob(base64);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }
      return bytes;
    } catch (error: any) {
      throw this.toFileSystemError(error, uri);
    }
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }): Promise<void> {
    const fsPath = this.asFsPath(uri);
    try {
      let binary = "";
      for (let i = 0; i < content.length; i++) {
        binary += String.fromCharCode(content[i]);
      }
      const base64 = btoa(binary);
      await vfsWriteFile(fsPath, base64, options.create, options.overwrite);
      scheduleSave();
    } catch (error: any) {
      throw this.toFileSystemError(error, uri);
    }
  }

  async delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> {
    const fsPath = this.asFsPath(uri);
    try {
      await vfsDelete(fsPath, options.recursive);
      scheduleSave();
    } catch (error: any) {
      throw this.toFileSystemError(error, uri);
    }
  }

  async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
    try {
      await vfsRename(this.asFsPath(oldUri), this.asFsPath(newUri), options.overwrite);
      scheduleSave();
    } catch (error: any) {
      throw this.toFileSystemError(error, oldUri);
    }
  }

  async copy(source: vscode.Uri, destination: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
    try {
      await vfsCopy(this.asFsPath(source), this.asFsPath(destination), options.overwrite);
      scheduleSave();
    } catch (error: any) {
      throw this.toFileSystemError(error, source);
    }
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    const fsPath = this.asFsPath(uri);
    try {
      await vfsMkdir(fsPath);
      scheduleSave();
    } catch (error: any) {
      throw this.toFileSystemError(error, uri);
    }
  }

  private asFsPath(uri: vscode.Uri): string {
    if (uri.scheme !== this.scheme) {
      throw vscode.FileSystemError.Unavailable(`Unsupported scheme: ${uri.scheme}`);
    }
    return uri.path || "/";
  }

  private toFileSystemError(error: unknown, uri: vscode.Uri): vscode.FileSystemError {
    const err = error as { code?: string; message?: string };
    switch (err?.code) {
      case "ENOENT":
        return vscode.FileSystemError.FileNotFound(uri);
      case "EEXIST":
        return vscode.FileSystemError.FileExists(uri);
      case "EISDIR":
        return vscode.FileSystemError.FileIsADirectory(uri);
      case "ENOTDIR":
        return vscode.FileSystemError.FileNotFound(uri);
      default:
        return vscode.FileSystemError.Unavailable(err?.message ?? "Unknown error");
    }
  }
}
