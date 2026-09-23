/**
 * Mock Test — 不需要 ANTHROPIC_API_KEY
 * 验证工具系统、权限系统、会话管理是否正常运行
 *
 * Run: npx tsx examples/00-mock-test.ts
 */

import { registerBuiltinTools, globalRegistry } from "../src/tools/index.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { BashTool } from "../src/tools/bash.js";
import { FileReadTool } from "../src/tools/file-read.js";
import { FileWriteTool } from "../src/tools/file-write.js";
import { FileEditTool } from "../src/tools/file-edit.js";
import { GlobTool } from "../src/tools/glob.js";
import { GrepTool } from "../src/tools/grep.js";
import { PermissionSystem, PermissionPresets } from "../src/permissions/index.js";
import { AllowlistJudge } from "../src/judge/allowlist.js";
import { createRiskGate, RISK_QUESTIONS } from "../src/judge/gate.js";
import { createModelRouter } from "../src/judge/router.js";
import { UNKNOWN_PROBABILITY } from "../src/judge/types.js";
import type { JudgeBackend, JudgeState, NoulAnswer, NoulQuestion } from "../src/judge/types.js";
import { SessionManager } from "../src/session/manager.js";
import { estimateCost, formatCost } from "../src/utils/cost.js";
import type {
  AgentConfig,
  AgentEvent,
  PermissionDecision,
  ToolContext,
  ToolResult,
} from "../src/types.js";
import { Agent } from "../src/agent.js";
import { Tool } from "../src/tools/base.js";
import { toOpenAIMessages } from "../src/model/openai.js";
import type { ModelClient, ModelRequest, ModelResponse } from "../src/model/types.js";
import type Anthropic from "@anthropic-ai/sdk";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

// ─────────────────────────────────────────────
const pass = (msg: string) => console.log(chalk.green("  ✓") + " " + msg);
const fail = (msg: string, err: unknown) => console.log(chalk.red("  ✗") + " " + msg + ": " + err);
const section = (title: string) => console.log(chalk.blue.bold(`\n▶ ${title}`));

let passed = 0;
let failed = 0;

function check(label: string, fn: () => void) {
  try {
    fn();
    pass(label);
    passed++;
  } catch (e) {
    fail(label, e);
    failed++;
  }
}

async function checkAsync(label: string, fn: () => Promise<void>) {
  try {
    await fn();
    pass(label);
    passed++;
  } catch (e) {
    fail(label, e);
    failed++;
  }
}

// ─────────────────────────────────────────────
// Mock context
// ─────────────────────────────────────────────
const ctx: ToolContext = {
  cwd: process.cwd(),
  sessionId: "test-session-001",
  agentId: "test-agent",
  permissions: { defaultMode: "allow", rules: [] },
};

// ─────────────────────────────────────────────
// 1. Tool Registry
// ─────────────────────────────────────────────
section("1. Tool Registry");

registerBuiltinTools();

check("全局注册表已注册内置工具", () => {
  const names = globalRegistry.names();
  if (names.length < 7) throw new Error(`只注册了 ${names.length} 个工具，期望 ≥ 7`);
  console.log(chalk.gray("    工具列表: " + names.join(", ")));
});

check("自定义注册表独立运作", () => {
  const reg = new ToolRegistry();
  reg.register(new BashTool());
  if (!reg.has("Bash")) throw new Error("Bash 工具未注册");
  if (reg.has("Read")) throw new Error("Read 不应在自定义注册表中");
});

check("重复注册抛出错误", () => {
  const reg = new ToolRegistry();
  reg.register(new BashTool());
  try {
    reg.register(new BashTool());
    throw new Error("应该抛出错误但没有");
  } catch (e: unknown) {
    if (e instanceof Error && e.message.includes("already registered")) return;
    throw e;
  }
});

check("resolve() 支持 allowedTools 过滤", () => {
  const tools = globalRegistry.resolve(["Read", "Glob"]);
  if (tools.length !== 2) throw new Error(`期望 2 个工具，得到 ${tools.length}`);
  if (!tools.find(t => t.name === "Read")) throw new Error("Read 未找到");
});

check("resolve() 支持 disallowedTools 过滤", () => {
  const total = globalRegistry.all().length;
  const tools = globalRegistry.resolve(undefined, ["Bash"]);
  if (tools.length !== total - 1) throw new Error(`过滤后数量不对: ${tools.length}`);
});

