#!/usr/bin/env bash
set -euo pipefail

# CodexHost macOS one-line installer.
# Downloads the latest verified DMG from GitHub Releases, installs codexhost.app
# into /Applications (or ~/Applications if /Applications is not writable), and
# clears com.apple.quarantine without requiring sudo or touching your Keychain.

REPO="${CODEXHOST_RELEASE_REPO:-BytePioneer-AI/codex-host}"
VERSION="${CODEXHOST_VERSION:-}"
INSTALL_DIR="${CODEXHOST_INSTALL_DIR:-}"

die() {
  echo "codexhost install: $*" >&2
  exit 1
}

if [[ "$(uname -s)" != "Darwin" ]]; then
  die "this installer is for macOS only"
fi

detect_arch() {
  local machine
  machine="$(uname -m)"
  # If running inside a Rosetta-translated shell on Apple Silicon, install arm64.
  if [[ "$machine" == "x86_64" ]] && [[ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" == "1" ]]; then
    echo "arm64"
    return
  fi
  case "$machine" in
    arm64|aarch64) echo "arm64" ;;
    x86_64) echo "x64" ;;
    *) die "unsupported macOS architecture: $machine" ;;
  esac
}

resolve_version() {
  if [[ -n "$VERSION" ]]; then
    echo "${VERSION#v}"
    return
  fi
  local tag
  tag="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
    | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    | head -n 1)"
  if [[ -z "$tag" ]]; then
    die "could not determine the latest release version from GitHub"
  fi
  echo "${tag#v}"
}

choose_install_dir() {
  if [[ -n "$INSTALL_DIR" ]]; then
    mkdir -p "$INSTALL_DIR"
    echo "$INSTALL_DIR"
    return
  fi
  if [[ -d "/Applications" && -w "/Applications" ]]; then
    echo "/Applications"
    return
  fi
  mkdir -p "$HOME/Applications"
  echo "$HOME/Applications"
}

ARCH="$(detect_arch)"
RESOLVED_VERSION="$(resolve_version)"
TAG="v${RESOLVED_VERSION}"
DMG_NAME="codexhost-${RESOLVED_VERSION}-macos-${ARCH}.dmg"
BASE_URL="https://github.com/${REPO}/releases/download/${TAG}"
TARGET_DIR="$(choose_install_dir)"
TARGET_APP="${TARGET_DIR}/codexhost.app"

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/codexhost-install.XXXXXX")"
MOUNT_DIR="${TMP_DIR}/mount"
DMG_PATH="${TMP_DIR}/${DMG_NAME}"
STAGED_APP="${TARGET_DIR}/.codexhost-install-$$.app"
BACKUP_APP="${TARGET_DIR}/.codexhost-backup-$$.app"

cleanup() {
  if [[ -d "$MOUNT_DIR" ]] && mount | grep -Fq "on ${MOUNT_DIR} "; then
    /usr/bin/hdiutil detach "$MOUNT_DIR" -quiet 2>/dev/null || /usr/bin/hdiutil detach "$MOUNT_DIR" -force -quiet 2>/dev/null || true
  fi
  rm -rf "$TMP_DIR" "$STAGED_APP"
}
trap cleanup EXIT

echo "==> Downloading CodexHost ${TAG} (macos-${ARCH})..."
curl -fL --progress-bar "${BASE_URL}/${DMG_NAME}" -o "$DMG_PATH"

if curl -fsSL "${BASE_URL}/SHA256SUMS.txt" -o "${TMP_DIR}/SHA256SUMS.txt" 2>/dev/null; then
  EXPECTED_SHA="$(awk -v file="$DMG_NAME" '$2 == file || $2 == "*" file { print $1; exit }' "${TMP_DIR}/SHA256SUMS.txt")"
  if [[ -n "$EXPECTED_SHA" ]]; then
    ACTUAL_SHA="$(/usr/bin/shasum -a 256 "$DMG_PATH" | awk '{ print $1 }')"
    if [[ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]]; then
      die "SHA-256 mismatch for ${DMG_NAME} (expected ${EXPECTED_SHA}, got ${ACTUAL_SHA})"
    fi
    echo "==> Verified SHA-256 checksum."
  fi
fi

echo "==> Installing to ${TARGET_APP}..."
mkdir -p "$MOUNT_DIR"
/usr/bin/hdiutil attach "$DMG_PATH" -nobrowse -readonly -mountpoint "$MOUNT_DIR" -quiet

if [[ ! -d "${MOUNT_DIR}/codexhost.app" ]]; then
  die "codexhost.app was not found inside ${DMG_NAME}"
fi

rm -rf "$STAGED_APP"
/usr/bin/ditto "${MOUNT_DIR}/codexhost.app" "$STAGED_APP"
/usr/bin/hdiutil detach "$MOUNT_DIR" -quiet || true

/usr/bin/xattr -dr com.apple.quarantine "$STAGED_APP" 2>/dev/null || true
/usr/bin/codesign --verify --deep --strict "$STAGED_APP" >/dev/null

if [[ -d "$TARGET_APP" ]]; then
  rm -rf "$BACKUP_APP"
  mv "$TARGET_APP" "$BACKUP_APP"
fi
if ! mv "$STAGED_APP" "$TARGET_APP"; then
  if [[ -d "$BACKUP_APP" ]]; then
    mv "$BACKUP_APP" "$TARGET_APP" || true
  fi
  die "failed to move codexhost.app into ${TARGET_DIR}"
fi
rm -rf "$BACKUP_APP"

# If the user previously opted into local code signing, re-sign automatically.
SIGNING_CONFIG="${CODEXHOST_DATA_DIR:-${HOME}/.codexhost}/macos-local-signing-v1.json"
if [[ -f "$SIGNING_CONFIG" && -x "${TARGET_APP}/Contents/MacOS/codexhost" ]]; then
  "${TARGET_APP}/Contents/MacOS/codexhost" macos-signing setup --app "$TARGET_APP" >/dev/null 2>&1 || true
fi

/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$TARGET_APP" >/dev/null 2>&1 || true

echo ""
echo "CodexHost ${TAG} installed to ${TARGET_APP}"
echo "You can open CodexHost from Applications or Spotlight without Gatekeeper warnings."
echo "Optional: to keep macOS notification/microphone permissions across future updates, enable 'Local signing' in Settings -> Updates (or run '${TARGET_APP}/Contents/MacOS/codexhost' macos-signing setup)."
