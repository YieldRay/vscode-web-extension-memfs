import * as vscode from "vscode";
import { createHostFunction } from "./host-bridge";

/** Result from almostnode's container.run() */
interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const MAX_HISTORY = 100;
const PROMPT = "$ ";

/** Callback invoked after each command to notify the file explorer of changes. */
export type OnCommandDone = () => void | Promise<void>;

const runCommand = createHostFunction((cmd: string) => {
  globalThis._runAbort = new AbortController();
  return globalThis.container.run(cmd, { signal: globalThis._runAbort.signal });
});

const abortRunning = createHostFunction(() => {
  if (globalThis._runAbort) {
    globalThis._runAbort.abort();
    globalThis._runAbort = null;
  }
  return "ok";
});

/**
 * VS Code Pseudoterminal backed by almostnode's container.run().
 *
 * Full line editor with cursor movement, word operations, and history.
 * Command execution happens on the main page via the commands bridge.
 */
export class AlmostNodeTerminal implements vscode.Pseudoterminal {
  private _writeEmitter = new vscode.EventEmitter<string>();
  readonly onDidWrite: vscode.Event<string> = this._writeEmitter.event;

  private _closeEmitter = new vscode.EventEmitter<void | number>();
  readonly onDidClose: vscode.Event<void | number> = this._closeEmitter.event;

  private _onCommandDone?: OnCommandDone;

  // Line editing state
  private _line = "";
  private _cursor = 0;
  private _running = false;

  // Command history
  private _history: string[] = [];
  private _historyIndex = -1;
  private _savedLine = "";

  constructor(onCommandDone?: OnCommandDone) {
    this._onCommandDone = onCommandDone;
  }

  open(_initialDimensions: vscode.TerminalDimensions | undefined): void {
    console.log("[AlmostNodeTerminal] open() called");
    this._writeEmitter.fire("MemFS Terminal (powered by almostnode)\r\n");
    this._writeEmitter.fire(PROMPT);
  }

  close(): void {
    this._writeEmitter.dispose();
    this._closeEmitter.dispose();
  }

  handleInput(data: string): void {
    // Allow Ctrl+C while a command is running to abort it
    if (this._running) {
      if (data.includes("\x03")) {
        this._writeEmitter.fire("^C\r\n");
        abortRunning();
      }
      return;
    }

    let i = 0;
    while (i < data.length) {
      const ch = data[i];

      // --- Escape sequences ---
      if (ch === "\x1b") {
        const consumed = this._handleEscape(data, i);
        if (consumed > 0) { i += consumed; continue; }
        i++;
        continue;
      }

      switch (ch) {
        case "\r": // Enter
          this._writeEmitter.fire("\r\n");
          this._executeCommand(this._line);
          break;

        case "\x7f": // Backspace
          this._deleteBackward(1);
          break;

        case "\x08": // Ctrl+Backspace (some terminals send \b)
          this._deleteWordBackward();
          break;

        case "\x01": // Ctrl+A — home
          this._moveCursorTo(0);
          break;

        case "\x05": // Ctrl+E — end
          this._moveCursorTo(this._line.length);
          break;

        case "\x02": // Ctrl+B — left
          this._moveCursorTo(this._cursor - 1);
          break;

        case "\x06": // Ctrl+F — right
          this._moveCursorTo(this._cursor + 1);
          break;

        case "\x17": // Ctrl+W — delete word backward
          this._deleteWordBackward();
          break;

        case "\x0b": // Ctrl+K — kill to end of line
          this._deleteToEnd();
          break;

        case "\x15": // Ctrl+U — kill entire line
          this._clearLine();
          break;

        case "\x04": // Ctrl+D — delete forward (or no-op if empty)
          if (this._line.length > 0) {
            this._deleteForward(1);
          }
          break;

        case "\x03": // Ctrl+C
          this._line = "";
          this._cursor = 0;
          this._historyIndex = -1;
          this._writeEmitter.fire("^C\r\n");
          this._writeEmitter.fire(PROMPT);
          break;

        case "\x0c": // Ctrl+L — clear screen
          this._writeEmitter.fire("\x1b[2J\x1b[H");
          this._writeEmitter.fire(PROMPT + this._line);
          if (this._cursor < this._line.length) {
            this._writeEmitter.fire(`\x1b[${this._line.length - this._cursor}D`);
          }
          break;

        default:
          if (ch >= " ") {
            this._insertAtCursor(ch);
          }
          break;
      }
      i++;
    }
  }

