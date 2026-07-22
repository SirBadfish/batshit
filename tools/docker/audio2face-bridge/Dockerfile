FROM python:3.13.5-slim-bookworm AS proto-builder

ARG NVIDIA_A2F_SAMPLES_COMMIT=a2d0150043be7dc15db2fad8193a78b660e1100f
ARG NVIDIA_A2F_SAMPLES_SHA256=827b47831b1640b8bffef005a2a07eb58bc793894e331638253b3080e628ab27

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL \
    "https://github.com/NVIDIA/Audio2Face-3D-Samples/archive/${NVIDIA_A2F_SAMPLES_COMMIT}.tar.gz" \
    -o /tmp/audio2face-samples.tar.gz \
  && echo "${NVIDIA_A2F_SAMPLES_SHA256}  /tmp/audio2face-samples.tar.gz" | sha256sum -c - \
  && mkdir -p /src \
  && tar -xzf /tmp/audio2face-samples.tar.gz --strip-components=1 -C /src \
  && rm /tmp/audio2face-samples.tar.gz
RUN python -m pip install --no-cache-dir \
  grpcio==1.82.1 \
  grpcio-tools==1.82.1 \
  protobuf==7.35.1 \
  PyYAML==6.0.3
WORKDIR /src/proto
RUN python generate_code_from_protos.py files_to_compile.yaml

FROM python:3.13.5-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
  PYTHONUNBUFFERED=1 \
  PYTHONPATH=/app/generated

WORKDIR /app
COPY tools/docker/audio2face-bridge/requirements.txt ./requirements.txt
RUN python -m pip install --no-cache-dir -r requirements.txt
COPY --from=proto-builder /src/proto/generated ./generated
COPY tools/docker/audio2face-bridge/server.py ./server.py

RUN groupadd --system --gid 10001 batshit-a2f \
  && useradd --system --uid 10001 --gid batshit-a2f --home-dir /nonexistent --shell /usr/sbin/nologin batshit-a2f \
  && mkdir -p /cache \
  && chown -R batshit-a2f:batshit-a2f /cache /app

USER batshit-a2f
EXPOSE 8068
CMD ["python", "/app/server.py"]
