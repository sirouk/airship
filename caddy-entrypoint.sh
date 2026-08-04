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

exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
