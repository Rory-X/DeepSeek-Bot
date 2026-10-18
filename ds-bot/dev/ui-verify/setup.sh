#!/bin/sh
# The browser this service renders in, and the system libraries it needs.
#
#   dev/ui-verify/setup.sh
#
# Installs playwright and Chromium into dev/ui-verify/node_modules. Chromium also needs
# system libraries (libnss3, libatk, libgbm and about a dozen more); with root, the usual
# way to get them is `npx playwright install-deps chromium`, and this script leaves that to
# the caller. Its fallback is for RPM-based Linux without root: it downloads the packages
# with `dnf download` and unpacks only their shared objects into .dsh-test-uiverify/libs,
# which verify.mjs puts on the browser's LD_LIBRARY_PATH. Nothing outside the repository is
# written, and libraries already on the machine are reused instead of downloaded again.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
LIBS="$REPO/.dsh-test-uiverify/libs"
RPMS="$REPO/.dsh-test-uiverify/rpms"

cd "$HERE"
[ -d node_modules/playwright ] || npm install --no-audit --no-fund
npx --no-install playwright install chromium

chrome() {
  ls -d "$HOME"/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell 2>/dev/null | head -1
}
# Any directory already holding the libraries is good enough; the repository's own, a
# shared one under ~/.local, or whatever UI_VERIFY_LIBS names. Nothing is downloaded twice.
ready_libs() {
  for dir in ${UI_VERIFY_LIBS:-} "$LIBS/usr/lib64" "$HOME/.local/chromium-libs/usr/lib64"; do
    [ -d "$dir" ] || continue
    if [ -z "$(LD_LIBRARY_PATH="$dir" ldd "$1" 2>/dev/null | awk '/not found/{print $1}')" ]; then echo "$dir"; return 0; fi
  done
  return 1
}
missing() {
  LD_LIBRARY_PATH="$LIBS/usr/lib64" ldd "$1" 2>/dev/null | awk '/not found/{print $1}' | sort -u
}

CHROME=$(chrome)
if [ -z "$CHROME" ]; then
  echo "no chromium under ~/.cache/ms-playwright; playwright install chromium failed" >&2
  exit 1
fi
if READY=$(ready_libs "$CHROME"); then
  echo "browser ready: $CHROME (libraries in $READY)"
  exit 0
fi

echo "chromium is missing system libraries; unpacking them into $LIBS" >&2
echo "(the no-root fallback for RPM-based Linux; with root, npx playwright install-deps chromium is the usual path)" >&2
mkdir -p "$RPMS" "$LIBS"
# libnspr4 and libnssutil3 name packages that the .so names do not: nspr, nss, nss-util.
PACKAGES="nspr nss nss-util nss-softokn atk at-spi2-atk at-spi2-core libXcomposite libXdamage \
libXfixes libXrandr libXi libXtst libXcursor libXext libXrender mesa-libgbm libxkbcommon \
libxkbcommon-x11 alsa-lib cups-libs libdrm dbus-libs libxshmfence pango cairo \
libX11-xcb libxcb libepoxy"
# --resolve pulls each package's own dependencies, so one pass usually covers everything.
# shellcheck disable=SC2086
dnf download --resolve --destdir="$RPMS" $PACKAGES >/dev/null 2>&1 || true
# Only the shared objects go on LD_LIBRARY_PATH: unpacking a dependency like glibc whole
# would shadow the system libc and break the browser in ways that look unrelated.
for rpm in "$RPMS"/*.x86_64.rpm; do
  [ -f "$rpm" ] || continue
  case "$(basename "$rpm")" in glibc*|kernel*|systemd*|bash*|coreutils*|gcc*|cpp*|binutils*|libgcc*|libstdc++*) continue ;; esac
  tmp=$(mktemp -d)
  rpm2cpio "$rpm" | (cd "$tmp" && cpio -idm --quiet 2>/dev/null)
  find "$tmp" \( -name '*.so' -o -name '*.so.*' \) -print | while read -r file; do
    rel=${file#"$tmp"/}
    mkdir -p "$LIBS/$(dirname "$rel")"
    cp -a "$file" "$LIBS/$rel"
  done
  rm -rf "$tmp"
done

LEFT=$(missing "$CHROME")
if [ -n "$LEFT" ]; then
  echo "still missing: $LEFT" >&2
  echo "install them as root (dnf install -y $PACKAGES) or set LD_LIBRARY_PATH yourself" >&2
  exit 1
fi
echo "browser ready: $CHROME (libraries in $LIBS)"
