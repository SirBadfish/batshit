FROM alpine:3.22

ARG TARGETARCH
ARG CLOUDFLARED_RELEASE_TAG=2026.3.0
ARG CLOUDFLARED_LINUX_AMD64_SHA256=4a9e50e6d6d798e90fcd01933151a90bf7edd99a0a55c28ad18f2e16263a5c30
ARG CLOUDFLARED_LINUX_ARM64_SHA256=0755ba4cbab59980e6148367fcf53a8f3ec85a97deefd63c2420cf7850769bee

RUN apk add --no-cache ca-certificates jq \
  && case "${TARGETARCH}" in \
    amd64) asset="cloudflared-linux-amd64"; checksum="${CLOUDFLARED_LINUX_AMD64_SHA256}" ;; \
    arm64) asset="cloudflared-linux-arm64"; checksum="${CLOUDFLARED_LINUX_ARM64_SHA256}" ;; \
    *) echo "Unsupported cloudflared sidecar architecture: ${TARGETARCH}" >&2; exit 1 ;; \
  esac \
  && wget -O /usr/local/bin/cloudflared "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_RELEASE_TAG}/${asset}" \
  && echo "${checksum}  /usr/local/bin/cloudflared" | sha256sum -c - \
  && chmod 0755 /usr/local/bin/cloudflared

COPY tools/docker/cloudflared-sidecar/entrypoint.sh /usr/local/bin/batshit-cloudflared-entrypoint
RUN sed -i 's/\r$//' /usr/local/bin/batshit-cloudflared-entrypoint \
  && chmod 0755 /usr/local/bin/batshit-cloudflared-entrypoint

ENTRYPOINT ["/usr/local/bin/batshit-cloudflared-entrypoint"]