// ─────────────────────────────────────────────
// 2. Tool Execution
// ─────────────────────────────────────────────
section("2. Tool Execution");

await checkAsync("BashTool: 执行简单命令", async () => {
  const tool = new BashTool();
  const result = await tool.execute({ command: "echo hello_agent" }, ctx);
  if (result.type !== "success") throw new Error(result.message);
  if (!result.output.includes("hello_agent")) throw new Error(`输出不包含 hello_agent: ${result.output}`);
});

await checkAsync("BashTool: 捕获错误退出码", async () => {
  const tool = new BashTool();
  const result = await tool.execute({ command: "exit 1" }, ctx);
  if (result.type !== "error") throw new Error("应该返回 error 类型");
});

await checkAsync("BashTool: 超时保护", async () => {
  const tool = new BashTool();
  const result = await tool.execute({ command: "sleep 10", timeout: 500 }, ctx);
  if (result.type !== "error") throw new Error("超时后应该返回 error");
});

await checkAsync("FileWriteTool + FileReadTool: 写入后读取", async () => {
  const tempDir = os.tmpdir();
  const filePath = path.join(tempDir, "agent_test_" + Date.now() + ".txt");
  const writeTool = new FileWriteTool();
  const readTool = new FileReadTool();

  const writeResult = await writeTool.execute(
    { file_path: filePath, content: "line1\nline2\nline3" },
    { ...ctx, cwd: tempDir }
  );
  if (writeResult.type !== "success") throw new Error("写入失败: " + writeResult.message);

  const readResult = await readTool.execute(
    { file_path: filePath },
    { ...ctx, cwd: tempDir }
  );
  if (readResult.type !== "success") throw new Error("读取失败: " + readResult.message);
  if (!readResult.output.includes("line2")) throw new Error("读取内容不包含 line2");
  console.log(chalk.gray("    文件路径: " + filePath));
});

await checkAsync("FileEditTool: 精确字符串替换", async () => {
  const tempDir = os.tmpdir();
  const filePath = path.join(tempDir, "agent_edit_" + Date.now() + ".txt");
  const writeTool = new FileWriteTool();
  const editTool = new FileEditTool();
  const readTool = new FileReadTool();

  await writeTool.execute({ file_path: filePath, content: "Hello World" }, { ...ctx, cwd: tempDir });
  const editResult = await editTool.execute(
    { file_path: filePath, old_string: "World", new_string: "Agent" },
    { ...ctx, cwd: tempDir }
  );
  if (editResult.type !== "success") throw new Error("编辑失败: " + editResult.message);

  const readResult = await readTool.execute({ file_path: filePath }, { ...ctx, cwd: tempDir });
  if (readResult.type !== "success") throw new Error("读取失败: " + readResult.message);
  if (!readResult.output.includes("Hello Agent")) throw new Error("替换结果不对");
});

await checkAsync("FileEditTool: 字符串不存在时报错", async () => {
  const tempDir = os.tmpdir();
  const filePath = path.join(tempDir, "agent_edit2_" + Date.now() + ".txt");
  const writeTool = new FileWriteTool();
  const editTool = new FileEditTool();

  await writeTool.execute({ file_path: filePath, content: "Hello World" }, { ...ctx, cwd: tempDir });
  const result = await editTool.execute(
    { file_path: filePath, old_string: "NotExist", new_string: "X" },
    { ...ctx, cwd: tempDir }
  );
  if (result.type !== "error") throw new Error("应该返回 error");
});

await checkAsync("GlobTool: 匹配 TS 文件", async () => {
  const tool = new GlobTool();
  const result = await tool.execute({ pattern: "src/**/*.ts" }, { ...ctx, cwd: REPO_ROOT });
  if (result.type !== "success") throw new Error(result.message);
  if (!result.output.includes(".ts")) throw new Error("应该找到 TS 文件");
  console.log(chalk.gray("    " + result.output.split("\n")[0]));
});

await checkAsync("GrepTool: 搜索关键词", async () => {
  const tool = new GrepTool();
  const result = await tool.execute(
    { pattern: "class Agent", path: path.join(REPO_ROOT, "src") },
    { ...ctx, cwd: REPO_ROOT }
  );
  if (result.type !== "success") throw new Error(result.message);
  // 输出包含匹配行内容（Windows 路径用 \ 分隔，用内容匹配而非文件名）
  if (!result.output.includes("export class Agent") && !result.output.includes("agent.ts")) {
    throw new Error(`未找到期望内容，实际输出: ${result.output.slice(0, 100)}`);
  }
  console.log(chalk.gray("    " + result.output.split("\n")[0]));
});

