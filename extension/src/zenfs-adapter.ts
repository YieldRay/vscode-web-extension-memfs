import type {
  IFileSystem,
  FsStat,
  MkdirOptions,
  RmOptions,
  CpOptions,
  BufferEncoding,
  ByteString,
} from "just-bash";
import { promises as fs } from "@zenfs/core";
import { posix as path } from "path";

// These interfaces exist in just-bash's fs/interface.ts but aren't
// re-exported from the package root. Inline them here.
interface ReadFileOptions {
  encoding?: BufferEncoding | null;
}

interface WriteFileOptions {
  encoding?: BufferEncoding;
}

/**
 * Convert a Uint8Array to a latin1 string (each char = one byte).
 * This is the format just-bash uses for its ByteString type.
 */
function toLatin1(buf: Uint8Array): string {
  let s = "";
  for (let i = 0; i < buf.length; i++) {
    s += String.fromCharCode(buf[i]);
  }
  return s;
}

/**
 * Adapter that implements just-bash's IFileSystem interface
 * by delegating to @zenfs/core's promises API.
 *
 * This means just-bash commands read/write the same IndexedDB-backed
 * filesystem that the VS Code file explorer uses — no sync needed.
 */
export interface FsChangeEvent {
  path: string;
  type: "created" | "changed" | "deleted";
}

export class ZenFsAdapter implements IFileSystem {
  /** Changes since the last call to flushChanges(). */
  private changes: FsChangeEvent[] = [];

  /** Return and clear accumulated change events. */
  flushChanges(): FsChangeEvent[] {
    const result = this.changes;
    this.changes = [];
    return result;
  }

  private _trackCreate(p: string): void {
    this.changes.push({ path: p, type: "created" });
    // Parent directory changed (new entry appeared)
    const parent = path.dirname(p);
    if (parent && parent !== p) {
      this.changes.push({ path: parent, type: "changed" });
    }
  }

  private _trackChange(p: string): void {
    this.changes.push({ path: p, type: "changed" });
  }

  private _trackDelete(p: string): void {
    this.changes.push({ path: p, type: "deleted" });
    const parent = path.dirname(p);
    if (parent && parent !== p) {
      this.changes.push({ path: parent, type: "changed" });
    }
  }

  resolvePath(base: string, p: string): string {
    return path.resolve(base, p);
  }

  async readFile(
    p: string,
    options?: ReadFileOptions | BufferEncoding
  ): Promise<string> {
    const encoding =
      typeof options === "string" ? options : options?.encoding ?? "utf8";
    const data = await fs.readFile(p);
    const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (encoding === "binary" || encoding === "latin1") {
      return toLatin1(buf);
    }
    return new TextDecoder(encoding === "utf-8" ? "utf-8" : encoding).decode(
      buf
    );
  }

  async readFileBytes(p: string): Promise<ByteString> {
    const data = await fs.readFile(p);
    const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
    // ByteString is a branded string type (latin1-encoded).
    // The cast is safe because toLatin1 produces exactly that encoding.
    return toLatin1(buf) as unknown as ByteString;
  }

  async readFileBuffer(p: string): Promise<Uint8Array> {
    const data = await fs.readFile(p);
    return data instanceof Uint8Array ? data : new Uint8Array(data);
  }

  async writeFile(
    p: string,
    content: string | Uint8Array,
    _options?: WriteFileOptions | BufferEncoding
  ): Promise<void> {
    const existed = await fs.exists(p);
    await this._ensureParentDir(p);
    await fs.writeFile(p, content);
    if (existed) {
      this._trackChange(p);
    } else {
      this._trackCreate(p);
    }
  }

  async appendFile(
    p: string,
    content: string | Uint8Array,
    _options?: WriteFileOptions | BufferEncoding
  ): Promise<void> {
    await this._ensureParentDir(p);
    try {
      const existing = await fs.readFile(p);
      const existingBuf =
        existing instanceof Uint8Array ? existing : new Uint8Array(existing);
      const appendBuf =
        typeof content === "string"
          ? new TextEncoder().encode(content)
          : content;
      const merged = new Uint8Array(existingBuf.length + appendBuf.length);
      merged.set(existingBuf);
      merged.set(appendBuf, existingBuf.length);
      await fs.writeFile(p, merged);
    } catch {
      // File doesn't exist yet — write fresh
      await fs.writeFile(p, content);
    }
    this._trackCreate(p);
  }

