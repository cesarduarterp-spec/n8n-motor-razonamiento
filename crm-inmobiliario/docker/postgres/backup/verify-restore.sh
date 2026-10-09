#!/usr/bin/env bash
# Prueba de restauración (un backup que no se restauró nunca no es un backup).
# Restaura el último backup en un directorio temporal, aplica WAL hasta el final,
# levanta Postgres en otro puerto y verifica la cadena de auditoría de cada tenant.
#   docker compose run --rm pg-backup verify-restore.sh
set -euo pipefail
source /usr/local/bin/walg-env.sh
require_secure_backup

TARGET=$(mktemp -d /tmp/restore.XXXX)
trap 'pg_ctl -D "$TARGET" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$TARGET"' EXIT

wal-g backup-fetch "$TARGET" LATEST
touch "$TARGET/recovery.signal"
cat >> "$TARGET/postgresql.auto.conf" <<CONF
restore_command = 'wal-g wal-fetch %f %p'
recovery_target_action = 'promote'
archive_mode = off
port = 55433
CONF
chmod 700 "$TARGET"
pg_ctl -D "$TARGET" -o "-k /tmp" -w -t 600 start

psql -h /tmp -p 55433 -d "$PGDATABASE" -v ON_ERROR_STOP=1 <<'SQL'
\echo '== Tablas principales =='
SELECT 'tenants' t, count(*) FROM tenants UNION ALL
SELECT 'contracts', count(*) FROM contracts UNION ALL
SELECT 'audit_logs', count(*) FROM audit_logs;
\echo '== Integridad de la cadena de auditoría por tenant =='
SELECT t.id, v.entries, v.first_broken_seq IS NULL AS intact
  FROM tenants t,
       LATERAL (SELECT set_config('app.tenant_id', t.id::text, false)) s,
       LATERAL audit_verify_chain(t.id) v;
SQL
echo "[verify] restauración OK"
