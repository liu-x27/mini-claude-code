import { exec } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
const execAsync = promisify(exec);

const searchPath = path.resolve("D:/CODE/agent-app", "D:/CODE/agent-app/src");
const normalized = searchPath.replace(/\\/g, "/");

const cmd = `rg --no-heading -n --glob '!node_modules/**' -- "class Agent" "${normalized}"`;
console.log("cmd:", cmd);
console.log("searchPath:", searchPath);
console.log("normalized:", normalized);

try {
  const r = await execAsync(cmd, { cwd: "D:/CODE/agent-app", maxBuffer: 1024 * 1024 });
  console.log("stdout:", r.stdout.slice(0, 300) || "(empty)");
  console.log("stderr:", r.stderr.slice(0, 100) || "(empty)");
} catch (e: unknown) {
  const err = e as { code?: number; stdout?: string; stderr?: string; message?: string };
  console.log("exit code:", err.code);
  console.log("stdout:", err.stdout?.slice(0, 100));
  console.log("stderr:", err.stderr?.slice(0, 100));
}