  // --- Escape sequence handler ---

  private _handleEscape(data: string, pos: number): number {
    if (pos + 1 >= data.length) return 0;

    // CSI sequences: \x1b[ ...
    if (data[pos + 1] === "[") {
      return this._handleCSI(data, pos);
    }

    // Alt+key: \x1b followed by a character
    if (data[pos + 1] >= " ") {
      const key = data[pos + 1];
      switch (key) {
        case "b": // Alt+B — word left
          this._moveWordLeft();
          return 2;
        case "f": // Alt+F — word right
          this._moveWordRight();
          return 2;
        case "d": // Alt+D — delete word forward
          this._deleteWordForward();
          return 2;
        case "\x7f": // Alt+Backspace — delete word backward
          this._deleteWordBackward();
          return 2;
      }
    }
    return 0;
  }

  private _handleCSI(data: string, pos: number): number {
    if (pos + 2 >= data.length) return 0;

    // Bracketed paste: \x1b[200~ ... \x1b[201~
    if (data.substring(pos, pos + 6) === "\x1b[200~") {
      const endIdx = data.indexOf("\x1b[201~", pos + 6);
      const pasteEnd = endIdx === -1 ? data.length : endIdx;
      const pasted = data.substring(pos + 6, pasteEnd);
      for (const c of pasted) {
        if (c >= " " || c === "\t") this._insertAtCursor(c);
      }
      return endIdx === -1 ? data.length - pos : endIdx + 6 - pos;
    }

    // Collect parameter bytes (digits and semicolons) then final byte
    let j = pos + 2;
    let params = "";
    while (j < data.length && ((data[j] >= "0" && data[j] <= "9") || data[j] === ";")) {
      params += data[j];
      j++;
    }
    if (j >= data.length) return 0;
    const final = data[j];
    const len = j - pos + 1;

    // Parse modifier: params like "1;5" means modifier=5 (Ctrl)
    const parts = params.split(";");
    const hasCtrl = parts.includes("5") || parts[1] === "5";

    switch (final) {
      case "A": // Up arrow
        this._navigateHistory(-1);
        return len;
      case "B": // Down arrow
        this._navigateHistory(1);
        return len;
      case "C": // Right arrow / Ctrl+Right
        if (hasCtrl) {
          this._moveWordRight();
        } else {
          this._moveCursorTo(this._cursor + 1);
        }
        return len;
      case "D": // Left arrow / Ctrl+Left
        if (hasCtrl) {
          this._moveWordLeft();
        } else {
          this._moveCursorTo(this._cursor - 1);
        }
        return len;
      case "H": // Home
        this._moveCursorTo(0);
        return len;
      case "F": // End
        this._moveCursorTo(this._line.length);
        return len;
      case "~": {
        // \x1b[3~ = Delete, \x1b[3;5~ = Ctrl+Delete
        const code = parts[0];
        if (code === "3") {
          if (hasCtrl) {
            this._deleteWordForward();
          } else {
            this._deleteForward(1);
          }
        }
        return len;
      }
    }

    return len; // consume unknown CSI to avoid garbage
  }

  // --- Cursor movement ---

  private _moveCursorTo(newPos: number): void {
    const clamped = Math.max(0, Math.min(newPos, this._line.length));
    if (clamped === this._cursor) return;
    const delta = clamped - this._cursor;
    if (delta > 0) {
      this._writeEmitter.fire(`\x1b[${delta}C`);
    } else {
      this._writeEmitter.fire(`\x1b[${-delta}D`);
    }
    this._cursor = clamped;
  }

  private _moveWordLeft(): void {
    let p = this._cursor;
    while (p > 0 && this._line[p - 1] === " ") p--;
    while (p > 0 && this._line[p - 1] !== " ") p--;
    this._moveCursorTo(p);
  }

  private _moveWordRight(): void {
    let p = this._cursor;
    while (p < this._line.length && this._line[p] !== " ") p++;
    while (p < this._line.length && this._line[p] === " ") p++;
    this._moveCursorTo(p);
  }

  // --- Editing operations ---

  private _insertAtCursor(text: string): void {
    if (this._cursor === this._line.length) {
      this._line += text;
      this._cursor += text.length;
      this._writeEmitter.fire(text);
    } else {
      const before = this._line.slice(0, this._cursor);
      const after = this._line.slice(this._cursor);
      this._line = before + text + after;
      this._cursor += text.length;
      this._writeEmitter.fire(text + after);
      if (after.length > 0) {
        this._writeEmitter.fire(`\x1b[${after.length}D`);
      }
    }
  }

