import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/** Codex's default cap on project instructions. */
export const MAX_INSTRUCTION_CHARS = 32 * 1024;

/**
 * The project's instruction files, as one note for the start of a session:
 * `~/.agent-app/AGENTS.md`, then from the repository root down to the working
 * directory, AGENTS.md in each directory, and CLAUDE.md where it says
 * something AGENTS.md does not. Undefined when there are none.
 *
 * AGENTS.md is what Codex, Gemini CLI, Cursor and most other agents read;
 * CLAUDE.md is Claude Code's. They go into the first message of a session,
 * not the system prompt, so editing one mid-session changes nothing that is
 * already cached, and a resumed session keeps the version it started with.
 * Nearest last, so the most specific reads as the last word; over the cap,
 * the farthest files are cut first.
 */
export async function loadProjectInstructions(cwd: string, home: string = os.homedir()): Promise<string | undefined> {
  const found: Array<{ file: string; text: string }> = [];
  const add = async (file: string) => {
    const text = await fs.readFile(file, "utf-8").then(
      (t) => t.trim(),
      () => "",
    );
    if (text && !found.some((f) => f.text === text)) found.push({ file, text });
  };

  await add(path.join(home, ".agent-app", "AGENTS.md"));
  for (const dir of await rootToCwd(cwd)) {
    await add(path.join(dir, "AGENTS.md"));
    await add(path.join(dir, "CLAUDE.md"));
  }
  if (found.length === 0) return undefined;

  let body = found.map((f) => `# ${f.file}\n\n${f.text}`).join("\n\n");
  let cut = "";
  if (body.length > MAX_INSTRUCTION_CHARS) {
    cut = ` The first ${(body.length - MAX_INSTRUCTION_CHARS).toLocaleString("en-US")} characters did not fit and were left out.`;
    body = body.slice(body.length - MAX_INSTRUCTION_CHARS);
  }
  return `[Project instructions from the files below. Where they conflict, the one nearest the working directory wins.${cut}]\n\n${body}`;
}

/** The directories from the enclosing git repository's root down to `cwd`; just `cwd` outside a repository. */
async function rootToCwd(cwd: string): Promise<string[]> {
  const chain: string[] = [];
  let dir = path.resolve(cwd);
  for (;;) {
    chain.unshift(dir);
    if (await exists(path.join(dir, ".git"))) return chain;
    const parent = path.dirname(dir);
    if (parent === dir) return [path.resolve(cwd)];
    dir = parent;
  }
}

function exists(p: string): Promise<boolean> {
  return fs.access(p).then(
    () => true,
    () => false,
  );
}