// ─────────────────────────────────────────────
// 3. Permission System
// ─────────────────────────────────────────────
section("3. Permission System");

await checkAsync("默认 allow 模式放行所有工具", async () => {
  const perm = new PermissionSystem(PermissionPresets.allowAll());
  const allowed = await perm.check({ toolName: "Bash", input: {}, description: "test" });
  if (!allowed) throw new Error("应该放行");
});

await checkAsync("readOnly 预设拒绝 Bash/Write/Edit", async () => {
  const perm = new PermissionSystem(PermissionPresets.readOnly());
  const r1 = await perm.check({ toolName: "Bash", input: {}, description: "test" });
  const r2 = await perm.check({ toolName: "Write", input: {}, description: "test" });
  const r3 = await perm.check({ toolName: "Read", input: {}, description: "test" });
  if (r1) throw new Error("Bash 应该被拒绝");
  if (r2) throw new Error("Write 应该被拒绝");
  if (!r3) throw new Error("Read 应该被放行");
});

check("getContext() 返回规则副本", () => {
  const perm = new PermissionSystem(PermissionPresets.readOnly());
  const ctx1 = perm.getContext();
  const ctx2 = perm.getContext();
  // Should be equal but not same reference
  if (ctx1 === ctx2) throw new Error("应该返回新对象");
  if (ctx1.rules.length !== ctx2.rules.length) throw new Error("规则数量不一致");
});

// ─────────────────────────────────────────────
// 4. Risk Gate
// ─────────────────────────────────────────────
section("4. Risk Gate");

// A backend that answers every question with the same number, and counts how
// often it was asked — enough to test the gate's own logic without a model.
function fakeJudge(probability: number) {
  const backend = {
    name: "fake",
    calls: 0,
    async noul(_state: JudgeState, questions: NoulQuestion[]): Promise<NoulAnswer[]> {
      backend.calls++;
      return questions.map((q) => ({ id: q.id, probability }));
    },
  };
  return backend;
}

/** A prompt that records being reached instead of touching stdin. */
function recordingPrompt() {
  const record = { asked: 0, prompt: async () => { record.asked++; return "deny" as const; } };
  return record;
}

await checkAsync("静态规则 allow 时不询问判断层", async () => {
  const judge = fakeJudge(0.99);
  const perm = new PermissionSystem({
    defaultMode: "allow",
    gate: createRiskGate({ backend: judge }),
  });
  const allowed = await perm.check({ toolName: "Bash", input: { command: "ls" }, description: "ls" });
  if (!allowed) throw new Error("应该放行");
  if (judge.calls !== 0) throw new Error(`判断层被调用了 ${judge.calls} 次，应该是 0`);
});

await checkAsync("静态规则 deny 时不询问判断层", async () => {
  const judge = fakeJudge(0.0);
  const perm = new PermissionSystem({
    ...PermissionPresets.readOnly(),
    gate: createRiskGate({ backend: judge }),
  });
  const allowed = await perm.check({ toolName: "Bash", input: { command: "ls" }, description: "ls" });
  if (allowed) throw new Error("deny 规则不该被判断层推翻");
  if (judge.calls !== 0) throw new Error(`判断层被调用了 ${judge.calls} 次，应该是 0`);
});

await checkAsync("低于阈值时自动放行，不打扰用户", async () => {
  const asker = recordingPrompt();
  const perm = new PermissionSystem({
    defaultMode: "ask",
    prompt: asker.prompt,
    gate: createRiskGate({ backend: fakeJudge(0.01), autoAllowBelow: 0.05 }),
  });
  const allowed = await perm.check({ toolName: "Bash", input: { command: "ls" }, description: "ls" });
  if (!allowed) throw new Error("应该自动放行");
  if (asker.asked !== 0) throw new Error("不应该问用户");
});

await checkAsync("高于阈值时落回询问用户", async () => {
  const asker = recordingPrompt();
  const perm = new PermissionSystem({
    defaultMode: "ask",
    prompt: asker.prompt,
    gate: createRiskGate({ backend: fakeJudge(0.9), autoAllowBelow: 0.05 }),
  });
  await perm.check({ toolName: "Bash", input: { command: "rm -rf /" }, description: "rm" });
  if (asker.asked !== 1) throw new Error(`应该问用户 1 次，实际 ${asker.asked} 次`);
});

