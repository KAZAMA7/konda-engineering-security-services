#!/bin/sh
set -eu

port="${PORT:-8080}"
case "$port" in
  *[!0-9]*) printf 'PORT must be an integer between 1024 and 65535\n' >&2; exit 1 ;;
esac
if [ "${#port}" -gt 5 ] || [ "$port" -lt 1024 ] || [ "$port" -gt 65535 ]; then
  printf 'PORT must be an integer between 1024 and 65535\n' >&2
  exit 1
fi

umask 077
sed "s/__PORT__/$port/g" /etc/nginx/nginx.conf.template > /tmp/nginx.conf
exec nginx -c /tmp/nginx.conf -g 'daemon off;'