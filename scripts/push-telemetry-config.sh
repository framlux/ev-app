#!/usr/bin/env bash
# Pushes the Fleet Telemetry configuration to the vehicle, via ev-teslaproxy.
#
# This cannot be a plain authenticated POST: Tesla requires the configuration to
# be SIGNED with the application private key that the car's paired virtual key
# corresponds to. ev-teslaproxy holds that key and is ClusterIP-only, so this
# runs a pod inside the cluster rather than curling from a laptop.
#
# Preconditions are checked BEFORE the push, because Tesla reports none of them.
# An unpaired key or firmware below the floor is accepted, applied to nothing,
# and leaves fleet_telemetry_config reporting synced: false forever - which is
# indistinguishable from a car that is merely asleep.
#
# The FIELD LIST is not here. It is `packages/tesla/src/catalogue.ts`, printed
# in Tesla's shape by scripts/telemetry-fields.mjs, because what we ask the car
# for has to agree with what we decode and what we store - and a shell script
# cannot be checked against either. See step 5.
#
#   pnpm --filter @ev/tesla build
#   CLIENT_ID=... REFRESH_TOKEN=... ./scripts/push-telemetry-config.sh [VIN]
set -euo pipefail

# Resolved rather than assumed, so the script works from any working directory;
# it needs the repo to reach the field catalogue.
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

NS=ev
POD=ev-teslacmd-push
HOSTNAME_=ev-telemetry.framlux.io
PORT=443
MIN_FW_YEAR=2024
MIN_FW_WEEK=26

step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
pass() { printf '   \033[32mPASS\033[0m %s\n' "$1"; }
fail() { printf '   \033[31mFAIL\033[0m %s\n' "$1"; exit 1; }
info() { printf '        %s\n' "$1"; }

for bin in kubectl curl python3 base64 node; do
  command -v "$bin" >/dev/null || { echo "required command not found: $bin" >&2; exit 2; }
done
: "${CLIENT_ID:?set CLIENT_ID}" "${REFRESH_TOKEN:?set REFRESH_TOKEN}"

TMP=$(mktemp -d)
cleanup() {
  rm -rf "$TMP"
  kubectl -n "$NS" delete pod "$POD" --ignore-not-found --wait=false >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

# --------------------------------------------------------------- token
step "1. Access token"
curl -sS -X POST https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token \
  -H 'content-type: application/x-www-form-urlencoded' \
  -d grant_type=refresh_token -d client_id="$CLIENT_ID" \
  -d refresh_token="$REFRESH_TOKEN" -o "$TMP/tok.json"
ACCESS=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("access_token",""))' "$TMP/tok.json")
[ -n "$ACCESS" ] || { sed 's/^/        /' "$TMP/tok.json"; fail "no access_token"; }
printf '%s' "$ACCESS" > "$TMP/token"
pass "minted an access token"

# --------------------------------------------------------------- pod
# Started early: every later step needs it, and the NetworkPolicy admits this
# label specifically.
step "2. In-cluster client"
kubectl -n "$NS" get secret ev-teslaproxy-tls -o jsonpath='{.data.ca\.crt}' | base64 -d > "$TMP/proxy-ca.crt"
[ -s "$TMP/proxy-ca.crt" ] || fail "ev-teslaproxy-tls has no ca.crt"
kubectl -n "$NS" run "$POD" --labels=app.kubernetes.io/name=ev-teslacmd \
  --image=curlimages/curl:8.11.1 --restart=Never --command -- sleep 1800 >/dev/null
kubectl -n "$NS" wait --for=condition=Ready "pod/$POD" --timeout=90s >/dev/null
kubectl -n "$NS" exec -i "$POD" -- sh -c 'cat > /tmp/ca.crt'  < "$TMP/proxy-ca.crt"
kubectl -n "$NS" exec -i "$POD" -- sh -c 'cat > /tmp/token'   < "$TMP/token"
pass "probe pod ready"

