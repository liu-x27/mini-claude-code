import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveShell, runCommand, type Shell } from "../tools/shell.js";
import {
  inside,
  type SandboxBackend,
  type SandboxedCommand,
  type SandboxPolicy,
  type SandboxRequest,
  type SandboxStatus,
  withoutSecrets,
} from "./index.js";

/**
 * Anthropic's sandbox-runtime (srt), an optional dependency loaded on the
 * first probe. Linux: bubblewrap, with the network unshared and reached
 * only through srt's proxy. macOS: sandbox-exec. Windows (alpha): each
 * command runs as a dedicated `srt-sandbox` account under a restricted
 * token in a job object, its connections blocked by WFP filters except to
 * srt's proxy, and its file access granted with ACL entries — which needs
 * a one-time elevated install this code never runs for you.
 */
export const SRT_PACKAGE = "@anthropic-ai/sandbox-runtime";
/**
 * The version this was written and tested against. srt is a research
 * preview whose API may change; 0.0.81 is the first whose Windows side
 * confines writes to the allow list (sandbox-runtime#402).
 */
export const SRT_VERSION = "0.0.81";

/** The parts of srt's API used here, checked at load time rather than trusted. */
interface SrtModule {
  SandboxManager: {
    initialize(config: unknown): Promise<void>;
    isSupportedPlatform(): boolean;
    wrapWithSandboxArgv(
      command: string,
      binShell?: string,
      customConfig?: undefined,
      abortSignal?: undefined,
      cwd?: string,
    ): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }>;
    annotateStderrWithSandboxFailures(command: string, stderr: string): string;
    cleanupAfterCommand(): void;
    reset(): Promise<void>;
  };
  SandboxRuntimeConfigSchema: { parse(value: unknown): unknown };
  VENDORED_SRT_WIN_EXE: string;
}

const INSTALL = `npm install ${SRT_PACKAGE}@${SRT_VERSION}`;

/** Under the home directory: what srt makes writable without being asked (its HOME_CONVENIENCE_WRITE_DIRS). */
export const SRT_CONVENIENCE_WRITES = [".npm/_logs", ".claude/debug"];

function platformFix(): string {
  switch (process.platform) {
    case "linux":
      return "srt needs bubblewrap, socat and ripgrep (Debian/Ubuntu: sudo apt-get install bubblewrap socat ripgrep). On Ubuntu 24.04 and later, AppArmor stops unprivileged user namespaces unless kernel.apparmor_restrict_unprivileged_userns is 0, which srt's README asks for; that is a system-wide setting, yours to change.";
    case "win32":
      return `On Windows srt needs a one-time install, which you run, with one UAC prompt: node node_modules/${SRT_PACKAGE}/dist/cli.js windows-install. It creates the srt-sandbox account and WFP filters; docs/sandbox-windows.md says what else it changes and how to undo it. After upgrading srt, run it again.`;
    default:
      return "See srt's README for this platform's requirements.";
  }
}

export class SrtBackend implements SandboxBackend {
  readonly name = "srt";
  private srt: SrtModule | undefined;
  /** The policy srt is initialized with, as JSON: a different one means reset and initialize again. */
  private current: string | undefined;
  /** Initializations, one at a time. */
  private chain: Promise<unknown> = Promise.resolve();
  /** Where srt itself is installed: never writable from inside, or a command could replace what runs the next one. */
  private home: string | undefined;

  /** Where srt is installed, once probed. */
  get installation(): string | undefined {
    return this.home;
  }

  async probe(): Promise<SandboxStatus> {
    let srt: SrtModule;
    let version: string;
    try {
      const specifier = SRT_PACKAGE;
      srt = (await import(specifier)) as SrtModule;
      this.home = path.dirname(path.dirname(fileURLToPath(import.meta.resolve(specifier))));
      version = (JSON.parse(fs.readFileSync(path.join(this.home, "package.json"), "utf-8")) as { version: string }).version;
    } catch (err) {
      return { ok: false, detail: `${SRT_PACKAGE} is not installed (${firstLine(err)})`, fix: `${INSTALL}. ${platformFix()}` };
    }
    const manager = srt.SandboxManager;
    const api = ["initialize", "isSupportedPlatform", "wrapWithSandboxArgv", "annotateStderrWithSandboxFailures", "cleanupAfterCommand", "reset"];
    const missing = api.filter((fn) => typeof (manager as unknown as Record<string, unknown> | undefined)?.[fn] !== "function");
    if (missing.length > 0 || typeof srt.SandboxRuntimeConfigSchema?.parse !== "function") {
      return { ok: false, detail: `${SRT_PACKAGE} ${version} lacks ${missing.join(", ") || "its config schema"}`, fix: INSTALL };
    }
    if (!manager.isSupportedPlatform()) return { ok: false, detail: `srt does not support ${process.platform} here` };
    this.srt = srt;

    // A command through it, end to end: dependencies, the account and the
    // filters on Windows, user namespaces on Linux all have to be there.
    const policy: SandboxPolicy = { allowWrite: [], denyWrite: [], denyRead: [], allowedDomains: [] };
    try {
      await this.configure(policy);
      const cwd = process.platform === "win32" ? (process.env.SystemRoot ?? "C:\\Windows") : os.tmpdir();
      const { argv, env } = await manager.wrapWithSandboxArgv("echo srt-probe-ok", binShell(resolveShell()), undefined, undefined, cwd);
      const [file = "", ...args] = argv;
      const out = await runCommand("echo srt-probe-ok", { cwd, timeoutMs: 60_000, sandboxed: { file, args, env: mergeEnv(withoutSecrets(), env) } });
      manager.cleanupAfterCommand();
      if (!out.stdout.includes("srt-probe-ok")) {
        const why = (out.spawnError ?? out.stderr).trim().slice(0, 300) || "no output";
        return { ok: false, detail: `a test command did not run in it (exit ${out.code}: ${why})`, fix: platformFix() };
      }
    } catch (err) {
      return { ok: false, detail: firstLine(err), fix: platformFix() };
    }
    const where = process.platform === "linux" ? "bubblewrap" : process.platform === "darwin" ? "sandbox-exec" : "srt-sandbox account, alpha";
    return { ok: true, detail: `sandbox-runtime ${version} (${where})` };
  }