await checkAsync("默认不自动拒绝（denyAbove 关闭）", async () => {
  const asker = recordingPrompt();
  const perm = new PermissionSystem({
    defaultMode: "ask",
    prompt: asker.prompt,
    gate: createRiskGate({ backend: fakeJudge(1.0) }),
  });
  await perm.check({ toolName: "Bash", input: { command: "rm -rf /" }, description: "rm" });
  if (asker.asked !== 1) throw new Error("最危险的调用也该让用户自己看到");
});

// The four fail-closed paths. Each one is a way the judge can stop working
// without anything else noticing, which is the failure worth testing.
const failingBackends: [string, JudgeBackend][] = [
  ["后端抛错", { name: "throws", async noul() { throw new Error("boom"); } }],
  [
    "后端超时",
    {
      name: "hangs",
      async noul() {
        await new Promise((r) => setTimeout(r, 200));
        return [];
      },
    },
  ],
  [
    "概率越界",
    {
      name: "out-of-range",
      async noul(_s: JudgeState, qs: NoulQuestion[]) {
        return qs.map((q) => ({ id: q.id, probability: -1 }));
      },
    },
  ],
  [
    "漏答一个问题",
    {
      name: "partial",
      async noul(_s: JudgeState, qs: NoulQuestion[]) {
        return qs.slice(1).map((q) => ({ id: q.id, probability: 0 }));
      },
    },
  ],
];

for (const [label, backend] of failingBackends) {
  await checkAsync(`${label}时落回询问用户（fail closed）`, async () => {
    const asker = recordingPrompt();
    const perm = new PermissionSystem({
      defaultMode: "ask",
      prompt: asker.prompt,
      gate: createRiskGate({ backend, timeoutMs: 50 }),
    });
    const allowed = await perm.check({
      toolName: "Bash",
      input: { command: "rm -rf /" },
      description: "rm",
    });
    if (allowed) throw new Error("判断层失效时绝不能放行");
    if (asker.asked !== 1) throw new Error("应该落回用户");
  });
}

await checkAsync("默认阈值是 0.2", async () => {
  // 0.2 是 llama3.1:8b 在两个标注集上都零漏放的最高值。这条测试不是为了
  // 锁死这个数字，而是为了让"换判断器却没重测阈值"变成一次测试失败。
  const asker = recordingPrompt();
  const perm = new PermissionSystem({
    defaultMode: "ask",
    prompt: asker.prompt,
    gate: createRiskGate({ backend: fakeJudge(0.19) }),
  });
  const allowed = await perm.check({
    toolName: "Bash",
    input: { command: "ls" },
    description: "ls",
  });
  if (!allowed) throw new Error("0.19 应该低于默认阈值 0.2");
  if (asker.asked !== 0) throw new Error("不该问用户");
});

await checkAsync("0.2 以上不放行（默认阈值边界）", async () => {
  const asker = recordingPrompt();
  const perm = new PermissionSystem({
    defaultMode: "ask",
    prompt: asker.prompt,
    gate: createRiskGate({ backend: fakeJudge(0.21) }),
  });
  const allowed = await perm.check({
    toolName: "Bash",
    input: { command: "ls" },
    description: "ls",
  });
  if (allowed) throw new Error("0.21 不该被放行");
  if (asker.asked !== 1) throw new Error("应该落回用户");
});

await checkAsync("AllowlistJudge 放行只读命令", async () => {
  const judge = new AllowlistJudge();
  const answers = await judge.noul({ tool: "Bash", command: "git log --oneline -5" }, [
    ...RISK_QUESTIONS,
  ]);
  if (answers.length !== RISK_QUESTIONS.length) throw new Error("每个问题都要有答案");
  if (answers.some((a) => a.probability > 0.05)) throw new Error("只读命令应判为安全");
});

