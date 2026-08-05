#!/usr/bin/env bash
set -euo pipefail

# Root-only production deployment with maintenance lock, candidate smoke, backup,
# and rollback. Does not publish npm and does not call real provider endpoints.
PROJECT_DIR="${PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
INSTALL_DIR="${INSTALL_DIR:-/opt/model-verity/lib/node_modules/model-verity}"
DATA_DIR="${DATA_DIR:-/var/lib/model-verity/config/model-verity}"
UNIT="${UNIT:-model-verity}"
PRODUCTION_HOST="${MODEL_VERITY_PRODUCTION_HOST:-127.0.0.1}"
PRODUCTION_PORT="${MODEL_VERITY_PRODUCTION_PORT:-8787}"
CANDIDATE_PORT="${MODEL_VERITY_CANDIDATE_PORT:-18787}"
ALLOWED_HOST="${ALLOWED_HOST:-modelverity.example}"
WAIT_SECONDS="${WAIT_SECONDS:-1800}"
SESSION_ID="deploy-$(date -u +%Y%m%dT%H%M%SZ)-$$"
LOCK="$DATA_DIR/maintenance.json"
BACKUP="/root/backups/model-verity/$SESSION_ID"
CANDIDATE_DATA="$(mktemp -d /tmp/model-verity-candidate-data.XXXXXX)"
CANDIDATE_PID=""
SWITCHED=0

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then echo "Run as root." >&2; exit 1; fi
mkdir -p "$DATA_DIR" "$BACKUP"
umask 077
if [[ -e "$LOCK" ]]; then echo "Maintenance lock already exists: $LOCK" >&2; exit 1; fi
printf '{"sessionId":"%s","createdAt":"%s"}\n' "$SESSION_ID" "$(date -u +%FT%TZ)" > "$LOCK"

cleanup() {
  local code=$?
  if [[ -n "$CANDIDATE_PID" ]]; then kill "$CANDIDATE_PID" 2>/dev/null || true; wait "$CANDIDATE_PID" 2>/dev/null || true; fi
  rm -rf "$CANDIDATE_DATA"
  if [[ $code -ne 0 && $SWITCHED -eq 1 ]]; then
    echo "Deployment failed after switch; restoring $BACKUP" >&2
    rm -rf "$INSTALL_DIR"
    cp -a "$BACKUP/install" "$INSTALL_DIR"
    cp -a "$BACKUP/model-verity.service" /etc/systemd/system/model-verity.service
    rm -rf "/etc/systemd/system/${UNIT}.service.d"
    if [[ -d "$BACKUP/systemd-dropin" ]]; then cp -a "$BACKUP/systemd-dropin" "/etc/systemd/system/${UNIT}.service.d"; fi
    systemctl daemon-reload
    systemctl restart "$UNIT" || true
  fi
  if [[ -f "$LOCK" ]] && grep -q "\"sessionId\":\"$SESSION_ID\"" "$LOCK"; then rm -f "$LOCK"; fi
  exit "$code"
}
trap cleanup EXIT INT TERM

cd "$PROJECT_DIR"
npm run typecheck
npm test
npm run build
# umask 077 protects backups/lock files but build artifacts must remain readable by
# the non-root systemd service account after copying into /opt.
chmod -R a+rX dist
chmod a+r package.json README.md LICENSE
npm audit --omit=dev --audit-level=high --registry=https://registry.npmjs.org

MODEL_VERITY_V2_EXPLORATORY_DEFAULT=1 MODEL_VERITY_ALLOWED_HOSTS="$ALLOWED_HOST" XDG_CONFIG_HOME="$CANDIDATE_DATA" \
  node dist/cli/index.js start --host 127.0.0.1 --port "$CANDIDATE_PORT" >"$BACKUP/candidate.log" 2>&1 &
CANDIDATE_PID=$!
for _ in {1..50}; do curl -fsS "http://127.0.0.1:$CANDIDATE_PORT/api/health" >"$BACKUP/candidate-health.json" && break; sleep .2; done
curl -fsS "http://127.0.0.1:$CANDIDATE_PORT/" | grep -q '<div id="root">'
curl -fsS "http://127.0.0.1:$CANDIDATE_PORT/api/providers" >/dev/null
curl -fsS "http://127.0.0.1:$CANDIDATE_PORT/api/v2/policy" | grep -q '"strongConclusionsEnabled":false'
legacy_status="$(curl -sS -o "$BACKUP/candidate-legacy-sunset.json" -w '%{http_code}' -H 'content-type: application/json' -d '{}' "http://127.0.0.1:$CANDIDATE_PORT/api/audits")"
[[ "$legacy_status" == "410" ]] || { echo "Candidate legacy write API did not return 410." >&2; exit 1; }
kill "$CANDIDATE_PID"; wait "$CANDIDATE_PID" || true; CANDIDATE_PID=""

