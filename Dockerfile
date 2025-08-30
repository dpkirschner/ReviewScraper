# Multi-stage build for production
FROM node:22-alpine AS base
RUN corepack enable pnpm
WORKDIR /app

# Install dependencies
FROM base AS deps
COPY package.json pnpm-lock.yaml* ./
COPY src/*/package.json ./src/*/
RUN pnpm install --frozen-lockfile

# Build stage
FROM base AS build
COPY . .
COPY --from=deps /app/node_modules ./node_modules
RUN pnpm build

# Production stage
FROM node:22-alpine AS production
RUN corepack enable pnpm
WORKDIR /app

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nodejs

COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules

USER nodejs

EXPOSE 3000

CMD ["node", "dist/index.js"]