import * as NodeCrypto from "node:crypto";
import type { WebhookIntegrationProvider } from "@t3tools/contracts";

export function verifyWebhookSignature(
  provider: WebhookIntegrationProvider,
  secret: string,
  body: Uint8Array,
  signature: string | undefined,
): boolean {
  const hex = provider === "github" ? signature?.replace(/^sha256=/, "") : signature;
  if (
    !hex ||
    !/^[a-f0-9]{64}$/.test(hex) ||
    (provider === "github" && !signature?.startsWith("sha256="))
  )
    return false;
  return NodeCrypto.timingSafeEqual(
    NodeCrypto.createHmac("sha256", secret).update(body).digest(),
    Buffer.from(hex, "hex"),
  );
}