# api <method> <path> [bodyfile] -> writes /tmp/out in pod, echoes status
api() {
  local method=$1 path=$2 body=${3:-}
  if [ -n "$body" ]; then
    kubectl -n "$NS" exec -i "$POD" -- sh -c 'cat > /tmp/body.json' < "$body"
    # shellcheck disable=SC2016
    kubectl -n "$NS" exec "$POD" -- sh -c "curl -sS --max-time 60 -o /tmp/out -w '%{http_code}' \
      --cacert /tmp/ca.crt -X $method \
      -H \"Authorization: Bearer \$(cat /tmp/token)\" \
      -H 'content-type: application/json' --data @/tmp/body.json \
      https://ev-teslaproxy.ev.svc.cluster.local:4443$path"
  else
    # shellcheck disable=SC2016
    kubectl -n "$NS" exec "$POD" -- sh -c "curl -sS --max-time 60 -o /tmp/out -w '%{http_code}' \
      --cacert /tmp/ca.crt -X $method \
      -H \"Authorization: Bearer \$(cat /tmp/token)\" \
      https://ev-teslaproxy.ev.svc.cluster.local:4443$path"
  fi
}
apibody() { kubectl -n "$NS" exec "$POD" -- cat /tmp/out; }

# --------------------------------------------------------------- vin
step "3. Vehicle"
VIN=${1:-}
CODE=$(api GET /api/1/vehicles)
[ "$CODE" = "200" ] || { apibody | sed 's/^/        /'; fail "GET /vehicles returned $CODE"; }
apibody > "$TMP/vehicles.json"
if [ -z "$VIN" ]; then
  VIN=$(python3 - "$TMP/vehicles.json" <<'EOF'
import json,sys
v=json.load(open(sys.argv[1]))["response"]
# Refuse to guess with more than one car: picking the wrong VIN configures the
# wrong vehicle and the mistake is invisible until data arrives from it.
print(v[0]["vin"] if len(v)==1 else "")
EOF
)
  [ -n "$VIN" ] || fail "more than one vehicle - pass the VIN as an argument"
fi
pass "VIN $VIN"

# --------------------------------------------------------------- preflight
step "4. Preconditions"
printf '{"vins":["%s"]}' "$VIN" > "$TMP/status-req.json"
CODE=$(api POST /api/1/vehicles/fleet_status "$TMP/status-req.json")
[ "$CODE" = "200" ] || { apibody | sed 's/^/        /'; fail "fleet_status returned $CODE"; }
apibody > "$TMP/status.json"
python3 - "$TMP/status.json" "$VIN" "$MIN_FW_YEAR" "$MIN_FW_WEEK" <<'EOF'
import json,sys
d=json.load(open(sys.argv[1]))["response"]
vin, fy, fw = sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
paired = vin in (d.get("key_paired_vins") or [])
info = (d.get("vehicle_info") or {}).get(vin, {})
ver = info.get("firmware_version","")
blockers=[]
if not paired:
    blockers.append("virtual key not paired - pair at https://www.tesla.com/_ak/<developer-domain>")
if not ver:
    blockers.append("no firmware_version reported; cannot verify the floor")
else:
    # Numeric per component, never lexical: a string compare puts "2024.9"
    # above "2024.26" and would pass a car four months too old.
    parts=[int(x) for x in ver.split(".")[:2] if x.isdigit()]
    ok = len(parts)>=2 and (parts[0]>fy or (parts[0]==fy and parts[1]>=fw))
    if not ok:
        blockers.append(f"firmware {ver} is below the {fy}.{fw} floor")
print(f"        firmware: {ver or '(unknown)'}")
print(f"        key paired: {paired}")
if info.get("safety_screen_streaming_toggle_enabled") is False:
    print('        WARNING: "Allow Third-Party App Data Streaming" is off on the car')
if blockers:
    for b in blockers: print(f"        BLOCKER: {b}")
    sys.exit(1)
EOF
pass "preconditions met"

