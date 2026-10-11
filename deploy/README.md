# Deploying the portfolio

Every push to `main` runs `.github/workflows/deploy.yml`:

1. **check** — `pnpm build` (type check incl. the wire-safety checks + Vite build)
2. **build** — Docker image (`Dockerfile`: Vite build → Caddy, non-root), pushed
   to `ghcr.io/thijmenbrand/portfolio-v4`, pinned by digest
3. **deploy** — SSH to the server as `deploy`, with a key that can only run
   `/usr/local/bin/deploy-portfolio deploy <image@digest>`

The script starts the new image, waits for its healthcheck and keeps the last
good one; an unhealthy image is rolled back automatically.

```
deploy/
├── web/Caddyfile               Caddy inside the container (CSP, CORS on /assets/, caching)
├── docker-compose.yml          → /srv/portfolio/docker-compose.yml on the server
├── caddy/portfolio.caddy       site block for the host's Caddy (reference copy)
└── server/
    └── deploy-portfolio        → /usr/local/bin/deploy-portfolio (the key's forced command)
```

## One-time server setup

Uses the same `deploy` user as FinTrack, with a **separate key**: each key can
only deploy its own app.

```sh
# 1. On your machine: a key just for this repo
ssh-keygen -t ed25519 -N "" -C portfolio-deploy -f portfolio-deploy

# 2. On the server (as your admin user), from a checkout of this repo
sudo install -d -o deploy -g deploy -m 755 /srv/portfolio
sudo install -o deploy -g deploy -m 644 deploy/docker-compose.yml /srv/portfolio/
sudo install -m 755 deploy/server/deploy-portfolio /usr/local/bin/deploy-portfolio

# 3. Allow the key — restricted to that one command (one line, in ~deploy/.ssh/authorized_keys)
restrict,command="/usr/local/bin/deploy-portfolio" ssh-ed25519 AAAA…(portfolio-deploy.pub)… portfolio-deploy
```

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
running — check `deploy-portfolio status`.

If the GitHub package is private, the `deploy` user needs to be logged in to
ghcr.io (`docker login ghcr.io` with a token that has `read:packages`) — or
make the package public under the repo's *Packages* settings; it only contains
the built static site.

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
sudo -u deploy deploy-portfolio status
sudo -u deploy deploy-portfolio rollback
```

## Checking a deploy

```sh
curl -sI https://thijmenbrand.nl/ | grep -iE 'HTTP/|strict-transport|content-security'
# → HTTP/2 200, plus the HSTS (host Caddy) and CSP (container Caddy) headers

curl -sI -H "Origin: null" https://thijmenbrand.nl/assets/<any>.js | grep -i access-control
# → Access-Control-Allow-Origin: *   (without it, no app or worker program can start)
```