check("AllowlistJudge 拦住拼接、危险 flag 和凭据路径", () => {
  const judge = new AllowlistJudge();
  const mustReject = [
    "ls; rm -rf /",
    "git status && rm -rf .git",
    'grep -rn "$(rm -rf /)" .',
    "echo pwned > src/agent.ts",
    'find . -name "*.ts" -delete',
    "sed -i 's/a/b/g' src/agent.ts",
    "cat ~/.ssh/id_rsa",
    "git push --force origin main",
    // 这两条是留出集上真实放过去的，修的是"白名单里套了个黑名单"这个结构问题：
    // 不再问"路径像不像机密"（那是黑名单，漏了 .docker），改问"路径是不是
    // 项目里的普通文件"；递归搜索无论 pattern 是什么都能读到任何文件，所以
    // 按遍历行为拒绝，而不是按 pattern 猜。
    "cat ~/.docker/config.json",
    "grep -r api_key . --include=*.json",
    // 同一个结构问题的其它形态，都没被单独列进任何名单
    "cat ~/.config/gh/hosts.yml",
    "head -5 ../sibling-project/.env",
    "cat .npmrc",
    "grep -rn TOKEN .",
  ];
  for (const command of mustReject) {
    if (judge.inspect(command).safe) throw new Error(`不该放行: ${command}`);
  }
  console.log(chalk.gray(`    ${mustReject.length} 条危险命令全部拦住`));
});

check("AllowlistJudge 仍然放行项目内的普通读取", () => {
  const judge = new AllowlistJudge();
  const mustClear = [
    "cat package.json",
    "head -50 README.md",
    "wc -l src/*.ts",
    "du -sh .",
    "find . -name *.ts",
    "git log --oneline -20",
    'grep -n "TODO" src/index.ts',
  ];
  for (const command of mustClear) {
    const verdict = judge.inspect(command);
    if (!verdict.safe) throw new Error(`不该拦: ${command} —— ${verdict.reason}`);
  }
  console.log(chalk.gray(`    ${mustClear.length} 条项目内读取仍然放行`));
});

await checkAsync("AllowlistJudge 对不认识的问题不瞎答", async () => {
  const judge = new AllowlistJudge();
  const answers = await judge.noul({ tool: "Bash", command: "ls" }, [
    { id: "is-the-user-happy", ask: "?" },
  ]);
  if (answers[0]?.probability !== UNKNOWN_PROBABILITY) {
    throw new Error(`应该返回 UNKNOWN，实际 ${answers[0]?.probability}`);
  }
});

await checkAsync("非 Bash 工具时 AllowlistJudge 退回 UNKNOWN", async () => {
  const judge = new AllowlistJudge();
  const answers = await judge.noul({ tool: "Write", path: "src/agent.ts" }, [...RISK_QUESTIONS]);
  if (answers.some((a) => a.probability !== UNKNOWN_PROBABILITY)) {
    throw new Error("它只懂 shell 命令，别的应该说不知道");
  }
});

await checkAsync("路由器低于阈值时选便宜模型", async () => {
  const route = createModelRouter({
    backend: fakeJudge(0.1),
    strong: "claude-opus-5",
    cheap: "claude-haiku-4-5",
  });
  const verdict = await route("How many lines are in src/agent.ts?");
  if (verdict.model !== "claude-haiku-4-5") throw new Error(`选了 ${verdict.model}`);
  if (!verdict.downgraded) throw new Error("downgraded 应该为 true");
});

await checkAsync("路由器高于阈值时选强模型", async () => {
  const route = createModelRouter({
    backend: fakeJudge(0.9),
    strong: "claude-opus-5",
    cheap: "claude-haiku-4-5",
  });
  const verdict = await route("Refactor the permission system.");
  if (verdict.model !== "claude-opus-5") throw new Error(`选了 ${verdict.model}`);
  if (verdict.downgraded) throw new Error("downgraded 应该为 false");
});

// 和闸门相反的方向：闸门失效要落回"问用户"，路由器失效要落回"贵的那个"。
// 两者都是 fail closed，只是"关"的方向由代价决定。
for (const [label, backend] of failingBackends) {
  await checkAsync(`${label}时路由器落回强模型（fail closed）`, async () => {
    const route = createModelRouter({
      backend,
      strong: "claude-opus-5",
      cheap: "claude-haiku-4-5",
      timeoutMs: 50,
    });
    const verdict = await route("anything");
    if (verdict.model !== "claude-opus-5") throw new Error(`选了 ${verdict.model}`);
    if (verdict.probability !== undefined) throw new Error("失效时不该报概率");
  });
}

// ─────────────────────────────────────────────
// 5. Session Manager
// ─────────────────────────────────────────────
section("5. Session Manager");

const tempSessionDir = path.join(os.tmpdir(), "agent_sessions_" + Date.now());

await checkAsync("创建新会话", async () => {
  const sm = new SessionManager(tempSessionDir);
  const session = await sm.create({ model: "claude-opus-5", cwd: "/tmp", turns: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCost: 0 });
  if (!session.metadata.sessionId) throw new Error("sessionId 为空");
  if (session.messages.length !== 0) throw new Error("新会话消息应为空");
});

