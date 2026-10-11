# Deploying the portfolio

Every push to `main` runs `.github/workflows/deploy.yml`:

1. **check** — `pnpm build` (type check incl. the wire-safety checks + Vite build)
2. **build** — Docker image (`Dockerfile`: Vite build → Caddy + the Node API, non-root), pushed
   to `ghcr.io/thijmenbrand/portfolio-v4`, pinned by digest
3. **deploy** — SSH to the server as `deploy`, with a key whose forced command
   only accepts `deploy <image@digest>`, `rollback` or `status`

The script starts the new image, waits for its healthcheck and keeps the last
good one; an unhealthy image is rolled back automatically.

```
server/                         the API (Node, stdlib only, run as .ts): owner login, /api/private/*
├── main.ts                     routes, CSRF + body limit, login rate limit
├── auth.ts                     password check, signed session cookie
├── hash.ts                     password on stdin → OWNER_PASSWORD_HASH
└── selftest.ts                 `node server/selftest.ts`
deploy/
├── web/Caddyfile               Caddy inside the container (CSP, CORS on /assets/, caching, /api/* → api)
├── docker-compose.yml          → /srv/portfolio/docker-compose.yml on the server
├── caddy/portfolio.caddy       site block for the host's Caddy (reference copy)
└── server/
    ├── portfolio-deploy-ssh    → /usr/local/bin/portfolio-deploy-ssh (the key's forced command, runs as deploy)
    └── portfolio-deploy        → /usr/local/sbin/portfolio-deploy (does the work, runs as root via sudo)
```

## One-time server setup

Uses the same `deploy` user as FinTrack, with a **separate key**: each key can
only deploy its own app. `deploy` is **not** in the `docker` group (that would
be root-equivalent); like FinTrack, the forced command validates the request and
calls one root-owned script through a single `sudo` rule.

```sh
# 1. On your machine: a key just for this repo
ssh-keygen -t ed25519 -N "" -C portfolio-deploy -f portfolio-deploy

# 2. On the server (as your admin user), from a checkout of this repo
#    Everything root-owned: the root script runs this compose file, so `deploy`
#    must not be able to edit it.
sudo install -d -o root -g root -m 755 /srv/portfolio
sudo install -o root -g root -m 644 deploy/docker-compose.yml /srv/portfolio/
sudo install -o root -g root -m 755 deploy/server/portfolio-deploy /usr/local/sbin/portfolio-deploy
sudo install -o root -g root -m 755 deploy/server/portfolio-deploy-ssh /usr/local/bin/portfolio-deploy-ssh

# 3. The API's secrets (see "API secrets" below) — before the first deploy, or
#    the api container can't start and the deploy rolls back
sudo install -o root -g root -m 600 api.env /srv/portfolio/api.env

# 4. Let deploy run (only) the root script
echo 'deploy ALL=(root) NOPASSWD: /usr/local/sbin/portfolio-deploy' |
  sudo tee /etc/sudoers.d/portfolio-deploy >/dev/null
sudo chmod 440 /etc/sudoers.d/portfolio-deploy && sudo visudo -c

# 5. Allow the key — restricted to the wrapper (one line, in ~deploy/.ssh/authorized_keys)
restrict,command="/usr/local/bin/portfolio-deploy-ssh" ssh-ed25519 AAAA…(portfolio-deploy.pub)… portfolio-deploy
```

### API secrets

`/srv/portfolio/api.env` (root:root, 600; compose reads it as root) holds the
owner login. Write it in your checkout, install it as in step 3, then delete
the local copy:

```sh
read -rs PW    # the owner password, not echoed and not in shell history
cat > api.env <<EOF
OWNER_USERNAME=thijmen
OWNER_PASSWORD_HASH=$(printf '%s' "$PW" | node server/hash.ts)
SESSION_SECRET=$(openssl rand -hex 32)
PUBLIC_ORIGIN=https://thijmenbrand.nl
SIMPLELOGIN_API_KEY=<key from SimpleLogin → Settings → API Keys>
EOF
```

`NODE_ENV` and `PORT` come from `docker-compose.yml`. After changing the file
(a new password or a new `SESSION_SECRET` signs out every session), recreate
the api with `sudo portfolio-deploy deploy "$(cat /srv/portfolio/current)"`.

### Reverse proxy + TLS

The host runs Caddy natively (apt package, systemd); it terminates TLS for every
app on the server and gets certificates on its own. The container only listens
on `127.0.0.1:8081`, so Caddy is the only way in.

The live config is `/etc/caddy/Caddyfile` **on the server** — that file is what
counts. `deploy/caddy/portfolio.caddy` is a reference copy of the portfolio's
block; it relies on the `(security_headers)` and `(proxy_defaults)` snippets
defined in the server's Caddyfile. When you change one, change the other.

```sh
# DNS for the domain must already point at the server, or the certificate request fails
dig +short thijmenbrand.nl

# Add the block from deploy/caddy/portfolio.caddy to /etc/caddy/Caddyfile, then
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
```

The CSP, CORS and cache headers come from the Caddy inside the container
(`deploy/web/Caddyfile`); the host's Caddy adds HSTS and compression. A 502 from Caddy means the container isn't
running — check `sudo portfolio-deploy status`.

If the GitHub package is private, **root** needs to be logged in to ghcr.io
(`sudo docker login ghcr.io` with a token that has `read:packages`), since the
pull runs in the root script — or
make the package public under the repo's *Packages* settings; it only contains
the built static site and the API's source (secrets live in `api.env`).

## GitHub settings (this repo)

| Name | Kind | Value |
|------|------|-------|
| `DEPLOY_HOST` | secret | server IP or hostname |
| `DEPLOY_SSH_KEY` | secret | contents of `portfolio-deploy` (the private key) |
| `DEPLOY_KNOWN_HOSTS` | secret | output of `ssh-keyscan -t ed25519 <host>` |

And an environment named `production` (Settings → Environments); add required
reviewers there if you want to approve each deploy by hand.

## By hand, on the server

```sh
sudo portfolio-deploy status
sudo portfolio-deploy rollback
```

## Checking a deploy

```sh
curl -sI https://thijmenbrand.nl/ | grep -iE 'HTTP/|strict-transport|content-security'
# → HTTP/2 200, plus the HSTS (host Caddy) and CSP (container Caddy) headers

curl -sI -H "Origin: null" https://thijmenbrand.nl/assets/<any>.js | grep -i access-control
# → Access-Control-Allow-Origin: *   (without it, no app or worker program can start)
```
