# FULU's x86-64 BambuNetwork host under QEMU user-mode emulation in a native arm64 container.
# Rosetta crashes in libbambu_networking.so's initializer (SIGBUS), so the host's process alone is emulated.
FROM --platform=linux/amd64 docker.io/library/ubuntu:24.04 AS x86
FROM --platform=linux/arm64 docker.io/library/ubuntu:25.10
RUN apt-get update && apt-get install -y --no-install-recommends qemu-user ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=x86 / /x86root
