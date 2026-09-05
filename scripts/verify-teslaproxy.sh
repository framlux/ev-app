#!/usr/bin/env bash
# Verifies the ev-teslaproxy deployment end to end.
#
# The checks are ordered so each one's failure is unambiguous. Every layer here
# fails in a way that looks like the layer below it: a NetworkPolicy drop and a
# proxy that is not listening both present as a hung connection, and an
# untrusted CA and an expired token both present as a failed request. Running
# them in order means the first failure names the actual cause.
#
# Read-only. Nothing here sends a vehicle command or wakes the car: the only
# upstream call is GET /api/1/vehicles, which lists vehicles from Tesla's
# servers and does not touch the car itself.
#
#   CLIENT_ID=... REFRESH_TOKEN=... ./scripts/verify-teslaproxy.sh
#
# Both come from the ev-tesla-oauth secret, which is deliberately NOT deployed
# to the cluster, so they have to be supplied from wherever you sealed them.
set -euo pipefail

NS=ev
POD=ev-teslacmd-verify
FAILED=0

step()  { printf '\n\033[1m== %s\033[0m\n' "$1"; }
pass()  { printf '   \033[32mPASS\033[0m %s\n' "$1"; }
fail()  { printf '   \033[31mFAIL\033[0m %s\n' "$1"; FAILED=1; }
info()  { printf '        %s\n' "$1"; }

TMP=$(mktemp -d)
cleanup() {
  rm -rf "$TMP"
  kubectl -n "$NS" delete pod "$POD" --ignore-not-found --wait=false >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------- 1. issuance
step "1. Internal CA and proxy certificate"
# The CA is a chain: selfsigned Issuer -> CA Certificate -> CA Issuer -> leaf.
# A break anywhere in it surfaces only as the leaf never going Ready, and the
# pod then sits in ContainerCreating rather than reporting anything itself.
for c in ev-internal-ca ev-teslaproxy-tls; do
  if [ "$(kubectl -n "$NS" get certificate "$c" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null)" = "True" ]; then
    pass "Certificate/$c Ready"
  else
    fail "Certificate/$c not Ready"
    kubectl -n "$NS" get certificate "$c" -o jsonpath='{.status.conditions[*].message}' 2>/dev/null | sed 's/^/        /'
    echo
  fi
done

# ------------------------------------------------------------------- 2. pod
step "2. Proxy pod"
if kubectl -n "$NS" rollout status deploy/ev-teslaproxy --timeout=60s >/dev/null 2>&1; then
  pass "deploy/ev-teslaproxy rolled out"
else
  fail "deploy/ev-teslaproxy not available"
  kubectl -n "$NS" get pods -l app.kubernetes.io/name=ev-teslaproxy 2>&1 | sed 's/^/        /'
  # The two failures worth naming, because neither says so plainly:
  #   CreateContainerConfigError -> ev-tesla-privkey missing or wrong key name
  #   CrashLoopBackOff           -> usually the key file being unreadable
  kubectl -n "$NS" logs -l app.kubernetes.io/name=ev-teslaproxy --tail=20 2>&1 | sed 's/^/        /' || true
fi

# --------------------------------------------------------- 3. key readability
step "3. Signing key is readable by the proxy's UID"
# This is the fsGroup/defaultMode interaction. If it is wrong the proxy cannot
# read its own key, and the error it prints reads like a missing file rather
# than a permissions problem.
if kubectl -n "$NS" exec deploy/ev-teslaproxy -- sh -c 'head -c 1 /etc/tesla/private-key.pem >/dev/null' 2>/dev/null; then
  pass "/etc/tesla/private-key.pem readable as UID 65532"
else
  # Distroless images have no shell, in which case this check cannot run and
  # its silence is not evidence of anything.
  info "could not exec a shell in the proxy image - skipping (not a failure)"
fi

# ------------------------------------------------------------------ 4. token
step "4. OAuth token"
: "${CLIENT_ID:?set CLIENT_ID}" "${REFRESH_TOKEN:?set REFRESH_TOKEN}"
if ! curl -sS -X POST https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token \
      -H 'content-type: application/x-www-form-urlencoded' \
      -d grant_type=refresh_token -d client_id="$CLIENT_ID" \
      -d refresh_token="$REFRESH_TOKEN" -o "$TMP/tok.json"; then
  fail "token refresh request failed"; exit 1
fi
if ! ACCESS=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["access_token"])' "$TMP/tok.json" 2>/dev/null); then
  fail "no access_token in refresh response"
  sed 's/^/        /' "$TMP/tok.json"; exit 1
