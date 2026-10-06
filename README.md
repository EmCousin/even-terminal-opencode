# Local Even Terminal OpenCode bridge

Direct OpenCode V2 integration for Even Terminal. No OpenChamber required.

## Local development

The source repository lives at `~/Github/even-terminal-opencode`.

```sh
cd ~/Github/even-terminal-opencode
npm ci
npm test
npm run check
```

The running service currently uses the separate installation at
`~/.local/lib/even-terminal-opencode`. Editing this repository does not change
the running service until the updated files are deployed there.

The systemd service supplies environment variables from
`~/.config/even-terminal/opencode.environment`. Keep tokens and credentials out
of source control. OpenCode discovery reads `~/.local/state/opencode/service.json`
on each request, so service credential/port changes do not require bridge edits.

## Behavior

- V2 live text deltas, thinking indicators, deduplicated message snapshots and
  compact tool cards. Raw reasoning and full tool output are not forwarded.
- Session-only ring approvals use pending permission requests in FIFO order.
  Always-allow is explicit; missing or invalid decisions never authorize a tool.
- Session-owned V2 forms support choices, voice text, booleans, numbers and
  multiselect. Multiple fields accept JSON keyed by field name or title.
  `answer: "skip"` cancels a form. External authentication/global MCP forms
  still need the desktop client; they cannot be completed from this bridge.
- Pending requests resync when a session is opened, on reconnect and every
  30 seconds. Failed upstream replies keep the request available for retry.
- One upstream SSE connection, reconnect backoff, 15-second downstream
  heartbeats, 500-event replay windows and `after` / `Last-Event-ID` cursors.
- Final text/result events with usage totals; history remains available while
  the agent is busy or waiting for an answer.

`WIRE_PROVIDER` defaults to `claude` for Even app compatibility; it does not
change the actual OpenCode agent/model. Set it to `opencode` if your app supports
that provider. `VERBOSE_TOOLS=true` shows read-only tool cards too.

The listener is LAN-facing (`0.0.0.0`) and uses the existing bearer/query token.
It is HTTP, not TLS: use only on a trusted LAN or through an encrypted tunnel.
Request logs omit query strings and tokens.

### Tailscale and HTTPS

For an Even app host setup that accepts only IP addresses, use the computer's
Tailscale IP and the bridge port (default `3458`). Keep Tailscale connected on
both the phone and computer, and keep token authentication enabled.

When the phone connects to the computer's Tailscale IP through Tailscale,
Tailscale encrypts the network traffic, including the token and session content,
even though the bridge uses HTTP. Connecting to an ordinary LAN IP does not
provide this Tailscale encryption. Do not expose the HTTP bridge to the internet.

HTTPS via Tailscale Serve adds TLS, but its certificate covers the computer's
`*.ts.net` hostname, not its numeric Tailscale IP. An IP-only host setup therefore
cannot use that hostname-based HTTPS endpoint with valid certificate verification.
Do not bypass certificate validation or assume a self-signed certificate will
work without explicit app support. HTTP over Tailscale remains an encrypted
option for this setup.

Tests use isolated fake requests and an authenticated local mock OpenCode HTTP/
SSE server. They never prompt, interrupt, approve or answer a real session.

The original entrypoint backup remains in the installed directory as
`bridge.mjs.pre-v2-improvements.bak`; it is not included in this repository.

## Requirements and manual startup

Use Node.js 22 or newer and a running OpenCode V2 service. Set `BRIDGE_TOKEN`
to a strong random token in your shell or your private service environment, then
run `npm start`. Empty and whitespace-only tokens are rejected. If the token is
unset, the bridge generates one in memory; for phone setup, configure a token
you can supply to the app. Do not commit it to this repository.

The default port is `3458`. `PORT` overrides it. Existing installations can keep
their private systemd environment file unchanged.

## Structure

- `bridge.mjs`: HTTP routes, session state and upstream event orchestration.
- `opencode-client.mjs`: service discovery, authentication and request timeouts.
- `protocol.mjs`: text reconciliation, permissions and form conversion.
- `history.mjs`: paginated turn history and generation-guarded completion.
- `replay.mjs`: bounded replay windows, cursor validation and downstream SSE.

Live SSE deltas and REST snapshots are tracked separately so a snapshot ahead
of queued deltas cannot render overlapping text twice. After a disconnect,
deltas without a reliable offset defer to snapshots until the text catches up.

`GET /api/messages` returns live replay events in `messages`, historical text
rows separately in `history`, and an `after` cursor for subsequent polling.
Use `GET /api/messages?sessionId=...&after=...` for incremental replay. Only live
events carry replay IDs; transcript row positions are not valid SSE cursors.
Invalid or negative cursors return HTTP 400. The transcript-only endpoint is
`GET /api/sessions/:sessionId/history`.

Completion follows the V2 descending-history `cursor.next` until the latest user
message, so long turns include all assistant messages and usage totals. Repeated
cursors or more than 200 pages fail explicitly rather than report partial totals.

## License

ISC; see [LICENSE](LICENSE). The package is marked private to prevent accidental
publication to npm; that does not restrict sharing the source on GitHub.
