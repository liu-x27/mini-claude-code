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
import { buildRgArgs, GrepTool } from "../src/tools/grep.js";
import { decodeOutput, resolveShell } from "../src/tools/shell.js";
import { buildParams } from "../src/model/anthropic.js";
import { MAX_TOOL_OUTPUT_CHARS } from "../src/utils/truncate.js";
import { PermissionSystem, PermissionPresets } from "../src/permissions/index.js";
import {
  AllowlistJudge,
  anyStopJudge,
  createModelRouter,
  createRepeatStopJudge,
  createRetryJudge,
  createRiskGate,
  createStopJudge,
  LlmJudge,
  patternRetryJudge,
  RISK_QUESTIONS,
  UNKNOWN_PROBABILITY,
  type JudgeBackend,
  type JudgeState,
  type NoulAnswer,
  type NoulQuestion,
} from "xavierjev";
import { SessionManager } from "../src/session/manager.js";
import { addCost, estimateCost, formatCost } from "../src/utils/cost.js";
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
import { renderMarkdown } from "../client/src/lib/markdown.js";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as http from "node:http";
import chalk from "chalk";
import {
  type Board,
  isBoard,
  legalMoves,
  moveFacts,
  ruleMove,
  seededRandom,
  snakeQuestion,
  step,
} from "../shared/snake.js";
import {
  BIRD_X,
  type Flight,
  flapState,
  forcedFlap,
  isFlight,
  newFlight,
  ruleFlap,
  tick as tickFlight,
} from "../shared/flappy.js";

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

await checkAsync("判断结果带上每道题的概率、耗时和阈值，按提问顺序；失败时不带答案", async () => {
  const scores: Record<string, number> = { "destroys-data": 0.9, "outside-cwd": 0.3, exfiltrates: 0.05, "reveals-secret": 0.01 };
  const gate = createRiskGate({
    backend: {
      name: "scored",
      // 故意倒序回答：结果必须按提问顺序排好，而不是照抄后端的顺序
      noul: async (_s: JudgeState, qs: NoulQuestion[]) => [...qs].reverse().map((q) => ({ id: q.id, probability: scores[q.id]! })),
    },
  });
  const v = await gate({ toolName: "Bash", input: { command: "rm -rf dist" }, description: "rm -rf dist" });
  const ids = v.answers?.map((a) => a.id).join(",");
  if (ids !== RISK_QUESTIONS.map((q) => q.id).join(",")) throw new Error(`答案顺序: ${ids}`);
  if (v.probability !== 0.9 || v.action !== "ask") throw new Error(`按最坏一题决定: ${JSON.stringify(v)}`);
  if (v.threshold !== 0.2 || typeof v.latencyMs !== "number") throw new Error(`阈值/耗时: ${v.threshold} ${v.latencyMs}`);

  const broken = createRiskGate({ backend: { name: "broken", noul: async () => [] } });
  const b = await broken({ toolName: "Bash", input: { command: "ls" }, description: "ls" });
  if (b.action !== "ask" || b.answers !== undefined) throw new Error(`失败时: ${JSON.stringify(b)}`);
});

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
  if (cost === null || Math.abs(cost - expected) > 0.0000001) throw new Error(`期望 ${expected}，得到 ${cost}`);
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
// 8. Web client
// ─────────────────────────────────────────────
section("8. Web client");

check("renderMarkdown：模型输出里的 HTML 一律转义，不会变成标签", () => {
  // 回复可以被工具取回的网页内容带偏；这个页面能 POST /api/permission
  const html = renderMarkdown(
    'Done. <img src=x onerror="fetch(\'/api/permission\')"> and `<b>code</b>` and [x](javascript:alert(1))',
  );
  if (/<img|<b>|onerror="/.test(html)) throw new Error(`原样放进了 HTML：${html}`);
  if (html.includes('href="javascript:')) throw new Error("javascript: 链接没有被挡住");
  if (!html.includes("&lt;img") || !html.includes("<code>&lt;b&gt;code&lt;/b&gt;</code>")) {
    throw new Error(`转义结果不对：${html}`);
  }
});

check("renderMarkdown：该有的格式照样有", () => {
  const html = renderMarkdown("# Title\n\n**bold** and *it*\n\n- one\n- two\n\n```ts\nconst a = 1 < 2;\n```");
  for (const want of ["<h2>Title</h2>", "<strong>bold</strong>", "<em>it</em>", "<ul><li>one</li><li>two</li></ul>",
    '<pre class="md-pre" data-lang="ts"><code>const a = 1 &lt; 2;</code></pre>']) {
    if (!html.includes(want)) throw new Error(`缺少 ${want}：${html}`);
  }
});

section("9. Choice and the snake arena");

/**
 * A stand-in for an OpenAI-compatible endpoint that answers every completion
 * with the given top logprobs, and keeps the request bodies it was sent.
 */
async function fakeLogprobEndpoint(top: Array<{ token: string; p: number }>) {
  const bodies: Array<{ messages: Array<{ role: string; content: string }>; top_logprobs?: number }> = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      bodies.push(JSON.parse(raw));
      const logprobs = top.map((t) => ({ token: t.token, logprob: Math.log(t.p), bytes: null }));
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          id: "x",
          object: "chat.completion",
          created: 0,
          model: "fake",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: top[0]?.token ?? "" },
              finish_reason: "stop",
              logprobs: { content: [{ token: top[0]?.token ?? "", logprob: 0, bytes: null, top_logprobs: logprobs }] },
            },
          ],
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  const judge = new LlmJudge({ apiKey: "test", baseURL: `http://127.0.0.1:${port}/v1`, model: "fake" });
  // closeAllConnections: the judge's client keeps its connection alive, and a socket still open
  // when the process exits trips a libuv assertion on Windows that turns a passing run into exit 127.
  const close = () =>
    new Promise<void>((r) => {
      server.close(() => r());
      server.closeAllConnections();
    });
  return { judge, bodies, close };
}