await checkAsync("保存并加载会话", async () => {
  const sm = new SessionManager(tempSessionDir);
  const session = await sm.create({ model: "claude-opus-5", cwd: "/tmp", turns: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCost: 0 });
  await sm.save(session);

  const loaded = await sm.load(session.metadata.sessionId);
  if (!loaded) throw new Error("会话加载失败");
  if (loaded.metadata.sessionId !== session.metadata.sessionId) throw new Error("sessionId 不匹配");
});

await checkAsync("appendMessages 追加消息", async () => {
  const sm = new SessionManager(tempSessionDir);
  let session = await sm.create({ model: "claude-opus-5", cwd: "/tmp", turns: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCost: 0 });
  session = sm.appendMessages(session, [{ role: "user", content: "hello" }]);
  if (session.messages.length !== 1) throw new Error(`期望 1 条消息，得到 ${session.messages.length}`);
});

await checkAsync("会话 id 不能跳出会话目录", async () => {
  // 在会话目录旁边放一个合法的会话文件，再用 ../ 去够它
  const sm = new SessionManager(tempSessionDir);
  const session = await sm.create({ model: "claude-opus-5", cwd: "/tmp", turns: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCost: 0 });
  const outside = tempSessionDir + "_outside.json";
  await fs.writeFile(outside, JSON.stringify(session), "utf-8");
  const escape = `../${path.basename(tempSessionDir)}_outside`;

  if ((await sm.load(escape)) !== null) throw new Error("load 读到了会话目录外的文件");
  await sm.delete(escape);
  await fs.access(outside).catch(() => {
    throw new Error("delete 删掉了会话目录外的文件");
  });
  await fs.unlink(outside);
});

await checkAsync("列出所有会话", async () => {
  const sm = new SessionManager(tempSessionDir);
  const sessions = await sm.list();
  if (sessions.length < 1) throw new Error("应该有至少 1 个会话");
  console.log(chalk.gray(`    找到 ${sessions.length} 个会话`));
});

// ─────────────────────────────────────────────
// 6. Cost Calculator
// ─────────────────────────────────────────────
section("6. Cost Calculator");

check("claude-opus-5 费用计算", () => {
  const cost = estimateCost("claude-opus-5", 1000, 500);
  const expected = (1000 / 1_000_000) * 5.0 + (500 / 1_000_000) * 25.0;
  if (Math.abs(cost - expected) > 0.0000001) throw new Error(`期望 ${expected}，得到 ${cost}`);
  console.log(chalk.gray(`    1K in + 500 out = ${formatCost(cost)}`));
});

check("formatCost 格式化", () => {
  const s = formatCost(0.00042);
  if (!s.startsWith("$")) throw new Error("应该以 $ 开头");
});

// ─────────────────────────────────────────────
// 7. Agent Loop（脚本化的模型，不联网）
// ─────────────────────────────────────────────
section("7. Agent Loop");

const noUsage = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
const said = (text: string): ModelResponse => ({
  content: [{ type: "text", text }],
  stopReason: "end_turn",
  usage: noUsage,
});
const calls = (...uses: Array<[id: string, name: string, input: Record<string, unknown>]>): ModelResponse => ({
  content: uses.map(([id, name, input]) => ({ type: "tool_use" as const, id, name, input })),
  stopReason: "tool_use",
  usage: noUsage,
});

/** 按剧本逐轮回复的模型；记下每次请求时的对话，供断言用 */
class ScriptedClient implements ModelClient {
  readonly name = "scripted";
  readonly seen: ModelRequest["messages"][] = [];
  constructor(private script: Array<ModelResponse | ((req: ModelRequest) => Promise<ModelResponse>)>) {}
  async create(request: ModelRequest): Promise<ModelResponse> {
    this.seen.push(JSON.parse(JSON.stringify(request.messages)));
    const next = this.script.shift();
    if (!next) throw new Error("剧本已用完，循环多跑了一轮");
    return typeof next === "function" ? next(request) : next;
  }
}

class EchoTool extends Tool {
  readonly name = "Echo";
  readonly description = "Echo the text back";
  readonly inputSchema = { type: "object" as const, properties: { text: { type: "string" as const } } };
  override async execute(input: Record<string, unknown>): Promise<ToolResult> {
    return { type: "success", output: String(input["text"]) };
  }
}

