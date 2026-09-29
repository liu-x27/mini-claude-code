import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Tool } from "../tools/base.js";
import type { ToolContext, ToolResult } from "../types.js";

/**
 * Agent Skills (agentskills.io): a folder holding a SKILL.md, whose YAML
 * frontmatter gives a `name` and a `description`, and whose body is the
 * instructions. Loaded the way the standard intends — progressively: a new
 * session is told each skill's name and description, a line apiece, and the
 * body comes in only when the model asks for it with the Skill tool.
 */
export interface SkillInfo {
  name: string;
  description: string;
  /** The skill's folder, which the files its instructions mention are relative to. */
  dir: string;
}

/**
 * Where skills are looked for, project before home, so a project's skill of
 * a given name wins: `.agents/skills` (the cross-agent location Codex and
 * goose read), `.claude/skills` (Claude Code's) and `.agent-app/skills`.
 */
export function skillRoots(cwd: string, home: string = os.homedir()): string[] {
  const under = (base: string) => [".agents", ".claude", ".agent-app"].map((d) => path.join(base, d, "skills"));
  return [...under(cwd), ...under(home)];
}

export async function discoverSkills(cwd: string, home?: string): Promise<SkillInfo[]> {
  const found = new Map<string, SkillInfo>();
  for (const root of skillRoots(cwd, home)) {
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(root, entry.name);
      const text = await fs.readFile(path.join(dir, "SKILL.md"), "utf-8").catch(() => undefined);
      if (text === undefined) continue;
      const meta = frontmatter(text).fields;
      const name = meta.name?.trim() || entry.name;
      const description = meta.description?.trim();
      if (!description || found.has(name)) continue;
      found.set(name, { name, description, dir });
    }
  }
  return [...found.values()];
}

/** The note a new session starts with: one line per skill. */
export function skillsNote(skills: SkillInfo[]): string {
  const lines = skills.map((s) => `- ${s.name}: ${s.description.replace(/\s+/g, " ")}`);
  return `[Skills available. When a task matches one, call the Skill tool with its name to load its instructions before starting.\n${lines.join("\n")}]`;
}

/** A SKILL.md split into its frontmatter fields and its body. Enough YAML for what the standard puts there. */
export function frontmatter(text: string): { fields: Record<string, string>; body: string } {
  const normalized = text.replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);
  if (!m) return { fields: {}, body: normalized };
  const fields: Record<string, string> = {};
  const lines = (m[1] ?? "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i] ?? "");
    if (!kv?.[1]) continue;
    let value = kv[2] ?? "";
    if (value === ">" || value === "|" || value === ">-" || value === "|-") {
      const block: string[] = [];
      while (i + 1 < lines.length && /^\s+/.test(lines[i + 1] ?? "")) block.push((lines[++i] ?? "").trim());
      value = block.join(value.startsWith(">") ? " " : "\n");
    }
    fields[kv[1]] = value.replace(/^(["'])(.*)\1$/, "$2");
  }
  return { fields, body: m[2] ?? "" };
}

interface SkillInput {
  name: string;
}

/** Loads one skill's instructions. Looked up afresh on each call, so a skill edited mid-session is read as it now is. */
export class SkillTool extends Tool<SkillInput> {
  readonly name = "Skill";
  readonly description =
    "Load the instructions of one of the skills listed at the start of the session, by name. " +
    "Follow them for the task at hand; files they mention are relative to the skill's folder, which the result names.";
  readonly inputSchema = {
    type: "object" as const,
    properties: { name: { type: "string" as const, description: "The skill's name, as listed" } },
    required: ["name"],
  };

  override async execute(input: SkillInput, context: ToolContext): Promise<ToolResult> {
    const skills = await discoverSkills(context.cwd);
    const skill = skills.find((s) => s.name === input.name);
    if (!skill) {
      return { type: "error", message: `No skill named "${input.name}". Available: ${skills.map((s) => s.name).join(", ") || "none"}` };
    }
    const text = await fs.readFile(path.join(skill.dir, "SKILL.md"), "utf-8");
    return {
      type: "success",
      output: `Skill "${skill.name}", from ${skill.dir}:\n\n${frontmatter(text).body.trim()}`,
    };
  }

  override summarize(input: SkillInput): string {
    return input.name;
  }
}
