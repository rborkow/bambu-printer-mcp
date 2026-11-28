#!/bin/sh
# Runs FULU's x86-64 Linux BambuNetwork host in an Apple container (container CLI, Rosetta) instead of a
# Lima/QEMU x86 VM. Use it as BAMBU_NETWORK_BRIDGE_COMMAND:
#
#   BAMBU_NETWORK_BRIDGE_COMMAND="PJARCZAK_EXPECTED_BAMBU_NETWORK_VERSION=02.05.02.58 /path/to/fulu-apple-container.sh"
#
# stdin/stdout carry the bridge's framed protocol, as with FULU's Lima wrapper. Only three folders are mounted, each
# at its own absolute path because the server passes host paths to the plug-in:
#   - FULU's runtime (read-only): PJARCZAK_BAMBU_PLUGIN_DIR, default OrcaSlicer's macos-bridge/runtime;
#   - the bridge's config folder (session, logs): BAMBU_NETWORK_CONFIG_DIR, default ~/.config/bambu-printer-mcp/bambu-network;
#   - TMPDIR, where the server writes each print's checked snapshot that the plug-in uploads.
# Build the image once: container build --platform linux/arm64 -t fulu-host-qemu:2 -f scripts/fulu-host-qemu.Containerfile .
# Requires `container system start` once.
set -eu

CONTAINER_CLI="${FULU_CONTAINER_CLI:-}"
if [ -z "$CONTAINER_CLI" ]; then
    for candidate in "$(command -v container 2>/dev/null || true)" /usr/local/bin/container /opt/homebrew/bin/container; do
        if [ -n "$candidate" ] && [ -x "$candidate" ]; then CONTAINER_CLI="$candidate"; break; fi
    done
fi
if [ -z "$CONTAINER_CLI" ]; then
    echo "Apple container CLI not found; install it from github.com/apple/container" >&2
    exit 127
fi

IMAGE="${FULU_CONTAINER_IMAGE:-fulu-host-qemu:2}"
RUNTIME="${PJARCZAK_BAMBU_PLUGIN_DIR:-$HOME/Library/Application Support/OrcaSlicer/macos-bridge/runtime}"
CONFIG="${BAMBU_NETWORK_CONFIG_DIR:-$HOME/.config/bambu-printer-mcp/bambu-network}"
SNAPSHOTS="${TMPDIR:-}"
SNAPSHOTS="${SNAPSHOTS%/}"

if [ ! -x "$RUNTIME/pjarczak_bambu_linux_host" ]; then
    echo "FULU runtime not found at $RUNTIME" >&2
    exit 127
fi
mkdir -p "$CONFIG"

set -- --mount "type=bind,source=$RUNTIME,target=$RUNTIME,readonly" \
       --mount "type=bind,source=$CONFIG,target=$CONFIG"
case "$SNAPSHOTS" in
    ""|/tmp|/private/tmp|/var/folders/*|/private/var/folders/*)
        echo "TMPDIR must be a private folder (the server's print snapshots are written there); got '${TMPDIR:-}'" >&2
        exit 2 ;;
    "$CONFIG"|"$CONFIG"/*) ;;
    *) mkdir -p "$SNAPSHOTS"; set -- "$@" --mount "type=bind,source=$SNAPSHOTS,target=$SNAPSHOTS" ;;
esac

# Rosetta crashes (SIGBUS) in libbambu_networking.so's initializer, an anti-tamper check that reads its parent's
# cmdline and /proc/self/maps; QEMU 8 crashes there too. QEMU 10's user-mode emulator runs it, so the image is a native
# arm64 Ubuntu 25.10 with qemu-user and an x86-64 Ubuntu 24.04 root at /x86root (Containerfile beside this script).
# Only the host process is emulated: no x86 kernel boots. FULU's ABI selector is skipped (its probe aborts under
# emulation and it writes a cache into the read-only runtime); abi1 matches the 02.05.02.5x plug-in.
ABI="${PJARCZAK_FORCE_HOST_ABI:-abi1}"
# The host is piped through cat (FULU #50); --init forwards the stop signal to it.
exec "$CONTAINER_CLI" run --rm -i --init "$@" "$IMAGE" /bin/sh -c '"$@" | cat' fulu-host \
    qemu-x86_64 -L /x86root \
    -E "LD_LIBRARY_PATH=$RUNTIME" \
    -E "PJARCZAK_BAMBU_PLUGIN_DIR=$RUNTIME" \
    -E "PJARCZAK_BAMBU_NETWORK_SO=$RUNTIME/libbambu_networking.so" \
    -E "PJARCZAK_BAMBU_SOURCE_SO=$RUNTIME/libBambuSource.so" \
    -E "PJARCZAK_BAMBU_LIVE555_SO=$RUNTIME/liblive555.so" \
    -E "PJARCZAK_EXPECTED_BAMBU_NETWORK_VERSION=${PJARCZAK_EXPECTED_BAMBU_NETWORK_VERSION:-}" \
    -E "PJARCZAK_BAMBU_COUNTRY_CODE=${PJARCZAK_BAMBU_COUNTRY_CODE:-${BAMBU_NETWORK_COUNTRY_CODE:-US}}" \
    -E "SSL_CERT_FILE=$RUNTIME/ca-certificates.crt" \
    -E "CURL_CA_BUNDLE=$RUNTIME/ca-certificates.crt" \
    -E "SSL_CERT_DIR=/x86root/etc/ssl/certs" \
    "$RUNTIME/pjarczak_bambu_linux_host_$ABI"
