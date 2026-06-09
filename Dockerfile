# Build stage for Frontend
FROM node:22-slim AS frontend-build
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build

# Final stage
FROM node:22-slim
WORKDIR /app
COPY backend/package*.json ./backend/
RUN apt-get update && apt-get install -y python3 make g++ && \
    cd backend && npm install && \
    apt-get purge -y python3 make g++ && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
COPY backend/ ./backend/
COPY templates/ ./templates/
# The Helm chart skeletons the "Generate K8s chart" feature streams at runtime.
# Without these the backend can't build the chart (and historically crashed at
# startup listing it). They are NOT bind-mounted by docker-compose, so they must
# be baked into the image. BOTH engines ship: helix-otel (Deployment) AND
# helix-otel-operator (OpenTelemetryCollector/Instrumentation CRs) — the
# operator dir was once missing here, so engine=operator downloads were hollow.
COPY helix-otel/ ./helix-otel/
COPY helix-otel-operator/ ./helix-otel-operator/
COPY --from=frontend-build /app/frontend/dist ./frontend-dist

# Copy root .env and config if needed (though they are mounted in compose)
# COPY .env .
# COPY otel-collector-config.yaml .

ENV PORT=3001
EXPOSE 3001
CMD ["node", "backend/index.js"]
