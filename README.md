# Even Terminal OpenCode

Use OpenCode from the Terminal app on Even G2 glasses. Follow live responses,
approve actions with your ring, and answer agents’ questions by voice.

## Start the bridge

You need Node.js 22 or newer, a running OpenCode V2 service, and the Terminal app
on your glasses. Run the bridge on the same computer and under the same user
account as OpenCode so it can discover the service automatically.

```sh
git clone https://github.com/EmCousin/even-terminal-opencode.git
cd even-terminal-opencode
npm ci
export BRIDGE_TOKEN="$(node -p "require('node:crypto').randomBytes(32).toString('hex')")"
npm start
```

Save the token privately. Reuse it when restarting the bridge so you don’t have
to update the phone’s host settings. Keep this process running while using the app.

## Add a host in the Even companion app

Open the Terminal app’s host setup on your phone and enter:

| Setting | Value |
| --- | --- |
| Name | Any name, such as `OpenCode` |
| Provider | **Claude** for now |
| Host / IP | Your computer’s Tailscale IP, from `tailscale ip -4` |
| Port | `3458` |
| Token | The value of `BRIDGE_TOKEN` from the bridge’s shell |

Choose **Claude** for compatibility with the Terminal app. The bridge still uses
OpenCode and its configured models; this setting doesn’t select a Claude model.
Leave `WIRE_PROVIDER` at its default, `claude`.

Keep Tailscale connected on both the phone and computer. The bridge uses HTTP;
Tailscale encrypts traffic between those devices. Don’t expose the port to the
public internet or disable token authentication. A trusted local network also
works, but ordinary LAN HTTP isn’t encrypted.

## What works

Live responses, compact tool summaries, session history, permission approvals,
and replies to session questions. Pending questions and approvals return after
a reconnect. A missing or invalid answer never grants permission.

External sign-ins and global MCP setup forms still need the OpenCode desktop
client.

## Options and development

- `PORT`: change the bridge port. Use the same port in the companion app.
- `VERBOSE_TOOLS=true`: also show read-only tool summaries.
- `OPENCODE_SERVICE_FILE`: override the default service discovery file,
  `~/.local/state/opencode/service.json`.

```sh
npm test
npm run check
```

Tests use a mock OpenCode server and don’t interact with your real sessions.

## License

[MIT](LICENSE).
