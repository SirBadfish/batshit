FROM node:24-bookworm-slim

ARG FBX2GLTF_VERSION=v0.9.7
ARG FBX2GLTF_LINUX_X64_SHA256=b38210352fdd29d50ba53a6514c3ff05ccbb5d1e0a6442db7a49834bf34a3145

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL \
    "https://github.com/facebookincubator/FBX2glTF/releases/download/${FBX2GLTF_VERSION}/FBX2glTF-linux-x64" \
    -o /usr/local/bin/FBX2glTF \
  && echo "${FBX2GLTF_LINUX_X64_SHA256}  /usr/local/bin/FBX2glTF" | sha256sum -c - \
  && chmod 0755 /usr/local/bin/FBX2glTF \
  && /usr/local/bin/FBX2glTF --version

WORKDIR /opt/batshit-fbx2vrma-worker
COPY tools/docker/fbx2vrma-worker/worker.mjs ./worker.mjs

RUN mkdir -p /work \
  && chown -R node:node /work /opt/batshit-fbx2vrma-worker

ENV NODE_ENV=production \
  BATSHIT_FBX2VRMA_PORT=8079 \
  BATSHIT_FBX2VRMA_HOST=0.0.0.0 \
  BATSHIT_FBX2GLTF_PATH=/usr/local/bin/FBX2glTF \
  BATSHIT_FBX2GLTF_VERSION=${FBX2GLTF_VERSION} \
  BATSHIT_FBX2VRMA_WORK_DIR=/work \
  BATSHIT_FBX2VRMA_MAX_BYTES=524288000

USER node

EXPOSE 8079

CMD ["node", "/opt/batshit-fbx2vrma-worker/worker.mjs"]
