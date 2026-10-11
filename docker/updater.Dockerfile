# tagave updater (opt-in, compose profile "updater"). A small image of its
# own rather than the app image: it needs the Docker CLI and the compose
# plugin, which the app image should not carry, and it needs nothing of the
# app (no web build, no pg_dump; backups and restores run inside the app
# container through `docker compose exec/run`).

# Build stage: compile packages/updater (no runtime dependencies).
FROM node:24-alpine AS builder

WORKDIR /app

RUN npm install -g pnpm@10.30.1

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages ./packages

RUN pnpm install --frozen-lockfile --filter @liner/updater...
RUN pnpm --filter @liner/updater... build

# Runtime: the official Docker CLI image (docker + compose plugin) plus Node.
FROM docker:29-cli

RUN apk add --no-cache nodejs

WORKDIR /opt/tagave/updater
COPY --from=builder /app/packages/updater/package.json ./package.json
COPY --from=builder /app/packages/updater/dist ./dist

# The compose files of this release: an update copies them into the install
# folder, as install-tagave.sh update does.
COPY deploy/compose.yml deploy/compose.db-published.yml /opt/tagave/deploy/

ARG GIT_SHA=unknown
ARG BUILT_AT=unknown
ARG LINER_VERSION=
ENV LINER_GIT_SHA=$GIT_SHA \
    LINER_BUILT_AT=$BUILT_AT \
    LINER_VERSION=$LINER_VERSION \
    NODE_ENV=production

ENTRYPOINT []
CMD ["node", "/opt/tagave/updater/dist/main.js"]
