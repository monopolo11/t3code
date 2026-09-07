import { createWebhookEnvironmentAtoms } from "@t3tools/client-runtime/state/webhooks";
import { connectionAtomRuntime } from "../connection/runtime";
export const webhookEnvironment = createWebhookEnvironmentAtoms(connectionAtomRuntime);
