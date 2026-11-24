# orca-cloudflare-access

English | [日本語](README.ja.md)

An Orca plugin for connecting the Orca desktop app to an Orca Remote Server (`orca serve`) published behind Cloudflare Access.

The plugin runs a local proxy that listens for WebSocket connections on `127.0.0.1`. It relays them upstream with an access token obtained through Cloudflare Access Managed OAuth. You do not need to modify Orca, deploy Cloudflare Workers, or install cloudflared on the client.

## Caveats

- While you are signed in, any process on the same machine that connects to the local proxy gets through Access. The Orca server still requires the device token issued at pairing, but Access no longer protects anything on this machine.
- The Orca server does not verify `Cf-Access-Jwt-Assertion`. Binding the server to anything other than `127.0.0.1` opens a path that bypasses Access, so bind it to loopback only, as shown below.

## Requirements

- Orca 1.4.248 or later, with the same version on the client and the server
- Cloudflare Zero Trust and a domain you can publish through a Tunnel
- macOS, Linux or Windows (sign-in opens the system's default browser)

## Server setup

Run the Orca server and cloudflared on the same host.

```bash
orca serve \
  --bind 127.0.0.1 \
  --port 6768 \
  --pairing-address ws://127.0.0.1:16768
```

`--pairing-address` is the address written into the pairing link. Set it to the client-side proxy, with the same port as the plugin's Local proxy port.

Point the cloudflared ingress at the server over HTTP. With `tcp://`, Access cannot authenticate at the HTTP level.

```yaml
ingress:
  - hostname: orca.example.com
    service: http://127.0.0.1:6768
  - service: http_status:404
```

Add `orca.example.com` to Access as a self-hosted application and configure it as follows.

| Setting                     | Value                                                       |
| --------------------------- | ----------------------------------------------------------- |
| Policy                      | Allow only the users who may connect                        |
| Managed OAuth               | On                                                          |
| Dynamic client registration | On                                                          |
| Allow loopback clients      | On (the redirect URI is `http://127.0.0.1:<port>/callback`) |
| Access token lifetime       | The default 15 minutes                                      |
| Grant session duration      | 1–2 weeks (how often you need to sign in again)             |

## Client setup

1. Run `orca plugin install shun-shobon/orca-cloudflare-access`, review the access it asks for, and install it with the `--approve` command it prints.
2. In the plugin settings, set Upstream URL to `https://orca.example.com`.
3. Click "Access: signed out" in the status bar and sign in to your IdP in the browser that opens. Setup is done when the item shows "Access: ready".
4. Go to Settings → Remote Orca Servers → Add Server and paste the server's pairing link. Orca warns "This link points back to this device"; check "I reach this address through an SSH tunnel" below the warning to register it. Despite the wording, this option accepts any manual tunnel to `127.0.0.1`.

### Settings

| Setting             | Default         | Description                                                            |
| ------------------- | --------------- | ---------------------------------------------------------------------- |
| Upstream URL        | None (required) | Origin of the Orca server protected by Access                          |
| Local proxy port    | `16768`         | Port the proxy listens on. Must match the server's `--pairing-address` |
| OAuth callback port | `16769`         | Port that receives the sign-in redirect                                |

### Status bar

| Text                  | State                               | On click                                 |
| --------------------- | ----------------------------------- | ---------------------------------------- |
| Access: signed out    | Not signed in                       | Sign in                                  |
| Access: ready         | Signed in, waiting for connections  | Show status                              |
| Access: n relaying    | Relaying n connections              | Show status                              |
| Access: sign in again | The refresh token expired           | Sign in                                  |
| Access: error         | Invalid settings, port in use, etc. | Show status (the tooltip also shows why) |

The plugin checks the access token's remaining lifetime on every connection and refreshes it automatically. You only sign in through the browser the first time and when the grant session expires. Connections already being relayed stay open when the token expires.

The command palette has Sign in, Sign out and Show status. Sign out deletes the stored credentials, so the next sign-in registers a new OAuth client.

## Troubleshooting

`orca plugin logs shun-shobon.cloudflare-access` shows connection starts and ends, upstream status codes, and whether token refreshes succeeded. Tokens are never logged.

To check whether Access lets a WebSocket upgrade with a bearer token through, get a token by hand and run the following. A `101 Switching Protocols` response means it does.

```bash
curl -i --http1.1 https://orca.example.com/ \
  -H "Authorization: Bearer $TOKEN" \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: $(openssl rand -base64 16)"
```

## License

MIT