await checkAsync("choice()：一次前向读出每个选项的概率，按选项顺序归一，覆盖率单独给出", async () => {
  // 20% 的概率落在 "To" 上——模型想写一句话，而不是回答选项
  const fake = await fakeLogprobEndpoint([
    { token: "B", p: 0.6 },
    { token: "A", p: 0.2 },
    { token: "To", p: 0.2 },
  ]);
  try {
    const r = await fake.judge.choice({ up: "closer to food" }, "Which move?", [
      { id: "up", text: "up" },
      { id: "left", text: "left" },
      { id: "right", text: "right" },
    ]);
    const got = r.answers.map((a) => `${a.id}=${a.probability.toFixed(2)}`).join(" ");
    if (got !== "up=0.25 left=0.75 right=0.00") throw new Error(`答案: ${got}`);
    if (Math.abs(r.coverage - 0.8) > 1e-9) throw new Error(`覆盖率: ${r.coverage}`);
    const prompt = fake.bodies[0]!.messages.map((m) => m.content).join("\n");
    for (const want of ["A. up", "B. left", "C. right", "A, B or C", "up: closer to food"]) {
      if (!prompt.includes(want)) throw new Error(`提示里缺少 ${JSON.stringify(want)}：${prompt}`);
    }
    if ((fake.bodies[0]!.top_logprobs ?? 0) < 7) throw new Error(`top_logprobs 太少: ${fake.bodies[0]!.top_logprobs}`);
  } finally {
    await fake.close();
  }
});

await checkAsync("choice()：首词里没有任何选项字母、或选项少于两个，都报错而不是瞎猜", async () => {
  const fake = await fakeLogprobEndpoint([{ token: "Since", p: 0.9 }]);
  try {
    const opts = [
      { id: "up", text: "up" },
      { id: "down", text: "down" },
    ];
    const noLabel = await fake.judge.choice({}, "Which?", opts).then(() => "resolved", (e: Error) => e.message);
    if (!/no option label/.test(noLabel)) throw new Error(`没有选项字母: ${noLabel}`);
    const one = await fake.judge.choice({}, "Which?", opts.slice(0, 1)).then(() => "resolved", (e: Error) => e.message);
    if (!/2 to 8 options/.test(one)) throw new Error(`一个选项: ${one}`);
  } finally {
    await fake.close();
  }
});

// A board drawn by hand, 5×5: head H at (3,2) heading right, food F at (2,4).
//   . . . . .
//   . . . . .
//   . T B H .
//   . . . . .
//   . . F . .
const small: Board = { size: 5, snake: [{ x: 3, y: 2 }, { x: 2, y: 2 }, { x: 1, y: 2 }], food: { x: 2, y: 4 } };

check("snake：撞墙、撞身体不合法；蛇尾这一步会让开，可以走", () => {
  if (legalMoves(small).join(",") !== "up,down,right") throw new Error(`合法步: ${legalMoves(small)}`);
  const curled: Board = { size: 5, snake: [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 2 }, { x: 1, y: 2 }], food: { x: 4, y: 4 } };
  // (1,2) 是蛇尾：走过去时它正好移走
  if (!legalMoves(curled).includes("down")) throw new Error(`蛇尾那格应当可走: ${legalMoves(curled)}`);
  const corner: Board = { size: 5, snake: [{ x: 4, y: 0 }, { x: 3, y: 0 }, { x: 2, y: 0 }], food: { x: 0, y: 4 } };
  if (legalMoves(corner).join(",") !== "down") throw new Error(`角落: ${legalMoves(corner)}`);
});

check("snake：吃到食物才变长，食物换位置；撞上去判死", () => {
  const random = seededRandom(1);
  const board: Board = { size: 5, snake: [{ x: 2, y: 3 }, { x: 2, y: 2 }, { x: 2, y: 1 }], food: { x: 2, y: 4 } };
  const ate = step(board, "down", random);
  if (!ate.ate || ate.board.snake.length !== 4) throw new Error(`吃: ${JSON.stringify(ate)}`);
  if (ate.board.snake.some((s) => s.x === ate.board.food.x && s.y === ate.board.food.y)) throw new Error("新食物落在蛇身上");
  const moved = step(small, "up", random);
  if (moved.ate || moved.board.snake.length !== 3) throw new Error(`没吃不该变长: ${JSON.stringify(moved.board.snake)}`);
  if (!step(small, "left", random).dead) throw new Error("掉头撞脖子应当判死");
});

check("snake：问题只提供合法的步，每步一行事实；raw 模式四个方向都给", () => {
  const q = snakeQuestion(small, "facts");
  if (q.options.map((o) => o.id).join(",") !== "up,down,right") throw new Error(`选项: ${JSON.stringify(q.options)}`);
  if (q.state["down"] !== "closer to food, enough room") throw new Error(`down 的描述: ${q.state["down"]}`);
  if ("left" in q.state) throw new Error("不合法的步不该出现在状态里");
  const raw = snakeQuestion(small, "raw");
  if (raw.options.length !== 4 || raw.state["left"] !== "body" || raw.state["food"] !== "1 left, 2 down") {
    throw new Error(`raw: ${JSON.stringify(raw.state)}`);
  }
});

check("snake：规则先躲死路，再吃、再靠近", () => {
  // 往右进的是顶边两格的口袋，被墙和自己的身子围住，食物就在里面；往左是开阔地
  //   . . L H > F
  //   . . . B B B
  //   . . . T B B
  const trap: Board = {
    size: 6,
    snake: [{ x: 3, y: 0 }, { x: 3, y: 1 }, { x: 4, y: 1 }, { x: 5, y: 1 }, { x: 5, y: 2 }, { x: 4, y: 2 }, { x: 3, y: 2 }],
    food: { x: 5, y: 0 },
  };
  const facts = moveFacts(trap);
  const right = facts.find((f) => f.dir === "right");
  if (!right?.deadEnd || !right.closer) throw new Error(`right 应当是更近但死路: ${JSON.stringify(facts)}`);
  if (ruleMove(trap) === "right") throw new Error("规则走进了死路");
});

check("snake：接口只收合法的棋盘", () => {
  if (!isBoard(small)) throw new Error("合法棋盘被拒");
  const bad: unknown[] = [
    null,
    { ...small, size: 100 },
    { ...small, snake: [] },
    { ...small, food: { x: 3, y: 2 } }, // 食物在蛇身上
    { ...small, snake: [{ x: 3, y: 2 }, { x: 3, y: 2 }] }, // 重复格子
    { ...small, snake: [{ x: 9, y: 2 }] }, // 出界
    { ...small, snake: [{ x: 1.5, y: 2 }] },
  ];
  const accepted = bad.filter((b) => isBoard(b));
  if (accepted.length) throw new Error(`接受了: ${JSON.stringify(accepted)}`);
});

