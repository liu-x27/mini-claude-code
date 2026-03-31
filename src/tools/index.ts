export { Tool } from "./base.js";
export { ToolRegistry, globalRegistry } from "./registry.js";
export { BashTool } from "./bash.js";
export { FileReadTool } from "./file-read.js";
export { FileWriteTool } from "./file-write.js";
export { FileEditTool } from "./file-edit.js";
export { GlobTool } from "./glob.js";
export { GrepTool } from "./grep.js";
export { WebFetchTool } from "./web-fetch.js";

import { globalRegistry } from "./registry.js";
import { BashTool } from "./bash.js";
import { FileEditTool } from "./file-edit.js";
import { FileReadTool } from "./file-read.js";
import { FileWriteTool } from "./file-write.js";
import { GlobTool } from "./glob.js";
import { GrepTool } from "./grep.js";
import { WebFetchTool } from "./web-fetch.js";

/** Register all built-in tools into the global registry */
export function registerBuiltinTools(): void {
  globalRegistry.register(
    new BashTool(),
    new FileReadTool(),
    new FileWriteTool(),
    new FileEditTool(),
    new GlobTool(),
    new GrepTool(),
    new WebFetchTool()
  );
}
