import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "@t3tools/contracts";
import { Predicate } from "effect";

const PATH = /^(?:payload)(?:\.(?:[A-Za-z_][\w-]*|\d+))*$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const MAX_PROMPT_LENGTH = PROVIDER_SEND_TURN_MAX_INPUT_CHARS;

/** Resolve own JSON properties only. Values are substituted once, never evaluated as code. */
export function renderWebhookPrompt(template: string, payload: unknown): string {
  const rendered = template.replace(/\{\{([\s\S]*?)\}\}/g, (_, expression: string) => {
    const path = expression.trim();
    if (!PATH.test(path)) throw new Error(`Invalid template variable: ${path}`);
    let value: unknown = payload;
    for (const key of path.split(".").slice(1)) {
      if (
        FORBIDDEN_KEYS.has(key) ||
        (!Predicate.isObject(value) && !Array.isArray(value)) ||
        !Object.hasOwn(value, key)
      ) {
        throw new Error(`Missing template variable: ${path}`);
      }
      value = Reflect.get(value, key);
    }
    return typeof value === "string" ? value : (JSON.stringify(value) ?? "null");
  });
  if (rendered.includes("{{") || rendered.includes("}}")) {
    // Payload values can themselves contain braces; only inspect the template's syntax.
    if (template.replace(/\{\{[\s\S]*?\}\}/g, "").match(/\{\{|\}\}/)) {
      throw new Error("Unclosed template variable.");
    }
  }
  if (rendered.length > MAX_PROMPT_LENGTH)
    throw new Error("Rendered prompt exceeds 120,000 characters.");
  return rendered;
}
