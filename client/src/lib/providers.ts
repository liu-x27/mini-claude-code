import type { Provider } from "../hooks/useChat";

export const PROVIDER_PRESETS: Array<{ label: string; provider: Provider; baseURL: string; models: string[] }> = [
  { label: "Anthropic", provider: "anthropic", baseURL: "", models: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"] },
  { label: "OpenAI", provider: "openai", baseURL: "https://api.openai.com/v1", models: ["gpt-4o", "gpt-4o-mini", "o3-mini"] },
  { label: "DeepSeek", provider: "openai", baseURL: "https://api.deepseek.com/v1", models: ["deepseek-chat", "deepseek-reasoner"] },
  { label: "Groq", provider: "openai", baseURL: "https://api.groq.com/openai/v1", models: ["llama-3.3-70b-versatile", "mixtral-8x7b-32768"] },
  { label: "OpenRouter", provider: "openai", baseURL: "https://openrouter.ai/api/v1", models: ["anthropic/claude-opus-5", "openai/gpt-4o", "google/gemini-2.0-flash-001"] },
];

export const API_FORMATS: Array<{ value: Provider; label: string }> = [
  { value: "anthropic", label: "Anthropic Messages" },
  { value: "openai", label: "OpenAI-compatible" },
];

export const ALL_MODELS = [...new Set(PROVIDER_PRESETS.flatMap((p) => p.models))];

/** Used until /api/health answers with the server's actual registry. */
export const DEFAULT_TOOLS = ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch"];
