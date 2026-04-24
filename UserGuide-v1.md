# Helix OpenTelemetry Configurator User Guide

## Introduction
The Helix Configurator is a local diagnostic tool designed to simplify the onboarding of OpenTelemetry data to BMC Helix. It provides a secure, web-based UI to manage your collector, validate configurations, and ensure your telemetry is successfully reaching the cloud.

## Phase 1: SaaS Configuration & Download
1. Log into your BMC Helix AIOps portal.
2. Navigate to the Manage OpenTelemetry page.
3. Select your hosting environment (e.g., Linux/Docker, Windows VM, Local Desktop).
4. Enter your Business Service name (this acts as your application source).
5. Click Download Configurator. An archive containing your pre-configured settings will be saved to your machine.

## Phase 2: Host Deployment
1. Transfer the downloaded archive to the system where your application runs.
2. Extract the archive contents into a new directory.
3. Open a terminal or command prompt in that directory.
4. Launch the environment by running: `docker-compose up -d`
5. Check the access instructions by viewing the logs: `docker logs helix-configurator`

## Phase 3: Secure Dashboard Access
* Local Access: If you are running the Configurator on your local machine, open your web browser and navigate to `http://localhost:3000`.
* Remote Access (SSH Tunnel): If you deployed the Configurator on a remote headless server, create a secure tunnel. Open a terminal on your local workstation and run: `ssh -L 3000:localhost:3000 <your-username>@<server-ip>`. Then, navigate to `http://localhost:3000` in your local browser.

## Phase 4: Diagnostics and Validation
1. Review Diagnostic Scan: The Configurator dashboard will automatically validate your configuration syntax, API key format, and network connectivity.
2. Review Logs: The Collector Troubleshooting Logs panel displays real-time output. If errors occur, expand the diagnostic cards for actionable inline fixes.
3. Edit Configuration: Use the Observability Pipeline Config editor to make necessary changes to your YAML.
4. Apply Changes: Click the Restart button in the Core Infrastructure panel to automatically apply your changes to the OpenTelemetry Collector.

## Phase 5: Finalization and Cleanup
1. Confirm Data Export: Check the Active Pipelines status in the Configurator, or look for the "Waiting for Valid Data" success indicator in your BMC Helix Portal tab.
2. Access Deep Links: Use the View AIOps Business Service button or the Discovered Services panel to jump directly to your visual topology in Helix.
3. Close the Session: Once verified, close your SSH tunnel. The OpenTelemetry Collector will continue running in the background, securely exporting data.
