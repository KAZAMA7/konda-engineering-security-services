FROM --platform=$BUILDPLATFORM node:25-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4 AS build

WORKDIR /app
ENV ASTRO_TELEMETRY_DISABLED=1

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-fund --no-audit
COPY . .

ARG VALIDATE_PRODUCTION=false
RUN case "$VALIDATE_PRODUCTION" in \
      true) npm run validate:production ;; \
      false) ;; \
      *) printf 'VALIDATE_PRODUCTION must be true or false\n' >&2; exit 1 ;; \
    esac \
    && npm run check \
    && npm test \
    && npm run build \
    && rm dist/_headers

FROM nginx:stable-alpine@sha256:ef8676b33d681f272ba429b27658bdd7e640963279714c96bddf1dc76307f7b6 AS runtime

COPY --from=build /app/dist/ /srv/site/
COPY --from=build /app/.deploy/nginx-security-headers.conf /etc/nginx/security-headers.conf
COPY infra/container/nginx.conf.template /etc/nginx/nginx.conf.template
COPY --chmod=0555 infra/container/entrypoint.sh /entrypoint.sh

USER 101:101
ENV PORT=8080
EXPOSE 8080
STOPSIGNAL SIGQUIT

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT:-8080}/healthz" || exit 1

ENTRYPOINT ["/entrypoint.sh"]