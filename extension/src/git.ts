/**
 * Git command implementation via isomorphic-git.
 *
 * isomorphic-git runs inside the extension worker (has native crypto).
 * FS operations are bridged to almostnode's VirtualFS on the main page
 * via createHostFunction.
 */

import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { createHostFunction } from "./host-bridge";

/** Parsed git command (parsed in the worker via minimist). */
export interface GitCommand {
  subcmd: string;
  args: string[];                // positional args (minimist _)
  flags: Record<string, any>;   // --flag, -m, etc.
}

// --- FS bridge: each call goes to the main page VFS ---

const fsReadFile = createHostFunction((path: string, encoding?: string) => {
  const vfs = globalThis.container.vfs;
  if (encoding) return vfs.readFileSync(path, encoding as "utf8");
  // Return as base64 for binary transfer
  const data = vfs.readFileSync(path);
  let binary = "";
  for (let i = 0; i < data.length; i++) binary += String.fromCharCode(data[i]);
  return { __base64: btoa(binary) };
});

const fsWriteFile = createHostFunction((path: string, dataB64: string, isBinary: boolean) => {
  const vfs = globalThis.container.vfs;
  const parent = path.substring(0, path.lastIndexOf("/")) || "/";
  if (parent !== "/" && !vfs.existsSync(parent)) {
    vfs.mkdirSync(parent, { recursive: true });
  }
  if (isBinary) {
    const binary = atob(dataB64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    vfs.writeFileSync(path, bytes);
  } else {
    vfs.writeFileSync(path, dataB64);
  }
});

const fsMkdir = createHostFunction((path: string) => {
  const vfs = globalThis.container.vfs;
  try { vfs.mkdirSync(path, { recursive: true }); } catch {}
});

const fsRmdir = createHostFunction((path: string) => {
  globalThis.container.vfs.rmdirSync(path);
});

const fsUnlink = createHostFunction((path: string) => {
  globalThis.container.vfs.unlinkSync(path);
});

const fsStat = createHostFunction((path: string) => {
  const s = globalThis.container.vfs.statSync(path);
  return {
    isFile: s.isFile(),
    isDirectory: s.isDirectory(),
    isSymbolicLink: s.isSymbolicLink(),
    size: s.size,
    mode: s.mode,
    mtimeMs: s.mtimeMs,
    ctimeMs: s.ctimeMs,
  };
});

const fsReaddir = createHostFunction((path: string) => {
  return globalThis.container.vfs.readdirSync(path);
});

const fsExists = createHostFunction((path: string) => {
  return globalThis.container.vfs.existsSync(path);
});

// --- Build the fs.promises adapter for isomorphic-git ---

function makeStat(raw: any) {
  return {
    isFile: () => raw.isFile,
    isDirectory: () => raw.isDirectory,
    isSymbolicLink: () => raw.isSymbolicLink,
    size: raw.size,
    mode: raw.mode,
    mtimeMs: raw.mtimeMs,
    ctimeMs: raw.ctimeMs,
  };
}

const fs = {
  promises: {
    async readFile(path: string, opts?: any): Promise<any> {
      const encoding = typeof opts === "string" ? opts : opts?.encoding;
      const result = await fsReadFile(path, encoding || undefined);
      if (result && typeof result === "object" && "__base64" in result) {
        // Decode base64 to Uint8Array
        const binary = atob((result as any).__base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
      }
      return result; // string
    },
    async writeFile(path: string, data: any): Promise<void> {
      if (typeof data === "string") {
        await fsWriteFile(path, data, false);
      } else {
        // Uint8Array → base64
        let binary = "";
        for (let i = 0; i < data.length; i++) binary += String.fromCharCode(data[i]);
        await fsWriteFile(path, btoa(binary), true);
      }
    },
    async mkdir(path: string, _opts?: any): Promise<void> {
      await fsMkdir(path);
    },
    async rmdir(path: string): Promise<void> {
      await fsRmdir(path);
    },
    async unlink(path: string): Promise<void> {
      await fsUnlink(path);
    },
    async stat(path: string): Promise<any> {
      const raw = await fsStat(path);
      return makeStat(raw);
    },
    async lstat(path: string): Promise<any> {
      const raw = await fsStat(path);
      return makeStat(raw);
    },
    async readdir(path: string): Promise<string[]> {
      return fsReaddir(path);
    },
    async readlink(_path: string): Promise<string> {
      throw Object.assign(new Error("ENOSYS: symlinks not supported"), { code: "ENOSYS" });
    },
    async symlink(_target: string, _path: string): Promise<void> {
      throw Object.assign(new Error("ENOSYS: symlinks not supported"), { code: "ENOSYS" });
    },
    async chmod(_path: string, _mode: number): Promise<void> {
      // no-op
    },
  },
};

// --- Git command runner ---

const CORS_PROXY = "https://cors.isomorphic-git.org";
const DIR = "/";

/** Read git user from .git/config, falling back to defaults. */
async function getAuthor(): Promise<{ name: string; email: string }> {
  let name = "User";
  let email = "user@memfs.local";
  try {
    const n = await git.getConfig({ fs, dir: DIR, path: "user.name" });
    if (n) name = n;
  } catch {}
  try {
    const e = await git.getConfig({ fs, dir: DIR, path: "user.email" });
    if (e) email = e;
  } catch {}
  return { name, email };
}

export async function runGitCommand(cmd: GitCommand): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { subcmd, args, flags } = cmd;
  let stdout = "";
  let stderr = "";

  try {
    if (!subcmd || flags.h || flags.help) {
      stdout = [
        "usage: git <command> [<args>]",
        "",
        "Available commands:",
        "  init                 Initialize a new repository",
        "  clone <url> [<dir>]  Clone a repository",
        "  add <path>           Stage files (use . or -A for all)",
        "  status               Show working tree status",
        "  commit -m <msg>      Record changes",
        "  log [--oneline]      Show commit history",
        "  diff                 Show changed files",
        "  branch [<name>]      List or create branches",
        "  checkout <branch>    Switch branches (-b to create)",
        "  remote               Manage remotes",
        "  fetch [<remote>]     Download objects and refs",
        "  pull [<remote>]      Fetch and merge",
        "  push [<remote>]      Update remote refs",
        "  config [<key> [<val>]] Get/set config (e.g. user.name, user.email)",
        "",
      ].join("\n");
      return { stdout, stderr, exitCode: 0 };
    }

    switch (subcmd) {
      case "init": {
        await git.init({ fs, dir: DIR });
        stdout = `Initialized empty Git repository in ${DIR}.git/\n`;
        break;
      }

      case "clone": {
        const url = args[0];
        if (!url) { stderr = "usage: git clone <url> [<dir>]\n"; return { stdout, stderr, exitCode: 1 }; }
        const cloneDir = args[1] || "/" + url.split("/").pop()?.replace(/\.git$/, "") || "/repo";
        await fs.promises.mkdir(cloneDir);
        const depth = flags.depth ? Number(flags.depth) : 1;
        await git.clone({ fs, http, dir: cloneDir, url, corsProxy: CORS_PROXY, singleBranch: !flags.all, depth });
        stdout = `Cloning into '${cloneDir}'...\ndone.\n`;
        break;
      }

      case "add": {
        const filepath = args[0];
        if (!filepath) { stderr = "usage: git add <path>\n"; return { stdout, stderr, exitCode: 1 }; }
        if (filepath === "." || flags.A || flags.all) {
          const matrix = await git.statusMatrix({ fs, dir: DIR });
          for (const [file, head, workdir, stage] of matrix) {
            if (workdir !== stage || head !== workdir) {
              if (workdir === 0) {
                await git.remove({ fs, dir: DIR, filepath: file });
              } else {
                await git.add({ fs, dir: DIR, filepath: file });
              }
            }
          }
        } else {
          await git.add({ fs, dir: DIR, filepath });
        }
        break;
      }

      case "status": {
        const matrix = await git.statusMatrix({ fs, dir: DIR });
        const lines: string[] = [];
        for (const [file, head, workdir, stage] of matrix) {
          if (head === 0 && workdir === 2 && stage === 2) lines.push(`new file:   ${file}`);
          else if (head === 0 && workdir === 2 && stage === 0) lines.push(`?? ${file}`);
          else if (head === 1 && workdir === 2 && stage === 2) lines.push(`modified:   ${file}`);
          else if (head === 1 && workdir === 2 && stage === 1) lines.push(` M ${file}`);
          else if (head === 1 && workdir === 0 && stage === 0) lines.push(`deleted:    ${file}`);
          else if (head === 1 && workdir === 0 && stage === 1) lines.push(` D ${file}`);
        }
        if (lines.length === 0) stdout = "nothing to commit, working tree clean\n";
        else stdout = lines.join("\n") + "\n";
        break;
      }

      case "commit": {
        const message = flags.m || flags.message;
        if (!message) {
          stderr = "error: please supply a message with -m\n";
          return { stdout, stderr, exitCode: 1 };
        }
        const author = await getAuthor();
        const sha = await git.commit({ fs, dir: DIR, message, author });
        stdout = `[${sha.slice(0, 7)}] ${message}\n`;
        break;
      }

      case "log": {
        const isOneline = !!flags.oneline;
        const depth = flags.n ? Number(flags.n) : 20;
        const commits = await git.log({ fs, dir: DIR, depth });
        const lines: string[] = [];
        for (const entry of commits) {
          if (isOneline) {
            lines.push(`${entry.oid.slice(0, 7)} ${entry.commit.message.split("\n")[0]}`);
          } else {
            lines.push(`commit ${entry.oid}`);
            lines.push(`Author: ${entry.commit.author.name} <${entry.commit.author.email}>`);
            const date = new Date(entry.commit.author.timestamp * 1000);
            lines.push(`Date:   ${date.toUTCString()}`);
            lines.push("");
            lines.push(`    ${entry.commit.message.trim()}`);
            lines.push("");
          }
        }
        stdout = lines.join("\n") + "\n";
        break;
      }

      case "branch": {
        if (args.length === 0 && !flags.d && !flags.D) {
          const branches = await git.listBranches({ fs, dir: DIR });
          const current = await git.currentBranch({ fs, dir: DIR });
          const lines = branches.map((b: string) => b === current ? `* ${b}` : `  ${b}`);
          stdout = lines.join("\n") + "\n";
        } else if (flags.d || flags.D) {
          const name = args[0];
          if (!name) { stderr = "usage: git branch -d <name>\n"; return { stdout, stderr, exitCode: 1 }; }
          await git.deleteBranch({ fs, dir: DIR, ref: name });
          stdout = `Deleted branch ${name}\n`;
        } else {
          const name = args[0];
          await git.branch({ fs, dir: DIR, ref: name });
          stdout = `Created branch ${name}\n`;
        }
        break;
      }

      case "checkout": {
        if (flags.b) {
          const newBranch = typeof flags.b === "string" ? flags.b : args[0];
          if (!newBranch) { stderr = "usage: git checkout -b <branch>\n"; return { stdout, stderr, exitCode: 1 }; }
          await git.branch({ fs, dir: DIR, ref: newBranch });
          await git.checkout({ fs, dir: DIR, ref: newBranch });
          stdout = `Switched to a new branch '${newBranch}'\n`;
        } else {
          const ref = args[0];
          if (!ref) { stderr = "usage: git checkout <branch>\n"; return { stdout, stderr, exitCode: 1 }; }
          await git.checkout({ fs, dir: DIR, ref });
          stdout = `Switched to branch '${ref}'\n`;
        }
        break;
      }

      case "remote": {
        const sub = args[0];
        if (sub === "add") {
          const name = args[1];
          const url = args[2];
          if (!name || !url) { stderr = "usage: git remote add <name> <url>\n"; return { stdout, stderr, exitCode: 1 }; }
          await git.addRemote({ fs, dir: DIR, remote: name, url });
        } else if (sub === "remove" || sub === "rm") {
          const name = args[1];
          if (!name) { stderr = "usage: git remote remove <name>\n"; return { stdout, stderr, exitCode: 1 }; }
          await git.deleteRemote({ fs, dir: DIR, remote: name });
        } else {
          const remotes = await git.listRemotes({ fs, dir: DIR });
          if (remotes.length === 0) break;
          const verbose = flags.v || flags.verbose;
          const lines = remotes.map((r) =>
            verbose ? `${r.remote}\t${r.url} (fetch)\n${r.remote}\t${r.url} (push)` : r.remote
          );
          stdout = lines.join("\n") + "\n";
        }
        break;
      }

      case "fetch": {
        const remote = args[0] || "origin";
        await git.fetch({ fs, http, dir: DIR, remote, corsProxy: CORS_PROXY });
        stdout = `From ${remote}\n * [fetched]\n`;
        break;
      }

      case "pull": {
        const remote = args[0] || "origin";
        const branch = args[1] || await git.currentBranch({ fs, dir: DIR }) || "main";
        const pullAuthor = await getAuthor();
        await git.pull({ fs, http, dir: DIR, remote, ref: branch, author: pullAuthor, corsProxy: CORS_PROXY, singleBranch: true });
        stdout = `Already up to date.\n`;
        break;
      }

      case "push": {
        const remote = args[0] || "origin";
        const branch = args[1] || await git.currentBranch({ fs, dir: DIR }) || "main";
        await git.push({ fs, http, dir: DIR, remote, ref: branch, corsProxy: CORS_PROXY });
        stdout = `Pushed to ${remote}/${branch}\n`;
        break;
      }

      case "config": {
        if (flags.list || flags.l) {
          // List all config
          const configPath = DIR + ".git/config";
          try {
            const content = await fs.promises.readFile(configPath, { encoding: "utf8" });
            stdout = typeof content === "string" ? content + "\n" : "";
          } catch {
            stdout = "";
          }
        } else if (args.length >= 2) {
          // git config key value → set
          await git.setConfig({ fs, dir: DIR, path: args[0], value: args[1] });
          stdout = "";
        } else if (args.length === 1) {
          // git config key → get
          const value = await git.getConfig({ fs, dir: DIR, path: args[0] });
          stdout = value !== undefined ? value + "\n" : "";
        } else {
          stderr = "usage: git config [--list] [<key> [<value>]]\n";
          return { stdout, stderr, exitCode: 1 };
        }
        break;
      }

      case "diff": {
        const matrix = await git.statusMatrix({ fs, dir: DIR });
        const lines: string[] = [];
        for (const [file, head, workdir] of matrix) {
          if (head !== workdir) {
            lines.push(`diff: ${file} (${head === 0 ? "new" : head === 1 && workdir === 0 ? "deleted" : "modified"})`);
          }
        }
        stdout = lines.length > 0 ? lines.join("\n") + "\n" : "";
        break;
      }

      default:
        stderr = `git: '${subcmd}' is not a git command.\n`;
        return { stdout, stderr, exitCode: 1 };
    }

    return { stdout, stderr, exitCode: 0 };
  } catch (e: any) {
    stderr = `fatal: ${e.message || e}\n`;
    return { stdout, stderr, exitCode: 128 };
  }
}
