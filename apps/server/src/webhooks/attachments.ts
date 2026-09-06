import { type ChatAttachment, ThreadId, WebhookError } from "@t3tools/contracts";
import { Effect, FileSystem } from "effect";
import { ServerConfig } from "../config.ts";
import {
  createAttachmentId,
  parseAttachmentFileExtension,
  resolveAttachmentPath,
} from "../attachmentStore.ts";

/** Each run owns a copy so an agent cannot change the template's attachments. */
export const copyWebhookAttachments = Effect.fn("webhooks.copyAttachments")(function* (
  attachments: readonly ChatAttachment[],
  threadId: ThreadId,
) {
  const fs = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig;
  return yield* Effect.forEach(
    attachments,
    Effect.fnUntraced(function* (attachment) {
      const id = createAttachmentId(
        threadId,
        parseAttachmentFileExtension(attachment.id) ?? undefined,
      );
      const copy = { ...attachment, id: id ?? "" };
      const source = resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment });
      const destination = resolveAttachmentPath({
        attachmentsDir: config.attachmentsDir,
        attachment: copy,
      });
      if (!id || !source || !destination)
        return yield* new WebhookError({ message: "Invalid trigger attachment." });
      yield* fs.copyFile(source, destination);
      return copy;
    }),
  );
});
