# The code sandbox (Docker)

The `sandbox_exec` tool lets the agent run short programs in bash, Python or Node, for example to read a CSV file, do a calculation or draw a chart. Each call runs in a new Docker container that has no network, strict limits and no access to your files. The tool is optional: without Docker, the tool is off and the rest of the app runs normally. Takes about 15 minutes, most of it for the image build.

## 1. Install Docker

- **macOS and Windows:** install Docker Desktop and start it once. On Windows, Docker Desktop runs through WSL2.
- **Linux:** install the Docker engine from the packages of your distribution or of Docker. Add your user to the `docker` group, or set `DOCKER_HOST` to a socket that your user can open (section 4).

The sandbox needs Docker 25 or later (engine API v1.44). Check with:

```
docker version
```

## 2. Build the image

In the project folder:

```
npm run sandbox:image
```

This builds `okc-sandbox:1` from [sandbox/Dockerfile](../../sandbox/Dockerfile). The image has Node 24, Python 3 with numpy, pandas, matplotlib and scipy, and the tools `jq`, `sqlite3`, csvkit, `bc`, `file` and `unzip`. The user in the image is `sandbox` (uid and gid 1000), and its home is `/work`. Build it again only when the Dockerfile changes; a new image definition always gets a new tag.

Then restart the app: `okc restart`. The app checks Docker only at the start (section 5).

## 3. Check that it works

Open the dashboard and read `GET /api/sandbox`, for example at `http://127.0.0.1:4317/api/sandbox`. The `status` part of the answer tells you if the tool is on:

```json
{ "status": { "available": true, "reason": null, "engine": "docker 28.3.0 (linux/arm64)", "image": "okc-sandbox:1", "network": true, "networkReason": null } }
```

When developer mode is on the dashboard, the page **Dev > Sandbox** shows the same status and each exec with its output and files.

To check the image by hand, with the same settings that the app uses:

```
docker run --rm --read-only --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges --network none --tmpfs /tmp:rw,noexec,nosuid,size=64m -v okc-test-work:/work okc-sandbox:1 bash -c 'id -u; python3 -c "import numpy, pandas, matplotlib; print(1)"; node -e "console.log(process.version)"; jq --version; sqlite3 --version; find / -xdev -perm /6000 -type f'
docker volume rm okc-test-work
```

It prints `1000`, `1`, the Node version, the `jq` and `sqlite3` versions, and no file names after them (no file has a setuid or setgid bit).

### What the reason means

When `available` is false, `reason` says why. The tool is then off until the cause is gone and the app restarts.

| Reason starts with | Why | Fix |
|---|---|---|
| `the code sandbox did not start` | The app found no Docker socket, or `DOCKER_HOST` has a form that the app does not support (for example an address that needs TLS) | Install and start Docker (section 1), or correct `DOCKER_HOST` (section 4) |
| `docker does not answer` | The socket is there, but Docker does not reply within 3 seconds. Docker Desktop is not running, the engine is stopped, your user cannot open the socket, or the engine is older than Docker 25 | Start Docker Desktop or the engine. On Linux, check the `docker` group. Update an old engine |
| `the image okc-sandbox:1 is missing` | Docker runs, but the image is not built | `npm run sandbox:image` |
| `the code sandbox is not set up in this process` | This process does not use the sandbox, for example a test | Nothing |

`network` is false and `networkReason` says why when the network mode (section 7) cannot work on this Docker host. Calls without network access still work.

## 4. How the app finds Docker

The app talks to the Docker engine API through its socket. It does not use the `docker` command. It looks in this order and uses the first one that it finds:

1. `DOCKER_HOST`, as `unix:///path/to/docker.sock` or `tcp://host:port`. Put it in `.env` if your Docker is not in a usual place, for example rootless Docker on Linux: `DOCKER_HOST=unix:///run/user/1000/docker.sock`.
2. On macOS, the socket of Docker Desktop: `~/.docker/run/docker.sock`.
3. `/var/run/docker.sock`.
4. On Windows, the pipe `//./pipe/docker_engine`.

TLS is not supported. A `tcp://` address must be a plain connection to a host that only you can reach. The app does not read Docker contexts, so `docker context use` has no effect on it.

