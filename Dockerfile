# syntax=docker/dockerfile:1
# Portfolio OS: a static Vite build, served by Caddy as a non-root user.
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
# `pnpm build` = tsc (type check, including the wire-safety checks) + vite build.
RUN pnpm build

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
FROM alpine:3 AS runner
COPY --from=caddy /caddy /usr/bin/caddy
COPY deploy/web/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist /srv
# The root filesystem is read-only at runtime; Caddy's (unused) state goes to /tmp.
ENV XDG_CONFIG_HOME=/tmp/caddy-config XDG_DATA_HOME=/tmp/caddy-data
USER 65532:65532
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/healthz"]
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
