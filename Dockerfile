# syntax=docker/dockerfile:1
# Portfolio OS: a static Vite build, served by Caddy as a non-root user, plus the
# API (server/) run by Node from the same image. One image, two services
# (deploy/docker-compose.yml): web runs the CMD below, api runs `node /app/server/main.ts`.
ARG NODE_VERSION=24

# --- build ----------------------------------------------------------------------
FROM node:${NODE_VERSION}-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable pnpm
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
COPY . .
# `pnpm build` = tsc (type check, including the wire-safety checks, and server/) + vite build.
RUN pnpm build
# The API's one dependency. pnpm's node_modules/otpauth is a symlink, so copy it
# dereferenced; its Node build imports only node:crypto.
RUN cp -rL node_modules/otpauth /otpauth

# --- caddy binary ---------------------------------------------------------------
# The official image sets the cap_net_bind_service file capability on the binary
# (to bind :80 as non-root). We listen on 8080 and run with all capabilities
# dropped, where a binary that asks for a capability can fail to exec at all.
# A plain `cp` doesn't copy extended attributes, so this copy has none.
FROM caddy:2-alpine AS caddy
RUN cp /usr/bin/caddy /caddy

# --- runtime --------------------------------------------------------------------
# Caddy as an unprivileged user, listening on 8080. Config and site files stay
# root-owned: the server can read them but never modify them.
# Node base for the API: it runs the .ts sources directly (type stripping) and
# uses the stdlib plus otpauth, so no build output and one package in node_modules.
FROM node:${NODE_VERSION}-alpine AS runner
COPY --from=caddy /caddy /usr/bin/caddy
COPY deploy/web/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist /srv
# package.json for "type": "module"; hash.ts is also the CLI for OWNER_PASSWORD_HASH.
COPY package.json /app/
COPY server/*.ts /app/server/
COPY --from=build /otpauth /app/node_modules/otpauth
# The root filesystem is read-only at runtime; Caddy's (unused) state goes to /tmp.
ENV XDG_CONFIG_HOME=/tmp/caddy-config XDG_DATA_HOME=/tmp/caddy-data
USER 65532:65532
EXPOSE 8080
# Web's healthcheck; the api service overrides it in deploy/docker-compose.yml.
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/healthz"]
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