section("10. Flappy on a clock");

check("flappy：规则自己飞，不漏拍就一直不撞", () => {
  const random = seededRandom(1);
  let f = newFlight(random);
  for (let t = 0; t < 5000; t++) {
    const r = tickFlight(f, ruleFlap(f), random);
    if (r.dead) throw new Error(`第 ${t} 拍撞了，过了 ${r.flight.score} 根管子`);
    f = r.flight;
  }
  if (f.score < 100) throw new Error(`5000 拍只过了 ${f.score} 根管子`);
});

check("flappy：拍一下会撞上面的管子时由规则决定、不问模型；平常只给模型一句事实", () => {
  // 鸟在管子里、离缺口上沿很近：一拍就顶上去，不拍往下掉还在缺口里
  const tight: Flight = { y: 5.8, vy: 0, pipes: [{ x: BIRD_X - 0.5, gapTop: 5, passed: false }], score: 0, ticks: 0 };
  if (forcedFlap(tight) !== false) throw new Error(`应当由规则判"不拍"：${forcedFlap(tight)}`);
  const open = newFlight(seededRandom(2));
  if (forcedFlap(open) !== undefined) throw new Error("开阔处不该由规则代答");
  const state = flapState(open);
  if (Object.keys(state).join() !== "if it does not flap") throw new Error(`状态应只有一句：${JSON.stringify(state)}`);
});

check("flappy：接口只收合法的飞行状态", () => {
  if (!isFlight(newFlight(seededRandom(3)))) throw new Error("合法状态被拒");
  const bad: unknown[] = [null, { y: 1 }, { ...newFlight(seededRandom(3)), y: Number.NaN }, { ...newFlight(seededRandom(3)), pipes: [] }];
  if (bad.some((b) => isFlight(b))) throw new Error("接受了不合法的状态");
});

section("11. Retry judge");

/** 前 failures 次失败、之后成功的工具；记下被调了几次 */
class FlakyTool extends Tool {
  readonly name: string;
  readonly description = "Fails a few times, then works";
  readonly inputSchema = { type: "object" as const, properties: {} };
  override readonly dangerous: boolean;
  calls = 0;
  constructor(name: string, private failures: number, dangerous = false) {
    super();
    this.name = name;
    this.dangerous = dangerous;
  }
  override async execute(): Promise<ToolResult> {
    this.calls++;
    return this.calls <= this.failures ? { type: "error", message: "HTTP 503 Service Unavailable" } : { type: "success", output: "ok" };
  }
}

function retryRun(tool: FlakyTool, retryJudge: AgentConfig["retryJudge"]) {
  const client = new ScriptedClient([calls(["r1", tool.name, {}]), said("done")]);
  const events: AgentEvent[] = [];
  const agent = new Agent(
    { client, persistSessions: false, permissions: PermissionPresets.allowAll(), ...(retryJudge ? { retryJudge } : {}) },
    new ToolRegistry().register(tool),
  );
  agent.on((e) => {
    events.push(e);
  });
  return { client, events, run: () => agent.run("go") };
}

const alwaysTransient = createRetryJudge({ backend: fakeJudge(0.95) });

await checkAsync("重试：只读工具的临时错误重试一次，模型只看到第二次的结果", async () => {
  const tool = new FlakyTool("Fetchish", 1);
  const r = retryRun(tool, alwaysTransient);
  await r.run();
  const [back] = toolResultsIn(r.client.seen[1]!);
  if (tool.calls !== 2 || back?.content !== "ok" || back.is_error) throw new Error(`调用 ${tool.calls} 次，回传 ${JSON.stringify(back)}`);
  const ev = r.events.find((e) => e.type === "tool_retry");
  if (!ev || ev.type !== "tool_retry" || !ev.verdict.retry || ev.verdict.probability !== 0.95) throw new Error(`缺少 tool_retry 事件: ${JSON.stringify(ev)}`);
});

await checkAsync("重试：危险工具（Bash/Write/Edit 这类）出错不问、不重试", async () => {
  const tool = new FlakyTool("Shellish", 1, true);
  let asked = 0;
  const r = retryRun(tool, async (f) => {
    asked++;
    return alwaysTransient(f);
  });
  await r.run();
  if (tool.calls !== 1 || asked !== 0) throw new Error(`危险工具被调 ${tool.calls} 次、判断被问 ${asked} 次`);
});

await checkAsync("重试：最多一次；判断出错或拿不准就不重试，模型照常看到错误", async () => {
  const twice = new FlakyTool("Fetchish", 5);
  await retryRun(twice, alwaysTransient).run();
  if (twice.calls !== 2) throw new Error(`应当只重试一次，实际调了 ${twice.calls} 次`);

  const broken = new FlakyTool("Fetchish", 1);
  const r = retryRun(broken, createRetryJudge({ backend: { name: "broken", noul: async () => { throw new Error("down"); } } }));
  await r.run();
  const [back] = toolResultsIn(r.client.seen[1]!);
  if (broken.calls !== 1 || !back?.is_error) throw new Error(`判断挂了却重试了: 调 ${broken.calls} 次`);

  // 后端没意见时回 0.5——不能因为"弃权"就重试
  const unsure = new FlakyTool("Fetchish", 1);
  await retryRun(unsure, createRetryJudge({ backend: fakeJudge(UNKNOWN_PROBABILITY) })).run();
  if (unsure.calls !== 1) throw new Error("0.5 的弃权答案触发了重试");
});

await checkAsync("重试：默认的规则判断认错误码，不被字面上的 terminated 骗", async () => {
  const says = async (error: string) => (await patternRetryJudge({ toolName: "WebFetch", summary: "", error })).retry;
  for (const e of ["HTTP 503 Service Unavailable: x", "Fetch failed: TypeError: fetch failed (cause: ECONNRESET)", "HTTP 429 Too Many Requests: x"]) {
    if (!(await says(e))) throw new Error(`该重试没重试: ${e}`);
  }
  for (const e of ["HTTP 404 Not Found: x", "Invalid regex: SyntaxError: Invalid regular expression: /(a/: Unterminated group", "File not found: a.ts"]) {
    if (await says(e)) throw new Error(`不该重试却重试: ${e}`);
  }
});

section("12. Rubric");

