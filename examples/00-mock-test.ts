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
import { SessionManager } from "../src/session/manager.js";
import { estimateCost, formatCost } from "../src/utils/cost.js";
import type { ToolContext } from "../src/types.js";
import * as os from "node:os";
import * as path from "node:path";
import chalk from "chalk";

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
  const result = await tool.execute({ pattern: "src/**/*.ts" }, { ...ctx, cwd: "D:/CODE/agent-app" });
  if (result.type !== "success") throw new Error(result.message);
  if (!result.output.includes(".ts")) throw new Error("应该找到 TS 文件");
  console.log(chalk.gray("    " + result.output.split("\n")[0]));
});

await checkAsync("GrepTool: 搜索关键词", async () => {
  const tool = new GrepTool();
  const result = await tool.execute(
    { pattern: "class Agent", path: "D:/CODE/agent-app/src" },
    { ...ctx, cwd: "D:/CODE/agent-app" }
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
// 4. Session Manager
// ─────────────────────────────────────────────
section("4. Session Manager");

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

await checkAsync("列出所有会话", async () => {
  const sm = new SessionManager(tempSessionDir);
  const sessions = await sm.list();
  if (sessions.length < 1) throw new Error("应该有至少 1 个会话");
  console.log(chalk.gray(`    找到 ${sessions.length} 个会话`));
});

// ─────────────────────────────────────────────
// 5. Cost Calculator
// ─────────────────────────────────────────────
section("5. Cost Calculator");

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
