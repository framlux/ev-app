#!/usr/bin/env bash
# Subscribes to the telemetry stream and writes it to a local file.
#
# WHY THIS IS URGENT RATHER THAN OPTIONAL: MQTT is not a queue. With no
# subscriber holding a session, everything fleet-telemetry publishes is
# discarded the moment it arrives. ev-ingest is scaled to zero and has no image
# yet, so until it exists there is nothing catching any of this - and a drive
# that has already happened cannot be recovered.
#
# The output is the fixture set the normaliser and its contract tests are built
# against, so it wants a real drive, a real charge and some idle time.
#
#   ./scripts/capture-telemetry.sh [output-file]
#
# Ctrl-C to stop. Safe to run repeatedly; it only subscribes.
set -euo pipefail

NS=ev
POD=ev-capture
OUT=${1:-telemetry-capture-$(date +%Y%m%d-%H%M%S).jsonl}

command -v kubectl >/dev/null || { echo "kubectl not found" >&2; exit 2; }

cleanup() { kubectl -n "$NS" delete pod "$POD" --ignore-not-found --wait=false >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM
cleanup

# The label is what ev-mqtt-ingress admits. Only ev-telemetry and ev-ingest may
# reach the broker, so this pod borrows ev-ingest's identity.
#
# The client id must NOT be ev-fleet-telemetry or ev-ingest. MQTT permits one
# live connection per client id: reusing the publisher's would disconnect
# fleet-telemetry in a reconnect loop and lose the very data being captured.
#
# The password comes from the Secret via env rather than an -P argument, which
# would put it in the pod spec and the node's process list.
kubectl -n "$NS" run "$POD" \
  --labels=app.kubernetes.io/name=ev-ingest \
  --image=eclipse-mosquitto:2.0 --restart=Never \
  --overrides='{
    "spec": {
      "containers": [{
        "name": "'"$POD"'",
        "image": "eclipse-mosquitto:2.0",
        "command": ["sh","-c",
          "mosquitto_sub -h ev-mqtt.ev.svc.cluster.local -p 1883 -u telemetry -P \"$MQTT_PASSWORD\" -i ev-capture -t \"ev/#\" -q 1 -v"],
        "env": [{
          "name": "MQTT_PASSWORD",
          "valueFrom": {"secretKeyRef": {"name": "ev-mqtt-auth", "key": "MQTT_PASSWORD"}}
        }]
      }]
    }
  }' >/dev/null

echo "waiting for the subscriber to connect..."
kubectl -n "$NS" wait --for=condition=Ready "pod/$POD" --timeout=90s >/dev/null
echo "subscribed. Writing to $OUT - Ctrl-C to stop."
echo
echo "Nothing will appear until the car sends something. A parked, asleep car"
echo "is silent for hours; that is not a fault. Leave this running through a"
echo "drive and a charge."
echo

# tee so the shape is visible live while the file accumulates. -v prefixes each
# message with its topic, which is what identifies the record type.
kubectl -n "$NS" logs -f "$POD" | tee "$OUT"
