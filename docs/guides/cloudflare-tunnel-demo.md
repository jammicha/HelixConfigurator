# Cloudflare Tunnel — Demo Setup

How to expose a locally-running Helix Configurator over a public HTTPS URL so a remote tester (e.g. on Windows) can drive the wizard without VPN, SSH tunnels, or firewall rules.

The configurator runs on the demo host (typically a Mac); the remote tester only needs a browser.

## TL;DR

```bash
cloudflared tunnel --url http://localhost:8765 --no-autoupdate
```

The command prints a URL like `https://random-words.trycloudflare.com` in its first few seconds of output. Hand that URL to the tester. Done.

## Prerequisites

- **`cloudflared` installed.** macOS: `brew install cloudflare/cloudflare/cloudflared`. Verify with `cloudflared --version` (≥ 2024 is fine).
- **Configurator container up.** `docker compose up -d` should show `helix-configurator` running with port `8765 → 3001`. Sanity check: `curl -s http://localhost:8765/api/auth/status` returns `{"required":...,"authenticated":...}`.
- **`UI_AUTH_PASSWORD` left blank in `.env`.** Demos want the tester to land directly on the wizard — a password gate forces an out-of-band credential exchange and defeats the point. Confirm `auth/status` shows `"required":false` before sharing the URL. The protection is the URL itself: the trycloudflare hostname is randomly generated and dies with the `cloudflared` process, so it's effectively secret as long as you don't paste it anywhere public.

No Cloudflare account, no DNS config, no tunnel credentials needed for the quick-tunnel flow below.

## Quick tunnel (ephemeral URL)

This is the everyday demo path. Cloudflare hands you a random `*.trycloudflare.com` hostname tied to the running `cloudflared` process; when the process stops, the URL dies.

```bash
cloudflared tunnel --url http://localhost:8765 --no-autoupdate
```

Watch the first ~5 seconds of output for the banner:

```
+--------------------------------------------------------------------------------------------+
|  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |
|  https://pit-screening-nhs-broadway.trycloudflare.com                                      |
+--------------------------------------------------------------------------------------------+
```

Verify before sharing the URL:

```bash
curl -s https://<your-subdomain>.trycloudflare.com/api/auth/status
# expect: {"required":false,"authenticated":true}
```

Then send the URL to the tester. They'll land directly on the wizard and walk the 4 steps exactly as if they were on `localhost`.

### Caveats

- **Ephemeral.** A new run gets a new random hostname. Don't bake the URL into anything durable.
- **No uptime SLA.** Cloudflare's TOS for quick tunnels reserves the right to investigate or revoke. Fine for ad-hoc demos, not for staged customer environments.
- **URL secrecy is the only gate.** With `UI_AUTH_PASSWORD` blank (the demo default), anyone who learns the URL has full configurator access — including the ability to attach/disconnect Docker containers on the demo host. Treat the URL as a short-lived secret: share it 1:1, don't put it in chat threads, screenshots, or recordings, and tear the tunnel down when the demo ends.
- **One connection.** Quick tunnels open a single edge connection (no HA). If the demo host's network blips, the tunnel reconnects but in-flight requests fail.

## Backend already handles tunnels correctly

`backend/index.js` trusts `X-Forwarded-*` from loopback proxies (cloudflared runs on the host, hits `localhost:8765`, so its forwarded headers count as loopback). What this buys:

- The configurator's install-bundle endpoints (`/api/aiops/install/...`) read `X-Forwarded-Host` and embed **the trycloudflare hostname** into the curl/PowerShell one-liner the wizard hands the tester. They don't have to know what the tunnel is or rewrite anything.
- The `INSTALL_BASE_URL` env var override is still available if you ever need to pin a specific public URL (e.g. for a named tunnel below), but you don't need to set it for quick tunnels.

## Named tunnel (stable URL on your own domain)

Skip this section unless you want a URL that survives restarts and lives on a domain you control. Setup is ~5–10 minutes and requires a Cloudflare account with a zone you own.

```bash
# One-time
cloudflared tunnel login                                    # opens browser, picks the zone
cloudflared tunnel create helix-demo                        # creates the tunnel + creds JSON
cloudflared tunnel route dns helix-demo demo.example.com    # DNS CNAME → tunnel
```

Then point the tunnel at the configurator:

```bash
# ~/.cloudflared/config.yml
tunnel: helix-demo
credentials-file: /Users/<you>/.cloudflared/<tunnel-uuid>.json

ingress:
  - hostname: demo.example.com
    service: http://localhost:8765
  - service: http_status:404
```

Run it:

```bash
cloudflared tunnel run helix-demo
```

`demo.example.com` now points at the configurator and the URL is stable across restarts. The same `X-Forwarded-Host` behavior applies, so install bundles embed `demo.example.com` automatically.

## Tearing down

For a quick tunnel: `Ctrl-C` the foreground `cloudflared` process. The URL becomes unreachable within seconds. No cleanup needed on Cloudflare's side.

For a named tunnel: `cloudflared tunnel delete helix-demo` (and remove the DNS record) if you don't want it lying around.

## Troubleshooting

- **Tunnel boots but URL returns 502/504.** Confirm `helix-configurator` is actually listening on `:8765` (`docker ps | grep helix-configurator`). The tunnel connects to Cloudflare instantly even if the origin is down.
- **Tester hits the URL and sees a login screen.** You left `UI_AUTH_PASSWORD` set. Either blank it out in `.env` and `docker compose restart helix-configurator`, or share the password out-of-band — but the blank-password path is the intended demo flow.
- **Install bundles show `localhost` in the install command.** The trust-proxy chain isn't seeing the forwarded headers. Confirm `cloudflared` is running on the same host (loopback) and you're hitting the tunnel URL, not a port-forwarded variant. Last resort: set `INSTALL_BASE_URL=https://<your-tunnel-host>` in `.env`.
- **Wizard "Discovered Services" / "Attach to Bridge" do nothing.** Those work against the demo host's Docker socket — the remote tester is *driving* Docker on your machine. That's correct for a demo, but be aware they can attach/disconnect your containers.
