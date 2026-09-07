import * as NodeCrypto from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import { verifyWebhookSignature } from "./signature.ts";

describe("webhook signatures", () => {
  const body = Buffer.from('{ "action": "opened" }');
  const digest = NodeCrypto.createHmac("sha256", "secret").update(body).digest("hex");
  it("verifies the exact bytes for GitHub and Linear", () => {
    expect(verifyWebhookSignature("github", "secret", body, `sha256=${digest}`)).toBe(true);
    expect(verifyWebhookSignature("linear", "secret", body, digest)).toBe(true);
    expect(
      verifyWebhookSignature(
        "github",
        "secret",
        Buffer.from('{"action":"opened"}'),
        `sha256=${digest}`,
      ),
    ).toBe(false);
  });
  it("rejects malformed, missing, wrong-prefix and wrong-secret signatures without throwing", () => {
    for (const signature of [
      undefined,
      "",
      "abc",
      digest,
      `sha1=${digest}`,
      `sha256=${"0".repeat(64)}`,
    ])
      expect(verifyWebhookSignature("github", "secret", body, signature)).toBe(false);
    expect(verifyWebhookSignature("linear", "other", body, digest)).toBe(false);
  });
});
