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
server/                         the API (Node, stdlib + otpauth, run as .ts): owner login, /api/private/*
├── main.ts                     routes, CSRF + body limit, login rate limit
├── auth.ts                     password check, signed session cookie
├── fsstore.ts                  the cloud filesystem: the tree in SQLite, the bytes in a documents directory
├── hash.ts                     password on stdin → OWNER_PASSWORD_HASH
├── totp.ts                     authenticator codes; CLI → OWNER_TOTP_SECRET + otpauth:// URI
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

### Keeping the server half in sync

Two files live on the server and are installed **by hand** (steps 2 above):
`/srv/portfolio/docker-compose.yml` and `/usr/local/sbin/portfolio-deploy`. CI
only builds the image and asks the server to deploy it — it never writes those
files, and deliberately so: the compose file is run by root, and `docker compose`
can mount anything and run privileged containers, so a deploy key that could
write it would be root-equivalent. That is the same reason `deploy` is not in
the `docker` group.

The cost of that split is drift. A commit that changes the image *and* those
files leaves the server a version behind until someone remembers, and the new
image then fails for a reason nothing says out loud — cloud sync added the
`/data` volume, the installed compose file had none, and the api spent 60s
failing its healthcheck on an unwritable database before rolling back.

So every image carries the copies it was built with at `/app/deploy/`, and
`portfolio-deploy deploy` compares them against what is installed **before** it
touches the running deployment. On a mismatch it prints a diff, exits 3 and
changes nothing:

```
[portfolio-deploy] stale server config: /srv/portfolio/docker-compose.yml differs from the copy in ghcr.io/…
[portfolio-deploy]   @@ -33,7 +33,14 @@
[portfolio-deploy]   +      CLOUD_DB: /data/cloud.db
[portfolio-deploy]   +    volumes:
[portfolio-deploy]   +      - cloud-data:/data
[portfolio-deploy] install both files from a checkout of the deployed commit (deploy/README.md), then deploy again
```

To clear it, install both files from a checkout of the commit being deployed
(`git checkout <sha>`, then the two `install` lines from step 2) and re-run the
deploy — from GitHub, Actions → deploy → *Run workflow*, so it deploys the new
digest rather than the one you rolled back to.

`sudo portfolio-deploy status` runs the same comparison and reports it without
failing, so you can check for drift without waiting for a deploy. `rollback`
skips it on purpose: the previous image expects the previous config, and a
rollback has to work even when the server half is mid-update.

The check can only catch drift once a *checking* script is installed, and only
against images built after `/app/deploy/` shipped — older images are reported
as unverifiable and deploy as before.

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
$(node server/totp.ts thijmen | tee /dev/stderr | head -1)
PUBLIC_ORIGIN=https://thijmenbrand.nl
SIMPLELOGIN_API_KEY=<key from SimpleLogin → Settings → API Keys>
EOF
```

The `otpauth://` line printed above goes into your authenticator app (type the
secret, or scan `qrencode -t ansiutf8 '<uri>'`); after that, the owner login
asks for its 6-digit code. Lost the phone: put a new `node server/totp.ts`
secret in `api.env` and recreate the api. Without `OWNER_TOTP_SECRET` the API
logs a warning and logs in with the password alone.

`NODE_ENV`, `PORT`, `CLOUD_DB` and `CLOUD_DOCS` come from `docker-compose.yml`.
`CLOUD_QUOTA_MB` (optional, default 1024) sets how much cloud storage may hold in
total; it lives in `api.env` rather than the compose file so changing it isn't
config drift. After changing the
file (a new password, TOTP secret or `SESSION_SECRET` signs out every session), recreate
the api with `sudo portfolio-deploy deploy "$(cat /srv/portfolio/current)"`.

### Cloud storage (`/mnt/cloud`)

The owner's synced files live in two places, which belong together:

- **the database**: one SQLite file on the `portfolio_cloud-data` volume, at
  `/data/cloud.db` inside the api container. It holds the whole tree (paths,
  versions, sizes) and, for each file, a reference to its bytes; never the bytes;
- **the documents directory**: `/srv/portfolio/documents` on the host, `/docs` in
  the container. Every file's bytes, from the apps' JSON state to a PDF, are one
  file here, named by a random id that its database row holds. Paths and names are
  only in the database, so the directory on its own is a heap of ids.

**These are the only server-side state that isn't an environment variable, so they
are the only things that need backing up — together.** Everything else can be
rebuilt from the repo and `api.env`.

The deploy script creates both and chowns them to the container's user on every
deploy; the container can't do that itself (it runs as 65532 with `cap_drop: ALL`),
and without it SQLite can't open the file and the api refuses to start.

```sh
# Back up (consistent while the api is running: SQLite's own .backup, via WAL)
docker run --rm -v portfolio_cloud-data:/data -v "$PWD:/out" \
  ghcr.io/thijmenbrand/portfolio-v4@"$(cut -d@ -f2 /srv/portfolio/current)" \
  node -e 'const{DatabaseSync}=require("node:sqlite");new DatabaseSync("/data/cloud.db",{readOnly:true}).exec("VACUUM INTO \'/out/cloud-backup.db\'")'
# ...then the documents. A file written or deleted between the two steps can be
# missing from the copy; stop the api first for an exact pair.
sudo tar -C /srv/portfolio -czf documents-backup.tgz documents

# Restore: stop the api, copy the file back, start it again
sudo portfolio-deploy status           # note the current image
docker compose --project-name portfolio -f /srv/portfolio/docker-compose.yml stop api
docker run --rm -v portfolio_cloud-data:/data -v "$PWD:/in" --user 0:0 --entrypoint sh \
  "$(cat /srv/portfolio/current)" -c 'cp /in/cloud-backup.db /data/cloud.db && rm -f /data/cloud.db-wal /data/cloud.db-shm && chown 65532:65532 /data/cloud.db'
sudo rm -rf /srv/portfolio/documents && sudo tar -C /srv/portfolio -xzf documents-backup.tgz
sudo portfolio-deploy deploy "$(cat /srv/portfolio/current)"
```

Limits (`server/fsstore.ts`): 20 MiB per file (what the apps let you upload),
`CLOUD_QUOTA_MB` in total (1 GiB unless `api.env` says otherwise), 5000 entries.
Past any of them the OS says the file is too large or there's no space left
rather than failing quietly. An upload is never held whole in memory: it is written
to the documents directory as it arrives, and read back as a stream.

A crash in the middle of an upload can leave a file in the documents directory
that no row points at. Nothing reads it and it doesn't count toward the quota; the
api never deletes unreferenced files by itself, so a database restored from an
older backup can't cost you the newer documents.

Databases from before the documents directory kept every file's bytes in its row.
On startup the api moves any such bytes out to the documents directory and
`VACUUM`s the database, logging `cloud: moved N files ...`; it does this once.
Back up before the first deploy that does it.

Rolling back to an image from before the documents directory existed shows every
cloud file as empty (their rows have no bytes in them), and the apps may save that
empty state. The bytes are intact in `/srv/portfolio/documents`, and whatever the
old image wrote meanwhile wins at the next deploy, empty saves included, so roll
back past it only from a backup.

Node may print an `ExperimentalWarning` for `node:sqlite` on Node 24. That is the
module's status, not a fault.

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
sudo portfolio-deploy status      # current image, config drift, container state
sudo portfolio-deploy rollback
```

Exit codes from `deploy`: 2 = the image isn't one of this repo's digests,
3 = the server half is stale (nothing was changed), 1 = the new image came up
unhealthy and was rolled back.

## Checking a deploy

```sh
curl -sI https://thijmenbrand.nl/ | grep -iE 'HTTP/|strict-transport|content-security'
# → HTTP/2 200, plus the HSTS (host Caddy) and CSP (container Caddy) headers

curl -sI -H "Origin: null" https://thijmenbrand.nl/assets/<any>.js | grep -i access-control
# → Access-Control-Allow-Origin: *   (without it, no app or worker program can start)
```