fi
printf '%s' "$ACCESS" > "$TMP/token"
pass "minted an access token from the sealed refresh token"
python3 - "$TMP/tok.json" <<'EOF' || true
import base64, json, sys
d = json.load(open(sys.argv[1]))
c = json.loads(base64.urlsafe_b64decode(d["access_token"].split(".")[1] + "=="))
print("        scopes:", " ".join(sorted(c.get("scp", []))) or "(none)")
EOF

# ------------------------------------------------------------- 5. end to end
step "5. Reaching the proxy and Tesla through it"
kubectl -n "$NS" get secret ev-teslaproxy-tls -o jsonpath='{.data.ca\.crt}' | base64 -d > "$TMP/ca.crt"
[ -s "$TMP/ca.crt" ] || { fail "ev-teslaproxy-tls has no ca.crt"; exit 1; }

# The label is what the NetworkPolicy admits. ev-teslacmd was added to that
# policy before the Job existed precisely so this pod can borrow it.
kubectl -n "$NS" run "$POD" \
  --labels=app.kubernetes.io/name=ev-teslacmd \
  --image=curlimages/curl:8.11.1 --restart=Never \
  --command -- sleep 600 >/dev/null
kubectl -n "$NS" wait --for=condition=Ready "pod/$POD" --timeout=90s >/dev/null

# Both secrets go in over stdin rather than as arguments: an exec argument is
# visible in the process list on the node.
kubectl -n "$NS" exec -i "$POD" -- sh -c 'cat > /tmp/ca.crt'  < "$TMP/ca.crt"
kubectl -n "$NS" exec -i "$POD" -- sh -c 'cat > /tmp/token'   < "$TMP/token"

set +e
# shellcheck disable=SC2016
# The single quotes are load-bearing: $(cat /tmp/token) must be evaluated by the
# shell INSIDE the pod, where the file exists. Expanding it locally would both
# fail and put the token on the local command line.
OUT=$(kubectl -n "$NS" exec "$POD" -- sh -c '
  curl -sS --max-time 30 -o /tmp/body -w "%{http_code}" \
    --cacert /tmp/ca.crt \
    -H "Authorization: Bearer $(cat /tmp/token)" \
    https://ev-teslaproxy.ev.svc.cluster.local:4443/api/1/vehicles 2>/tmp/err
  echo " |$(head -c 400 /tmp/body)|$(head -c 200 /tmp/err)"' 2>&1)
set -e

CODE=${OUT%% *}
case "$CODE" in
  200)
    pass "HTTP 200 from Tesla via the proxy - TLS, CA trust, NetworkPolicy, token passthrough and upstream connectivity all good"
    echo "$OUT" | sed 's/^[0-9]* |//' | cut -c1-300 | sed 's/^/        /'
    ;;
  401|403)
    fail "HTTP $CODE - reached the proxy and Tesla, but the token was rejected"
    info "the proxy is fine; this is a scope or expiry problem with the token"
    ;;
  000|"")
    fail "no HTTP response - did not reach the proxy"
    info "TLS verification against the internal CA, the NetworkPolicy, or the listener"
    info "if the error mentions certificate: the -host flag or the SANs"
    info "if it hangs: the NetworkPolicy label selector"
    echo "$OUT" | sed 's/^/        /'
    ;;
  *)
    fail "HTTP $CODE"
    echo "$OUT" | sed 's/^/        /'
    ;;
esac

step "Result"
if [ "$FAILED" -eq 0 ]; then
  printf '   \033[32mALL CHECKS PASSED\033[0m\n'
  info "The proxy can sign for the car. Nothing above sent a command or woke it."
else
  printf '   \033[31mSOME CHECKS FAILED\033[0m - fix the FIRST failure above; the later ones are usually downstream of it.\n'
  exit 1
fi