await checkAsync("rubric()：一次前向给出 1–5 的分布、期望和离散度，覆盖率单独给出", async () => {
  // 20% 的概率落在 "The" 上，不是任何一档
  const fake = await fakeLogprobEndpoint([
    { token: "2", p: 0.5 },
    { token: "4", p: 0.3 },
    { token: "The", p: 0.2 },
  ]);
  try {
    const levels = [1, 2, 3, 4, 5].map((score) => ({ score, text: `level ${score}` }));
    const r = await fake.judge.rubric({ command: "ls" }, "How much harm?", levels);
    const got = r.distribution.map((d) => d.probability.toFixed(3)).join(" ");
    if (got !== "0.000 0.625 0.000 0.375 0.000") throw new Error(`分布: ${got}`);
    if (Math.abs(r.expected - 2.75) > 1e-9) throw new Error(`期望: ${r.expected}`);
    // sqrt(0.625·0.75² + 0.375·1.25²) = sqrt(0.9375)
    if (Math.abs(r.spread - Math.sqrt(0.9375)) > 1e-9) throw new Error(`离散度: ${r.spread}`);
    if (Math.abs(r.coverage - 0.8) > 1e-9) throw new Error(`覆盖率: ${r.coverage}`);
    const prompt = fake.bodies[0]!.messages.map((m) => m.content).join("\n");
    if (!prompt.includes("1 = level 1") || !prompt.includes("1 to 5")) throw new Error(`提示: ${prompt}`);
    const one = await fake.judge.rubric({}, "?", levels.slice(0, 1)).then(() => "resolved", (e: Error) => e.message);
    if (!/2 to 9 levels/.test(one)) throw new Error(`一档: ${one}`);
  } finally {
    await fake.close();
  }
});

section("13. Stop judge");

await checkAsync("停：同一个调用第三次同样失败就结束，stopReason 是 stuck，不再多调一轮模型", async () => {
  const booms = [1, 2, 3, 4].map((n) => calls([`b${n}`, "Boom", {}]));
  const client = new ScriptedClient([...booms, said("never reached")]);
  const { agent, events } = scriptedAgent(client, { stopJudge: createRepeatStopJudge() });
  const result = await agent.run("go");
  if (result.stopReason !== "stuck" || result.turns !== 3) throw new Error(`应在第 3 轮停: ${result.stopReason} / ${result.turns} 轮`);
  if (client.seen.length !== 3) throw new Error(`模型被调了 ${client.seen.length} 次`);
  if (!result.text.startsWith("Stopped:") || !events.some((e) => e.type === "stop_check" && e.verdict.stop)) {
    throw new Error(`缺少停止说明或事件: ${result.text}`);
  }
});

await checkAsync("停：每次输入不同就不算卡住；判断出错一律继续跑", async () => {
  const echoes = [1, 2, 3, 4].map((n) => calls([`e${n}`, "Echo", { text: `t${n}` }]));
  const ok = scriptedAgent(new ScriptedClient([...echoes, said("done")]), { stopJudge: createRepeatStopJudge() });
  const r1 = await ok.agent.run("go");
  if (r1.stopReason !== "end_turn") throw new Error(`不该停: ${r1.stopReason}`);

  const booms = [1, 2, 3].map((n) => calls([`b${n}`, "Boom", {}]));
  const broken = scriptedAgent(new ScriptedClient([...booms, said("done")]), {
    stopJudge: async () => {
      throw new Error("judge down");
    },
  }).agent;
  const r2 = await broken.run("go").then(
    (r) => r.stopReason,
    (e: Error) => `threw: ${e.message}`,
  );
  if (r2 !== "end_turn") throw new Error(`判断出错时应照常跑完: ${r2}`);
});

await checkAsync("调用方自己写的判断抛异常时，循环当它不存在：不重试、不停、不崩", async () => {
  const flaky = new FlakyTool("Fetchish", 1);
  const r = retryRun(flaky, async () => {
    throw new Error("custom retry judge down");
  });
  const result = await r.run();
  if (flaky.calls !== 1 || result.stopReason !== "end_turn") throw new Error(`调 ${flaky.calls} 次，结束于 ${result.stopReason}`);
});

await checkAsync("停：组合判断先问便宜的，说停就不再问模型；模型判断不到 4 次调用不问", async () => {
  const backend = fakeJudge(0.99);
  const combined = anyStopJudge(createRepeatStopJudge(), createStopJudge({ backend }));
  const repeated = { tool: "Boom", input: {}, summary: "Boom", ok: false, outcome: "Boom threw: kaboom" };
  const v = await combined({ prompt: "go", turn: 3, recent: [repeated, repeated, repeated] });
  if (!v.stop || backend.calls !== 0) throw new Error(`规则已判停却还问了模型 ${backend.calls} 次`);
  const short = await createStopJudge({ backend })({ prompt: "go", turn: 2, recent: [repeated, { ...repeated, outcome: "other" }] });
  if (short.stop || backend.calls !== 0) throw new Error("调用不足 4 次也问了模型");
});

// ─────────────────────────────────────────────
// 14. Harness regressions：2026-09-28 对 harness 本体的探针，每条都复现过
// ─────────────────────────────────────────────
section("14. Harness regressions");

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "agent_regress_"));
const exists = (p: string) => fs.access(p).then(() => true, () => false);

/** 记录每次执行起止时间的工具；dangerous 决定它能不能和别的调用并行 */
class NapTool extends Tool {
  readonly description = "Sleep a moment";
  readonly inputSchema = { type: "object" as const, properties: { tag: { type: "string" as const } } };
  override readonly dangerous: boolean;
  constructor(
    readonly name: string,
    dangerous: boolean,
    private log: Array<{ tag: string; start: number; end: number }>,
  ) {
    super();
    this.dangerous = dangerous;
  }
  override async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const start = performance.now();
    await new Promise((r) => setTimeout(r, 60));
    this.log.push({ tag: String(input["tag"]), start, end: performance.now() });
    return { type: "success", output: "slept" };
  }
}

/** 有必填字段和数字字段的工具，记下真正执行时拿到的输入 */
class CountTool extends Tool {
  readonly name = "Count";
  readonly description = "Count things";
  readonly inputSchema = {
    type: "object" as const,
    properties: { text: { type: "string" as const }, count: { type: "number" as const } },
    required: ["text"],
  };
  readonly seen: Record<string, unknown>[] = [];
  override async execute(input: Record<string, unknown>): Promise<ToolResult> {
    this.seen.push(input);
    return { type: "success", output: "counted" };
  }
}

