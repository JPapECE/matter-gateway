# Multi-stage build for TypeScript matter-gateway
FROM node:20-bullseye-slim AS builder
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN apt-get update && apt-get install -y python3 make g++ libudev-dev libbluetooth-dev && rm -rf /var/lib/apt/lists/*
RUN npm ci
COPY src ./src
RUN npm run build

# Production runtime stage
FROM node:20-bullseye-slim
WORKDIR /app

# Install native compilation dependencies for production package installs
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    libudev-dev \
    libbluetooth-dev \
    bluez \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist

# Create storage directory for volumes
RUN mkdir -p /app/matter-storage

ENV DB_PATH=/app/database.sqlite
ENV MATTER_STORAGE_PATH=/app/matter-storage

CMD ["node", "dist/index.js"]
