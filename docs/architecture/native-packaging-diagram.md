# Native Packaging — Architecture Diagrams

> Stakeholder-facing view of the native-packaging architecture. Companion to the
> [design spec](../superpowers/specs/2026-06-05-native-packaging-design.md) and
> [implementation plan](../superpowers/plans/2026-06-05-native-packaging.md).
> Rendered, theme-styled vector exports live alongside this file:
> [`native-packaging-e2e.svg`](native-packaging-e2e.svg) and
> [`native-packaging-codebase.svg`](native-packaging-codebase.svg) — crisp at any
> zoom and importable into PowerPoint / Keynote.

---

## 1. End-to-end flow

From the customer opening the Helix AIOps page to telemetry landing in BMC Helix —
**no Docker Desktop required to run the configurator.**

```mermaid
flowchart TD
    subgraph CLOUD["☁️ Hosted (BMC / demo)"]
        AIOPS["Helix AIOps — Manage OTel page<br/><i>real: BMC · demo: helix-aiops-mock :9000</i>"]
        REL["GitHub Releases<br/><i>4 pre-built platform zips<br/>latest/download/</i>"]
    end

    subgraph LOCAL["💻 Customer machine (no Docker Desktop needed)"]
        SCRIPT["Install one-liner<br/>curl … | bash  /  iwr … | iex"]
        PKG["Native package<br/>node + backend + frontend-dist"]
        CFG["helix-configurator<br/><b>host process · localhost:8765</b><br/>onboarding · dashboard · /otel-data"]
        GW["helix-gateway<br/><i>OTel Collector container</i><br/>:4317 / :4318"]
        APPS["Customer apps<br/><i>instrumented</i>"]
    end

    subgraph HELIX["☁️ BMC Helix"]
        ING["OTLP ingestion<br/>topology · dashboards · Situations"]
    end

    AIOPS -->|"1 · enter service → token + API key"| SCRIPT
    SCRIPT -->|"2 · detect platform, download zip"| REL
    REL -->|"3 · extract + templated .env"| PKG
    PKG -->|"4 · ./node backend/index.js"| CFG
    CFG -->|"5 · wizard: Where will this run?"| GW
    CFG -.->|"K8s target: generate Helm chart (generate-only)"| HELIX
    APPS -->|"OTLP :4317 / :4318"| GW
    GW -->|"X-Api-Key + X-Source"| ING
    GW -->|"fan-out → host.docker.internal:8765"| CFG

    classDef cloud fill:#1b2742,stroke:#3759d8,color:#dce3f7;
    classDef local fill:#161b24,stroke:#2a3140,color:#e6e8ee;
    classDef helix fill:#102a1c,stroke:#2faf6a,color:#d5f7e3;
    class AIOPS,REL cloud;
    class SCRIPT,PKG,CFG,GW,APPS local;
    class ING helix;
```

**Key shifts from the Docker-Compose model**

| | Before (Compose) | After (Native) |
|---|---|---|
| Run the configurator | Docker Desktop required | None |
| Configurator process | Container on `helix-bridge` | Host process on `:8765` |
| Gateway created by | `docker compose up` | **The configurator** (dockerode) |
| Local fan-out target | `helix-configurator:3001` | `host.docker.internal:8765` |
| Install payload | App source (build locally) | Pre-built zip (~80 MB) |

---

## 2. Codebase makeup

Two projects plus two artifact channels. The configurator is cleaned of all
demo/tunnel code; the demo page becomes its own project.

```mermaid
flowchart LR
    subgraph A["📦 helix-configurator (this repo)"]
        direction TB
        BE["<b>backend/</b> — Express<br/>otlp · traces · situations<br/>lifecycle <b>+ gateway-create</b><br/>k8sChart · version"]
        FE["<b>frontend/</b> — React<br/>onboarding wizard · dashboard<br/>/otel-data · <b>UpdateBanner</b>"]
        PK["<b>packaging/</b><br/>start.command / .sh / .bat"]
        CIN["<b>.github/workflows/</b><br/>native-release.yml<br/>publish.yml (GHCR)"]
    end

    subgraph B["🌐 helix-aiops-mock (new project)"]
        direction TB
        SRV["server.js<br/>session store · /configure · /install"]
        IS["installScripts.js<br/>bash + ps1 renderers"]
        UI["public/index.html<br/>Manage OTel form"]
    end

    REL["🗄️ GitHub Releases<br/>helix-configurator-&lt;platform&gt;.zip ×4"]
    GHCR["🐳 GHCR<br/>Docker image (secondary path)"]

    CIN -->|"on v* tag"| REL
    CIN -->|"on push/tag"| GHCR
    IS -->|"latest/download/ URL"| REL
    SRV --> IS
    UI --> SRV
    FE -.->|"GET /api/version"| REL

    classDef cfg fill:#161b24,stroke:#3759d8,color:#e6e8ee;
    classDef mock fill:#1b2742,stroke:#5b7cf0,color:#dce3f7;
    classDef art fill:#241b2e,stroke:#9b6ad8,color:#ecd9ff;
    class BE,FE,PK,CIN cfg;
    class SRV,IS,UI mock;
    class REL,GHCR art;
```

**Removed from the configurator:** `backend/routes/demo.js`,
`frontend/src/components/AiopsPage.tsx`, the `/aiops` route, `IS_DEMO_INSTALL`,
`computeInstallBaseUrl` + tunnel awareness, and the `marked` dependency.
**Kept:** `archiver` (still used by the K8s Helm-chart streamer).
