#!/bin/sh
# the entrypoint of the image. it prepares the run directory /okc and then starts the command.
set -eu

run=/okc

if [ ! -f "$run/okc.config.json" ]; then
  echo "okc: $run/okc.config.json is missing. copy deploy/okc.config.example.json there and fill it in." >&2
  exit 1
fi

if [ ! -w "$run" ]; then
  echo "okc: $run is not writable by uid $(id -u). give the run directory on the host to 10001:10001." >&2
  exit 1
fi

# the workspace is a copy of the template on the first start. later starts keep the files that the owner changed.
if [ ! -d "$run/workspace" ]; then
  cp -R /app/workspace "$run/workspace"
fi

mkdir -p "$run/data" "$run/skills"

exec "$@"
