#!/usr/bin/env bash
set -euo pipefail

# Docker Desktop bind-mounted secrets may appear as 0777. Keep the original
# mount read-only; hand the official entrypoint a private, memory-backed copy.
secret_dir=/run/qyvra-search-secrets
[[ -d "$secret_dir" && -w "$secret_dir" && -r "$ELASTIC_PASSWORD_FILE" ]] || {
  echo 'Private Elasticsearch secret handoff is unavailable.' >&2
  exit 1
}
umask 077
cat -- "$ELASTIC_PASSWORD_FILE" > "$secret_dir/bootstrap_password"
chmod 600 "$secret_dir/bootstrap_password"
export ELASTIC_PASSWORD_FILE="$secret_dir/bootstrap_password"
exec /usr/local/bin/docker-entrypoint.sh "$@"
