#!/usr/bin/env bash
set -euo pipefail
password=$(cat /run/secrets/search_bootstrap_password)
[[ "$password" =~ ^[a-zA-Z0-9]{16,128}$ ]] || exit 1
# Credentials go through a private file descriptor, never command arguments/logs.
curl --silent --fail --max-time 4 --config <(printf 'user = "elastic:%s"\n' "$password") \
  'http://localhost:9200/_cluster/health?wait_for_status=yellow&timeout=2s' \
  | grep -q '"timed_out":false'
