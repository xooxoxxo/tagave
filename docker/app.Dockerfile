# Build stage
FROM node:24-alpine AS builder

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm@10.30.1

# Copy workspace files
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages ./packages

# Install dependencies
RUN pnpm install --frozen-lockfile

# Build all packages
RUN pnpm -r build

# Runtime stage
FROM node:24-slim

WORKDIR /app

# Install pnpm in runtime
RUN npm install -g pnpm@10.30.1

# pnpm's per-package node_modules symlink farms make selective copies
# fragile; ship the whole built workspace.
COPY --from=builder /app ./

# Build identity (XO-313): deploy.sh passes the commit; readBuildInfo() reads it.
ARG GIT_SHA=unknown
ARG BUILT_AT=unknown
ARG LINER_VERSION=0.1.0
ENV LINER_GIT_SHA=$GIT_SHA \
    LINER_BUILT_AT=$BUILT_AT \
    LINER_VERSION=$LINER_VERSION

EXPOSE 3000

CMD ["node", "packages/api/dist/index.js"]
