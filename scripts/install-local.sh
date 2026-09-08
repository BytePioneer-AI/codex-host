#!/usr/bin/env bash
set -euo pipefail

REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  cat <<'EOF'
usage: scripts/install-local.sh [--no-build]

Build and globally install the current macOS codexhost npm package, stop the
running Codex Desktop and its previous codexhost runtime, then start Codex
Desktop through the newly installed codexhost command.

options:
  --no-build  reuse the existing TypeScript, Renderer, and Rust release artifacts
  --help      show this help
EOF
}

SKIP_BUILD=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-build)
      if [[ "$SKIP_BUILD" == true ]]; then
        echo "error: --no-build may only be provided once" >&2
        exit 2
      fi
      SKIP_BUILD=true
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "error: local install and Codex Desktop restart are currently supported only on macOS" >&2
  exit 1
fi

case "$(uname -m)" in
  arm64) TARGET="macos-arm64" ;;
  x86_64) TARGET="macos-x64" ;;
  *)
    echo "error: unsupported macOS architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

command -v node >/dev/null 2>&1 || {
  echo "error: node is required" >&2
  exit 1
}
command -v npm >/dev/null 2>&1 || {
  echo "error: npm is required" >&2
  exit 1
}
if [[ "$SKIP_BUILD" == false ]]; then
  command -v cargo >/dev/null 2>&1 || {
    echo "error: cargo is required" >&2
    exit 1
  }
fi

cd "$REPOSITORY_ROOT"
VERSION="$(node -p 'require("./package.json").version')"

echo "codexhost local install: preparing $VERSION for $TARGET"
PACKAGE_ARGUMENTS=(run release:npm -- --target "$TARGET" --version "$VERSION" --pack)
if [[ "$SKIP_BUILD" == true ]]; then
  PACKAGE_ARGUMENTS+=(--skip-build)
fi
npm "${PACKAGE_ARGUMENTS[@]}"
npm run release:npm:meta -- --version "$VERSION" --pack

PLATFORM_TARBALL="$REPOSITORY_ROOT/build/npm/$VERSION/$TARGET/codexhost-cli-$VERSION-$TARGET.tgz"
META_TARBALL="$REPOSITORY_ROOT/build/npm/$VERSION/meta/codexhost-cli-$VERSION.tgz"
for artifact in "$PLATFORM_TARBALL" "$META_TARBALL"; do
  if [[ ! -s "$artifact" ]]; then
    echo "error: expected npm package is missing or empty: $artifact" >&2
    exit 1
  fi
done

echo "codexhost local install: installing npm packages"
# Both local tarballs are installed together. Offline mode prevents the meta
# package's optional dependencies for other platforms from reaching the registry.
npm install --global --offline "$PLATFORM_TARBALL" "$META_TARBALL"

NPM_PREFIX="$(npm prefix --global)"
CODEXHOST_BIN="$NPM_PREFIX/bin/codexhost"
if [[ ! -x "$CODEXHOST_BIN" ]]; then
  echo "error: installed codexhost command is unavailable: $CODEXHOST_BIN" >&2
  exit 1
fi
INSTALLED_VERSION="$("$CODEXHOST_BIN" --version)"
if [[ "$INSTALLED_VERSION" != "$VERSION" ]]; then
  echo "error: installed codexhost version is $INSTALLED_VERSION; expected $VERSION" >&2
  exit 1
fi

SYSTEM_DESKTOP_PATTERN='^/Applications/(ChatGPT|Codex)\.app/Contents/'
USER_DESKTOP_PATTERN="^$HOME/Applications/(ChatGPT|Codex)\.app/Contents/"
desktop_running() {
  /usr/bin/pgrep -f "$SYSTEM_DESKTOP_PATTERN" >/dev/null 2>&1 ||
    /usr/bin/pgrep -f "$USER_DESKTOP_PATTERN" >/dev/null 2>&1
}

RUNTIME_DESCRIPTOR="$HOME/Library/Application Support/codexhost/desktop-runtime-v1.json"
descriptor_value() {
  if [[ ! -f "$RUNTIME_DESCRIPTOR" ]]; then
    return 0
  fi
  /usr/bin/sed -nE "s/.*\"$1\"[[:space:]]*:[[:space:]]*([0-9]+).*/\1/p" \
    "$RUNTIME_DESCRIPTOR" | /usr/bin/head -n 1
}

controller_pid() {
  local control_port candidate command_line
  control_port="$(descriptor_value control_port)"
  if [[ -z "$control_port" ]]; then
    return 0
  fi
  candidate="$(
    /usr/sbin/lsof -nP -t -iTCP:"$control_port" -sTCP:LISTEN 2>/dev/null |
      /usr/bin/head -n 1
  )"
  if [[ -z "$candidate" ]]; then
    return 0
  fi
  command_line="$(/bin/ps -p "$candidate" -o command= 2>/dev/null || true)"
  case "$command_line" in
    *"/app/desktop-controller.mjs"*|*"packages/desktop-control/dist/release-main.js"*)
      printf '%s\n' "$candidate"
      ;;
  esac
}

runtime_running() {
  /usr/bin/pgrep -x codexhost >/dev/null 2>&1 ||
    /usr/bin/pgrep -x codexhost-shim >/dev/null 2>&1 ||
    [[ -n "$(controller_pid)" ]]
}

echo "codexhost local install: stopping Codex Desktop"
if desktop_running; then
  /usr/bin/pkill -TERM -f "$SYSTEM_DESKTOP_PATTERN" >/dev/null 2>&1 || true
  /usr/bin/pkill -TERM -f "$USER_DESKTOP_PATTERN" >/dev/null 2>&1 || true

  for _ in {1..100}; do
    desktop_running || break
    /bin/sleep 0.1
  done

  if desktop_running; then
    echo "codexhost local install: Codex Desktop did not exit gracefully; forcing it to stop"
    /usr/bin/pkill -KILL -f "$SYSTEM_DESKTOP_PATTERN" >/dev/null 2>&1 || true
    /usr/bin/pkill -KILL -f "$USER_DESKTOP_PATTERN" >/dev/null 2>&1 || true
  fi
fi

CONTROLLER_PID="$(controller_pid)"
if [[ -n "$CONTROLLER_PID" ]]; then
  /bin/kill -TERM "$CONTROLLER_PID" >/dev/null 2>&1 || true
fi

for _ in {1..50}; do
  runtime_running || break
  /bin/sleep 0.1
done

if runtime_running; then
  echo "codexhost local install: stopping the previous codexhost runtime"
  CONTROLLER_PID="$(controller_pid)"
  if [[ -n "$CONTROLLER_PID" ]]; then
    /bin/kill -KILL "$CONTROLLER_PID" >/dev/null 2>&1 || true
  fi
  /usr/bin/pkill -KILL -x codexhost >/dev/null 2>&1 || true
  /usr/bin/pkill -KILL -x codexhost-shim >/dev/null 2>&1 || true
fi

for _ in {1..100}; do
  runtime_running || break
  /bin/sleep 0.1
done
if runtime_running; then
  echo "error: the previous codexhost runtime did not exit before timeout" >&2
  exit 1
fi

echo "codexhost local install: starting $CODEXHOST_BIN"
"$CODEXHOST_BIN"