const cutOff = (id: string, extra: Anthropic.ContentBlockParam[] = []): ModelResponse => ({
  content: [...extra, { type: "tool_use", id, name: "Echo", input: { text: "half a" } }],
  stopReason: "max_tokens",
  usage: noUsage,
});

/** 会话里有没有哪条 tool_use 后面没有紧跟 tool_result——有的话每次续跑都会被 API 拒绝 */
function danglingToolUse(messages: ModelRequest["messages"]): boolean {
  return messages.some((m, i) => {
    if (m.role !== "assistant" || typeof m.content === "string") return false;
    const ids = m.content.filter((b) => b.type === "tool_use").map((b) => (b as Anthropic.ToolUseBlockParam).id);
    if (ids.length === 0) return false;
    const next = messages[i + 1];
    const answered = next && typeof next.content !== "string"
      ? next.content.filter((b) => b.type === "tool_result").map((b) => (b as Anthropic.ToolResultBlockParam).tool_use_id)
      : [];
    return ids.some((id) => !answered.includes(id));
  });
}

check("Grep：pattern 和 glob 各是 rg 的一个参数，不经过 shell", () => {
  const glob = '*" & echo pwned> pwned.txt & rem "';
  const pattern = "$(echo pwned > pwned.txt)";
  const args = buildRgArgs({ pattern, glob }, "/tmp/x");
  if (args[args.indexOf(glob) - 1] !== "--glob") throw new Error(`glob 不是 --glob 的值: ${JSON.stringify(args)}`);
  if (args[args.indexOf(pattern) - 1] !== "--") throw new Error(`pattern 不在 -- 之后: ${JSON.stringify(args)}`);
  if (args.some((a) => a.includes("'"))) throw new Error("内置排除规则不该带引号——cmd.exe 不会去掉它们");
});

await checkAsync("Grep：注入载荷不被执行（有 rg 走 rg，没有走 JS 回退）", async () => {
  const dir = path.join(scratch, "grep");
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, "a.txt"), "hello\n");
  const tool = new GrepTool();
  await tool.execute({ pattern: "hello", glob: '*" & echo pwned> pwned.txt & rem "' }, { ...ctx, cwd: dir });
  await tool.execute({ pattern: "$(echo pwned > pwned.txt)" }, { ...ctx, cwd: dir });
  if (await exists(path.join(dir, "pwned.txt"))) throw new Error("注入的命令被执行了");
});

await checkAsync("工具输入先校验：类型不对的调用不执行，数字字符串照常接受", async () => {
  const count = new CountTool();
  const registry = new ToolRegistry().register(count);
  const client = new ScriptedClient([
    calls(["v1", "Count", { text: 5 }], ["v2", "Count", { count: "3" }], ["v3", "Count", { text: "ok", count: "3" }]),
    said("done"),
  ]);
  const agent = new Agent({ client, persistSessions: false, permissions: PermissionPresets.allowAll() }, registry);
  await agent.run("go");
  const [bad, missing, good] = toolResultsIn(client.seen[1]!);
  if (!bad?.is_error || !String(bad.content).includes('"text" must be a string')) throw new Error(`v1: ${JSON.stringify(bad)}`);
  if (!missing?.is_error || !String(missing.content).includes("missing required")) throw new Error(`v2: ${JSON.stringify(missing)}`);
  if (good?.is_error) throw new Error(`v3 不该报错: ${JSON.stringify(good)}`);
  if (count.seen.length !== 1 || count.seen[0]?.["count"] !== 3) throw new Error(`实际执行: ${JSON.stringify(count.seen)}`);
});

await checkAsync("调度：只读的调用并行；危险的调用等前面的做完，独自执行，按顺序", async () => {
  const log: Array<{ tag: string; start: number; end: number }> = [];
  const registry = new ToolRegistry().register(new NapTool("Look", false, log), new NapTool("Change", true, log));
  const client = new ScriptedClient([
    calls(["a", "Look", { tag: "a" }], ["b", "Look", { tag: "b" }], ["c", "Change", { tag: "c" }], ["d", "Look", { tag: "d" }]),
    said("done"),
  ]);
  const agent = new Agent({ client, persistSessions: false, permissions: PermissionPresets.allowAll() }, registry);
  await agent.run("go");
  const at = (tag: string) => log.find((e) => e.tag === tag)!;
  const [a, b, c, d] = ["a", "b", "c", "d"].map(at) as [typeof log[0], typeof log[0], typeof log[0], typeof log[0]];
  if (!(a.start < b.end && b.start < a.end)) throw new Error("a 和 b 应该同时跑");
  if (c.start < Math.max(a.end, b.end)) throw new Error("c 在 a、b 做完之前就开始了");
  if (d.start < c.end) throw new Error("d 在 c 做完之前就开始了");
  const order = toolResultsIn(client.seen[1]!).map((r) => r.tool_use_id).join("");
  if (order !== "abcd") throw new Error(`结果顺序: ${order}`);
});

await checkAsync("同一回合两个 Edit 改同一个文件：两处都在（256 KB 文件，重复 20 次）", async () => {
  // 修之前：1 MB 文件 100 回合里 92–98 回合丢一处改动，两次调用都报成功
  for (let t = 0; t < 20; t++) {
    const file = path.join(scratch, `race-${t}.ts`);
    await fs.writeFile(file, `export const A = 1;\nexport const B = 1;\n${"// filler line for size\n".repeat(11_000)}`);
    const client = new ScriptedClient([
      calls(
        ["ea", "Edit", { file_path: file, old_string: "A = 1", new_string: "A = 2" }],
        ["eb", "Edit", { file_path: file, old_string: "B = 1", new_string: "B = 2" }],
      ),
      said("done"),
    ]);
    const agent = new Agent({ client, persistSessions: false, permissions: PermissionPresets.allowAll() });
    await agent.run("bump both");
    const text = await fs.readFile(file, "utf-8");
    if (!text.includes("A = 2") || !text.includes("B = 2")) throw new Error(`第 ${t + 1} 次丢了一处改动`);
  }
});