# --------------------------------------------------------------- config
step "5. Building the configuration"
kubectl -n "$NS" get secret ev-telemetry-ca -o jsonpath='{.data.tls\.crt}' | base64 -d > "$TMP/ca.pem"
grep -q "BEGIN CERTIFICATE" "$TMP/ca.pem" || fail "ev-telemetry-ca holds no certificate"
# The CA the CAR pins - our private root, not the server's own leaf and not a
# public chain. Getting this wrong is silent: the car accepts the config and
# then fails every connection.
info "ca: $(grep -c 'BEGIN CERTIFICATE' "$TMP/ca.pem") certificate(s) from ev-telemetry-ca"

# The field list, from packages/tesla/src/catalogue.ts, in the shape the API
# takes: interval_seconds from the entry's tier and minimum_delta from its
# delta. It lives there and not here because an unknown field name is DROPPED by
# the car, not refused - a name that does not match the normaliser costs a signal
# with no error anywhere - and only a list in the repo can be tested against the
# vendored proto, the column catalogue and the schema. That test is
# packages/tesla/test/push-config.test.ts; this script's job is to send what it
# is given.
node "$ROOT/scripts/telemetry-fields.mjs" > "$TMP/fields.json" \
  || fail "could not build the field list - run: pnpm --filter @ev/tesla build"
COUNT=$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))))' "$TMP/fields.json")
# A config with no fields is accepted and stops the car streaming ANYTHING, which
# looks exactly like a car that is asleep. Refuse rather than push it.
[ "$COUNT" -gt 0 ] || fail "the catalogue emitted no fields"
info "$COUNT fields from packages/tesla/src/catalogue.ts"

python3 - "$TMP/ca.pem" "$VIN" "$HOSTNAME_" "$PORT" "$TMP/fields.json" > "$TMP/config.json" <<'EOF'
import json,sys
ca=open(sys.argv[1]).read()
vin, host, port = sys.argv[2], sys.argv[3], int(sys.argv[4])
fields=json.load(open(sys.argv[5]))
cfg = {
    "vins": [vin],
    "config": {
        "hostname": host,
        "port": port,
        "ca": ca,
        # Typed enums rather than raw ints, decided before the normaliser is
        # written so the fixtures it is built against match production.
        "prefer_typed": True,
        "fields": fields,
    },
}
print(json.dumps(cfg))
EOF
info "$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["config"]["fields"]), "fields in the configuration")' "$TMP/config.json")"

# --------------------------------------------------------------- push
step "6. Pushing to the vehicle"
CODE=$(api POST /api/1/vehicles/fleet_telemetry_config "$TMP/config.json")
apibody > "$TMP/push.json"
if [ "$CODE" != "200" ]; then
  sed 's/^/        /' "$TMP/push.json"
  fail "push returned $CODE"
fi
sed 's/^/        /' "$TMP/push.json"
pass "accepted by Tesla"

# --------------------------------------------------------------- poll
step "7. Waiting for the car to apply it"
info "A sleeping car applies this on its next check-in. Waiting is normal,"
info "not a fault; Ctrl-C is safe - the configuration stays queued."
for i in $(seq 1 60); do
  CODE=$(api GET "/api/1/vehicles/$VIN/fleet_telemetry_config")
  if [ "$CODE" = "200" ]; then
    apibody > "$TMP/cfg.json"
    SYNCED=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["response"].get("synced"))' "$TMP/cfg.json" 2>/dev/null || echo "?")
    if [ "$SYNCED" = "True" ]; then
      pass "synced: true - the car has the configuration"
      step "Done"
      info "Watch for the first connection:"
      info "  kubectl -n ev logs -f deploy/ev-telemetry"
      exit 0
    fi
    printf '   ...%2dm synced=%s\n' "$i" "$SYNCED"
  else
    printf '   ...%2dm HTTP %s\n' "$i" "$CODE"
  fi
  sleep 60
done
info "still not synced after 60 minutes - the car is probably asleep."
info "Re-check later without re-pushing:"
info "  ./scripts/check-telemetry-synced.sh $VIN"
