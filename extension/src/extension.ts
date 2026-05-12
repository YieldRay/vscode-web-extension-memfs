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
    globalThis.container = globalThis.almostnode.createContainer({ cwd: "/" });
  }
  return "ok";
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

// --- Extension activation ---

export async function activate(context: vscode.ExtensionContext) {
  await initContainer();

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
      memFs.fireChanges([
        { type: vscode.FileChangeType.Changed, uri: vscode.Uri.from({ scheme: "memfs", path: "/" }) },
      ]);
      vscode.window.showInformationMessage("MemFS cleared, please reload the window.");
    }),
  );

  // Terminal
  const workspaceAuthority = vscode.workspace.workspaceFolders?.[0]?.uri.authority ?? "";

  function notifyFsChanged() {
    memFs.fireChanges([
      {
        type: vscode.FileChangeType.Changed,
        uri: vscode.Uri.from({ scheme: "memfs", authority: workspaceAuthority, path: "/" }),
      },
    ]);
  }

  function createTerminal() {
    const pty = new AlmostNodeTerminal(notifyFsChanged);
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
          pty: new AlmostNodeTerminal(notifyFsChanged),
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
    } catch (error: any) {
      throw this.toFileSystemError(error, uri);
    }
  }

  async delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> {
    const fsPath = this.asFsPath(uri);
    try {
      await vfsDelete(fsPath, options.recursive);
    } catch (error: any) {
      throw this.toFileSystemError(error, uri);
    }
  }

  async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
    try {
      await vfsRename(this.asFsPath(oldUri), this.asFsPath(newUri), options.overwrite);
    } catch (error: any) {
      throw this.toFileSystemError(error, oldUri);
    }
  }

  async copy(source: vscode.Uri, destination: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
    try {
      await vfsCopy(this.asFsPath(source), this.asFsPath(destination), options.overwrite);
    } catch (error: any) {
      throw this.toFileSystemError(error, source);
    }
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    const fsPath = this.asFsPath(uri);
    try {
      await vfsMkdir(fsPath);
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