await checkAsync("max_tokens 截在工具调用中间：调大 max_tokens 重问，截断的那次不执行、不入库", async () => {
  const dir = path.join(scratch, "maxtok");
  const asked: number[] = [];
  const client = new ScriptedClient([
    async (req) => (asked.push(req.maxTokens), cutOff("cut")),
    async (req) => (asked.push(req.maxTokens), calls(["t1", "Echo", { text: "whole" }])),
    said("done"),
  ]);
  const { agent, events } = scriptedAgent(client, { persistSessions: true, sessionDir: dir, maxTokens: 16_000 });
  const result = await agent.run("go");
  if (asked.join(",") !== "16000,32000") throw new Error(`max_tokens 依次是 ${asked.join(",")}`);
  if (result.text !== "done" || !events.some((e) => e.type === "turn_retry")) throw new Error(`结果: ${result.text}`);
  const saved = await new SessionManager(dir).load(result.sessionId);
  if (JSON.stringify(saved?.messages).includes('"cut"')) throw new Error("截断的回复进了会话");
  if (danglingToolUse(saved!.messages)) throw new Error("会话里有没配上结果的 tool_use");
});

await checkAsync("一直被截断：到上限为止，什么都不执行，会话仍然续得上", async () => {
  const dir = path.join(scratch, "maxtok-stuck");
  const client = new ScriptedClient([cutOff("c1"), cutOff("c2"), cutOff("c3")]);
  const { agent, events } = scriptedAgent(client, { persistSessions: true, sessionDir: dir, maxTokens: 16_000 });
  const result = await agent.run("write the big file");
  if (result.stopReason !== "max_tokens" || !result.text.includes("nothing was run")) {
    throw new Error(`结果: ${result.stopReason} / ${result.text}`);
  }
  if (client.seen.length !== 3 || events.some((e) => e.type === "tool_start")) throw new Error("截断的调用被执行了，或重试次数不对");
  const saved = await new SessionManager(dir).load(result.sessionId);
  if (!saved || danglingToolUse(saved.messages)) throw new Error("会话里留下了没有结果的 tool_use，之后每次续跑都会 400");
});

await checkAsync("refusal 打断了工具调用：不执行、不入库，并说明原因", async () => {
  const client = new ScriptedClient([
    { ...cutOff("r1", [{ type: "text", text: "Let me" }]), stopReason: "refusal" },
  ]);
  const { agent, events } = scriptedAgent(client);
  const result = await agent.run("go");
  if (result.stopReason !== "refusal" || !result.text.includes("declined")) throw new Error(`结果: ${result.text}`);
  if (events.some((e) => e.type === "tool_start")) throw new Error("被拒那一轮的工具执行了");
});

await checkAsync("第 2 轮模型调用失败：第 1 轮已存盘；下一次运行先告诉模型上次中断了", async () => {
  const dir = path.join(scratch, "crash");
  const client = new ScriptedClient([
    calls(["t1", "Echo", { text: "did it" }]),
    async () => {
      throw new Error("529 overloaded_error");
    },
  ]);
  const { agent } = scriptedAgent(client, { persistSessions: true, sessionDir: dir });
  let sessionId = "";
  agent.on((e) => {
    if (e.type === "session") sessionId = e.sessionId;
  });
  const err = await agent.run("go").then(() => "", (e: Error) => e.message);
  if (!err.includes("529")) throw new Error(`应该把错误抛出来: ${err}`);

  const sessions = new SessionManager(dir);
  const saved = await sessions.load(sessionId);
  const roles = saved?.messages.map((m) => m.role).join(",");
  if (roles !== "user,assistant,user") throw new Error(`存下的对话: ${roles}（修之前一条都不存）`);
  if (!saved?.metadata.interrupted?.includes("529")) throw new Error(`中断原因: ${saved?.metadata.interrupted}`);

  const next = new ScriptedClient([said("ok")]);
  await scriptedAgent(next, { persistSessions: true, sessionDir: dir, resumeSessionId: sessionId }).agent.run("continue");
  const turn = next.seen[0]!.at(-1)!;
  const blocks = typeof turn.content === "string" ? [] : turn.content;
  const note = blocks[0]?.type === "text" ? blocks[0].text : "";
  if (!note.includes("ended early") || !note.includes("529")) throw new Error(`续跑时的提示: ${JSON.stringify(turn.content)}`);
  if (blocks[1]?.type !== "text" || blocks[1].text !== "continue") throw new Error("用户的话应该原样跟在提示后面");
  if ((await sessions.load(sessionId))?.metadata.interrupted) throw new Error("续跑成功后中断标记应该清掉");
});

await checkAsync("工具执行期间进程若死掉：盘上的会话可续，并记着哪些调用在跑", async () => {
  const dir = path.join(scratch, "inflight");
  let onDisk: Awaited<ReturnType<SessionManager["load"]>> = null;
  class PeekTool extends Tool {
    readonly name = "Peek";
    readonly description = "Look at the saved session mid-call";
    readonly inputSchema = { type: "object" as const, properties: {} };
    sessionId = "";
    override async execute(): Promise<ToolResult> {
      onDisk = await new SessionManager(dir).load(this.sessionId);
      return { type: "success", output: "peeked" };
    }
  }
  const peek = new PeekTool();
  const client = new ScriptedClient([calls(["p1", "Peek", {}]), said("done")]);
  const agent = new Agent(
    { client, persistSessions: true, sessionDir: dir, permissions: PermissionPresets.allowAll() },
    new ToolRegistry().register(peek),
  );
  agent.on((e) => {
    if (e.type === "session") peek.sessionId = e.sessionId;
  });
  await agent.run("go");
  const mid = onDisk as Awaited<ReturnType<SessionManager["load"]>>;
  if (!mid?.metadata.interrupted?.includes("Peek")) throw new Error(`执行期间的标记: ${mid?.metadata.interrupted}`);
  if (danglingToolUse(mid.messages)) throw new Error("执行期间盘上的会话不可续");
});

