# Run ok computer in Docker on your own machine

Use this to try the image before a server deploy. For a server, see [aws.md](aws.md).

The image runs as uid 10001. The run folder is `/okc` in the container, and `/okc/data` is a volume. A container has no keyring, so use the file secret backend.

## 1. Build the image

In the project folder:

```sh
docker build -t okc:local .
```

The image works on linux/amd64 and linux/arm64. On amd64 it has Chrome. On arm64 there is no Chrome build, so the image puts Debian's Chromium behind the path of Chrome, and the browser tools work the same way.

## 2. Make a run folder

```sh
mkdir -p run/data run/workspace run/skills
```

Put an `okc.config.json` in `run/` with the file backend:

```json
{
  "secrets": { "backend": "file", "path": "data/secrets.json" }
}
```

The app writes `run/data/secrets.json` with mode 0600. Do not commit `run/`.

On Linux, the container user must own the folder: `sudo chown -R 10001:10001 run`. Docker Desktop on macOS and Windows does not need this.

## 3. Run it

**With compose** (the same file as on a server, with the Tailscale sidecar):

```sh
docker compose -f deploy/compose.yaml --env-file deploy/.env up -d --build
```

Copy `deploy/env.example` to `deploy/.env` first and set `OKC_RUN` to the full path of `run/`. The dashboard is then at `https://<name>.<tailnet>.ts.net` from your tailnet. The services are `tailscale`, `restore`, `app` and `litestream`; `restore` and `litestream` need a bucket, so for a quick local try the plain run below is simpler.

**With a plain `docker run`:**

```sh
docker run -it --name okc-local --env-file run/.env \
  -v $PWD/run:/okc -v $PWD/run/data:/okc/data okc:local
```

`run/.env` holds `ANTHROPIC_API_KEY` and `DASHBOARD_TOKEN`. Leave out `TELEGRAM_BOT_TOKEN` and `TELEGRAM_OWNER_ID` while another host is the live Telegram host (see [aws.md](aws.md), section 10).

## 4. Reach the dashboard

The dashboard listens on `127.0.0.1:4317` inside the container, so a plain `docker run` cannot reach it from outside. Do not publish the port. Either use the compose file with its Tailscale sidecar, or ask from inside the container:

```sh
docker exec okc-local node -e "fetch('http://127.0.0.1:4317/api/secrets',{headers:{authorization:'Bearer '+process.env.DASHBOARD_TOKEN}}).then(r=>r.text()).then(console.log)"
```

It prints `"backend":"file"` and `"ok":true` when the secret file works.

## 5. Stop

`Ctrl+C`, or `docker stop okc-local`. With compose: `docker compose -f deploy/compose.yaml --env-file deploy/.env down`. The run folder keeps everything.
