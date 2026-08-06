# Airship — static PWA, built once and served by Caddy.
#
# Unlike the proxy services in this fleet there is no application process at
# runtime: the browser *is* the application, and this image ships the compiled
# bundle plus the web server that hands it over with the right headers.
#
# The build is the load-bearing stage. Vite inlines its `VITE_*` inputs at build
# time, so a variable supplied only at `docker run` reaches nothing — every
# deployment-shaped value has to arrive here as a build argument.

FROM node:22-slim AS build
WORKDIR /app

# Dependencies first so a source-only change does not re-resolve the tree.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Where the app is served from. `/` for a domain root; a subpath needs the
# trailing slash (`/airship/`) or the manifest and service worker resolve wrong.
ARG AIRSHIP_PUBLIC_BASE_PATH=/
# The origin the app tells providers to return to. OAuth redirects are compared
# against this exactly, so it must match the domain Caddy answers on.
ARG VITE_AIRSHIP_PUBLIC_ORIGIN=
# Optional provider registrations. Absent is a supported configuration: Vite
# strips the Drive connect branch entirely when the Google client ID is empty,
# which is why the default vault provider below moves with it.
ARG VITE_GOOGLE_CLIENT_ID=
ARG VITE_AIRSHIP_CHUTES_PUBLIC_CLIENT_ID=

ENV AIRSHIP_PUBLIC_BASE_PATH=${AIRSHIP_PUBLIC_BASE_PATH} \
    VITE_AIRSHIP_PUBLIC_ORIGIN=${VITE_AIRSHIP_PUBLIC_ORIGIN} \
    VITE_GOOGLE_CLIENT_ID=${VITE_GOOGLE_CLIENT_ID} \
    VITE_AIRSHIP_CHUTES_PUBLIC_CLIENT_ID=${VITE_AIRSHIP_CHUTES_PUBLIC_CLIENT_ID}

# Fail closed on an unconfigured deployment: start in explicit page-memory mode
# rather than silently creating durable storage the person did not choose.
RUN if [ -n "$VITE_GOOGLE_CLIENT_ID" ]; then \
      export VITE_AIRSHIP_DEFAULT_VAULT_PROVIDER=google-drive; \
    else \
      export VITE_AIRSHIP_DEFAULT_VAULT_PROVIDER=ephemeral; \
    fi; \
    npm run build

# The app is hash-routed, but a deep link or a refresh can still arrive at a
# path the bundle does not emit. Same fallback the Pages workflow uses.
RUN cp dist/index.html dist/404.html


FROM caddy:2-alpine AS runtime

# Static output only. No node, no npm, no source — nothing at runtime can
# execute application code, because at runtime there is no application.
COPY --from=build /app/dist /srv

COPY Caddyfile /etc/caddy/Caddyfile
COPY caddy-entrypoint.sh /caddy-entrypoint.sh
RUN chmod +x /caddy-entrypoint.sh

EXPOSE 80 443
ENTRYPOINT ["/caddy-entrypoint.sh"]