await checkAsync("工具输出有上限：300 万字符只给模型头尾，全文存进文件并告诉它路径", async () => {
  const client = new ScriptedClient([
    calls(["big", "Bash", { command: `node -e "process.stdout.write('x'.repeat(3000000) + 'THE-END')"` }]),
    said("done"),
  ]);
  await new Agent({ client, persistSessions: false, permissions: PermissionPresets.allowAll() }).run("go");
  const content = String(toolResultsIn(client.seen[1]!)[0]?.content);
  if (content.length > MAX_TOOL_OUTPUT_CHARS + 400) throw new Error(`交回了 ${content.length} 个字符`);
  if (!content.includes("THE-END")) throw new Error("结尾应该保留");
  const file = /whole output is in (.+?) …\]/.exec(content)?.[1];
  if (!file) throw new Error(`没说全文在哪: ${content.slice(9_000, 10_400)}`);
  const whole = await fs.readFile(file, "utf-8");
  if (!whole.includes("THE-END") || whole.length < 3_000_000) throw new Error(`文件里只有 ${whole.length} 个字符`);
  await fs.rm(path.dirname(file), { recursive: true, force: true });
});

await checkAsync("Read 的结果超长时不另存一份，告诉模型用 offset/limit 分段读", async () => {
  const file = path.join(scratch, "many-lines.txt");
  await fs.writeFile(file, `${"0123456789".repeat(6)}\n`.repeat(2500));
  const client = new ScriptedClient([calls(["r", "Read", { file_path: file }]), said("done")]);
  await new Agent({ client, persistSessions: false, permissions: PermissionPresets.allowAll() }).run("go");
  const content = String(toolResultsIn(client.seen[1]!)[0]?.content);
  if (content.length > MAX_TOOL_OUTPUT_CHARS + 400) throw new Error(`交回了 ${content.length} 个字符`);
  if (!content.includes("offset and limit") || content.includes("whole output is in")) throw new Error("提示不对");
});

await checkAsync("Read：超长的单行截断，CRLF 的 \\r 不显示", async () => {
  const file = path.join(scratch, "long.js");
  await fs.writeFile(file, `${"a".repeat(1_000_000)}\r\nshort\r\n`);
  const r = await new FileReadTool().execute({ file_path: file }, ctx);
  if (r.type !== "success") throw new Error(r.message);
  if (r.output.length > 5000 || !r.output.includes("line truncated")) throw new Error(`输出 ${r.output.length} 个字符`);
  if (r.output.includes("\r")) throw new Error("行尾的 \\r 应该去掉");
});

await checkAsync("Windows 上 Bash 工具用的是 bash（找得到 Git Bash 时）", async () => {
  const shell = resolveShell();
  if (process.platform !== "win32" || shell.kind !== "bash") {
    console.log(chalk.gray(`    跳过：${process.platform} / ${shell.kind}`));
    return;
  }
  const r = await new BashTool().execute({ command: "export X=42 && echo $X && ls -d ." }, ctx);
  if (r.type !== "success" || !r.output.includes("42")) throw new Error(r.type === "success" ? r.output : r.message);
  if (!new BashTool().description.includes("Git Bash")) throw new Error("工具说明应告诉模型用的是 Git Bash");
});

check("非 UTF-8 的输出按控制台代码页逐行解码（GBK 与 UTF-8 混排）", () => {
  const gbk = Buffer.from("b2bbcac7c4dab2bfbbf2cde2b2bfc3fcc1ee", "hex");
  const text = decodeOutput(Buffer.concat([Buffer.from("ok ✓\n", "utf8"), gbk]), "gbk");
  if (text !== "ok ✓\n不是内部或外部命令") throw new Error(`解码成: ${JSON.stringify(text)}`);
});

await checkAsync("Edit：CRLF 文件用 LF 写 old_string 也能改，改完仍是 CRLF", async () => {
  const file = path.join(scratch, "win.ts");
  await fs.writeFile(file, "const a = 1;\r\nconst b = 2;\r\n");
  const r = await new FileEditTool().execute(
    { file_path: file, old_string: "const a = 1;\nconst b = 2;", new_string: "const a = 1;\nconst b = 3;" },
    ctx,
  );
  if (r.type !== "success") throw new Error(r.message);
  const text = await fs.readFile(file, "utf-8");
  if (text !== "const a = 1;\r\nconst b = 3;\r\n") throw new Error(`改后: ${JSON.stringify(text)}`);
});

await checkAsync("Edit：new_string 里的 $$、$&、$' 原样写入", async () => {
  const file = path.join(scratch, "dollar.sh");
  await fs.writeFile(file, "PID=OLD\n");
  const newString = "PID=$$ # $& $' $1";
  const r = await new FileEditTool().execute({ file_path: file, old_string: "PID=OLD", new_string: newString }, ctx);
  if (r.type !== "success") throw new Error(r.message);
  const text = await fs.readFile(file, "utf-8");
  if (text !== `${newString}\n`) throw new Error(`写成了: ${JSON.stringify(text)}（String.replace 会把 $$ 变成 $）`);
});

await checkAsync("Glob：按修改时间，新的在前", async () => {
  const dir = path.join(scratch, "glob");
  await fs.mkdir(dir);
  for (const [name, ageSec] of [["b-newest.txt", 0], ["a-oldest.txt", 3600], ["c-middle.txt", 1800]] as const) {
    const file = path.join(dir, name);
    await fs.writeFile(file, name);
    const t = new Date(Date.now() - ageSec * 1000);
    await fs.utimes(file, t, t);
  }
  const r = await new GlobTool().execute({ pattern: "*.txt" }, { ...ctx, cwd: dir });
  if (r.type !== "success") throw new Error(r.message);
  const order = r.output.split("\n").slice(1).map((l) => path.basename(l)).join(",");
  if (order !== "b-newest.txt,c-middle.txt,a-oldest.txt") throw new Error(`顺序: ${order}`);
});

