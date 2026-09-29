import * as os from "node:os";
import * as path from "node:path";
import type { PermissionMode, PermissionRule } from "../types.js";

/**
 * `Bash`, `Bash(npm test *)`, `Read(~/.ssh/**)`, `Edit(src/**)`,
 * `WebFetch(domain:docs.python.org)` or `*` — Claude Code's rule syntax —
 * as a rule with the given mode.
 */
export function parseRule(spec: string, mode: PermissionMode): PermissionRule {
  const m = /^\s*([\w*.-]+)\s*(?:\((.*)\))?\s*$/s.exec(spec);
  if (!m?.[1]) throw new Error(`not a permission rule: ${JSON.stringify(spec)} (try Bash, Bash(npm test *), Read(src/**))`);
  const tool = m[1];
  const pattern = m[2]?.trim();
  if (pattern !== undefined && (pattern === "" || tool === "*")) {
    throw new Error(`not a permission rule: ${JSON.stringify(spec)} (a pattern needs a tool and some text)`);
  }
  return pattern === undefined ? { tool, mode } : { tool, mode, pattern };
}

/** What a rule is matched against: the call, and the directory relative paths are resolved in. */
export interface RuleTarget {
  toolName: string;
  input: Record<string, unknown>;
  cwd: string;
}

/** Pattern rules beat tool rules, which beat `*`. */
export function specificity(rule: PermissionRule): number {
  if (rulePattern(rule) !== undefined) return 2;
  return rule.tool === "*" ? 0 : 1;
}

/** Path patterns on Read cover the other tools that read, and on Edit the other that writes. */
const FAMILIES: Record<string, string[]> = {
  Read: ["Read", "Glob", "Grep"],
  Edit: ["Edit", "Write"],
  Write: ["Write"],
  Glob: ["Glob"],
  Grep: ["Grep"],
};

export function ruleMatches(rule: PermissionRule, target: RuleTarget): boolean {
  const pattern = rulePattern(rule);
  if (pattern === undefined) return rule.tool === "*" || rule.tool === target.toolName;

  if (rule.tool === "Bash") {
    if (target.toolName !== "Bash" || typeof target.input.command !== "string") return false;
    return bashMatches(pattern, target.input.command, rule.mode);
  }
  if (rule.tool === "WebFetch") {
    if (target.toolName !== "WebFetch" || typeof target.input.url !== "string") return false;
    return domainMatches(pattern, target.input.url);
  }
  const family = FAMILIES[rule.tool];
  if (family?.includes(target.toolName)) {
    const file = targetPath(target);
    return file !== undefined && pathMatches(pattern, file, target.cwd);
  }
  return false;
}

function rulePattern(rule: PermissionRule): string | undefined {
  return rule.pattern ?? rule.pathPattern;
}

// ─────────────────────────────────────────────
// Bash
// ─────────────────────────────────────────────

/**
 * A command pattern: `*` stands for any text, and a trailing ` *` also
 * matches the command with no arguments, so `npm test *` covers `npm test`.
 *
 * An allow rule matches only a simple command: one command line with no
 * control or redirection operator and no command substitution. Anything
 * else falls through to the tool's own mode, so allowing `npm test *` never
 * allows what follows an `&&`. A deny or ask rule matches if the whole
 * command or any part of it does — the parts between operators, and what
 * sits inside `$(...)` or backticks.
 */
function bashMatches(pattern: string, command: string, mode: PermissionMode): boolean {
  const re = commandRegex(pattern);
  const text = command.trim();
  if (mode === "allow") return isSimpleCommand(text) && re.test(text);
  return [text, ...commandParts(text)].some((part) => re.test(part));
}

function commandRegex(pattern: string): RegExp {
  const optionalTail = pattern.endsWith(" *");
  const core = optionalTail ? pattern.slice(0, -2) : pattern;
  const body = core
    .split("*")
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}${optionalTail ? "(?:\\s.*)?" : ""}$`, "s");
}

function isSimpleCommand(command: string): boolean {
  return !/[;&|<>\n`]|\$\(/.test(command);
}

function commandParts(command: string): string[] {
  const inner = [...command.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)].map((m) => m[1] ?? m[2] ?? "");
  const pieces = command.split(/&&|\|\||[;|&\n]/);
  return [...pieces, ...inner].map((p) => p.trim()).filter(Boolean);
}

// ─────────────────────────────────────────────
// Paths and domains
// ─────────────────────────────────────────────

function targetPath(target: RuleTarget): string | undefined {
  const raw = target.input.file_path ?? target.input.path;
  if (typeof raw === "string") return raw;
  // Glob and Grep default to the working directory.
  return target.toolName === "Glob" || target.toolName === "Grep" ? target.cwd : undefined;
}

/** A glob over the resolved path: `~/` is the home directory, anything relative is under `cwd`. */
function pathMatches(pattern: string, file: string, cwd: string): boolean {
  const abs = (p: string) => {
    const expanded = p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;
    return path.resolve(cwd, expanded).replace(/\\/g, "/");
  };
  const target = abs(file);
  const glob = abs(pattern);
  // A pattern naming a directory covers what is inside it, and `dir/**`
  // covers `dir` itself, which the glob alone does not: otherwise a Grep
  // with path ~/.ssh walked past a Read(~/.ssh/**) deny.
  const root = glob.endsWith("/**") ? glob.slice(0, -3) : glob.replace(/\/+$/, "");
  return path.matchesGlob(target, glob) || path.matchesGlob(target, root) || path.matchesGlob(target, `${root}/**`);
}

/** `domain:example.com` matches example.com and its subdomains. */
function domainMatches(pattern: string, url: string): boolean {
  if (!pattern.startsWith("domain:")) return false;
  const domain = pattern.slice("domain:".length).toLowerCase();
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === domain || host.endsWith(`.${domain}`);
  } catch {
    return false;
  }
}
