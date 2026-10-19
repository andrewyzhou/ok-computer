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
mkdir -p run/data
```

Do not make `run/workspace` yourself. On the first start the container copies the workspace template there only when the folder is missing, and it makes `run/skills` too.

Put an `okc.config.json` in `run/` with the file backend:

```json
{
  "secrets": { "backend": "file", "path": "data/secrets.json" }
}
```

The app writes `run/data/secrets.json` with mode 0600. Git ignores `run/`, and the build leaves it out of the build context, so neither the repo nor an image gets its secrets. Do not put the secret file in `workspace` or `skills`; the config refuses that, because the agent can read those folders.

The file backend refuses a secret file that other users can read. On Windows, and with some file sharing setups of Docker Desktop on macOS, a bind-mounted folder shows every file as mode 0777 or 0755, and `chmod` has no effect there. Then each read of the secrets fails with `can be read by other users`. In that case keep `run/data` on a named volume (`-v okc-data:/okc/data` in place of the second `-v` below) or inside the WSL file system, or use the `aws` backend. On a native Windows desktop the file backend makes no mode check and sets no access list, so it gives no protection there; use the default `keyring` backend on a desktop.

On Linux, the container user must own the folder, its `data` folder and `okc.config.json` before the first start: `sudo chown -R 10001:10001 run`. Otherwise Docker makes the missing folders as root and the app cannot write them. Docker Desktop on macOS and Windows does not need this.

## 3. Run it

**With compose** (the same file as on a server, with the Tailscale sidecar):

```sh
docker compose -f deploy/compose.yaml --env-file deploy/.env up -d --build
```

Copy `deploy/env.example` to `deploy/.env` first and set `OKC_RUN` to the full path of `run/`. The dashboard is then at `https://<name>.<tailnet>.ts.net` from your tailnet. The services are `tailscale`, `restore`, `app` and `litestream`; `restore` and `litestream` need a bucket, so for a quick local try the plain run below is simpler.

**With a plain `docker run`:**

```sh
docker run -i --init --shm-size=1g --name okc-local --env-file run/.env \
  -v $PWD/run:/okc -v $PWD/run/data:/okc/data okc:local
```

`--shm-size=1g` gives Chrome the shared memory it needs. With the default of 64 MB, the browser tools crash or fail on heavy pages (compose sets `shm_size: 1gb`).

Keep `-i`. Without Telegram the app starts a CLI channel, and that channel stops the app when stdin ends. `--init` gives the container an init process, because the image has none (compose sets `init: true`). The second `-v` is needed, because the `VOLUME` of the image would otherwise put an empty volume over `run/data`.

`run/.env` holds `ANTHROPIC_API_KEY` (or `CLAUDE_API_KEY`) and `DASHBOARD_TOKEN`. Leave out `TELEGRAM_BOT_TOKEN` and `TELEGRAM_OWNER_ID` while another host is the live Telegram host (see [aws.md](aws.md), section 10).

## 4. Reach the dashboard

The dashboard listens on `127.0.0.1:4317` inside the container, so a plain `docker run` cannot reach it from outside, and publishing the port with `-p` does not help. Do not publish the port. Use one of these:

- On Linux, add `--network host` to the `docker run` command. The dashboard is then at `http://127.0.0.1:4317` on the machine itself.
- Use the compose file with its Tailscale sidecar.
- Ask from inside the container:

```sh
docker exec okc-local node -e "fetch('http://127.0.0.1:4317/api/secrets',{headers:{authorization:'Bearer '+process.env.DASHBOARD_TOKEN}}).then(r=>r.text()).then(console.log)"
```

It prints `"backend":"file"` and `"ok":true` when the secret file works.

## 5. Stop

`Ctrl+C`, or `docker stop okc-local`. With compose: `docker compose -f deploy/compose.yaml --env-file deploy/.env down`. The run folder keeps everything.
