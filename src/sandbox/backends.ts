import type { SandboxBackend } from "./index.js";
import { MxcBackend } from "./mxc.js";
import { SrtBackend } from "./srt.js";

/** The backends `--sandbox` can name. */
export const SANDBOX_BACKENDS = ["srt", "mxc"] as const;
export type SandboxBackendName = (typeof SANDBOX_BACKENDS)[number];

export function isSandboxBackendName(value: string | undefined): value is SandboxBackendName {
  return value !== undefined && (SANDBOX_BACKENDS as readonly string[]).includes(value);
}

export function sandboxBackend(name: SandboxBackendName): SandboxBackend {
  return name === "mxc" ? new MxcBackend() : new SrtBackend();
}