## 5. The limits

Each call gets a fresh container with these settings. They are fixed in `src/sandbox/limits.ts`, not in `okc.config.json`.

| Setting | Value |
|---|---|
| User | `1000:1000`, never root |
| Capabilities | all dropped, and `no-new-privileges` |
| Root filesystem | read only |
| `/tmp` | 64 MB in memory, programs cannot run from it |
| Network | none, unless the call asks for the network mode (section 7) |
| CPU | 1 CPU; a call can ask for up to 2 |
| Memory | 512 MB with no swap; a call can ask for up to 2,048 MB |
| Processes | 128 |
| Time | 60 seconds; a call can ask for up to 5 minutes. Then the container is killed |
| Output | 1 MB each for stdout and stderr. The rest is counted but not kept |
| Code | 100,000 bytes for each call. Put a longer program in a file |
| Files | 20 files in and 20 out, 10 MB each, 20 MB for each call |
| Calls at the same time | 2. A third call gets an error at once |

Docker is checked at the start only, so the list of tools stays the same while the app runs. If you start Docker or build the image after the app started, run `okc restart`.

## 6. The scratch folder `/work`

`/work` is a Docker volume, not a folder on your PC. All calls of one task share it, so a call can use the files of an earlier call. A task is the conversation from one `/new` to the next, so `/new` gives a fresh `/work`.

- A volume that no call used for a day is removed.
- A volume over 256 MB after a call is removed, and the result of that call tells the agent that `/work` is empty again.

Files go in and out through the blob store of the app. The agent gives the files of a call as text or as the blob of an earlier result. After the code ends, only the paths that the call names in `collect` come back, each as a blob. A text file is redacted like every other text in the trace; other files are kept as they are. Python packages that `pip install` adds go into `/work/.local`, so they stay for the task.

## 7. The network mode

A call can ask for network access to a short list of hosts, for example `pypi.org` and `files.pythonhosted.org`. Then:

- You approve each such call with a button, as for every action that leaves the PC. The card shows the code and the hosts.
- The container reaches the internet only through the egress proxy of the app, and only the hosts of the list (and their subdomains). A direct connection to any address fails. The proxy also refuses addresses on your own machine and your local network.
- A host that is too broad, for example `com` or `co.uk`, is refused before the call runs.
- What the call reads from the network is outside text, so the session is tainted (see the reviewer in the README).

## 8. What the agent can do

| Tool | Risk | What happens |
|---|---|---|
| `sandbox_exec` | exec | The reviewer model checks the code first. When the reviewer fails, you approve the call. |
| `sandbox_exec` with `network.allow` | external | You approve each call. |

The tool is in the main session and in automation runs. The dashboard keeps each exec: the code, the image, the limits, the exit code, the full output, the files, the time and the reviewer decision.

## 9. Clean up

Every container, volume and network of the sandbox has the label `okc.sandbox=1`. The app removes its own objects at the start and after each call. To see them, or to remove them by hand while the app is stopped:

```
docker ps -a --filter label=okc.sandbox
docker volume ls --filter label=okc.sandbox
docker network ls --filter label=okc.sandbox
docker rm -f $(docker ps -aq --filter label=okc.sandbox)
docker volume rm $(docker volume ls -q --filter label=okc.sandbox)
docker network rm $(docker network ls -q --filter label=okc.sandbox)
```

To remove the image: `docker image rm okc-sandbox:1`. The tool is then off after the next start.

## If something is wrong

| You see | Why | Fix |
|---|---|---|
| The agent says that it cannot run code | The tool is off | Read the reason in `GET /api/sandbox` (section 3), fix it, then `okc restart` |
| A call ends with `timeout` | The code ran longer than its time limit | Ask for a shorter task, or for a longer limit (up to 5 minutes) |
| A call ends with `failed` and says that the memory ran out | The code used more memory than its limit | Ask for more memory (up to 2,048 MB), or use less data at a time |
| `/work` is empty in a later call | `/new` started a new task, the volume was idle for a day, or it grew over 256 MB | Give the files again |
| A call with network access fails with a reason about the network | The network mode cannot work on this Docker host | Read `networkReason` in `GET /api/sandbox`. Calls without network access still work |
