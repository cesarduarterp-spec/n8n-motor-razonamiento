-- ════════════════════════════════════════════════════════════════════
-- Row-Level Security multi-tenant.
--
-- Roles (creados por infra en docker/postgres/init/01-roles.sh):
--   crm_owner  : dueño del esquema, ejecuta migraciones.
--   crm_app    : API HTTP. SIN BYPASSRLS → toda query queda filtrada por
--                app.tenant_id, que se setea con SET LOCAL en cada transacción.
--   crm_system : workers/cron y enrutamiento de webhooks. BYPASSRLS.
--
-- FORCE ROW LEVEL SECURITY hace que la política aplique también al dueño de
-- la tabla, de modo que un bug en el código no pueda saltear el aislamiento.
-- Si app.tenant_id no está seteado, nullif(...) devuelve NULL y la política
-- no matchea ninguna fila (deny by default).
-- ════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION app_current_tenant() RETURNS uuid
  LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;
--> statement-breakpoint

DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'tenant_secrets', 'users', 'channel_accounts', 'properties', 'contacts',
    'contact_identities', 'leads', 'conversations', 'messages',
    'conversation_memory', 'agent_drafts', 'agent_runs', 'contracts',
    'contract_parties', 'contract_documents', 'contract_adjustments',
    'payment_schedules', 'payment_receipts', 'settlements'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (tenant_id = app_current_tenant())
         WITH CHECK (tenant_id = app_current_tenant())', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- La tabla tenants se aísla por su propia PK.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_self ON tenants;
--> statement-breakpoint
CREATE POLICY tenant_self ON tenants
  USING (id = app_current_tenant())
  WITH CHECK (id = app_current_tenant());
--> statement-breakpoint

-- ── Grants ──
GRANT USAGE ON SCHEMA public TO crm_app, crm_system;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO crm_app, crm_system;
--> statement-breakpoint
-- index_rates es global y de solo lectura para la API; solo el worker la escribe.
REVOKE INSERT, UPDATE, DELETE ON index_rates FROM crm_app;
--> statement-breakpoint
-- agent_runs es un log de auditoría: append-only para la API.
REVOKE UPDATE, DELETE ON agent_runs FROM crm_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_current_tenant() TO crm_app, crm_system;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO crm_app, crm_system;
--> statement-breakpoint

-- ── updated_at automático ──
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;
--> statement-breakpoint
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'updated_at'
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_touch ON %I', r.table_name);
    EXECUTE format('CREATE TRIGGER trg_touch BEFORE UPDATE ON %I
                    FOR EACH ROW EXECUTE FUNCTION touch_updated_at()', r.table_name);
  END LOOP;
END $$;