# Existing tasks continue while maintenance blocks creation of new ones.
deadline=$((SECONDS + WAIT_SECONDS))
while :; do
  # Pre-Review-#005 production does not have /api/status yet; /api/runs is the
  # one-time bootstrap fallback. Future deployments use the maintenance-aware status API.
  status="$(curl -sS -H "Host: $ALLOWED_HOST" "http://$PRODUCTION_HOST:$PRODUCTION_PORT/api/status" || true)"
  if [[ -z "$status" || "$status" == *'"error":"not_found"'* || "$status" == *'"error":"not found"'* ]]; then
    status="$(curl -fsS -H "Host: $ALLOWED_HOST" "http://$PRODUCTION_HOST:$PRODUCTION_PORT/api/runs")"
  fi
  if [[ "$status" != *'"activeRun":true'* && "$status" != *'"status":"running"'* && "$status" != *'"status":"queued"'* ]]; then break; fi
  if (( SECONDS >= deadline )); then echo "Active task did not finish within $WAIT_SECONDS seconds; deployment stopped." >&2; exit 1; fi
  sleep 5
done

cp -a "$INSTALL_DIR" "$BACKUP/install"
cp -a /etc/systemd/system/model-verity.service "$BACKUP/model-verity.service"
if [[ -d "/etc/systemd/system/${UNIT}.service.d" ]]; then cp -a "/etc/systemd/system/${UNIT}.service.d" "$BACKUP/systemd-dropin"; fi
cp -a "$DATA_DIR" "$BACKUP/data"
# Preserve installed runtime dependencies; replace only project artifacts.
rm -rf "$INSTALL_DIR/dist"
mkdir -p "$INSTALL_DIR/dist"
cp -a "$PROJECT_DIR/dist/." "$INSTALL_DIR/dist/"
cp -a "$PROJECT_DIR/package.json" "$PROJECT_DIR/README.md" "$PROJECT_DIR/LICENSE" "$INSTALL_DIR/"
test -s "$INSTALL_DIR/dist/cli/index.js"
test -s "$INSTALL_DIR/dist/web/index.html"
SWITCHED=1
mkdir -p "/etc/systemd/system/${UNIT}.service.d"
printf '%s\n' '[Service]' 'Environment=MODEL_VERITY_V2_EXPLORATORY_DEFAULT=1' > "/etc/systemd/system/${UNIT}.service.d/v2-exploratory.conf"
systemctl daemon-reload
systemctl restart "$UNIT"
production_ready=0
for _ in {1..50}; do
  if curl -fsS --connect-timeout 1 --max-time 2 -H "Host: $ALLOWED_HOST" "http://$PRODUCTION_HOST:$PRODUCTION_PORT/api/health" >"$BACKUP/production-health.json"; then production_ready=1; break; fi
  sleep .2
done
if [[ $production_ready -ne 1 ]]; then
  journalctl -u "$UNIT" -n 40 --no-pager >"$BACKUP/production-journal.log" || true
  echo "Production health check did not become ready." >&2
  exit 1
fi
curl -fsS -H "Host: $ALLOWED_HOST" "http://$PRODUCTION_HOST:$PRODUCTION_PORT/" | grep -q '<div id="root">'
curl -fsS -H "Host: $ALLOWED_HOST" "http://$PRODUCTION_HOST:$PRODUCTION_PORT/api/providers" >/dev/null
curl -fsS -H "Host: $ALLOWED_HOST" "http://$PRODUCTION_HOST:$PRODUCTION_PORT/api/v2/policy" | grep -q '"strongConclusionsEnabled":false'
legacy_status="$(curl -sS -o "$BACKUP/production-legacy-sunset.json" -w '%{http_code}' -H "Host: $ALLOWED_HOST" -H 'content-type: application/json' -d '{}' "http://$PRODUCTION_HOST:$PRODUCTION_PORT/api/audits")"
[[ "$legacy_status" == "410" ]] || { echo "Production legacy write API did not return 410." >&2; exit 1; }
SWITCHED=0
echo "Production candidate deployed; npm was not published."
