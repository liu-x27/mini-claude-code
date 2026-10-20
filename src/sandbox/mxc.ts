import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { runCommand, type Shell } from "../tools/shell.js";
import { inside, type SandboxBackend, type SandboxedCommand, type SandboxRequest, type SandboxStatus, withoutSecrets } from "./index.js";

/**
 * Microsoft Execution Containers (MXC), through the `wxc-exec.exe` its SDK
 * ships, on Windows. On a build that has the OS's own process-container API
 * (MXC's "base-container" tier), a command runs in an AppContainer-family
 * container whose file grants and network rules Windows enforces itself:
 * nothing is installed, and nothing on disk has its permissions changed.
 * MXC's weaker tiers do the same by editing folder permissions; this
 * backend refuses them rather than let them edit the user's folders.
 *
 * Commands run in cmd.exe: Git Bash, and anything else built on
 * msys-2.0.dll, cannot start in a container (microsoft/mxc#1061).
 *
 * The CLI rather than the SDK's Node API: that streams output only on Node
 * 24.21 or later, and does not expose `fallback.allowDaclMutation`.
 */
export const MXC_PACKAGE = "@microsoft/mxc-sdk";
/** The version this was written and tested against. */
export const MXC_VERSION = "1.0.1";

/** What `wxc-exec --probe` prints, as far as it is read here. */
interface MxcProbe {
  tier?: string;
  warnings?: string[];
  error?: string;
  probes?: { baseContainerApiPresent?: boolean; baseContainerSupportsDenyPaths?: boolean };
}

const FIX_INSTALL = `npm install ${MXC_PACKAGE}@${MXC_VERSION}, or point AGENT_MXC_EXEC at a wxc-exec.exe`;
const FIX_TIER =
  "MXC's OS process container needs Windows 11 24H2 or 25H2 at build 26100.9278 / 26200.9278 or later (KB5120998, which Microsoft is rolling out gradually). Its other tiers change folder permissions, which this harness does not let them do.";

export class MxcBackend implements SandboxBackend {
  readonly name = "mxc";
  readonly shell: Shell = cmd();
  readonly note = "Reading is closed too, except in the working directory, the temp directory and the Windows and Program Files folders.";
  private exe: string | undefined;
  private denyPaths = false;
  private tmp: string | undefined;

  /** The wxc-exec.exe that starts every command, once probed. */
  get executable(): string | undefined {
    return this.exe;
  }

  async probe(): Promise<SandboxStatus> {
    if (process.platform !== "win32") return { ok: false, detail: "the mxc backend is for Windows; on Linux and macOS use srt" };
    const found = findWxcExec();
    if (!found) return { ok: false, detail: `wxc-exec.exe was not found (${MXC_PACKAGE} is not installed)`, fix: FIX_INSTALL };

    const env = withoutSecrets();
    const probe = await runCommand("wxc-exec --probe", { cwd: os.tmpdir(), timeoutMs: 60_000, sandboxed: { file: found.exe, args: ["--probe"], env } });
    let facts: MxcProbe;
    try {
      facts = JSON.parse(probe.stdout) as MxcProbe;
    } catch {
      return { ok: false, detail: `wxc-exec --probe did not answer in JSON (exit ${probe.code}: ${(probe.spawnError ?? probe.stderr).trim().slice(0, 300)})` };
    }
    if (facts.tier !== "base-container") {
      const why = [facts.error, ...(facts.warnings ?? [])].filter(Boolean).join("; ");
      return { ok: false, detail: `MXC would use its ${facts.tier ?? "unknown"} tier here, not the OS process container${why ? ` (${why})` : ""}`, fix: FIX_TIER };
    }
    this.exe = found.exe;
    this.denyPaths = facts.probes?.baseContainerSupportsDenyPaths === true;

    // A command through it, end to end, with nothing granted but its temp directory.
    const tmp = this.tempDir();
    const file = this.writePolicy("echo mxc-probe-ok", { allowWrite: [], deny: [], cwd: tmp, env });
    try {
      const run = await runCommand("echo mxc-probe-ok", { cwd: tmp, timeoutMs: 60_000, sandboxed: { file: found.exe, args: [file], env } });
      if (!run.stdout.includes("mxc-probe-ok")) {
        const why = (run.spawnError ?? explainError(run.stderr) ?? run.stderr).trim().slice(0, 300) || "no output";
        return { ok: false, detail: `a test command did not run in it (exit ${run.code}: ${why})` };
      }
    } finally {
      fs.rmSync(file, { force: true });
    }
    return { ok: true, detail: `MXC ${found.version} (OS process container, cmd.exe)` };
  }

