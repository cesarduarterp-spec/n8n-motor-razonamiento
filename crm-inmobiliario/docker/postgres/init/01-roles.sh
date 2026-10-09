#!/usr/bin/env bash
# Se ejecuta una sola vez al crear el volumen de Postgres.
# POSTGRES_USER (crm_owner) es el dueño del esquema y corre las migraciones.
set -euo pipefail
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
  CREATE ROLE crm_app    LOGIN PASSWORD '${CRM_APP_PASSWORD}'    NOSUPERUSER NOBYPASSRLS;
  CREATE ROLE crm_system LOGIN PASSWORD '${CRM_SYSTEM_PASSWORD}' NOSUPERUSER BYPASSRLS;
  GRANT CONNECT ON DATABASE "${POSTGRES_DB}" TO crm_app, crm_system;
  CREATE EXTENSION IF NOT EXISTS vector;
SQL