  async prepare(request: SandboxRequest): Promise<SandboxedCommand> {
    const srt = this.srt;
    if (!srt) throw new Error("srt was never probed");
    await this.configure(request.policy);
    // srt points TMPDIR here and always lets it be written, but leaves making it to whoever
    // embeds srt; a folder that is not there on the host is not mounted, and writes to it fail.
    if (process.platform !== "win32") fs.mkdirSync(srtTempDir(), { recursive: true });
    const { argv, env } = await srt.SandboxManager.wrapWithSandboxArgv(request.command, binShell(request.shell), undefined, undefined, request.cwd);
    const [file, ...args] = argv;
    if (!file) throw new Error("srt returned no command to run");
    return {
      file,
      args,
      env: mergeEnv(request.env, env),
      // Linux mounts placeholder files over the paths it denies; this takes them away again.
      cleanup: async () => srt.SandboxManager.cleanupAfterCommand(),
    };
  }

  explain(command: string, stderr: string): string | undefined {
    if (!this.srt) return undefined;
    const annotated = this.srt.SandboxManager.annotateStderrWithSandboxFailures(command, stderr);
    return annotated === stderr ? undefined : annotated.slice(stderr.length).trim();
  }

  async dispose(): Promise<void> {
    // On Windows this takes back the ACL entries initialize() granted.
    if (this.srt && this.current !== undefined) await this.srt.SandboxManager.reset();
    this.current = undefined;
  }

  /** srt's session config for `policy`, set up unless it already is. srt fixes filesystem grants at initialize(). */
  private configure(policy: SandboxPolicy): Promise<void> {
    const next = this.chain.then(async () => {
      const srt = this.srt;
      if (!srt) throw new Error("srt was never probed");
      const config = srt.SandboxRuntimeConfigSchema.parse(this.config(policy));
      const key = JSON.stringify(config);
      if (key === this.current) return;
      if (this.current !== undefined) await srt.SandboxManager.reset();
      this.current = undefined;
      await srt.SandboxManager.initialize(config);
      this.current = key;
    });
    this.chain = next.catch(() => undefined);
    return next;
  }

  private config(policy: SandboxPolicy): Record<string, unknown> {
    const windows = process.platform === "win32";
    const home = os.homedir();
    // srt's own files, when a sandboxed command could otherwise write them:
    // on Windows srt-win.exe is started anew for every command, as the user.
    const own = this.home && policy.allowWrite.some((dir) => inside(this.home as string, dir)) ? [this.home] : [];
    // Two log folders srt opens to writing on Linux and macOS as a convenience, outside the
    // workspace; closed, so that the policy is what it says.
    const convenience = windows ? [] : SRT_CONVENIENCE_WRITES.map((p) => path.join(home, p));
    return {
      network: {
        // allowedDomains must be present, even empty, or srt leaves the network open.
        allowedDomains: policy.allowedDomains,
        deniedDomains: [],
        strictAllowlist: true,
      },
      filesystem: {
        // On Windows srt's install either leaves the profile closed to the sandbox account or
        // opens it to reading minus its own list of credential stores, which takes in all of
        // CREDENTIAL_PATHS (0.0.81, srt-win's profile_plan.rs); a deny of ours there would only
        // be another ACL entry on the user's own folders.
        denyRead: windows ? policy.denyRead.filter((p) => !inside(p, home)) : policy.denyRead,
        allowWrite: policy.allowWrite,
        denyWrite: [...policy.denyWrite, ...own, ...convenience],
      },
      ...(windows && this.srt ? { windows: { srtWin: { path: this.srt.VENDORED_SRT_WIN_EXE } } } : {}),
    };
  }
}

/** The TMPDIR srt gives a sandboxed command on Linux and macOS, chosen as srt chooses it. */
function srtTempDir(): string {
  return process.env.CLAUDE_CODE_TMPDIR || process.env.CLAUDE_TMPDIR || "/tmp/claude";
}

/** Git Bash as an absolute path, which srt runs with -c; cmd.exe, srt's own default, as nothing. */
function binShell(shell: Shell): string | undefined {
  return shell.kind === "cmd" ? undefined : shell.file;
}

/**
 * The environment srt asked for, on top of the harness's. On Linux and
 * macOS srt hands back process.env unchanged and carries its own variables
 * in the wrapped command; on Windows it builds the broker's. Either way,
 * what srt added or changed is kept, what it took out stays out, and what
 * the harness left out — the secrets — is not put back.
 */
function mergeEnv(harness: Record<string, string>, srt: NodeJS.ProcessEnv): Record<string, string> {
  const env = { ...harness };
  for (const name of Object.keys(process.env)) {
    if (srt[name] === undefined) delete env[name];
  }
  for (const [name, value] of Object.entries(srt)) {
    if (value !== undefined && process.env[name] !== value) env[name] = value;
  }
  return env;
}

function firstLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "";
}
