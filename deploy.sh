#!/bin/bash
# Airship — deployment management.
#
# Airship is a static PWA: there is no application process at runtime, so this
# builds the bundle into an image and hands it to Caddy. The one thing that can
# silently rot is the header set — `public/_headers` is a format Caddy does not
# read, so the Caddyfile carries its own copy and `--verify` checks they agree.

set -euo pipefail
cd "$(dirname "$0")"

GREEN='\033[0;32m'; BLUE='\033[0;34m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'

banner() {
  echo -e "${BLUE}╔══════════════════════════════════════════╗${NC}"
  echo -e "${BLUE}║  Airship — Deployment Management         ║${NC}"
  echo -e "${BLUE}╚══════════════════════════════════════════╝${NC}"
  echo
}

# The Caddyfile duplicates `public/_headers` because Caddy cannot read that
# format. Duplication that drifts is worse than duplication that is checked, so
# this compares the security-relevant directives rather than trusting a comment.
verify_headers() {
  local failed=0
  echo -e "${BLUE}Checking the Caddyfile against public/_headers…${NC}"

  local csp_src csp_caddy
  csp_src="$(grep -o "Content-Security-Policy: .*" public/_headers | sed 's/^Content-Security-Policy: //')"
  csp_caddy="$(grep -o 'Content-Security-Policy "[^"]*"' Caddyfile | sed 's/^Content-Security-Policy "//; s/"$//')"

  if [ "$csp_src" = "$csp_caddy" ]; then
    echo -e "  ${GREEN}✓${NC} Content-Security-Policy matches"
  else
    echo -e "  ${RED}✗${NC} Content-Security-Policy DIFFERS between public/_headers and Caddyfile"
    echo -e "    ${YELLOW}A deploy would serve a policy the repository never reviewed.${NC}"
    diff <(echo "$csp_src" | tr ';' '\n' | sed 's/^ *//' | sort) \
         <(echo "$csp_caddy" | tr ';' '\n' | sed 's/^ *//' | sort) || true
    failed=1
  fi

  # Cross-origin isolation is the pair whose absence breaks the threaded WASM
  # runtime with an error that reads like a bug in the semantic pack.
  for header in "Cross-Origin-Embedder-Policy" "Cross-Origin-Opener-Policy" \
                "Cross-Origin-Resource-Policy" "Referrer-Policy" \
                "X-Content-Type-Options" "X-Frame-Options" \
                "Strict-Transport-Security" "Permissions-Policy"; do
    if grep -q "$header" Caddyfile; then
      echo -e "  ${GREEN}✓${NC} $header present"
    else
      echo -e "  ${RED}✗${NC} $header missing from Caddyfile"
      failed=1
    fi
  done

  return $failed
}

require_env() {
  if [ ! -f .env ]; then
    echo -e "${YELLOW}⚠️  .env not found${NC}"
    echo -e "${BLUE}Creating .env from .env.sample…${NC}"
    cp .env.sample .env
    echo -e "${GREEN}✓ Created .env${NC}"
    echo -e "${YELLOW}⚠️  Edit .env with your domain, then run this again.${NC}"
    exit 0
  fi
}

case "${1:-}" in
  --verify)
    banner
    verify_headers
    echo -e "\n${GREEN}✓ Header policies agree${NC}"
    exit 0
    ;;
  --logs)   exec docker compose logs -f ;;
  --stop)   exec docker compose down ;;
esac

banner
echo -e "${YELLOW}Choose action:${NC}"
echo "1) Deploy"
echo "2) Deploy locally over plain HTTP (no domain, no certificate)"
echo "3) Stop"
echo "4) Logs"
read -r -p "Enter choice (1/2/3/4): " choice

case "${choice}" in
  1|2)
    require_env
    # shellcheck disable=SC1091
    source .env

    if [ "${choice}" = "2" ]; then
      export CADDY_DOMAIN="localhost"
      export CADDY_TLS="false"
      export CADDY_PORT="${LOCAL_PORT:-8080}"
      export VITE_AIRSHIP_PUBLIC_ORIGIN="http://localhost:${CADDY_PORT}"
      export AIRSHIP_PUBLIC_BASE_PATH="/"
      echo -e "${YELLOW}Local mode: http://localhost:${CADDY_PORT} — no TLS, no domain.${NC}"
    fi

    echo -e "${BLUE}Configuration:${NC}"
    echo "  Domain:      ${CADDY_DOMAIN}"
    echo "  Port:        ${CADDY_PORT}"
    echo "  TLS:         ${CADDY_TLS}"
    echo "  Base path:   ${AIRSHIP_PUBLIC_BASE_PATH}"
    echo "  App origin:  ${VITE_AIRSHIP_PUBLIC_ORIGIN}"
    if [ -z "${VITE_GOOGLE_CLIENT_ID:-}" ]; then
      echo -e "  Vault default: ${YELLOW}local-device${NC} (no Google client ID configured)"
    else
      echo -e "  Vault default: google-drive"
    fi
    echo

    if ! docker info > /dev/null 2>&1; then
      echo -e "${RED}❌ Docker is not running${NC}"; exit 1
    fi

    # Refuse before building rather than after publishing.
    if ! verify_headers; then
      echo -e "\n${RED}❌ Refusing to deploy: the served headers do not match the reviewed ones.${NC}"
      echo -e "${YELLOW}Reconcile Caddyfile with public/_headers, then run again.${NC}"
      exit 1
    fi
    echo

    echo -e "${BLUE}Building…${NC}"
    docker compose build

    echo -e "${BLUE}Starting…${NC}"
    docker compose up -d

    echo -e "${BLUE}Waiting for Caddy…${NC}"
    sleep 4

    scheme="https"; [ "${CADDY_TLS}" = "false" ] && scheme="http"
    url="${scheme}://${CADDY_DOMAIN}:${CADDY_PORT}"
    [ "${CADDY_PORT}" = "443" ] && url="${scheme}://${CADDY_DOMAIN}"

    echo -e "${BLUE}Checking what is actually served…${NC}"
    if curl -kfsS -o /dev/null -w "  HTTP %{http_code}\n" "${url}/" 2>/dev/null; then
      served_csp="$(curl -kfsSI "${url}/" 2>/dev/null | grep -i "^content-security-policy:" | head -1 || true)"
      if [ -n "${served_csp}" ]; then
        echo -e "  ${GREEN}✓${NC} Content-Security-Policy is being sent"
      else
        echo -e "  ${RED}✗${NC} No CSP on the served response — check the Caddyfile header block"
      fi
      coep="$(curl -kfsSI "${url}/" 2>/dev/null | grep -i "^cross-origin-embedder-policy:" | head -1 || true)"
      if [ -n "${coep}" ]; then
        echo -e "  ${GREEN}✓${NC} Cross-origin isolation headers present"
      else
        echo -e "  ${YELLOW}!${NC} No COEP — the semantic pack's threaded runtime will not start"
      fi
    else
      echo -e "  ${YELLOW}!${NC} No answer yet. With a real domain, Caddy needs DNS to resolve here"
      echo -e "    before it can obtain a certificate. ${BLUE}./deploy.sh --logs${NC} to watch."
    fi

    echo
    echo -e "${GREEN}✓ Airship is up at ${url}${NC}"
    echo -e "${BLUE}  ./deploy.sh --logs${NC}   follow output"
    echo -e "${BLUE}  ./deploy.sh --stop${NC}   stop"
    ;;
  3) docker compose down; echo -e "${GREEN}✓ Stopped${NC}" ;;
  4) docker compose logs -f ;;
  *) echo -e "${RED}Invalid choice${NC}"; exit 1 ;;
esac
