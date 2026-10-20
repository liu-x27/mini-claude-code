/**
 * Escape tests — a real sandbox backend, real commands, through the Bash tool.
 *
 * Every case that should be blocked has a control showing the same thing
 * works where it is allowed: the target is written from outside the sandbox
 * first, the network is reached from outside first. A sandbox that blocks
 * everything, or never started, cannot pass by accident, and a machine with
 * no network fails the network cases rather than passing them.
 *
 * Run: npm run test:sandbox -- --backend srt|mxc [--root <dir>]
 *
 * --root puts the test's workspace under <dir> (default: the temp
 * directory). Where matters on Windows: srt's account can write wherever a
 * folder's ACL already lets any signed-in user modify it, as on D:\ by
 * default (sandbox-runtime issue #402), so a run with --root D:\somewhere
 * tests that case.
 *
 * It writes only inside a directory of its own, except for one canary each
 * in ~/.ssh, the home directory and the temp directory, which it removes.
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import chalk from "chalk";
import { isSandboxBackendName, SANDBOX_BACKENDS, sandboxBackend } from "../src/sandbox/backends.js";
import { inside as within, Sandbox } from "../src/sandbox/index.js";
import { MxcBackend } from "../src/sandbox/mxc.js";
import { SRT_PACKAGE, SrtBackend } from "../src/sandbox/srt.js";
import { BashTool } from "../src/tools/bash.js";
import { resolveShell } from "../src/tools/shell.js";
import type { ToolContext, ToolResult } from "../src/types.js";

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
const name = flag("--backend");
if (!isSandboxBackendName(name)) {
  console.error(`usage: npm run test:sandbox -- --backend ${SANDBOX_BACKENDS.join("|")} [--root <dir>]`);
  process.exit(2);
}

/** On Actions, also an annotation, which the run's page shows to anyone, unlike its logs. */
function annotate(title: string, message: string): void {
  const data = message.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=${title.replace(/[%:,\r\n]/g, " ")}::${data}`);
}

let sandbox = new Sandbox(sandboxBackend(name));
const status = await sandbox.ready();
if (!status.ok) {
  console.error(chalk.red(`✗ the ${name} sandbox is not available: ${status.detail}`));
  if (status.fix) console.error(chalk.gray(`  ${status.fix}`));
  annotate(`${name} sandbox not available`, status.detail);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `### Sandbox escape tests: ${name} on ${process.platform}\n\nNot run: the sandbox is not available: ${status.detail}\n\n`);
  }
  await sandbox.dispose();
  process.exit(1);
}

const id = randomBytes(4).toString("hex");
const home = os.homedir();
const root = await fs.mkdtemp(path.join(path.resolve(flag("--root") ?? os.tmpdir()), "sbx-escape-"));
const workspace = path.join(root, "workspace");
await fs.mkdir(workspace);
const context: ToolContext = { cwd: workspace, sessionId: "escape", agentId: "escape", permissions: { defaultMode: "allow", rules: [] } };
console.log(chalk.bold(`Escape tests · ${name} · ${status.detail}`));
console.log(chalk.gray(`workspace ${workspace}`));

/** In the sandbox, through the Bash tool, as the model's command would run. */
const inside = (command: string, box: Sandbox = sandbox): Promise<ToolResult> =>
  new BashTool(box).execute({ command, timeout: 60_000 }, context);

