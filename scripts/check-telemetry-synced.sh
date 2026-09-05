#!/usr/bin/env bash
# Reports whether the vehicle has applied the pushed Fleet Telemetry config.
#
# Safe to run repeatedly and safe to run after Ctrl-C'ing the push script: it
# only reads. The configuration stays queued at Tesla until the car next checks
# in, so a `false` here means "not yet", not "the push failed".
#
#   CLIENT_ID=... REFRESH_TOKEN=... ./scripts/check-telemetry-synced.sh <VIN>
set -euo pipefail

NS=ev
POD=ev-teslacmd-check
VIN=${1:?usage: check-telemetry-synced.sh <VIN>}
: "${CLIENT_ID:?set CLIENT_ID}" "${REFRESH_TOKEN:?set REFRESH_TOKEN}"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"; kubectl -n "$NS" delete pod "$POD" --ignore-not-found --wait=false >/dev/null 2>&1 || true' EXIT INT TERM

curl -sS -X POST https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token \
  -H 'content-type: application/x-www-form-urlencoded' \
  -d grant_type=refresh_token -d client_id="$CLIENT_ID" \
  -d refresh_token="$REFRESH_TOKEN" -o "$TMP/tok.json"
python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["access_token"])' "$TMP/tok.json" > "$TMP/token"

kubectl -n "$NS" get secret ev-teslaproxy-tls -o jsonpath='{.data.ca\.crt}' | base64 -d > "$TMP/ca.crt"
kubectl -n "$NS" run "$POD" --labels=app.kubernetes.io/name=ev-teslacmd \
  --image=curlimages/curl:8.11.1 --restart=Never --command -- sleep 120 >/dev/null
kubectl -n "$NS" wait --for=condition=Ready "pod/$POD" --timeout=90s >/dev/null
kubectl -n "$NS" exec -i "$POD" -- sh -c 'cat > /tmp/ca.crt' < "$TMP/ca.crt"
kubectl -n "$NS" exec -i "$POD" -- sh -c 'cat > /tmp/token' < "$TMP/token"

# shellcheck disable=SC2016
# Single quotes are required: $(cat /tmp/token) must expand inside the pod.
kubectl -n "$NS" exec "$POD" -- sh -c '
  curl -sS --max-time 30 --cacert /tmp/ca.crt \
    -H "Authorization: Bearer $(cat /tmp/token)" \
    https://ev-teslaproxy.ev.svc.cluster.local:4443/api/1/vehicles/'"$VIN"'/fleet_telemetry_config' \
  > "$TMP/cfg.json"

python3 - "$TMP/cfg.json" <<'EOF'
import json, sys
r = json.load(open(sys.argv[1])).get("response", {})
synced = r.get("synced")
print(f"synced: {synced}")
cfg = r.get("config") or {}
if cfg:
    print(f"hostname: {cfg.get('hostname')}:{cfg.get('port')}")
    print(f"fields: {len(cfg.get('fields') or {})}")
    # The car pins this. If it does not match ev-telemetry-ca, every connection
    # fails silently, which looks exactly like a car that never wakes.
    ca = cfg.get("ca") or ""
    print(f"ca: {'present' if 'BEGIN CERTIFICATE' in ca else 'MISSING'}")
if synced is not True:
    print("\nNot applied yet. The car applies this on its next check-in;")
    print("a sleeping car can take hours. Nothing needs re-pushing.")
    sys.exit(1)
EOF
