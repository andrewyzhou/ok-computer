# the default image of the code sandbox of ok computer. npm run sandbox:image builds it as okc-sandbox:1.
#
# when you change what this image holds, also change SANDBOX_IMAGE in src/sandbox/limits.ts (okc-sandbox:2, and so
# on) and the tag in the sandbox:image script of package.json. the new tag makes sure that an app never runs an old
# image by mistake.
#
# the base is pinned by digest, so each build starts from the same bytes. the debian packages are not pinned to versions,
# so a build on another day can hold other package versions. each exec keeps the image id that ran it, and
# docs/setup/sandbox.md says how to note the id of a build. the digest is the digest of the multi-arch
# index, so the same line works on amd64 and arm64. to update it:
#   1. run: docker buildx imagetools inspect node:24-trixie-slim
#   2. copy the first "Digest:" line (the index, not one platform) into the FROM line below.
#   3. build the image, run the check in docs/setup/sandbox.md, and change the tag as said above.
FROM node:24-trixie-slim@sha256:7f486cabe892bff8fef04c0f7da8dba84a560be3e4e2740b7a86afc57ebec315

LABEL okc.sandbox.image="1"

# the tools that a short data task needs. --no-install-recommends keeps the image small, and the package lists are
# removed in the same layer. pip is the debian package and is not upgraded.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bc \
      ca-certificates \
      csvkit \
      file \
      jq \
      python3 \
      python3-matplotlib \
      python3-numpy \
      python3-pandas \
      python3-pip \
      python3-scipy \
      sqlite3 \
      unzip \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

# the base image has the user node with uid and gid 1000. the sandbox renames it to sandbox, with the home /work, so
# that SANDBOX_USER (1000:1000) has a name and a home. the runner mounts the scratch volume of the task at /work.
RUN groupmod -n sandbox node \
 && usermod -l sandbox -d /work -s /bin/bash node \
 && mkdir -p /work /opt/okc \
 && chown 1000:1000 /work

# no file keeps a setuid or setgid bit, so a process in the container cannot get other ids. no-new-privileges also
# blocks this, but the image does not depend on that one setting.
RUN find / -xdev -perm /6000 -type f -exec chmod a-s {} +

# the relay of the network mode. it carries the traffic of a call with network access to the egress proxy of the app.
COPY relay.mjs /opt/okc/relay.mjs

# the root filesystem is read only, so every program writes its files to /work or /tmp. pip installs a package into
# /work/.local and not into the system python, so the debian rule against pip in the system python does not apply.
# matplotlib draws to files, because the container has no display.
ENV HOME=/work \
    LANG=C.UTF-8 \
    MPLBACKEND=Agg \
    PIP_NO_CACHE_DIR=1 \
    PIP_USER=1 \
    PIP_BREAK_SYSTEM_PACKAGES=1

USER 1000:1000
WORKDIR /work

# the base sets the entrypoint docker-entrypoint.sh. the runner and the relay reset it (Entrypoint [""] in the create
# request), so the command of each call runs as it is, for example timeout -s KILL 65 python3 -c <code>. there is no CMD.
