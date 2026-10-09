# Runbook: restauración point-in-time (PITR)

> Probar este procedimiento al menos una vez por mes con `verify-restore.sh`.

1. Detener API y workers: `docker compose stop api worker`.
2. Detener Postgres y mover el data dir actual (no borrarlo hasta validar):
   `docker compose stop postgres && docker run --rm -v crm-inmobiliario_pgdata:/d alpine sh -c 'mv /d/pgdata /d/pgdata.broken'`
3. Restaurar el backup base más cercano anterior al incidente:
   `docker compose run --rm --entrypoint bash postgres -c 'source walg-env.sh && wal-g backup-fetch "$PGDATA" LATEST'`
   (o un nombre concreto de `wal-g backup-list`).
4. Configurar la recuperación en `$PGDATA/postgresql.auto.conf`:
   ```
   restore_command = 'wal-g wal-fetch %f %p'
   recovery_target_time = '2026-10-09 14:55:00-03'   # instante previo al incidente
   recovery_target_action = 'promote'
   ```
   y crear `$PGDATA/recovery.signal`.
5. Iniciar Postgres (`docker compose up -d postgres`), revisar logs hasta `database system is ready`.
6. Validar: `SELECT * FROM audit_verify_chain('<tenant>')` para cada tenant y conteos de negocio.
7. Levantar API y workers. Registrar el incidente (hora, objetivo de recuperación, datos perdidos).

**RPO** ≈ `archive_timeout` (60 s). **RTO** depende del tamaño del backup y del WAL a reproducir.

Archivos subidos (contratos, comprobantes): el volumen `uploads` no está en Postgres; en producción usar
un bucket S3/GCS con **versionado + Object Lock** (o `rclone sync` cifrado programado).