class BoomTool extends Tool {
  readonly name = "Boom";
  readonly description = "Always throws";
  readonly inputSchema = { type: "object" as const, properties: {} };
  override async execute(): Promise<ToolResult> {
    throw new Error("kaboom");
  }
}

const loopRegistry = new ToolRegistry().register(new EchoTool(), new BoomTool());

function scriptedAgent(client: ModelClient, config: Omit<AgentConfig, "client"> = {}) {
  const events: AgentEvent[] = [];
  const agent = new Agent(
    { client, persistSessions: false, permissions: PermissionPresets.allowAll(), ...config },
    loopRegistry,
  );
  agent.on((e) => {
    events.push(e);
  });
  return { agent, events };
}

/** 最后一条 user 消息里的 tool_result 块 */
function toolResultsIn(messages: ModelRequest["messages"]) {
  const last = messages[messages.length - 1];
  if (!last || typeof last.content === "string") return [];
  return last.content.filter((b): b is Anthropic.ToolResultBlockParam => b.type === "tool_result");
}

await checkAsync("工具往返：tool_use → 执行 → 结果带着 id 回给模型", async () => {
  const client = new ScriptedClient([calls(["t1", "Echo", { text: "hi" }]), said("done")]);
  const { agent, events } = scriptedAgent(client);
  const result = await agent.run("go");

  if (result.text !== "done" || result.stopReason !== "end_turn" || result.turns !== 2) {
    throw new Error(`结果不对: ${JSON.stringify({ text: result.text, stop: result.stopReason, turns: result.turns })}`);
  }
  const [back] = toolResultsIn(client.seen[1]!);
  if (back?.tool_use_id !== "t1" || back.content !== "hi") throw new Error(`回传的结果不对: ${JSON.stringify(back)}`);
  const lifecycle = events
    .filter((e) => "toolUseId" in e && e.toolUseId === "t1")
    .map((e) => e.type)
    .join(",");
  if (lifecycle !== "tool_request,tool_start,tool_end") throw new Error(`t1 的事件序列: ${lifecycle}`);
});

await checkAsync("最后一轮正常结束不误报 max_turns；最后一轮还要工具才算", async () => {
  const clean = await scriptedAgent(new ScriptedClient([said("ok")]), { maxTurns: 1 }).agent.run("go");
  if (clean.stopReason !== "end_turn") throw new Error(`最后一轮 end_turn 被报成了 ${clean.stopReason}`);

  const cut = await scriptedAgent(new ScriptedClient([calls(["t1", "Echo", { text: "x" }])]), {
    maxTurns: 1,
  }).agent.run("go");
  if (cut.stopReason !== "max_turns") throw new Error(`被轮数截断却报成了 ${cut.stopReason}`);
});

await checkAsync("工具抛异常只算这一次调用失败，同批调用和这一轮都不丢", async () => {
  const client = new ScriptedClient([calls(["t1", "Boom", {}], ["t2", "Echo", { text: "still here" }]), said("ok")]);
  const result = await scriptedAgent(client).agent.run("go");
  if (result.stopReason !== "end_turn") throw new Error(`run 没跑完: ${result.stopReason}`);
  const [boom, echo] = toolResultsIn(client.seen[1]!);
  if (!boom?.is_error || !String(boom.content).includes("kaboom")) throw new Error(`Boom 的结果: ${JSON.stringify(boom)}`);
  if (echo?.is_error || echo?.content !== "still here") throw new Error(`Echo 的结果: ${JSON.stringify(echo)}`);
});

await checkAsync("被拒的调用发 tool_denied，不发 tool_start", async () => {
  const client = new ScriptedClient([calls(["t1", "Echo", { text: "x" }]), said("ok")]);
  const { agent, events } = scriptedAgent(client, {
    permissions: { defaultMode: "allow", rules: [{ tool: "Echo", mode: "deny" }] },
  });
  await agent.run("go");
  const types = events.filter((e) => "toolUseId" in e).map((e) => e.type);
  if (types.join(",") !== "tool_request,tool_denied") throw new Error(`事件序列: ${types.join(",")}`);
  if (!toolResultsIn(client.seen[1]!)[0]?.is_error) throw new Error("模型应该收到一个错误结果");
});

