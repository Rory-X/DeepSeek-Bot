#!/bin/sh
# One command for the mobile style verification service:
#
#   dev/ui-verify/run.sh                      # every default viewport, bench started if needed
#   dev/ui-verify/run.sh --viewports 390x844  # one viewport
#   dev/ui-verify/run.sh --static             # CSS pass only, no browser, no bench
#   dev/ui-verify/run.sh --stop               # stop the bench this service started
#
# The bench (mock model + dsh web over this checkout) needs a DeepSeek Harness install:
# set DSH_HARNESS to one, or keep a ../deepseek-harness checkout beside the repository.
# dev/ui-verify/setup.sh installs the browser and the libraries it needs.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)

if [ ! -d "$HERE/node_modules/playwright" ]; then
  echo "installing playwright in dev/ui-verify ..." >&2
  (cd "$HERE" && npm install --no-audit --no-fund)
fi
exec node "$HERE/verify.mjs" "$@"
