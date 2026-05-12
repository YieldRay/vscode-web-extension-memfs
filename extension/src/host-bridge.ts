/**
 * Bridge utilities for executing code on the main page from the extension worker.
 *
 * The extension runs in a cross-origin web worker (raw.esm.sh) and cannot access
 * the main page directly. These helpers serialize functions and their arguments,
 * send them to the main page via `host.promise` command, and return the result.
 */

import * as vscode from "vscode";

/**
 * Low-level bridge: execute a code string on the main page and return the result.
 * Throws if the eval rejects.
 */
export async function hostPromise(code: string): Promise<any> {
  const result: any = await vscode.commands.executeCommand("host.promise", code);
  if (result.status === "fulfilled") {
    return result.value;
  } else {
    throw result.reason;
  }
}

/**
 * Execute a function on the main page with the given arguments.
 * The function and args are serialized and eval'd in the main window context.
 *
 * @example
 * const ua = await runOnHost(() => navigator.userAgent);
 *
 * @example
 * const stat = await runOnHost((path: string) => {
 *   const s = globalThis.container.vfs.statSync(path);
 *   return { isFile: s.isFile(), size: s.size };
 * }, "/foo.txt");
 */
export function runOnHost<TReturn>(fn: () => TReturn): Promise<TReturn>;
export function runOnHost<TArgs extends unknown[], TReturn>(
  fn: (...args: TArgs) => TReturn,
  ...args: TArgs
): Promise<TReturn>;
export function runOnHost(fn: Function, ...args: unknown[]): Promise<unknown> {
  const src = fn.toString();
  const serializedArgs = args.map((a) => JSON.stringify(a)).join(", ");
  return hostPromise(`(${src})(${serializedArgs})`);
}

/**
 * Create a reusable function handle that executes on the main page.
 * Each invocation serializes the arguments and round-trips through the bridge.
 *
 * @example
 * const readFile = createHostFunction((path: string) => {
 *   const vfs = globalThis.container.vfs;
 *   const data = vfs.readFileSync(path);
 *   let binary = "";
 *   for (let i = 0; i < data.length; i++) binary += String.fromCharCode(data[i]);
 *   return btoa(binary);
 * });
 *
 * const base64 = await readFile("/hello.txt");
 */
export function createHostFunction<TArgs extends unknown[], TReturn>(
  fn: (...args: TArgs) => TReturn,
): (...args: TArgs) => Promise<TReturn> {
  const src = fn.toString();
  return (...args: TArgs): Promise<TReturn> => {
    const serializedArgs = args.map((a) => JSON.stringify(a)).join(", ");
    return hostPromise(`(${src})(${serializedArgs})`) as Promise<TReturn>;
  };
}
