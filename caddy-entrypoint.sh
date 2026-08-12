#!/bin/sh
# Sets CADDY_PROTOCOL from CADDY_TLS, then starts Caddy.
#
# Same contract as the proxy services in this fleet: CADDY_TLS=false serves
# plain HTTP (local testing, or behind another terminator); anything else lets
# Caddy provision certificates itself.

CADDY_TLS=${CADDY_TLS:-true}

if [ "$CADDY_TLS" = "false" ]; then
    export CADDY_PROTOCOL="http://"
else
    export CADDY_PROTOCOL=""
fi

# The base path is a build value that Caddy also needs, because it serves the
# URLs the build inlined. Vite appends the trailing slash when it inlines it
# (`/airship` becomes `/airship/`) and Caddy does not, so without the same
# normalization here `{$AIRSHIP_PUBLIC_BASE_PATH:/}assets/*` expands to
# `/airshipassets/*` — a matcher that matches nothing. The site would still
# serve; it would just lose its cache and service-worker headers with nothing
# said. The default matches the Dockerfile ARG and the compose default.
AIRSHIP_PUBLIC_BASE_PATH=${AIRSHIP_PUBLIC_BASE_PATH:-/}
case "$AIRSHIP_PUBLIC_BASE_PATH" in
    */) ;;
    *) AIRSHIP_PUBLIC_BASE_PATH="$AIRSHIP_PUBLIC_BASE_PATH/" ;;
esac
export AIRSHIP_PUBLIC_BASE_PATH

exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