/** Commands in the dialect of the shell inside the sandbox: cmd.exe under MXC, bash otherwise. */
const cmd = (sandbox.backend.shell ?? resolveShell()).kind === "cmd";
const q = (p: string) => (cmd ? `"${p}"` : `'${p.replace(/\\/g, "/").replace(/'/g, `'\\''`)}'`);
const say = {
  write: (text: string, p: string) => `echo ${text} > ${q(p)}`,
  read: (p: string) => `${cmd ? "type" : "cat"} ${q(p)}`,
  list: (p: string) => (cmd ? `dir /a /b ${q(p)}` : `ls -a ${q(p)}`),
  exit: (n: number) => (cmd ? `exit /b ${n}` : `exit ${n}`),
  env: (v: string) => (cmd ? `echo [%${v}%]` : `echo "[$${v}]"`),
  tmp: (text: string) =>
    cmd
      ? `echo ${text} > "%TEMP%\\sbx-tmp.txt" && type "%TEMP%\\sbx-tmp.txt"`
      : `t="\${TMPDIR:-$TEMP}"; echo ${text} > "$t/sbx-tmp.txt" && cat "$t/sbx-tmp.txt"`,
  devnull: cmd ? "NUL" : "/dev/null",
};

const text = (r: ToolResult) => (r.type === "success" ? r.output : r.message);
const gist = (r: ToolResult) => text(r).replace(/\s+/g, " ").slice(0, 160);
const exists = (p: string) => fs.access(p).then(() => true, () => false);

interface Outcome {
  case: string;
  expect: string;
  ok: boolean;
  /** Set when the case failed the way an open upstream issue says it does, under that issue's conditions. */
  known?: string;
  detail: string;
}
const outcomes: Outcome[] = [];
const cleanups: Array<() => Promise<unknown>> = [];

/**
 * One case. `known` names an open upstream issue that makes it fail where
 * `when` holds: such a failure is reported as known and not counted, and
 * only if its message matches `matches`, so a different failure still counts.
 */
async function test(
  label: string,
  expect: string,
  fn: () => Promise<string>,
  known?: { when: boolean; issue: string; matches: RegExp },
): Promise<void> {
  try {
    const detail = await fn();
    outcomes.push({ case: label, expect, ok: true, detail: known?.when ? `${detail} (${known.issue} did not show)` : detail });
    console.log(`${chalk.green("  ✓")} ${label} ${chalk.gray(`— ${detail}`)}`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (known?.when && known.matches.test(detail)) {
      outcomes.push({ case: label, expect, ok: true, known: known.issue, detail });
      console.log(`${chalk.yellow("  ⚠")} ${label} ${chalk.yellow(`— known, ${known.issue}: ${detail}`)}`);
      return;
    }
    outcomes.push({ case: label, expect, ok: false, detail });
    console.log(`${chalk.red("  ✗")} ${label} ${chalk.red(`— ${detail}`)}`);
    annotate(label, detail);
  }
}

/** A write the user can make outside the sandbox, which the sandbox must refuse. */
async function blockedWrite(target: string): Promise<string> {
  await fs.writeFile(`${target}.control`, "control");
  await fs.rm(`${target}.control`);
  cleanups.push(() => fs.rm(target, { force: true }));
  const r = await inside(say.write("escaped", target));
  if (await exists(target)) throw new Error(`the file was written: ${target}`);
  if (r.type === "success") throw new Error(`the command reported success: ${gist(r)}`);
  return `refused (${gist(r)})`;
}

/** A TCP connection from outside the sandbox, as the network control. */
function connect(host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port, timeout: 10_000 });
    socket.once("connect", () => {
      socket.destroy();
      resolve();
    });
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error("timed out"));
    });
    socket.once("error", reject);
  });
}

try {
  console.log(chalk.blue.bold("\n▶ Allowed: the controls"));

  await test("a command runs and its output comes back", "allowed", async () => {
    const r = await inside("echo sbx-ok");
    if (r.type !== "success" || !r.output.includes("sbx-ok")) throw new Error(gist(r));
    return "echo printed sbx-ok";
  });

  await test("its exit code comes back", "allowed", async () => {
    const r = await inside(say.exit(3));
    if (r.type !== "error" || !r.message.includes("exit code: 3")) throw new Error(gist(r));
    return "exit 3 came back as 3";
  });

  await test("it writes in the workspace", "allowed", async () => {
    const r = await inside(say.write("inside", "in-workspace.txt"));
    const written = await fs.readFile(path.join(workspace, "in-workspace.txt"), "utf-8").catch(() => "");
    if (r.type !== "success" || written.trim() !== "inside") throw new Error(`${gist(r)}; file: ${JSON.stringify(written)}`);
    return "in-workspace.txt written";
  });

  await test("it reads in the workspace", "allowed", async () => {
    await fs.writeFile(path.join(workspace, "readme.txt"), `readable-${id}\n`);
    const r = await inside(say.read("readme.txt"));
    if (r.type !== "success" || !r.output.includes(`readable-${id}`)) throw new Error(gist(r));
    return "readme.txt read";
  });

  // Node's realpath stats every folder down to the script; srt's account on Windows cannot stat
  // those between the profile and a workspace two or more levels inside it.
  const srtProfileStat = {
    when: name === "srt" && process.platform === "win32" && within(workspace, home) && workspace !== home,
    issue: "sandbox-runtime#657",
    matches: /EPERM: operation not permitted, lstat/,
  };
  await test(
    "a Node script in the workspace runs",
    "allowed",
    async () => {
      await fs.writeFile(path.join(workspace, "hello.mjs"), `console.log("node-${id}", process.version);\n`);
      const r = await inside("node hello.mjs");
      if (r.type !== "success" || !r.output.includes(`node-${id}`)) throw new Error(gist(r));
      return r.output.trim().split(/\s+/).slice(-1)[0] ?? "ran";
    },
    srtProfileStat,
  );

  await test("it writes in the temp directory the sandbox gives it", "allowed", async () => {
    const r = await inside(say.tmp(`t-${id}`));
    if (r.type !== "success" || !r.output.includes(`t-${id}`)) throw new Error(gist(r));
    return "written and read back";
  });

  console.log(chalk.blue.bold("\n▶ Blocked: writing outside the workspace"));

  await test("a write to the home directory", "blocked", () => blockedWrite(path.join(home, `sbx-escape-${id}.txt`)));
  await test("a write to the shared temp directory", "blocked", () => blockedWrite(path.join(os.tmpdir(), `sbx-escape-${id}.txt`)));
  await test("a write next to the workspace", "blocked", () => blockedWrite(path.join(root, `next-to-workspace-${id}.txt`)));
  // srt opens this to writing by default on Linux and macOS; the srt backend closes it again.
  await test("a write to ~/.npm/_logs", "blocked", async () => {
    const logs = path.join(home, ".npm", "_logs");
    if (!(await exists(logs))) {
      await fs.mkdir(logs, { recursive: true });
      cleanups.push(() => fs.rmdir(logs).catch(() => undefined));
    }
    return blockedWrite(path.join(logs, `sbx-escape-${id}.txt`));
  });

  await test("a write through a link in the workspace that points outside", "blocked", async () => {
    const target = path.join(home, `sbx-link-target-${id}`);
    await fs.mkdir(target);
    cleanups.push(() => fs.rm(target, { recursive: true, force: true }));
    // A junction on Windows: a directory symlink there needs a privilege or developer mode.
    await fs.symlink(target, path.join(workspace, "link-out"), process.platform === "win32" ? "junction" : "dir");
    await fs.writeFile(path.join(workspace, "link-out", "control.txt"), "control");
    await fs.rm(path.join(target, "control.txt"));
    const r = await inside(say.write("escaped", path.join("link-out", "escaped.txt")));
    if (await exists(path.join(target, "escaped.txt"))) throw new Error("the file was written through the link");
    if (r.type === "success") throw new Error(`the command reported success: ${gist(r)}`);
    return `refused (${gist(r)})`;
  });

  console.log(chalk.blue.bold("\n▶ Blocked: reading ~/.ssh"));

  await test("reading a file in ~/.ssh, and listing it", "blocked", async () => {
    const ssh = path.join(home, ".ssh");
    if (!(await exists(ssh))) {
      await fs.mkdir(ssh, { mode: 0o700 });
      cleanups.push(() => fs.rm(ssh, { recursive: true, force: true }));
    }
    const canary = path.join(ssh, `sbx-canary-${id}`);
    const secret = `canary-${randomBytes(8).toString("hex")}`;
    await fs.writeFile(canary, `${secret}\n`, { mode: 0o600 });
    cleanups.push(() => fs.rm(canary, { force: true }));
    if (!(await fs.readFile(canary, "utf-8")).includes(secret)) throw new Error("inconclusive: the canary cannot be read outside either");
    const read = await inside(say.read(canary));
    if (text(read).includes(secret)) throw new Error("the canary's contents came back");
    const list = await inside(say.list(ssh));
    if (text(list).includes(`sbx-canary-${id}`)) throw new Error("~/.ssh could be listed");
    return `refused (${gist(read)})`;
  });

  console.log(chalk.blue.bold("\n▶ Blocked: the network"));

  // example.com's page says "Example Domain"; a proxy's refusal of an HTTPS tunnel leaves the code at 000.
  const answered = (r: ToolResult) => text(r).includes("Example Domain") || /http [23]\d\d/.test(text(r));
  // curl's own words, an error or the code -w printed: a curl that never started says neither,
  // and its failure would say nothing about the network.
  const curlRan = (r: ToolResult) => /curl: \(\d+\)|(?:http|tcp) \d{3}/.test(text(r));
  const refused = (r: ToolResult) => {
    if (answered(r)) throw new Error(`it went through: ${gist(r)}`);
    if (!curlRan(r)) throw new Error(`inconclusive: curl did not run inside: ${gist(r)}`);
    return `refused (${gist(r)})`;
  };

  await test("curl starts inside the sandbox", "allowed", async () => {
    const r = await inside("curl --version");
    if (r.type !== "success" || !/^curl \d/m.test(r.output)) throw new Error(gist(r));
    return r.output.split("\n")[1]?.slice(0, 60) ?? "ran";
  });

  // Plain HTTP as well as HTTPS: TLS can fail inside for reasons of its own (on Windows, Git
  // Bash's curl is built on schannel, which srt's restricted token stops), and a request that
  // fails that way says nothing about the sandbox.
  for (const url of ["http://example.com/", "https://example.com/"]) {
    await test(`a request to ${url}`, "blocked", async () => {
      const control = await fetch(url, { signal: AbortSignal.timeout(15_000) }).catch((err: unknown) => err as Error);
      if (control instanceof Error) throw new Error(`inconclusive: no network outside the sandbox either (${control.message})`);
      return refused(await inside(`curl -sS -m 15 -w "\\nhttp %{http_code}" ${url}`));
    });
  }

  await test("a direct TCP connection to an IP address, past any proxy", "blocked", async () => {
    await connect("1.1.1.1", 80).catch((err: Error) => {
      throw new Error(`inconclusive: no connection outside the sandbox either (${err.message})`);
    });
    const r = await inside(`curl -sS -m 10 --noproxy "*" -o ${say.devnull} -w "tcp %{http_code}" http://1.1.1.1/`);
    if (/tcp [1-5]\d\d/.test(text(r))) throw new Error(`the connection was made: ${gist(r)}`);
    return refused(r);
  });

  // The control for the two cases above, where the backend can filter by host: curl inside the
  // sandbox does reach a host the policy names, so its failures there were the sandbox's.
  if (sandbox.backend instanceof SrtBackend) {
    await test("a host the policy names answers; one it does not is refused", "allowed, then blocked", async () => {
      await sandbox.dispose();
      sandbox = new Sandbox(sandboxBackend("srt"), { allowedDomains: ["example.com"] });
      const again = await sandbox.ready();
      if (!again.ok) throw new Error(`inconclusive: ${again.detail}`);
      // Plain HTTP, through srt's proxy without a TLS tunnel, for the reason above.
      const allowed = await inside('curl -sS -m 20 -w "\\nhttp %{http_code}" http://example.com/');
      if (!answered(allowed)) throw new Error(`example.com, which the policy names, did not answer: ${gist(allowed)}`);
      const other = await inside('curl -sS -m 20 -w "\\nhttp %{http_code}" http://example.org/');
      return `example.com answered; example.org ${refused(other)}`;
    });
  }

  console.log(chalk.blue.bold("\n▶ The harness's part"));

  await test("an API key in the harness's environment", "not passed in", async () => {
    const secret = `sk-${id}-not-real`;
    process.env.SBX_ESCAPE_API_KEY = secret;
    try {
      const r = await inside(say.env("SBX_ESCAPE_API_KEY"));
      if (r.type !== "success" || r.output.includes(secret)) throw new Error(gist(r));
      return "not there inside";
    } finally {
      delete process.env.SBX_ESCAPE_API_KEY;
    }
  });

  // What launches the sandbox must not be writable from inside it, or one
  // command could replace what starts the next one, as the user.
  const backend = sandbox.backend;
  if (backend instanceof SrtBackend && backend.installation) {
    const srtHome = backend.installation;
    await test(`a write into ${SRT_PACKAGE}'s own files, from a grant that covers them`, "blocked", async () => {
      await sandbox.dispose();
      // The grant is on the folder above srt's, as when the workspace is a checkout with srt in node_modules.
      sandbox = new Sandbox(sandboxBackend("srt"), { allowWrite: [path.dirname(srtHome)] });
      const again = await sandbox.ready();
      if (!again.ok) throw new Error(`inconclusive: ${again.detail}`);
      const target = path.join(srtHome, `sbx-escape-${id}.txt`);
      cleanups.push(() => fs.rm(target, { force: true }));
      const r = await inside(say.write("escaped", target));
      if (await exists(target)) throw new Error(`written: ${target}`);
      return `refused (${gist(r)})`;
    });
  }
  if (backend instanceof MxcBackend && backend.executable) {
    const exe = backend.executable;
    await test("a grant that would let commands write over wxc-exec.exe", "refused", async () => {
      const box = new Sandbox(sandboxBackend("mxc"), { allowWrite: [path.dirname(exe)] });
      const ready = await box.ready();
      if (!ready.ok) throw new Error(`inconclusive: ${ready.detail}`);
      try {
        const r = await inside("echo should-not-run", box);
        if (r.type === "success" || !text(r).includes("wxc-exec.exe")) throw new Error(`it ran: ${gist(r)}`);
        return `refused (${gist(r)})`;
      } finally {
        await box.dispose();
      }
    });
  }
} finally {
  for (const cleanup of cleanups.reverse()) await cleanup().catch(() => undefined);
  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  await sandbox.dispose();
}