  private _deleteBackward(count: number): void {
    if (this._cursor === 0) return;
    const del = Math.min(count, this._cursor);
    const before = this._line.slice(0, this._cursor - del);
    const after = this._line.slice(this._cursor);
    this._line = before + after;
    this._cursor -= del;
    this._writeEmitter.fire(`\x1b[${del}D`);
    this._writeEmitter.fire(after + " ".repeat(del));
    this._writeEmitter.fire(`\x1b[${after.length + del}D`);
  }

  private _deleteForward(count: number): void {
    if (this._cursor >= this._line.length) return;
    const del = Math.min(count, this._line.length - this._cursor);
    const after = this._line.slice(this._cursor + del);
    this._line = this._line.slice(0, this._cursor) + after;
    this._writeEmitter.fire(after + " ".repeat(del));
    this._writeEmitter.fire(`\x1b[${after.length + del}D`);
  }

  private _deleteWordBackward(): void {
    if (this._cursor === 0) return;
    let p = this._cursor;
    while (p > 0 && this._line[p - 1] === " ") p--;
    while (p > 0 && this._line[p - 1] !== " ") p--;
    const del = this._cursor - p;
    if (del > 0) this._deleteBackward(del);
  }

  private _deleteWordForward(): void {
    if (this._cursor >= this._line.length) return;
    let p = this._cursor;
    while (p < this._line.length && this._line[p] === " ") p++;
    while (p < this._line.length && this._line[p] !== " ") p++;
    const del = p - this._cursor;
    if (del > 0) this._deleteForward(del);
  }

  private _deleteToEnd(): void {
    if (this._cursor >= this._line.length) return;
    this._line = this._line.slice(0, this._cursor);
    this._writeEmitter.fire("\x1b[K");
  }

  private _clearLine(): void {
    if (this._cursor > 0) {
      this._writeEmitter.fire(`\x1b[${this._cursor}D`);
    }
    this._writeEmitter.fire("\x1b[K");
    this._line = "";
    this._cursor = 0;
  }

  // --- Line replacement (history) ---

  private _replaceLine(newLine: string): void {
    if (this._cursor > 0) {
      this._writeEmitter.fire(`\x1b[${this._cursor}D`);
    }
    this._writeEmitter.fire("\x1b[K");
    this._writeEmitter.fire(newLine);
    this._line = newLine;
    this._cursor = newLine.length;
  }

  private _navigateHistory(direction: number): void {
    if (this._history.length === 0) return;

    if (this._historyIndex === -1) {
      this._savedLine = this._line;
    }

    const newIndex = this._historyIndex + direction;

    if (direction < 0) {
      if (this._historyIndex === -1) {
        this._historyIndex = this._history.length - 1;
      } else if (newIndex >= 0) {
        this._historyIndex = newIndex;
      } else {
        return;
      }
    } else {
      if (newIndex >= this._history.length) {
        this._historyIndex = -1;
        this._replaceLine(this._savedLine);
        return;
      }
      this._historyIndex = newIndex;
    }

    this._replaceLine(this._history[this._historyIndex]);
  }

  // --- Command execution ---

  private async _executeCommand(cmdLine: string): Promise<void> {
    const trimmed = cmdLine.trim();
    if (trimmed === "") {
      this._writeEmitter.fire(PROMPT);
      return;
    }

    if (this._history[this._history.length - 1] !== trimmed) {
      this._history.push(trimmed);
      if (this._history.length > MAX_HISTORY) {
        this._history.shift();
      }
    }
    this._historyIndex = -1;
    this._line = "";
    this._cursor = 0;

    this._running = true;
    try {
      const result: RunResult = await runCommand(trimmed);

      if (result.stdout) {
        this._writeEmitter.fire(result.stdout.replace(/\n/g, "\r\n"));
        if (!result.stdout.endsWith("\n")) {
          this._writeEmitter.fire("\r\n");
        }
      }
      if (result.stderr) {
        this._writeEmitter.fire(result.stderr.replace(/\n/g, "\r\n"));
        if (!result.stderr.endsWith("\n")) {
          this._writeEmitter.fire("\r\n");
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this._writeEmitter.fire(`Error: ${msg}\r\n`);
    }

    // Notify file explorer of potential changes and check for new servers
    if (this._onCommandDone) {
      await this._onCommandDone();
    }

    this._running = false;
    this._writeEmitter.fire(PROMPT);
  }
}
