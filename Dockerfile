# MaterialIQ — SIH 2026 prototype image (TRD §18/§35: Docker-compatible deployment)
#
# Build:  docker build -t materialiq .
# Run:    docker run -p 3000:3000 -v materialiq-data:/app/data materialiq
#         → migrations + seed run automatically on first start; the SQLite
#           database lives in the mounted volume so demo data persists.
#
# Single-stage build: node:sqlite is built into the runtime, no native deps.

FROM node:24-alpine

WORKDIR /app

# Install dependencies first (better layer caching)
COPY package.json package-lock.json* ./
RUN npm ci || npm install

# Build the application
COPY . .
RUN npm run build

# Runtime configuration
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
EXPOSE 3000

# Data directory is a volume so materialiq.db survives container replacement
VOLUME ["/app/data"]

# Start: migrate → seed (both idempotent) → serve
CMD ["sh", "-c", "npm run db:migrate && npm run db:seed && npm start -- -p ${PORT}"]
