#!/usr/bin/env bash
set -euo pipefail
admin=$(cat /run/secrets/search_bootstrap_password)
runtime=$(cat /run/secrets/search_runtime_password)
[[ "$admin" =~ ^[a-zA-Z0-9]{16,128}$ && "$runtime" =~ ^[a-zA-Z0-9]{16,128}$ ]] || {
  echo 'Search secret files require 16-128 alphanumeric characters.' >&2; exit 1;
}
[[ "$admin" != "$runtime" ]] || { echo 'Bootstrap and runtime secrets must differ.' >&2; exit 1; }
auth() { printf 'user = "elastic:%s"\n' "$admin"; }
curl --silent --fail --max-time 15 --config <(auth) -H 'Content-Type: application/json' \
  -X PUT 'http://elasticsearch:9200/_security/role/qyvra_search' \
  --data-binary '{"cluster":["monitor"],"indices":[{"names":["qyvra-search-*"],"privileges":["read","write","create_index","view_index_metadata","maintenance"]}]}' > /dev/null
printf '{"password":"%s","roles":["qyvra_search"]}' "$runtime" \
  | curl --silent --fail --max-time 15 --config <(auth) -H 'Content-Type: application/json' \
    -X PUT 'http://elasticsearch:9200/_security/user/qyvra_search' --data-binary @- > /dev/null
echo 'Private search runtime role provisioned.'