  async exists(p: string): Promise<boolean> {
    return fs.exists(p);
  }

  async stat(p: string): Promise<FsStat> {
    const s = await fs.stat(p);
    return {
      isFile: s.isFile(),
      isDirectory: s.isDirectory(),
      isSymbolicLink: s.isSymbolicLink(),
      mode: s.mode,
      size: s.size,
      mtime: s.mtime,
    };
  }

  async lstat(p: string): Promise<FsStat> {
    const s = await fs.lstat(p);
    return {
      isFile: s.isFile(),
      isDirectory: s.isDirectory(),
      isSymbolicLink: s.isSymbolicLink(),
      mode: s.mode,
      size: s.size,
      mtime: s.mtime,
    };
  }

  async mkdir(p: string, options?: MkdirOptions): Promise<void> {
    await fs.mkdir(p, { recursive: options?.recursive ?? false });
    this._trackCreate(p);
  }

  async readdir(p: string): Promise<string[]> {
    return fs.readdir(p);
  }

  async rm(p: string, options?: RmOptions): Promise<void> {
    try {
      await fs.rm(p, {
        recursive: options?.recursive ?? false,
        force: options?.force ?? false,
      });
      this._trackDelete(p);
    } catch (e: unknown) {
      if (options?.force) return;
      throw e;
    }
  }

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    const s = await fs.stat(src);
    if (s.isDirectory()) {
      if (!options?.recursive) {
        throw Object.assign(
          new Error(`cp: -r not specified; omitting directory '${src}'`),
          { code: "EISDIR" }
        );
      }
      await this._copyDirRecursive(src, dest);
    } else {
      await this._ensureParentDir(dest);
      const data = await fs.readFile(src);
      await fs.writeFile(
        dest,
        data instanceof Uint8Array ? data : new Uint8Array(data)
      );
    }
  }

  async mv(src: string, dest: string): Promise<void> {
    try {
      await fs.rename(src, dest);
    } catch {
      // Cross-directory rename may fail; fall back to cp + rm
      const s = await fs.stat(src);
      if (s.isDirectory()) {
        await this._copyDirRecursive(src, dest);
      } else {
        await this._ensureParentDir(dest);
        const data = await fs.readFile(src);
        await fs.writeFile(
          dest,
          data instanceof Uint8Array ? data : new Uint8Array(data)
        );
      }
      await fs.rm(src, { recursive: true, force: true });
    }
    this._trackChange(src);
    this._trackChange(dest);
  }

  getAllPaths(): string[] {
    // Not needed — just-bash falls back to recursive readdir for globs
    return [];
  }

  async chmod(p: string, mode: number): Promise<void> {
    await fs.chmod(p, mode);
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    await fs.symlink(target, linkPath);
  }

  async link(_existingPath: string, _newPath: string): Promise<void> {
    throw Object.assign(new Error("Hard links are not supported"), {
      code: "ENOSYS",
    });
  }

  async readlink(p: string): Promise<string> {
    return fs.readlink(p);
  }

  async realpath(p: string): Promise<string> {
    return fs.realpath(p);
  }

  async utimes(p: string, atime: Date, mtime: Date): Promise<void> {
    await fs.utimes(p, atime, mtime);
  }

  // --- private helpers ---

  private async _ensureParentDir(p: string): Promise<void> {
    const parent = path.dirname(p);
    if (parent && parent !== p && !(await fs.exists(parent))) {
      await fs.mkdir(parent, { recursive: true });
    }
  }

  private async _copyDirRecursive(src: string, dest: string): Promise<void> {
    if (!(await fs.exists(dest))) {
      await fs.mkdir(dest, { recursive: true });
    }
    const entries = await fs.readdir(src);
    for (const entry of entries) {
      const srcChild = path.join(src, entry);
      const destChild = path.join(dest, entry);
      const s = await fs.stat(srcChild);
      if (s.isDirectory()) {
        await this._copyDirRecursive(srcChild, destChild);
      } else {
        const data = await fs.readFile(srcChild);
        await fs.writeFile(
          destChild,
          data instanceof Uint8Array ? data : new Uint8Array(data)
        );
      }
    }
  }
}