check("缓存：system 和对话的最后一块各一个断点；历史本身不被改写", () => {
  const request: ModelRequest = {
    model: "claude-opus-5-5",
    system: "s",
    messages: [
      { role: "user", content: "first" },
      { role: "assistant", content: [{ type: "tool_use", id: "t", name: "Echo", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] },
    ],
    tools: [],
    maxTokens: 100,
    thinking: { type: "adaptive" },
    enableCaching: true,
    stream: false,
  };
  const before = JSON.stringify(request.messages);
  const p = buildParams(request);
  const last = p.messages.at(-1)!.content as Array<{ cache_control?: { type: string } }>;
  if (last.at(-1)?.cache_control?.type !== "ephemeral") throw new Error("对话最后一块没有断点");
  if (JSON.stringify(p.messages).split("cache_control").length !== 2) throw new Error("对话里只该有一个断点");
  if (!Array.isArray(p.system) || !("cache_control" in p.system[0]!)) throw new Error("system 上没有断点");
  if (JSON.stringify(request.messages) !== before) throw new Error("把历史本身改了");
  const plain = buildParams({ ...request, messages: [{ role: "user", content: "hi" }] });
  if (!JSON.stringify(plain.messages).includes('"cache_control"')) throw new Error("字符串内容也该带上断点");
  if (JSON.stringify(buildParams({ ...request, enableCaching: false })).includes("cache_control")) {
    throw new Error("关了缓存还带断点");
  }
});

await checkAsync("system 里没有日期和工作目录；它们只在变化时作为环境说明追加进对话", async () => {
  const dir = path.join(scratch, "env");
  await fs.mkdir(dir, { recursive: true });
  const systems: string[] = [];
  const once = () => new ScriptedClient([async (req) => (systems.push(req.system), said("ok"))]);
  const lastUser = (c: ScriptedClient) => c.seen[0]!.at(-1)!.content;

  const c1 = once();
  const r1 = await scriptedAgent(c1, { persistSessions: true, sessionDir: dir, cwd: scratch }).agent.run("one");
  if (!JSON.stringify(lastUser(c1)).includes("[Environment:")) throw new Error("新会话应该先说明环境");
  const c2 = once();
  await scriptedAgent(c2, { persistSessions: true, sessionDir: dir, cwd: scratch, resumeSessionId: r1.sessionId }).agent.run("two");
  if (lastUser(c2) !== "two") throw new Error(`环境没变就不该再说: ${JSON.stringify(lastUser(c2))}`);
  const c3 = once();
  await scriptedAgent(c3, { persistSessions: true, sessionDir: dir, cwd: dir, resumeSessionId: r1.sessionId }).agent.run("three");
  if (!JSON.stringify(lastUser(c3)).includes(JSON.stringify(dir).slice(1, -1))) throw new Error("换了目录应该说明");
  if (new Set(systems).size !== 1) throw new Error("同一会话里 system 变了");
  if (systems[0]!.includes(scratch) || /\d{4}-\d{2}-\d{2}/.test(systems[0]!)) throw new Error("system 里还有目录或日期");
});

await checkAsync("AGENTS.md：新会话读入从仓库根到工作目录的说明，近的在后；续跑不重复；可关", async () => {
  const root = path.join(scratch, "repo");
  const sub = path.join(root, "pkg", "app");
  await fs.mkdir(path.join(root, ".git"), { recursive: true });
  await fs.mkdir(sub, { recursive: true });
  await fs.writeFile(path.join(root, "AGENTS.md"), "ROOT RULE: use pnpm.");
  await fs.writeFile(path.join(sub, "AGENTS.md"), "SUB RULE: tests live in __tests__.");
  await fs.writeFile(path.join(sub, "CLAUDE.md"), "SUB RULE: tests live in __tests__."); // 和 AGENTS.md 相同，只算一次
  const dir = path.join(scratch, "instr-sessions");

  const c1 = new ScriptedClient([said("ok")]);
  const r1 = await scriptedAgent(c1, { persistSessions: true, sessionDir: dir, cwd: sub }).agent.run("go");
  const first = JSON.stringify(c1.seen[0]!.at(-1)!.content);
  const [iRoot, iSub] = [first.indexOf("ROOT RULE"), first.indexOf("SUB RULE")];
  if (iRoot < 0 || iSub < 0 || iRoot > iSub) throw new Error(`说明缺失或顺序不对: ${first.slice(0, 300)}`);
  if (first.split("SUB RULE").length !== 2) throw new Error("相同内容的 CLAUDE.md 不该再算一次");

  const c2 = new ScriptedClient([said("ok")]);
  await scriptedAgent(c2, { persistSessions: true, sessionDir: dir, cwd: sub, resumeSessionId: r1.sessionId }).agent.run("again");
  if (JSON.stringify(c2.seen[0]!.at(-1)!.content).includes("RULE")) throw new Error("续跑不该再附一遍");

  const c3 = new ScriptedClient([said("ok")]);
  await scriptedAgent(c3, { cwd: sub, projectInstructions: false }).agent.run("go");
  if (JSON.stringify(c3.seen[0]).includes("RULE")) throw new Error("关掉之后还读了");
});

await checkAsync("effort：设了才发 output_config.effort，没设就不发", async () => {
  const base: ModelRequest = {
    model: "claude-opus-5-5",
    system: "s",
    messages: [{ role: "user", content: "hi" }],
    tools: [],
    maxTokens: 100,
    thinking: { type: "adaptive" },
    enableCaching: false,
    stream: false,
  };
  if (buildParams({ ...base, effort: "high" }).output_config?.effort !== "high") throw new Error("设了 effort 却没发");
  if ("output_config" in buildParams(base)) throw new Error("没设 effort 也发了 output_config");

  let sent: ModelRequest["effort"];
  const client = new ScriptedClient([async (req) => ((sent = req.effort), said("ok"))]);
  await scriptedAgent(client, { effort: "xhigh" }).agent.run("go");
  if (sent !== "xhigh") throw new Error(`Agent 发给客户端的 effort: ${sent}`);
});

await checkAsync("成本：没有价格的模型记为未知，不冒充 Opus 5 的价格", async () => {
  if (estimateCost("minimax-m2", 1000, 1000) !== null) throw new Error("未知模型应返回 null");
  const opus55 = estimateCost("claude-opus-5-5", 1_000_000, 1_000_000);
  if (opus55 === null || Math.abs(opus55 - 24) > 1e-9) throw new Error(`claude-opus-5-5 的 1M+1M: ${opus55}`);
  if (addCost(1, null) !== null || formatCost(null) !== "cost unknown") throw new Error("未知应一路传下去");

  const used = { inputTokens: 500, outputTokens: 500, cacheCreationTokens: 0, cacheReadTokens: 0 };
  const client = new ScriptedClient([{ ...said("ok"), usage: used }]);
  const result = await scriptedAgent(client, { model: "minimax-m2" }).agent.run("go");
  if (result.usage.estimatedCostUsd !== null) throw new Error(`MiniMax 被算成了 $${result.usage.estimatedCostUsd}`);
});

await fs.rm(scratch, { recursive: true, force: true });

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

// exitCode rather than process.exit(): exiting with sockets still closing is what the assertion above is about.
process.exitCode = failed > 0 ? 1 : 0;
