#!/usr/bin/env bash
# Sidecar de backups: base backup diario (delta salvo cada WALG_DELTA_MAX_STEPS) y retención.
#   BACKUP_HOUR_UTC   hora del backup (por defecto 06 UTC = 03:00 AR)
#   BACKUP_RETAIN_FULL cantidad de backups FULL a conservar (por defecto 14)
set -euo pipefail
source /usr/local/bin/walg-env.sh
require_secure_backup

HOUR="${BACKUP_HOUR_UTC:-06}"
RETAIN="${BACKUP_RETAIN_FULL:-14}"

run_backup() {
  echo "[backup] $(date -u +%FT%TZ) base backup → ${WALG_S3_PREFIX:-${WALG_GS_PREFIX}}"
  wal-g backup-push "$PGDATA"
  wal-g delete retain FULL "$RETAIN" --confirm
  wal-g backup-list --detail | tail -n 5
}

# Primer backup al iniciar si no existe ninguno (un PITR necesita al menos un base backup).
wal-g backup-list >/dev/null 2>&1 && [[ -n "$(wal-g backup-list 2>/dev/null | tail -n +2)" ]] || run_backup

while true; do
  now=$(date -u +%s)
  next=$(date -u -d "today ${HOUR}:00" +%s)
  (( next <= now )) && next=$(date -u -d "tomorrow ${HOUR}:00" +%s)
  sleep $(( next - now ))
  run_backup || echo "[backup] ERROR en el backup de $(date -u +%F)" >&2
done
