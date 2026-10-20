import * as os from "node:os";
import * as path from "node:path";
import type { Shell } from "../tools/shell.js";

/**
 * What a sandboxed command may touch. Reading is open except for `denyRead`;
 * writing is closed except for `allowWrite`, and closed again for
 * `denyWrite`; the network is closed except for `allowedDomains`. Each
 * backend enforces this as far as its mechanism can, and its README entry
 * says how far that is.
 */
export interface SandboxPolicy {
  /** Directories the command may write in, and everything under them: the workspace first. */
  allowWrite: string[];
  /** Paths it may not write even inside `allowWrite`: the sandbox's own code, for one. */
  denyWrite: string[];
  /** Files and directories it may not read, such as ~/.ssh. */
  denyRead: string[];
  /** Hosts it may connect to, where the backend can filter by host; empty means no network at all. */
  allowedDomains: string[];
}

/** What a backend is given for one command. */
export interface SandboxRequest {
  command: string;
  policy: SandboxPolicy;
  /** The shell the Bash tool would have run it in. */
  shell: Shell;
  /** The directory the command runs in: the workspace, or the call's own `cwd`. */
  cwd: string;
  /** The harness's environment less anything named like a secret: what the command may see. */
  env: Record<string, string>;
}

/** One command, ready to start inside the sandbox: what `runCommand` spawns instead of the bare shell. */
export interface SandboxedCommand {
  file: string;
  args: string[];
  /** cmd.exe-style quoting: Node must not quote the arguments again. */
  verbatim?: boolean;
  /** The whole environment to start it with. */
  env: Record<string, string>;
  /** Called once the command has exited, to remove whatever `prepare` made for it. */
  cleanup?: () => Promise<void>;
}

export type SandboxStatus = { ok: true; detail: string } | { ok: false; detail: string; fix?: string };

/**
 * An OS mechanism that runs a shell command contained. Implementations wrap
 * something outside this repository — sandbox-runtime, MXC — and none is
 * taken at its word: `probe` runs a command through it before saying yes.
 */
export interface SandboxBackend {
  readonly name: string;
  /** The shell commands run in inside it, when that cannot be the Bash tool's own: MXC cannot start Git Bash. */
  readonly shell?: Shell;
  /** A sentence for the model on how this backend's sandbox differs from what the Bash tool says of them all. */
  readonly note?: string;
  /**
   * Whether commands can run contained on this machine, and if not, what is
   * missing and how to get it. Never throws: a failure is an answer.
   */
  probe(): Promise<SandboxStatus>;
  /** The command, wrapped to run under its policy. Throws when it cannot be contained; it must then not run at all. */
  prepare(request: SandboxRequest): Promise<SandboxedCommand>;
  /** What the sandbox reported blocking while `command` ran, if the backend can tell. */
  explain?(command: string, stderr: string): string | undefined;
  /** Stop whatever `probe` and `prepare` started, and take back what they granted. */
  dispose?(): Promise<void>;
}

export interface SandboxOptions {
  /** More directories sandboxed commands may write in, besides the workspace. */
  allowWrite?: string[];
  /** More paths sandboxed commands may not read, besides `CREDENTIAL_PATHS`. */
  denyRead?: string[];
  /** Hosts sandboxed commands may reach. Default: none. */
  allowedDomains?: string[];
  /**
   * Whether a call may ask to run outside the sandbox, with
   * `dangerouslyDisableSandbox` — Claude Code's name for it. Such a call goes
   * to the permission rules, the gate and the user like any Bash call did
   * before there was a sandbox. Default true; false takes the way out away.
   */
  allowUnsandboxed?: boolean;
}

/**
 * Where tools keep keys and tokens, under the home directory. Reading them
 * is closed to a sandboxed command; nothing else in the home directory is,
 * unless the backend closes more.
 */
export const CREDENTIAL_PATHS = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".config/gcloud",
  ".config/gh",
  ".kube",
  ".docker",
  ".netrc",
  ".git-credentials",
];

/**
 * The variables a sandboxed command is not given: anything named like a key,
 * a token or a password, and SSH_AUTH_SOCK, through which an agent signs with
 * the user's keys.
 */
export const SECRET_ENV = /(?:^|_)(?:KEY|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|AUTH|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)(?:_|$)/i;

/** Raised by `Sandbox.prepare` when the sandbox is not there; the command must not run. */
export class SandboxUnavailable extends Error {
  override readonly name = "SandboxUnavailable";
}

/**
 * A backend and the policy it runs Bash commands under, shared by an agent
 * and its subagents. `ready()` probes once; until it has said yes, nothing
 * runs in it and nothing is let through on its account.
 */
export class Sandbox {
  readonly backend: SandboxBackend;
  readonly allowUnsandboxed: boolean;
  private readonly options: SandboxOptions;
  private probing: Promise<SandboxStatus> | undefined;
  private status: SandboxStatus | undefined;

  constructor(backend: SandboxBackend, options: SandboxOptions = {}) {
    this.backend = backend;
    this.options = options;
    this.allowUnsandboxed = options.allowUnsandboxed ?? true;
  }

  /** Probe the backend, once. A probe that throws is a no, not a crash. */
  ready(): Promise<SandboxStatus> {
    this.probing ??= this.backend
      .probe()
      .catch((err: unknown): SandboxStatus => ({ ok: false, detail: `the probe failed: ${err instanceof Error ? err.message : String(err)}` }))
      .then((status) => {
        this.status = status;
        return status;
      });
    return this.probing;
  }

  /** True once `ready()` has said yes. */
  get usable(): boolean {
    return this.status?.ok === true;
  }

  /** The hosts sandboxed commands may reach. */
  get allowedDomains(): string[] {
    return [...(this.options.allowedDomains ?? [])];
  }

  /**
   * The policy for a command whose workspace is `workspace`: the agent's
   * working directory, never the per-call `cwd`, which can point anywhere.
   */
  policy(workspace: string): SandboxPolicy {
    const home = os.homedir();
    return {
      allowWrite: [path.resolve(workspace), ...(this.options.allowWrite ?? []).map((p) => path.resolve(p))],
      denyWrite: [],
      denyRead: [...CREDENTIAL_PATHS.map((p) => path.join(home, p)), ...(this.options.denyRead ?? []).map((p) => path.resolve(p))],
      allowedDomains: this.allowedDomains,
    };
  }

  /**
   * `command` wrapped to run contained: its workspace is `workspace`, and it
   * starts in `cwd`. Throws `SandboxUnavailable` if the sandbox never came
   * up, and whatever the backend throws if it cannot contain this one;
   * either way the caller reports the failure and does not run the command.
   */
  async prepare(command: string, workspace: string, cwd: string, shell: Shell): Promise<SandboxedCommand> {
    const status = await this.ready();
    if (!status.ok) throw new SandboxUnavailable(`the ${this.backend.name} sandbox is not available: ${status.detail}`);
    return this.backend.prepare({ command, policy: this.policy(workspace), shell, cwd, env: withoutSecrets() });
  }

  async dispose(): Promise<void> {
    await this.backend.dispose?.();
  }
}

/** Whether `child` is `parent` or under it. */
export function inside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * The environment, less what looks like a secret. Not the OS's doing but
 * the harness's: the API key it was started with is in its own environment,
 * and a command in the sandbox could otherwise print it or write it into the
 * workspace.
 */
export function withoutSecrets(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const kept: Record<string, string> = { FORCE_COLOR: "0" };
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !SECRET_ENV.test(name) && name !== "FORCE_COLOR") kept[name] = value;
  }
  return kept;
}
