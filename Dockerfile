# Build stage for Frontend
FROM node:20-slim AS frontend-build
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build

# Final stage
FROM node:20-slim
WORKDIR /app
COPY backend/package*.json ./backend/
RUN apt-get update && apt-get install -y python3 make g++ && \
    cd backend && npm install && \
    apt-get purge -y python3 make g++ && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
COPY backend/ ./backend/
COPY templates/ ./templates/
COPY --from=frontend-build /app/frontend/dist ./frontend-dist

# Copy root .env and config if needed (though they are mounted in compose)
# COPY .env .
# COPY otel-collector-config.yaml .

EXPOSE 3001
CMD ["node", "backend/index.js"]
