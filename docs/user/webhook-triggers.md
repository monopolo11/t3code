# Webhook triggers

Start a new thread automatically when GitHub or Linear sends an event. Each trigger
belongs to one integration on one machine, with its own events, prompt, project,
model, permission mode, and workspace settings. Manage triggers in **Settings →
Integrations** on web, desktop, or mobile.

## Connect an integration

1. Run T3 Code on the machine where agents should work. Point your Cloudflare tunnel
   at that server's local address and port. Use a stable public HTTPS hostname.
   The tunnel must allow requests to `/api/webhooks/*`, including OAuth callbacks.
2. Open **Settings → Integrations** and choose the default machine.
3. Create your own [GitHub OAuth app](https://github.com/settings/developers) or
   [Linear OAuth app](https://linear.app/settings/api/applications). Register the
   callback URL shown in T3 Code, using your tunnel's hostname.
4. Enter the tunnel URL, OAuth client ID, and client secret. Sign in, follow the
   authorization link, then return to T3 Code and refresh.

GitHub requests `admin:repo_hook` and `read:user`. You must be allowed to administer
webhooks on the repository. Linear requests `read` and `admin`, which Linear
requires to manage webhooks. Credentials stay on the selected machine. Changing
the OAuth app, connected account, or tunnel hostname requires deleting that
integration's triggers first.

## Create a trigger

Choose an integration, name the trigger, and select its events. For GitHub, enter
`owner/repository`. For Linear, enter a team UUID, or `*` for all public teams.
Optionally restrict actions: for example, `opened, reopened` for GitHub issues or
`create, update` for Linear issues. Leaving actions empty accepts every action
for the selected events.

Choose a project and compose a prompt with the regular composer. Files, images,
provider and model options, permission modes, and workspace controls are available.
Save the prompt, then enable the trigger in Integrations. Enabling registers the
webhook with the integration.

The selected machine owns both the listener and the project. To run triggers on
another machine, connect the integration and tunnel there. **New worktree** creates
a separate checkout for each delivery; **Local** uses the chosen existing checkout
and switches it to the saved branch.
The usual start-from-origin and setup-script behavior applies to new worktrees.
Local checkouts remain shared with other work using them.

## Use event data in prompts

Templates use double braces and JSON property paths:

```text
Investigate this GitHub issue:
{{payload.issue.title}}

{{payload.issue.body}}
```

For Linear, an issue title is `{{payload.data.title}}`. Use `{{payload}}` to include
the complete event, or a numeric path such as `{{payload.issue.labels.0.name}}`
for an array entry. Objects and arrays become JSON. Missing fields fail the
delivery instead of silently producing an incomplete prompt. Templates substitute
values once and do not execute expressions or code.

Web and desktop include a sample-payload preview in the trigger composer. Expanded
prompts have the same 120,000-character limit as ordinary messages. Webhook request
bodies are limited to 2 MB.

## Manage deliveries

Keep the machine and tunnel running; the client app can be closed. Each matching
delivery starts a fresh thread using the saved prompt and settings. Attachments
are copied separately for each thread. Agent availability and approval behavior
follow the selected provider and permission mode.

Refresh Integrations to see recent deliveries and open their threads. Failed
deliveries show an error and can be retried. Fix missing template fields before
retrying; once a delivery has begun preparing a thread, retries resume its saved
configuration. Accepted deliveries survive a server restart, and redeliveries
with the same delivery identifier do not create another thread.

Pause stops accepting new events for a trigger. Already accepted deliveries
continue. Resume with **Enable**. Deleting a trigger removes its remote webhook;
existing threads remain. Delete an integration's triggers before disconnecting
its OAuth credentials. You can revoke the OAuth app in GitHub or Linear as well.
