import type { ToolContext, ToolResult } from "../types.js";
import { Tool } from "./base.js";

interface WebFetchInput {
  url: string;
  max_length?: number;
}

const MAX_CHARS = 50_000;

/**
 * Fetch a URL and return its text content.
 * Strips HTML tags for readability.
 */
export class WebFetchTool extends Tool<WebFetchInput> {
  readonly name = "WebFetch";
  readonly description =
    "Fetch a URL and return its text content. Automatically strips HTML. " +
    "Use for reading documentation, web pages, GitHub files, etc.";

  readonly inputSchema = {
    type: "object" as const,
    properties: {
      url: {
        type: "string" as const,
        description: "URL to fetch",
      },
      max_length: {
        type: "number" as const,
        description: `Maximum characters to return (default: ${MAX_CHARS})`,
      },
    },
    required: ["url"],
  };

  override async execute(input: WebFetchInput, _context: ToolContext): Promise<ToolResult> {
    const maxLen = input.max_length ?? MAX_CHARS;

    let res: Response;
    try {
      res = await fetch(input.url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; AgentApp/0.1; +https://github.com/your-org/agent-app)",
          Accept: "text/html,application/xhtml+xml,text/plain,application/json",
        },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      return { type: "error", message: `Fetch failed: ${String(err)}` };
    }

    if (!res.ok) {
      return { type: "error", message: `HTTP ${res.status} ${res.statusText}: ${input.url}` };
    }

    const contentType = res.headers.get("content-type") ?? "";
    let text: string;

    try {
      text = await res.text();
    } catch (err) {
      return { type: "error", message: `Failed to read response body: ${String(err)}` };
    }

    // Strip HTML if needed
    if (contentType.includes("html")) {
      text = this.stripHtml(text);
    }

    // Truncate
    if (text.length > maxLen) {
      text = text.slice(0, maxLen) + `\n\n[Truncated at ${maxLen} chars. Total: ${text.length}]`;
    }

    return { type: "success", output: text };
  }

  private stripHtml(html: string): string {
    // Remove scripts and styles entirely
    let text = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "");

    // Replace block elements with newlines
    text = text.replace(/<(br|p|div|h[1-6]|li|tr)[^>]*>/gi, "\n");

    // Remove remaining tags
    text = text.replace(/<[^>]+>/g, "");

    // Decode common HTML entities
    text = text
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, " ");

    // Collapse excessive whitespace
    text = text.replace(/\n{3,}/g, "\n\n").trim();

    return text;
  }

  override summarize(input: WebFetchInput): string {
    return input.url;
  }
}
