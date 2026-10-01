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

# pg_dump/pg_restore for the backup the app takes before it migrates, and for
# `liner-doctor backup`. They must match the server major (postgres:16):
# Debian bookworm ships client 15,
# and pg_dump refuses a newer server, so take 16 from the PGDG repository.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && install -d /usr/share/postgresql-common/pgdg \
    && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
         -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
    && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
         > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update && apt-get install -y --no-install-recommends postgresql-client-16 \
    && apt-get purge -y --auto-remove curl \
    && rm -rf /var/lib/apt/lists/*

# Install pnpm in runtime
RUN npm install -g pnpm@10.30.1

# pnpm's per-package node_modules symlink farms make selective copies
# fragile; ship the whole built workspace.
COPY --from=builder /app ./

# Build identity (XO-313): deploy.sh passes the commit; readBuildInfo() reads it.
ARG GIT_SHA=unknown
ARG BUILT_AT=unknown
# Empty unless CI or deploy.sh passes it: readBuildInfo() then reads the
# root package.json, so a plain build never reports a stale version.
ARG LINER_VERSION=
ENV LINER_GIT_SHA=$GIT_SHA \
    LINER_BUILT_AT=$BUILT_AT \
    LINER_VERSION=$LINER_VERSION

# Pre-migration backups (mount a volume or a host folder here). VOLUME gives
# an older compose.yml without a /backups mount a persistent anonymous volume
# instead of the container layer; the app refuses to back up into a folder
# that is not a mount (LINER_BACKUP_REQUIRE_MOUNT), since recreating the
# container would delete the dump.
RUN mkdir -p /backups
VOLUME /backups
ENV LINER_BACKUP_DIR=/backups \
    LINER_BACKUP_REQUIRE_MOUNT=1

EXPOSE 3000

CMD ["node", "packages/api/dist/index.js"]
