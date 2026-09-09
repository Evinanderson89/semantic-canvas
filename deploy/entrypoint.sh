#!/bin/sh
set -eu
umask 077
mkdir -p /data/config
if [ ! -f "$SOURCES_PATH" ]; then
  if [ "${SC_MODE:-local}" = team ]; then cp /app/deploy/empty-sources.yaml "$SOURCES_PATH"; else cp /app/sources.yaml "$SOURCES_PATH"; fi
fi
if [ ! -f "$RLS_PATH" ]; then cp /app/security/policies.yaml "$RLS_PATH"; fi
if [ ! -f "$SC_ENV_PATH" ]; then touch "$SC_ENV_PATH"; fi
exec "$@"
