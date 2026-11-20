#!/bin/bash
# Cloud environment setup for the FVS design editor.
# Runs as root on Ubuntu 24.04 before Claude Code starts; the result is cached
# as a snapshot, so keep it under ~5 minutes.
# Nothing here is fatal: a failed step warns and the session still starts.
set -uo pipefail
export DEBIAN_FRONTEND=noninteractive

step() { echo "setup: $*"; }
warn() { echo "setup: WARNING: $*" >&2; }

# One package per call, so a renamed package warns instead of failing the lot.
apt_install() {
  local pkg
  for pkg in "$@"; do
    apt-get install -y -qq --no-install-recommends "$pkg" >/dev/null 2>&1 \
      || warn "could not install $pkg"
  done
}

# 1. System packages ----------------------------------------------------------
step "installing system packages"
apt-get update -qq || warn "apt-get update failed"

# Headless display, the runtime libraries Chromium and Electron need, and an
# emoji font so text-rendering tests have the same glyphs on every run.
apt_install xvfb xauth fonts-noto-color-emoji fonts-liberation \
  libnss3 libgbm1 libgtk-3-0t64 libasound2t64 libxss1 libxtst6

# 2. Find the repo (the script's working directory is not guaranteed) ----------
REPO="${REPO_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || true)}"
if [ -z "$REPO" ] || [ ! -f "$REPO/package.json" ]; then REPO=""; fi

# 3. Desktop shell: auto | electron | tauri | both | none ----------------------
# Electron needs nothing beyond step 1. Tauri needs WebKitGTK and build tools.
SHELL_KIND="${DESKTOP_SHELL:-auto}"
if [ "$SHELL_KIND" = "auto" ]; then
  SHELL_KIND=electron
  if [ -n "$REPO" ] && [ -n "$(find "$REPO" -maxdepth 3 -type d -name src-tauri \
        -not -path '*/node_modules/*' -print -quit 2>/dev/null)" ]; then
    SHELL_KIND=tauri
  fi
fi
case "$SHELL_KIND" in
  tauri|both)
    step "installing Tauri build dependencies"
    apt_install build-essential curl wget file libssl-dev libxdo-dev \
      libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev \
      webkit2gtk-driver
    command -v cargo >/dev/null || warn "cargo is not on PATH; Tauri builds need Rust"
    ;;
esac

# 4. Project dependencies ------------------------------------------------------
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}"
if [ -n "$REPO" ]; then
  cd "$REPO" || exit 0
  if [ -f pnpm-lock.yaml ]; then
    step "installing node dependencies"
    pnpm install --frozen-lockfile || warn "pnpm install failed"
  fi
  # Use the repo's own Playwright version so the browser build matches the tests.
  if pnpm exec playwright --version >/dev/null 2>&1; then
    step "installing Playwright Chromium"
    pnpm exec playwright install chromium \
      || warn "Playwright download failed (is cdn.playwright.dev allowed?)"
    chmod -R a+rX "$PLAYWRIGHT_BROWSERS_PATH" 2>/dev/null || true
  fi
else
  step "no package.json yet; skipping dependency install"
fi

step "done"
exit 0
