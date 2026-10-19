# the image of ok computer for linux/amd64 and linux/arm64. docs/setup/docker.md tells how to run it, and
# deploy/compose.yaml runs it on a server.

# the build stage runs on the arch of the builder. its output is plain javascript and static files, so a build for
# the other arch does not need an emulator for tsc and vite.
FROM --platform=$BUILDPLATFORM node:24.22.0-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
# only what the build reads. a copy of the whole context would put any file that .dockerignore misses into a layer
# of the build cache.
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY web ./web
RUN npm run build

FROM node:24.22.0-bookworm-slim
ARG TARGETARCH

# the browser worker launches playwright with channel 'chrome', which looks for /opt/google/chrome/chrome on linux.
# on amd64 that is google chrome from its signed apt repo. there is no linux build of google chrome for arm64, so on
# arm64 the image installs the debian chromium package and links /usr/bin/chromium to /opt/google/chrome/chrome.
# channel 'chrome' then starts chromium, and no code change is needed. the packages bring the libs that the browser
# needs, and the fonts give pages readable text and emoji.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl gnupg fonts-liberation fonts-dejavu-core fonts-noto-color-emoji; \
    case "$TARGETARCH" in \
      amd64) \
        install -d -m 0755 /etc/apt/keyrings; \
        curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /etc/apt/keyrings/google-chrome.gpg; \
        echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list; \
        apt-get update; \
        apt-get install -y --no-install-recommends google-chrome-stable; \
        ;; \
      arm64) \
        apt-get install -y --no-install-recommends chromium; \
        install -d -m 0755 /opt/google/chrome; \
        ln -s /usr/bin/chromium /opt/google/chrome/chrome; \
        ;; \
      *) echo "no browser for the arch $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    test -x /opt/google/chrome/chrome; \
    apt-get purge -y --auto-remove curl gnupg; \
    rm -rf /var/lib/apt/lists/*

# the code lives in /app and belongs to root, so the app cannot change it.
WORKDIR /app
COPY package.json package-lock.json ./
# the keyring package has prebuilt binaries for linux arm64 and x64 with glibc, so npm builds nothing here.
RUN npm ci --omit=dev && npm cache clean --force
# the dashboard serves web/dist next to dist, as the build puts it (see WEB_DIR in src/dashboard/server.ts).
COPY --from=build /src/dist ./dist
COPY --from=build /src/web/dist ./web/dist
# the entrypoint copies this template to /okc/workspace on the first start.
COPY workspace ./workspace
COPY --chmod=0755 deploy/entrypoint.sh ./deploy/entrypoint.sh

# the app runs as a fixed uid and gid, so the owner can give the run directory on the host to 10001:10001.
RUN groupadd --gid 10001 okc \
    && useradd --uid 10001 --gid 10001 --create-home --home-dir /home/okc --shell /usr/sbin/nologin okc \
    && install -d -o okc -g okc /okc /okc/data

# /okc is the run directory. the app finds okc.config.json, okc.policy.json, data/, workspace/ and skills/ there.
WORKDIR /okc
USER okc
VOLUME ["/okc/data"]

# compose gives the init process (init: true), so the image holds none.
ENTRYPOINT ["/app/deploy/entrypoint.sh"]
CMD ["node", "/app/dist/main.js"]
