# Localhost API

Use the localhost API to start T3 Code threads from another app or script on the
same machine as the server.

In the web or desktop app, open **Settings → Connections → Localhost API** and
choose **Generate key**. Copy it before leaving Settings; it is shown only once.
**Replace key** invalidates the previous key immediately. **Revoke key** disables
access. These controls require permission to manage the environment's access.

Send the key as `Authorization: Bearer <key>`. Use the server's HTTP port and a
loopback address such as `http://127.0.0.1:<port>`. In development, use the server
port, not the web development port. LAN, T3 Connect, tunnel, and forwarded
requests cannot use these endpoints. A normal pairing token or session cookie
cannot substitute for this key.

## Get composer options

`GET /api/local/composer` returns projects, configured providers, models and their
option descriptors, permission modes, interaction modes, and environment defaults.

Once a project is selected, request
`GET /api/local/composer?projectId=<id>&instanceId=<provider-instance-id>` to load
its workspace skills, slash commands, and branch choices. Omitting `instanceId`
loads workspace options for every enabled, installed provider. For an existing
worktree, include `worktreePath=<absolute-path>`.

Use the selected provider's matching `workspaceSnapshots` entry for workspace
skills and slash commands; fall back to its top-level catalogs when no workspace
snapshot is available. Providers report their own availability and capabilities.
Use model `capabilities.optionDescriptors` to render choices and send selections
as `{ "id": "<option-id>", "value": "<choice-id>" }` (or a boolean).

Branch results are in `refs`. Search with `refQuery`; when `refs.nextCursor` is
non-null, pass it as `refCursor` for the next page. Project defaults take
precedence over environment defaults. Draft preferences saved only in a client
are not available through this API.

## Create a thread and send its first message

`POST /api/local/threads` accepts JSON. For example, replace the project, provider,
and model values with those returned by the composer endpoint:

```json
{
  "projectId": "my-project",
  "title": "Review changes",
  "prompt": "$review Review the current changes",
  "modelSelection": {
    "instanceId": "codex",
    "model": "<model-slug>"
  },
  "runtimeMode": "approval-required",
  "interactionMode": "default"
}
```

Reference an available skill with `$skill-name` in the prompt, as in the composer.
For skills marked `userInvocationOnly`, use their `/skill-name` slash command.

To create a worktree, include:

```json
{
  "createWorktree": {
    "baseBranch": "main",
    "branch": "review-changes",
    "startFromOrigin": true
  },
  "runSetupScript": true
}
```

Alternatively, specify `branch` and `worktreePath` for an existing worktree.
Do not combine these fields with `createWorktree`. Without either, the thread
uses the project's working directory. `attachments` optionally accepts image
uploads with `type`, `name`, `mimeType`, `sizeBytes`, and a base64 `dataUrl`.

A successful response contains `threadId` and `sequence`. The first turn has been
submitted; the agent may still be running. The thread appears in connected T3
Code clients. Authentication failures return 401, non-local requests return 403,
and invalid parameters or rejected thread setup return 400.
