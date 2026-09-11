#!/bin/sh
set -eu
umask 077
app="${SC_APP_DIR:-/app}"
mkdir -p "$(dirname "$SOURCES_PATH")"
# The Gateway suite shares one lake between Ingest and Canvas (docs/connected-canvas.md);
# seed it with the sample data so the sample source works before anything is loaded.
if [ -n "${SC_SHARED_LAKE:-}" ]; then
  mkdir -p "$SC_SHARED_LAKE/tables"
  if [ -z "$(ls -A "$SC_SHARED_LAKE/tables")" ]; then cp -R "$app"/sample-data/lake/. "$SC_SHARED_LAKE/tables/"; fi
fi
if [ ! -f "$SOURCES_PATH" ]; then
  case "${SC_MODE:-local}" in
    team) cp "$app/deploy/empty-sources.yaml" "$SOURCES_PATH" ;;
    gateway) if [ -n "${SC_SHARED_LAKE:-}" ]; then cp "$app/deploy/gateway-sources.yaml" "$SOURCES_PATH"; else cp "$app/sources.yaml" "$SOURCES_PATH"; fi ;;
    *) cp "$app/sources.yaml" "$SOURCES_PATH" ;;
  esac
fi
if [ ! -f "$RLS_PATH" ]; then cp "$app/security/policies.yaml" "$RLS_PATH"; fi
if [ ! -f "$SC_ENV_PATH" ]; then touch "$SC_ENV_PATH"; fi
exec "$@"