const failed = outcomes.filter((o) => !o.ok);
const known = outcomes.filter((o) => o.known);
const passed = outcomes.length - failed.length - known.length;
const knownNote = known.length > 0 ? `, ${known.length} known (${known.map((o) => o.known).join(", ")})` : "";
console.log(`\n${"─".repeat(50)}`);
console.log(
  failed.length === 0
    ? chalk.green.bold(`✅ ${passed}/${outcomes.length} on ${name} (${process.platform})${knownNote}`)
    : chalk.yellow(`⚠  ${passed}/${outcomes.length} on ${name} (${process.platform})${knownNote}, ${chalk.red(`${failed.length} failed`)}`),
);
console.log("─".repeat(50));

// On Actions, the same table on the run's summary page.
if (process.env.GITHUB_STEP_SUMMARY) {
  const mark = (o: Outcome) => (o.known ? `⚠️ known, ${o.known}` : o.ok ? "✅" : "❌");
  const rows = outcomes.map((o) => `| ${mark(o)} | ${o.case} | ${o.expect} | ${o.detail.replace(/\|/g, "\\|")} |`);
  const head = `### Sandbox escape tests: ${name} on ${process.platform} (${status.detail})\n\n| | case | expected | what happened |\n|---|---|---|---|`;
  await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `${head}\n${rows.join("\n")}\n\n`);
}

process.exitCode = failed.length > 0 ? 1 : 0;
