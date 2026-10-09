#!/usr/bin/env bash
# archive_command de Postgres: sube cada segmento WAL (RPO ≈ archive_timeout).
# Si el backup no está configurado:
#   BACKUP_REQUIRED=true  → falla (Postgres reintenta y retiene el WAL: nada se pierde, alerta por disco)
#   BACKUP_REQUIRED=false → descarta (solo desarrollo)
set -euo pipefail
source /usr/local/bin/walg-env.sh
if ! backup_configured; then
  [[ "${BACKUP_REQUIRED:-true}" == "true" ]] && { echo "[archive] backup no configurado y BACKUP_REQUIRED=true" >&2; exit 1; }
  exit 0
fi
require_secure_backup
exec wal-g wal-push "$1"