  async prepare(request: SandboxRequest): Promise<SandboxedCommand> {
    const exe = this.exe;
    if (!exe) throw new Error("MXC was never probed");
    const { policy } = request;
    if (policy.allowedDomains.length > 0) {
      throw new Error("MXC filters the network by IP address, not by host name; letting sandboxed commands reach a host needs the srt backend");
    }
    // It starts every command, as the user: a command that could rewrite it would run the next one outside.
    const open = policy.allowWrite.find((dir) => inside(exe, dir));
    if (open) throw new Error(`wxc-exec.exe is inside ${open}, which sandboxed commands may write; install ${MXC_PACKAGE} elsewhere or set AGENT_MXC_EXEC`);
    // Nothing outside the grants is reachable in the first place; a deny is needed only inside one.
    const deny = [...policy.denyRead, ...policy.denyWrite].filter((p) => policy.allowWrite.some((dir) => inside(p, dir)));
    if (deny.length > 0 && !this.denyPaths) {
      throw new Error(`this Windows build's process container cannot deny a path inside a grant (${deny.join(", ")})`);
    }
    const file = this.writePolicy(request.command, { allowWrite: policy.allowWrite, deny, cwd: request.cwd, env: request.env });
    return { file: exe, args: [file], env: request.env, cleanup: async () => fs.rmSync(file, { force: true }) };
  }

  explain(_command: string, stderr: string): string | undefined {
    return explainError(stderr);
  }

  async dispose(): Promise<void> {
    if (this.tmp) fs.rmSync(this.tmp, { recursive: true, force: true });
    this.tmp = undefined;
  }

  /**
   * The request as MXC's 1.0.0 policy JSON, in a file of its own outside
   * every grant; it is read before the container starts. `fallback` keeps
   * MXC from editing folder permissions if the OS container is not there.
   */
  private writePolicy(command: string, o: { allowWrite: string[]; deny: string[]; cwd: string; env: NodeJS.ProcessEnv }): string {
    const tmp = this.tempDir();
    const env = { ...o.env, TEMP: tmp, TMP: tmp };
    const policy = {
      version: "1.0.0",
      containment: "processcontainer",
      process: {
        commandLine: `"${this.shell.file}" /d /s /c "${command}"`,
        cwd: o.cwd,
        env: Object.entries(env)
          .filter((entry): entry is [string, string] => entry[1] !== undefined)
          .map(([name, value]) => `${name}=${value}`),
        inheritDefaultEnv: false,
      },
      filesystem: { readwritePaths: [...o.allowWrite, tmp], readonlyPaths: [], deniedPaths: o.deny },
      network: { egress: { default: "deny" }, ingress: { default: "deny", hostLoopback: "deny" } },
      ui: { disable: true, clipboard: "none", injection: false },
      fallback: { allowDaclMutation: false },
      telemetry: { enabled: false },
    };
    const file = path.join(os.tmpdir(), `mini-claude-code-mxc-${randomUUID()}.json`);
    fs.writeFileSync(file, JSON.stringify(policy), { mode: 0o600 });
    return file;
  }

  /** A temp directory of the container's own, granted to it: the shared one is outside every grant. */
  private tempDir(): string {
    if (!this.tmp) {
      this.tmp = path.join(os.tmpdir(), `mini-claude-code-mxc-${process.pid}`);
      fs.mkdirSync(this.tmp, { recursive: true });
    }
    return this.tmp;
  }
}

/** cmd.exe, as the Bash tool runs it when there is no bash. */
function cmd(): Shell {
  return {
    kind: "cmd",
    file: path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe"),
    args: (c) => ["/d", "/s", "/c", `"${c}"`],
    verbatim: true,
  };
}

/** wxc-exec.exe from AGENT_MXC_EXEC, or from the SDK package wherever Node would find it. */
function findWxcExec(): { exe: string; version: string } | undefined {
  const override = process.env.AGENT_MXC_EXEC;
  if (override) return fs.existsSync(override) ? { exe: override, version: "(AGENT_MXC_EXEC)" } : undefined;
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  for (const dir of createRequire(import.meta.url).resolve.paths(MXC_PACKAGE) ?? []) {
    const root = path.join(dir, ...MXC_PACKAGE.split("/"));
    const exe = path.join(root, "bin", arch, "wxc-exec.exe");
    if (!fs.existsSync(exe)) continue;
    let version = "?";
    try {
      version = (JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8")) as { version: string }).version;
    } catch {
      // The binary is what matters.
    }
    return { exe, version };
  }
  return undefined;
}

/** MXC's own failures come back on stderr as {"error":{"code","message"}}. */
function explainError(stderr: string): string | undefined {
  for (const line of stderr.split("\n")) {
    const text = line.trim();
    if (!text.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(text) as { error?: { code?: string; message?: string } };
      if (parsed.error) return `MXC ${parsed.error.code ?? "error"}: ${parsed.error.message ?? ""}`.trim();
    } catch {
      // Not MXC's.
    }
  }
  return undefined;
}
