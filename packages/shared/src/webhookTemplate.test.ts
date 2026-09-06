import { describe, expect, it } from "vite-plus/test";
import { renderWebhookPrompt } from "./webhookTemplate.ts";

describe("webhook prompt templates", () => {
  it("renders JSON, arrays and null without evaluating payload content", () => {
    const payload = {
      issue: { title: "{{payload.secret}}", labels: [{ name: "bug" }], body: null },
      secret: "private",
    };
    expect(
      renderWebhookPrompt(
        "{{payload.issue.title}} / {{payload.issue.labels.0.name}} / {{payload.issue.body}}",
        payload,
      ),
    ).toBe("{{payload.secret}} / bug / null");
    expect(renderWebhookPrompt("Event: {{payload}}", payload)).toBe(
      `Event: ${JSON.stringify(payload)}`,
    );
  });
  it("rejects missing fields, prototype traversal, expressions, and malformed templates", () => {
    for (const template of [
      "{{payload.missing}}",
      "{{payload.constructor}}",
      "{{payload.__proto__}}",
      "{{payload.toString}}",
      "{{payload.issue + 1}}",
      "{{payload",
      "payload}}",
    ])
      expect(() => renderWebhookPrompt(template, {})).toThrow();
  });
  it("bounds the expanded prompt", () => {
    expect(() =>
      renderWebhookPrompt("{{payload.body}}{{payload.body}}", { body: "x".repeat(65_000) }),
    ).toThrow("120,000");
  });
});
