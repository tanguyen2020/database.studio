#!/usr/bin/env bash
#
# Download + flatten Oracle Instant Client into src-tauri/resources/instantclient/
# for macOS and Linux, so `tauri build` bundles it (see that folder's README.md).
# On Windows use scripts/fetch-instantclient.ps1 instead.
#
# Detects OS + arch and picks a default package (Basic Light on Linux; Basic DMG
# on macOS, which is ARM64-only for v23). Override the URL with --url when Oracle
# bumps the version (grab the exact link from the download pages). Idempotent:
# skips when the client is already present; --force re-downloads.
#
#   scripts/fetch-instantclient.sh [--force] [--url <package-url>]
#
set -euo pipefail

FORCE=0
URL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE=1; shift ;;
    --url)   URL="${2:-}"; shift 2 ;;
    -h|--help) grep -E '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEST="$REPO_ROOT/src-tauri/resources/instantclient"
mkdir -p "$DEST"

os="$(uname -s)"
arch="$(uname -m)"

case "$os" in
  Darwin) LIB_PREFIX="libclntsh.dylib" ;;
  Linux)  LIB_PREFIX="libclntsh.so" ;;
  MINGW*|MSYS*|CYGWIN*)
    echo "On Windows, run: pwsh scripts/fetch-instantclient.ps1" >&2; exit 2 ;;
  *) echo "Unsupported OS '$os' — this script handles macOS and Linux." >&2; exit 2 ;;
esac

# Idempotent guard.
if [ "$FORCE" -ne 1 ] && ls "$DEST/${LIB_PREFIX}"* >/dev/null 2>&1; then
  echo "Instant Client already present at $DEST (use --force to re-download)."
  exit 0
fi

# Default download URL per platform+arch. These follow Oracle's OTN naming; if a
# default 404s (version bumped), pass --url with the current package.
VER="23.8.0.25.04"
VERDIR="2380000"
BASE="https://download.oracle.com/otn_software"
if [ -z "$URL" ]; then
  case "$os/$arch" in
    Linux/x86_64)
      URL="$BASE/linux/instantclient/$VERDIR/instantclient-basiclite-linux.x64-$VER.zip" ;;
    Linux/aarch64|Linux/arm64)
      URL="$BASE/linux/instantclient/$VERDIR/instantclient-basiclite-linux.arm64-$VER.zip" ;;
    Darwin/arm64|Darwin/aarch64)
      # macOS = ARM64-only for v23; Basic DMG "latest" permalink.
      URL="$BASE/mac/instantclient/instantclient-basic-macos-arm64.dmg" ;;
    Darwin/x86_64)
      echo "Oracle stopped shipping Instant Client for Intel macOS after 19c." >&2
      echo "Build on Apple Silicon, or install a client system-wide (startup falls back to it)." >&2
      exit 2 ;;
    *)
      echo "No built-in default for $os/$arch." >&2
      echo "Pass --url with the package from https://www.oracle.com/database/technologies/instant-client/downloads.html" >&2
      exit 2 ;;
  esac
fi

TMP="$(mktemp -d)"
MNT=""
cleanup() {
  [ -n "$MNT" ] && hdiutil detach "$MNT" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

ext="${URL##*.}"
file="$TMP/ic.$ext"
echo "Downloading $URL ..."
curl -fL --retry 3 -o "$file" "$URL"

echo "Extracting ..."
case "$ext" in
  zip)
    unzip -q "$file" -d "$TMP/x"
    src="$(find "$TMP/x" -maxdepth 1 -type d -name 'instantclient*' | head -n1)"
    [ -z "$src" ] && src="$TMP/x"
    cp -a "$src"/. "$DEST"/
    ;;
  dmg)
    MNT="$TMP/mnt"; mkdir -p "$MNT"
    hdiutil attach "$file" -nobrowse -quiet -mountpoint "$MNT"
    src="$(find "$MNT" -maxdepth 1 -type d -name 'instantclient*' | head -n1)"
    [ -z "$src" ] && src="$MNT"
    # Preserve internal symlinks (libclntsh.dylib -> libclntsh.dylib.23.1).
    cp -a "$src"/. "$DEST"/
    hdiutil detach "$MNT" >/dev/null 2>&1 || true
    MNT=""
    ;;
  *)
    echo "Unsupported package type '.$ext'." >&2; exit 2 ;;
esac

if ! ls "$DEST/${LIB_PREFIX}"* >/dev/null 2>&1; then
  echo "ERROR: ${LIB_PREFIX}* not found in $DEST after extraction." >&2
  echo "The download may be incomplete or the URL wrong for this platform." >&2
  echo "Get the right package from https://www.oracle.com/database/technologies/instant-client/downloads.html and re-run with --url." >&2
  exit 1
fi
echo "Instant Client ready at $DEST"
