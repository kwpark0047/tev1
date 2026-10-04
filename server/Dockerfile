# TEV1 Server - Production Dockerfile
# Multi-stage build for minimal production image

# Stage 1: Builder
FROM node:22-alpine AS builder

WORKDIR /app

# Install build dependencies
RUN apk add --no-cache python3 make g++

# Copy package files
COPY package*.json ./

# Install all dependencies (including dev)
RUN npm ci

# Copy source code
COPY src/ ./src/

# Stage 2: Production
FROM node:22-alpine AS production

# Install runtime dependencies
RUN apk add --no-cache dumb-init tini

WORKDIR /app

# Create non-root user
RUN addgroup -g 1000 -S tev1 && \
    adduser -u 1000 -S tev1 -G tev1

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production && npm cache clean --force

# Copy built source from builder
COPY --from=builder /app/src ./src

# Create directories for logs and cache
RUN mkdir -p logs cache && chown -R tev1:tev1 /app

# Switch to non-root user
USER tev1

# Expose port
EXPOSE 8081

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8081/health || exit 1

# Use tini for proper signal handling
ENTRYPOINT ["/sbin/tini", "--"]

# Start server
CMD ["node", "src/server.js"]