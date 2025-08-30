FROM node:22-alpine

RUN corepack enable pnpm
WORKDIR /app

# Copy workspace root files
COPY ../../package.json ../../pnpm-lock.yaml* ./

# Copy service-specific files
COPY package.json ./
COPY tsconfig.json ./
COPY src/ ./src/

# Copy shared dependencies
COPY ../shared/ ../shared/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Build the application
RUN pnpm build

# Create non-root user
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nodejs

# Change ownership and switch to non-root user
RUN chown -R nodejs:nodejs /app
USER nodejs

# Expose port (if needed for health checks)
EXPOSE 3001

# Start the application
CMD ["pnpm", "start"]