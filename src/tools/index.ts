export { Tool } from "./base.js";
export { ToolRegistry, globalRegistry } from "./registry.js";
export { BashTool } from "./bash.js";
export { FileReadTool } from "./file-read.js";
export { FileWriteTool } from "./file-write.js";
export { FileEditTool } from "./file-edit.js";
export { GlobTool } from "./glob.js";
export { GrepTool } from "./grep.js";
export { WebFetchTool } from "./web-fetch.js";

import { BashTool } from "./bash.js";
import { FileEditTool } from "./file-edit.js";
import { FileReadTool } from "./file-read.js";
import { FileWriteTool } from "./file-write.js";
import { GlobTool } from "./glob.js";
import { GrepTool } from "./grep.js";
import { globalRegistry } from "./registry.js";
import { WebFetchTool } from "./web-fetch.js";

let builtinsRegistered = false;

/**
 * Register all built-in tools into the global registry.
 *
 * Idempotent: `agent.ts` calls this at module load, so any consumer that both
 * imports `Agent` and calls this itself (the documented public API) would
 * otherwise hit `register()`'s duplicate-name guard. That guard stays strict
 * for user-supplied tools, where a name collision is a real mistake.
 */
export function registerBuiltinTools(): void {
  if (builtinsRegistered) return;
  builtinsRegistered = true;

  globalRegistry.register(
    new BashTool(),
    new FileReadTool(),
    new FileWriteTool(),
    new FileEditTool(),
    new GlobTool(),
    new GrepTool(),
    new WebFetchTool(),
  );
}
