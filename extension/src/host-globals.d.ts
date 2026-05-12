/**
 * Type declarations for globals available on the main page (host window).
 *
 * These are used inside functions passed to `createHostFunction` / `runOnHost`.
 * The functions are serialized and eval'd on the main page where these globals exist.
 * TypeScript needs these declarations to avoid "no index signature" errors.
 */

import type { VirtualFS, RunResult } from "almostnode";

interface AlmostNodeContainer {
  vfs: VirtualFS;
  run(command: string, options?: { cwd?: string }): Promise<RunResult>;
  execute(code: string, filename?: string): { exports: unknown };
  runFile(filename: string): { exports: unknown };
  sendInput(data: string): void;
}

declare global {
  // eslint-disable-next-line no-var
  var container: AlmostNodeContainer;
  // eslint-disable-next-line no-var
  var almostnode: typeof import("almostnode");
}