await checkAsync("中止：不再开新一轮，会话照样保存、可以续上", async () => {
  const dir = path.join(os.tmpdir(), `agent_abort_${Date.now()}`);
  const controller = new AbortController();
  const client = new ScriptedClient([calls(["t1", "Echo", { text: "x" }]), said("never")]);
  const { agent } = scriptedAgent(client, { persistSessions: true, sessionDir: dir });
  agent.on((e) => {
    if (e.type === "tool_end") controller.abort();
  });

  const result = await agent.run("go", { signal: controller.signal });
  if (result.stopReason !== "aborted") throw new Error(`stopReason: ${result.stopReason}`);
  if (client.seen.length !== 1) throw new Error(`中止后又调了 ${client.seen.length - 1} 次模型`);

  const saved = await new SessionManager(dir).load(result.sessionId);
  const roles = saved?.messages.map((m) => m.role).join(",");
  if (roles !== "user,assistant,user") throw new Error(`保存的对话: ${roles}`);
  if (toolResultsIn(saved!.messages)[0]?.tool_use_id !== "t1") throw new Error("tool_use 没有配上 tool_result，续不上");
});

await checkAsync("中止正在进行的模型调用", async () => {
  const controller = new AbortController();
  const client = new ScriptedClient([
    (req) =>
      new Promise((_, reject) => {
        req.signal?.addEventListener("abort", () => reject(new Error("aborted by signal")));
      }),
  ]);
  setTimeout(() => controller.abort(), 20);
  const result = await scriptedAgent(client).agent.run("go", { signal: controller.signal });
  if (result.stopReason !== "aborted" || result.turns !== 1) {
    throw new Error(`结果: ${JSON.stringify({ stop: result.stopReason, turns: result.turns })}`);
  }
});

await checkAsync("同批的多个询问排队一次问一个；always-allow 替后面同名的调用作答", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  let asked = 0;
  const askWith = (decision: PermissionDecision) =>
    new PermissionSystem({
      defaultMode: "allow",
      rules: [{ tool: "Bash", mode: "ask" }],
      prompt: async () => {
        asked++;
        maxInFlight = Math.max(maxInFlight, ++inFlight);
        await new Promise((r) => setTimeout(r, 15));
        inFlight--;
        return decision;
      },
    });
  const three = (perm: PermissionSystem) =>
    Promise.all([1, 2, 3].map((n) => perm.check({ toolName: "Bash", input: { n }, description: `call ${n}` })));

  const once = await three(askWith("allow"));
  if (!once.every(Boolean) || asked !== 3 || maxInFlight !== 1) {
    throw new Error(`allow: 问了 ${asked} 次，最多同时 ${maxInFlight} 个`);
  }
  asked = 0;
  maxInFlight = 0;
  const always = await three(askWith("always-allow"));
  if (!always.every(Boolean) || asked !== 1) throw new Error(`always-allow 之后还问了 ${asked - 1} 次`);
});

check("toOpenAIMessages：tool_use/tool_result 对应成 tool_calls/tool 消息", () => {
  const out = toOpenAIMessages("sys", [
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "checking" },
        { type: "tool_use", id: "c1", name: "Echo", input: { text: "x" } },
      ],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "x" }] },
    // 旧版 web server 在这条路径上存的格式：没有 type
    { role: "user", content: [{ tool_use_id: "c2", content: "y" }] as unknown as Anthropic.ContentBlockParam[] },
    { role: "assistant", content: "done" },
  ]);
  const shape = out.map((m) => (m.role === "tool" ? `tool:${m.tool_call_id}` : m.role)).join(",");
  if (shape !== "system,user,assistant,tool:c1,tool:c2,assistant") throw new Error(`消息序列: ${shape}`);
  const asked = out[2] as { content: string | null; tool_calls?: Array<{ id: string; function: { arguments: string } }> };
  if (asked.content !== "checking" || asked.tool_calls?.[0]?.id !== "c1") throw new Error("assistant 的 tool_calls 不对");
  if (asked.tool_calls[0].function.arguments !== '{"text":"x"}') throw new Error("参数没序列化成 JSON");
});

// ─────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────
console.log("\n" + "─".repeat(50));
const total = passed + failed;
if (failed === 0) {
  console.log(chalk.green.bold(`✅ 全部通过 ${passed}/${total} 项测试`));
} else {
  console.log(chalk.yellow(`⚠  ${passed}/${total} 通过，${chalk.red(failed + " 项失败")}`));
}
console.log("─".repeat(50) + "\n");

process.exit(failed > 0 ? 1 : 0);
