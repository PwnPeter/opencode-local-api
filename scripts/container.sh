#!/bin/sh
set -eu
if [ "$#" -gt 0 ]; then
  exec "$@"
fi
python3 scripts/install.py prepare
set -a
. /data/opencode-local-api/environment
exec node src/server.mjs
