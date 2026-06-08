# Helix AIOps — Mock "Manage OpenTelemetry" page

A tiny local web app that **simulates the BMC Helix AIOps "Manage OpenTelemetry"
onboarding page** so you can demo the full Helix Configurator install experience
end-to-end without a live Helix tenant.

You enter a service name, it hands back a one-line install command, and running
that command downloads and launches the real, pre-built **Helix Configurator**
native package (from GitHub Releases) on `localhost:8765` — exactly what a
customer would see.

> **This is a demo tool, not a product.** The API key it generates is fake and
> the tenant endpoint is a placeholder — you fill in real credentials during the
> configurator's own onboarding. It hosts no packages; the install command pulls
> the native zip straight from GitHub Releases.

---

## Prerequisites

- **Node.js 18+** (no other runtime, no Docker)

## Run it

```bash
npm install
npm start
```

Then open **http://localhost:9000**.

That's the whole thing. There's no build step and no database.

## The demo flow

1. Open the mock page (`:9000`) — it looks like the BMC Helix "Service
   Monitoring → Manage OpenTelemetry" console.
2. Type a **service name** and click **Configure**. It mints a (fake) API key
   and shows the install one-liner for your platform.
3. Copy the command and run it **on the machine you want to onboard**:
   - macOS / Linux: `curl -fsSL http://<host>:9000/install/<token>.sh | bash`
   - Windows (PowerShell): `iwr http://<host>:9000/install/<token>.ps1 | iex`
4. The installer detects the platform, downloads
   `helix-configurator-<platform>.zip` from GitHub Releases, extracts it, writes
   a templated `.env`, and launches the configurator at **http://localhost:8765**.
5. Finish onboarding in the configurator (drop in your real Helix endpoint + key).

> Running the install command on a **different** machine? Start the mock with
> the host reachable on your LAN and use that host's IP/hostname in place of
> `localhost` — the page builds the command from the address you load it on.

## Configuration

Set via environment variables (all optional):

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `9000` | Port the mock listens on. |
| `RELEASES_REPO` | `jammicha/HelixConfigurator` | `owner/repo` whose GitHub Releases the install command downloads the native package from (`releases/latest/download/...`). |

```bash
PORT=8080 RELEASES_REPO=yourorg/HelixConfigurator npm start
```

## What it serves

| Route | Purpose |
|---|---|
| `GET /` | The mock "Manage OpenTelemetry" page (`public/index.html`). |
| `POST /configure` | Mints a 1-hour demo session; returns the token, fake API key, and the install one-liners. |
| `GET /install/:token.sh` | The bash installer (macOS / Linux). |
| `GET /install/:token.ps1` | The PowerShell installer (Windows). |

## Notes & limitations

- **Apple Silicon, Linux, Windows** are supported. **Intel Macs are not** — the
  installer points them at the Docker image instead (GitHub's Intel-Mac CI
  runner is retired, so no `darwin-amd64` native zip is built).
- The downloaded package is the **real** Helix Configurator; only the
  credentials handed to it here are simulated.
- For the install command to succeed, the `RELEASES_REPO` must have a published
  release with the `helix-configurator-<platform>.zip` assets.

## Development

```bash
npm test     # vitest — covers the install-script renderers
```

## How this maps to production

In a real BMC Helix deployment, the actual AIOps **Manage OpenTelemetry** page
does what this mock does: generate a scoped key and a templated install command.
This project exists so the entire onboarding journey — page → one-liner →
running configurator — can be shown locally, end to end.
