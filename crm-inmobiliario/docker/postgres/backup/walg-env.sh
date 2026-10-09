#!/usr/bin/env bash
# Configuración común de WAL-G. Destinos soportados:
#   S3 / compatible (MinIO, R2):  WALG_S3_PREFIX=s3://bucket/crm  + AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY/AWS_REGION
#   Google Cloud Storage:         WALG_GS_PREFIX=gs://bucket/crm  + GOOGLE_APPLICATION_CREDENTIALS=/run/secrets/gcs.json
# Cifrado del lado del cliente (los datos salen ya cifrados del servidor):
#   WALG_LIBSODIUM_KEY=<32 bytes en base64>  (openssl rand -base64 32)
#   o WALG_PGP_KEY_PATH=/run/secrets/backup.pub (+ WALG_PGP_KEY_PASSPHRASE para restaurar)
# Cifrado del lado del bucket (adicional): WALG_S3_SSE=aws:kms [+ WALG_S3_SSE_KMS_ID]
export WALG_COMPRESSION_METHOD="${WALG_COMPRESSION_METHOD:-brotli}"
export WALG_DELTA_MAX_STEPS="${WALG_DELTA_MAX_STEPS:-6}"       # backups delta (incrementales) entre fulls
export WALG_UPLOAD_CONCURRENCY="${WALG_UPLOAD_CONCURRENCY:-4}"
export WALG_LIBSODIUM_KEY_TRANSFORM="${WALG_LIBSODIUM_KEY_TRANSFORM:-base64}"
export PGHOST="${PGHOST:-/var/run/postgresql}" PGUSER="${PGUSER:-${POSTGRES_USER:-crm_owner}}" PGDATABASE="${PGDATABASE:-${POSTGRES_DB:-crm}}"

backup_configured() {
  [[ -n "${WALG_S3_PREFIX:-}" || -n "${WALG_GS_PREFIX:-}" ]]
}

encryption_configured() {
  [[ -n "${WALG_LIBSODIUM_KEY:-}" || -n "${WALG_PGP_KEY_PATH:-}" || -n "${WALG_PGP_KEY:-}" ]]
}

require_secure_backup() {
  backup_configured || { echo "[backup] ERROR: falta WALG_S3_PREFIX o WALG_GS_PREFIX" >&2; return 1; }
  encryption_configured || { echo "[backup] ERROR: backups sin cifrado de cliente no permitidos (WALG_LIBSODIUM_KEY / WALG_PGP_KEY_PATH)" >&2; return 1; }
}
