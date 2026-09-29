import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** The shell the Bash tool runs commands in, and how to hand it one. */
export interface Shell {
  readonly kind: "bash" | "sh" | "cmd";
  readonly file: string;
  args(command: string): string[];
  /** cmd.exe parses its own command line; Node must not quote it again. */
  readonly verbatim: boolean;
}

let resolved: Shell | undefined;

/**
 * Bash where there is one. On Windows that means Git Bash: `exec` used to
 * hand every command to cmd.exe while the tool, its name and the model all
 * assumed bash, so `ls`, `export` and `$VAR` failed on the platform this
 * project is developed on. cmd.exe remains the fallback, and the tool's
 * description says so, so the model is not left guessing.
 * `AGENT_SHELL` names a bash-compatible shell to use instead.
 */
export function resolveShell(): Shell {
  resolved ??= findShell();
  return resolved;
}

function findShell(): Shell {
  const override = process.env.AGENT_SHELL;
  if (override) return bash(override);
  if (process.platform !== "win32") {
    return fs.existsSync("/bin/bash") ? bash("/bin/bash") : { ...bash("/bin/sh"), kind: "sh" };
  }
  const roots = [
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs") : undefined,
  ];
  for (const root of roots) {
    // Not System32\bash.exe, which is the WSL launcher and a different machine.
    const candidate = root && path.join(root, "Git", "bin", "bash.exe");
    if (candidate && fs.existsSync(candidate)) return bash(candidate);
  }
  return { kind: "cmd", file: process.env.ComSpec ?? "cmd.exe", args: (c) => ["/d", "/s", "/c", `"${c}"`], verbatim: true };
}

function bash(file: string): Shell {
  return { kind: "bash", file, args: (c) => ["-c", c], verbatim: false };
}

export interface RunOutcome {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: string | null;
  timedOut: boolean;
  /** Set when the shell could not be started at all. */
  spawnError?: string;
}

/** Bytes kept at each end of a stream; the middle of anything larger is dropped as it arrives. */
const KEEP_BYTES = 2 * 1024 * 1024;
/** How long to wait for output after the shell exits, if a background job still holds the pipes. */
const DRAIN_MS = 250;

/**
 * Run one command: stdin closed, output kept head and tail, the whole process
 * tree killed on timeout.
 *
 * `exec` buffered everything up to 10 MB and killed the command past that,
 * so a verbose build either failed or came back whole. Here memory stays
 * bounded however much a command prints, and the caller trims the text.
 */
export function runCommand(command: string, opts: { cwd: string; timeoutMs: number }): Promise<RunOutcome> {
  const shell = resolveShell();
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(shell.file, shell.args(command), {
        cwd: opts.cwd,
        env: { ...process.env, FORCE_COLOR: "0" },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        windowsVerbatimArguments: shell.verbatim,
        // Its own process group, so a timeout can kill what it started too.
        detached: process.platform !== "win32",
      });
    } catch (err) {
      resolve({ stdout: "", stderr: "", code: null, signal: null, timedOut: false, spawnError: String(err) });
      return;
    }

    const out = new Capture(KEEP_BYTES);
    const err = new Capture(KEEP_BYTES);
    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));

    let timedOut = false;
    let done = false;
    let exit: { code: number | null; signal: string | null } = { code: null, signal: null };
    const finish = (spawnError?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({
        stdout: out.text(),
        stderr: err.text(),
        ...exit,
        timedOut,
        ...(spawnError ? { spawnError } : {}),
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      // If the kill itself fails, still answer.
      setTimeout(() => finish(), 5000);
    }, opts.timeoutMs);

    child.on("error", (e) => finish(e.message));
    child.on("exit", (code, signal) => {
      exit = { code, signal };
      // `cmd &` leaves a job holding stdout open; do not wait for it forever.
      setTimeout(() => finish(), DRAIN_MS);
    });
    child.on("close", () => finish());
  });
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

/** The first and last `half` bytes of a stream, and a count of what fell between. */
class Capture {
  private head: Buffer[] = [];
  private headBytes = 0;
  private tail: Buffer[] = [];
  private tailBytes = 0;
  private dropped = 0;

  constructor(private readonly half: number) {}

  push(chunk: Buffer): void {
    let rest = chunk;
    if (this.headBytes < this.half) {
      const take = rest.subarray(0, this.half - this.headBytes);
      this.head.push(take);
      this.headBytes += take.length;
      rest = rest.subarray(take.length);
    }
    if (rest.length === 0) return;
    this.tail.push(rest);
    this.tailBytes += rest.length;
    while (this.tail.length > 1 && this.tailBytes - (this.tail[0]?.length ?? 0) >= this.half) {
      const first = this.tail.shift();
      if (!first) break;
      this.tailBytes -= first.length;
      this.dropped += first.length;
    }
  }

  text(): string {
    if (this.dropped === 0) return normalize(decodeOutput(Buffer.concat([...this.head, ...this.tail])));
    const head = decodeOutput(Buffer.concat(this.head));
    const tail = decodeOutput(Buffer.concat(this.tail));
    return normalize(`${head}\n\n[… ${this.dropped.toLocaleString("en-US")} bytes omitted …]\n\n${tail}`);
  }
}

function normalize(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/**
 * Bytes from a command, as text.
 *
 * UTF-8 where it is valid, and the console's code page line by line where it
 * is not. Native Windows programs write in the console code page — GBK on a
 * Chinese system — and decoding that as UTF-8 handed the model error messages
 * made of replacement characters. Line by line, because one command's output
 * can mix a UTF-8 tool's lines with a native program's.
 */
export function decodeOutput(buf: Buffer, legacy: string = legacyEncoding()): string {
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  try {
    return utf8.decode(buf);
  } catch {
    // Mixed or legacy output: decide per line.
  }
  let fallback: TextDecoder;
  try {
    // Node types list only the labels they know; any WHATWG label works with full ICU.
    fallback = new TextDecoder(legacy as ConstructorParameters<typeof TextDecoder>[0]);
  } catch {
    fallback = new TextDecoder("utf-8");
  }
  const parts: string[] = [];
  let start = 0;
  while (start < buf.length) {
    const nl = buf.indexOf(0x0a, start);
    const end = nl === -1 ? buf.length : nl + 1;
    const line = buf.subarray(start, end);
    try {
      parts.push(utf8.decode(line));
    } catch {
      parts.push(fallback.decode(line));
    }
    start = end;
  }
  return parts.join("");
}

const CODE_PAGES: Record<number, string> = {
  936: "gbk",
  950: "big5",
  932: "shift_jis",
  949: "euc-kr",
  866: "ibm866",
  1250: "windows-1250",
  1251: "windows-1251",
  1252: "windows-1252",
  65001: "utf-8",
};

let legacy: string | undefined;

/** The encoding of text that is not UTF-8: the console code page on Windows, Latin-1 elsewhere. */
function legacyEncoding(): string {
  if (legacy) return legacy;
  legacy = "windows-1252";
  if (process.platform === "win32") {
    try {
      const out = execFileSync("chcp.com", { encoding: "latin1", windowsHide: true, timeout: 2000 });
      const page = Number(/(\d{3,5})/.exec(out)?.[1]);
      legacy = CODE_PAGES[page] ?? legacy;
    } catch {
      // Keep the default.
    }
  }
  return legacy;
}
