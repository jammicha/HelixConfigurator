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
# The Helm chart skeleton the "Generate K8s chart" feature streams at runtime.
# Without this the backend can't build the chart (and historically crashed at
# startup listing it). It is NOT bind-mounted by docker-compose, so it must be
# baked into the image.
COPY helix-otel/ ./helix-otel/
COPY --from=frontend-build /app/frontend/dist ./frontend-dist

# Copy root .env and config if needed (though they are mounted in compose)
# COPY .env .
# COPY otel-collector-config.yaml .

ENV PORT=3001
EXPOSE 3001
CMD ["node", "backend/index.js"]
