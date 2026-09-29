import type { JsonSchemaProperty, ToolInputSchema } from "../types.js";

export type Validated = { ok: true; value: Record<string, unknown> } | { ok: false; error: string };

/**
 * Check a tool call's input against the tool's own schema before it runs.
 *
 * Nothing upstream guarantees the shape: the Anthropic API validates only when
 * `strict` is set, and OpenAI-compatible endpoints pass through whatever the
 * model wrote. A string where a number belongs used to reach the Grep tool's
 * command line as-is. Two lenient cases are accepted rather than refused,
 * because smaller models produce them constantly and they are unambiguous: a
 * numeric string for a number and "true"/"false" for a boolean. `null` for an
 * optional field means the field is absent.
 */
export function validateInput(schema: ToolInputSchema, input: unknown): Validated {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, error: "input must be a JSON object" };
  }

  const value: Record<string, unknown> = {};
  const problems: string[] = [];
  const required = new Set(schema.required ?? []);

  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    const prop = schema.properties[key];
    if (!prop) {
      if (schema.additionalProperties === false) problems.push(`unknown field "${key}"`);
      else value[key] = raw;
      continue;
    }
    if (raw === null && !required.has(key)) continue;
    const checked = checkValue(prop, raw, key);
    if (typeof checked === "string") problems.push(checked);
    else value[key] = checked.value;
  }

  for (const key of required) {
    if (value[key] === undefined) problems.push(`missing required field "${key}"`);
  }

  return problems.length > 0 ? { ok: false, error: problems.join("; ") } : { ok: true, value };
}

function checkValue(prop: JsonSchemaProperty, raw: unknown, path: string): { value: unknown } | string {
  let v = raw;
  if (prop.type === "number" && typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) v = Number(v);
  if (prop.type === "boolean" && (v === "true" || v === "false")) v = v === "true";

  const actual = Array.isArray(v) ? "array" : v === null ? "null" : typeof v;
  if (actual !== prop.type) return `"${path}" must be ${article(prop.type)} (got ${actual})`;
  if (prop.type === "number" && !Number.isFinite(v as number)) return `"${path}" must be a finite number`;
  if (prop.enum && !prop.enum.includes(v as string | number | boolean)) {
    return `"${path}" must be one of ${prop.enum.map((e) => JSON.stringify(e)).join(", ")}`;
  }
  if (prop.type === "array" && prop.items) {
    const items: unknown[] = [];
    for (const [i, item] of (v as unknown[]).entries()) {
      const checked = checkValue(prop.items, item, `${path}[${i}]`);
      if (typeof checked === "string") return checked;
      items.push(checked.value);
    }
    v = items;
  }
  return { value: v };
}

function article(type: string): string {
  return type === "array" || type === "object" ? `an ${type}` : `a ${type}`;
}
