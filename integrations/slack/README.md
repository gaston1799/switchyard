# Switchyard Slack app

## Registered development installation

- App: **Switchyard**, app ID `A0CBB5TU3BM`.
- Workspace: **Agent Toolpacks**, workspace ID `T0BS3H5RUDC`.
- Owner account: `switchyard@agent-toolpacks.com`, display name **Switchyard**.
- App settings: <https://api.slack.com/apps/A0CBB5TU3BM>.
- The app is installed in the workspace and uses the repository's `icon.png`.
- `manifest.json` is the initial app configuration, accepted by Slack during creation.

The owner address uses an active Cloudflare Email Routing rule. The destination
inbox remains private and is not part of the repository configuration.

## Permissions

The initial bot scopes are `app_mentions:read`, `chat:write`, `im:history`, and
`im:write`. These prepare the app for mentions, direct-message conversations,
and bot replies. The app's Messages tab accepts user input.

## Remaining messaging work

Local API sessions can now load the `slack` toolpack with `load_toolpack`.
Set `SWITCHYARD_SLACK_BOT_TOKEN` in the local environment. The `slack` tool
checks bot identity, reads one bounded conversation-history page, and sends
user-confirmed messages. It does not subscribe to events, wake agents from
mobile messages, or provide hosted pairing. No real messages were sent during
implementation; tests use mocked Slack responses.

Registration and installation are complete; mobile agent messaging is not yet
connected. No production relay, event subscriptions, interactivity endpoint,
OAuth callback, or computer pairing service has been deployed. The app is not
published in the Slack Marketplace or enabled for distribution to customers.

The next implementation should provide:

1. A hosted relay with Slack request signature verification, OAuth installation
   state validation, and separately stored credentials for each workspace.
2. Explicit pairing of an authorized Slack user and workspace to a Switchyard
   installation through an authenticated outbound connection.
3. A durable mapping of workspace/channel/thread to project/session/agent, with
   duplicate event protection and queued/received/failed message receipts.
4. Integration with Switchyard's existing park, wake, safe-turn queue, and
   stopped-session resume behavior, retaining the saved project context.
5. Agent replies sent to the originating Slack conversation, plus a dedicated
   messaging skill for concise updates, questions, completion, and waiting.
6. Verified event and OAuth endpoint URLs added to the manifest before enabling
   public installation. Socket Mode remains disabled for the official app.

Keep Slack client secrets, signing secrets, and bot/app tokens out of manifests,
source control, screenshots, logs, and chat. App registration did not copy those
credentials into the repository or configure any running Switchyard sessions.
