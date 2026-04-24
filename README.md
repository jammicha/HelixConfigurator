# Helix Configurator

The Helix Configurator is a local diagnostic and management tool designed to simplify the onboarding of OpenTelemetry data to BMC Helix. It provides a secure, web-based UI to manage your OpenTelemetry collector, validate configurations, and ensure your telemetry is successfully reaching the cloud.

## Prerequisites

Before you begin, ensure you have the following installed on your system:
* [Docker](https://docs.docker.com/get-docker/)
* [Docker Compose](https://docs.docker.com/compose/install/)

## Getting Started

Follow these steps to configure and run the application locally.

### 1. Configure Environment Variables

The application relies on environment variables to securely connect to your BMC Helix instance.

1. Open the `.env` file located in the root of this project directory (`dev/HelixConfigurator/.env`).
2. Update the variables with your specific Helix credentials:

   ```env
   HELIX_ENDPOINT=https://your-helix-instance.com/otlp/v1/traces
   HELIX_API_KEY=your-api-key-here
   X_SOURCE=enter-your-xsource-here
   ```

### 2. Start the Services

The application is fully containerized. Use Docker Compose to build and start the backend, frontend, and the OpenTelemetry Collector simultaneously.

1. Open a terminal and navigate to the project directory:
   ```bash
   cd dev/HelixConfigurator
   ```
2. Build and run the containers in detached mode:
   ```bash
   docker-compose up --build -d
   ```

### 3. Access the Application

Once the containers are running, the Helix Configurator UI will be available on your host machine.

* **Local Access:** Open your web browser and navigate to:
  [http://localhost:3000](http://localhost:3000)

* **Remote Access (SSH Tunnel):** If you deployed the Configurator on a remote headless server, you can create a secure tunnel. Run this on your local workstation:
  ```bash
  ssh -L 3000:localhost:3000 <your-username>@<server-ip>
  ```
  Then, navigate to `http://localhost:3000` in your local browser.

## Troubleshooting & Management

* **View Logs:** To view the logs for the Configurator application:
  ```bash
  docker logs helix-configurator
  ```
  To view the logs for the OpenTelemetry Collector:
  ```bash
  docker logs helix-otel-collector
  ```

* **Stop the Services:** When you are finished, you can gracefully stop and remove the containers by running:
  ```bash
  docker-compose down
  ```

## Development

If you wish to run the application components locally without Docker for development purposes:

### Backend
1. Navigate to the `backend` directory.
2. Install dependencies: `npm install`
3. Start the server (runs on port 3001): `npm run dev`

### Frontend
1. Navigate to the `frontend` directory.
2. Install dependencies: `npm install`
3. Start the Vite dev server (runs on port 3000): `npm run dev`
