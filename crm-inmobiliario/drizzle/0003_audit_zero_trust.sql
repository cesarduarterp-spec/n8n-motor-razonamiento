-- ════════════════════════════════════════════════════════════════════
-- Zero-trust: auditoría inmutable, soft delete, versionado, capa privada,
-- pipeline por defecto y anti doble-reserva de visitas.
--
-- La auditoría vive en la base (triggers), no en el código: cualquier
-- mutación —API, workers, SQL manual— queda registrada con snapshots
-- old/new y el actor que la aplicación declara vía SET LOCAL:
--   app.actor_type  user | agent | system | public
--   app.user_id     uuid del usuario (si actor_type = user)
--   app.agent_id    'gemini-frontline' | 'claude-specialist' | 'booker' | ...
--   app.ip / app.user_agent / app.request_id
-- ════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint

-- ── Contexto del actor ──
CREATE OR REPLACE FUNCTION app_setting(name text) RETURNS text
  LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting(name, true), '') $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_actor_label() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE coalesce(app_setting('app.actor_type'), 'system')
    WHEN 'user'  THEN 'user:'  || coalesce(app_setting('app.user_id'), '?')
    WHEN 'agent' THEN 'agent:' || coalesce(app_setting('app.agent_id'), '?')
    WHEN 'public' THEN 'public'
    ELSE 'system:' || coalesce(app_setting('app.agent_id'), current_user)
  END $$;
--> statement-breakpoint

-- ── RLS para las tablas nuevas ──
DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'developments', 'property_units', 'price_lists', 'price_list_items',
    'listing_private_data', 'pipeline_stages', 'assignment_rules', 'assignment_state',
    'lead_requirements', 'property_matches', 'visits', 'ai_decision_logs'
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

-- Capa privada: política RESTRICTIVA adicional. Aunque el código del agente
-- IA o de las fichas intentara leerla, la base devuelve 0 filas.
CREATE POLICY private_layer ON listing_private_data AS RESTRICTIVE
  USING (app_setting('app.can_view_private') = 'on')
  WITH CHECK (app_setting('app.can_view_private') = 'on');
--> statement-breakpoint

-- ── Audit trail ──
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY audit_read ON audit_logs FOR SELECT USING (tenant_id = app_current_tenant());
--> statement-breakpoint
CREATE POLICY audit_append ON audit_logs FOR INSERT WITH CHECK (true);
--> statement-breakpoint
-- Nadie (ni la API ni los workers) puede escribir directo: solo los triggers SECURITY DEFINER.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON audit_logs FROM crm_app, crm_system;
--> statement-breakpoint
REVOKE ALL ON audit_chain_heads FROM crm_app, crm_system;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON ai_decision_logs FROM crm_app, crm_system;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% es append-only: % no permitido', TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;
--> statement-breakpoint
CREATE TRIGGER audit_logs_immutable BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON audit_logs FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER ai_logs_immutable BEFORE UPDATE OR DELETE ON ai_decision_logs FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER ai_logs_no_truncate BEFORE TRUNCATE ON ai_decision_logs FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint

-- Hash de una entrada (misma fórmula para escribir y para verificar).
CREATE OR REPLACE FUNCTION audit_entry_hash(
  p_prev text, p_tenant uuid, p_seq int, p_action audit_action, p_entity text, p_entity_id text,
  p_actor actor_type, p_user uuid, p_agent text, p_old jsonb, p_new jsonb, p_at timestamptz
) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(sha256(convert_to(concat_ws('|',
    p_prev, p_tenant::text, p_seq::text, p_action::text, p_entity, coalesce(p_entity_id, ''),
    p_actor::text, coalesce(p_user::text, ''), coalesce(p_agent, ''),
    coalesce(p_old::text, ''), coalesce(p_new::text, ''),
    to_char(p_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  ), 'UTF8')), 'hex') $$;
--> statement-breakpoint

-- Escribe una entrada encadenada. La fila de audit_chain_heads queda
-- bloqueada hasta el commit: serializa la cadena por tenant.
CREATE OR REPLACE FUNCTION audit_append(
  p_tenant uuid, p_action audit_action, p_entity text, p_entity_id text,
  p_old jsonb, p_new jsonb, p_changed text[]
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_head audit_chain_heads%ROWTYPE;
  v_actor actor_type := coalesce(app_setting('app.actor_type'), 'system')::actor_type;
  v_user uuid := CASE WHEN v_actor = 'user' THEN app_setting('app.user_id')::uuid END;
  v_agent text := app_setting('app.agent_id');
  v_at timestamptz := clock_timestamp();
  v_hash text;
BEGIN
  IF p_tenant IS NULL THEN RETURN; END IF;
  INSERT INTO audit_chain_heads (tenant_id) VALUES (p_tenant) ON CONFLICT DO NOTHING;
  SELECT * INTO v_head FROM audit_chain_heads WHERE tenant_id = p_tenant FOR UPDATE;
  v_hash := audit_entry_hash(v_head.last_hash, p_tenant, v_head.seq + 1, p_action, p_entity, p_entity_id,
                             v_actor, v_user, v_agent, p_old, p_new, v_at);
  INSERT INTO audit_logs (tenant_id, seq, action, entity_name, entity_id, actor_type, user_id, agent_id,
                          old_state, new_state, changed_fields, ip, user_agent, request_id, occurred_at, prev_hash, hash)
  VALUES (p_tenant, v_head.seq + 1, p_action, p_entity, p_entity_id, v_actor, v_user, v_agent,
          p_old, p_new, p_changed, app_setting('app.ip'), app_setting('app.user_agent'), app_setting('app.request_id'),
          v_at, v_head.last_hash, v_hash);
  UPDATE audit_chain_heads SET seq = seq + 1, last_hash = v_hash WHERE tenant_id = p_tenant;
END $$;
--> statement-breakpoint

-- Trigger genérico de filas.
CREATE OR REPLACE FUNCTION audit_row_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_old jsonb := CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END;
  v_new jsonb := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END;
  v_row jsonb := coalesce(v_new, v_old);
  v_tenant uuid := CASE WHEN TG_TABLE_NAME = 'tenants' THEN (v_row->>'id')::uuid ELSE (v_row->>'tenant_id')::uuid END;
  v_action audit_action;
  v_changed text[];
  -- Nunca se copian al log: vectores (ruido) ni secretos.
  v_strip text[] := ARRAY['embedding', 'ciphertext', 'password_hash'];
BEGIN
  v_old := v_old - v_strip;
  v_new := v_new - v_strip;

  IF TG_OP = 'INSERT' THEN
    v_action := 'CREATE';
  ELSIF TG_OP = 'DELETE' THEN
    v_action := 'DELETE';
  ELSE
    SELECT array_agg(k ORDER BY k) INTO v_changed
      FROM jsonb_object_keys(v_new) k
     WHERE k NOT IN ('updated_at', 'version') AND (v_old->k) IS DISTINCT FROM (v_new->k);
    IF v_changed IS NULL THEN RETURN NULL; END IF; -- UPDATE sin cambios reales

    IF (v_old->>'deleted_at') IS NULL AND (v_new->>'deleted_at') IS NOT NULL THEN
      v_action := 'DELETE';
    ELSIF (v_old->>'deleted_at') IS NOT NULL AND (v_new->>'deleted_at') IS NULL THEN
      v_action := 'RESTORE';
    ELSIF TG_TABLE_NAME = 'payment_schedules'
          AND ((v_new->>'status') IN ('paid', 'partial') AND (v_old->>'status') IS DISTINCT FROM (v_new->>'status')
               OR (v_old->>'paid_amount') IS DISTINCT FROM (v_new->>'paid_amount')) THEN
      v_action := 'PAYMENT_EXEC';
    ELSIF TG_TABLE_NAME = 'payment_receipts' AND (v_new->>'verified')::boolean AND NOT (v_old->>'verified')::boolean THEN
      v_action := 'PAYMENT_EXEC';
    ELSE
      v_action := 'UPDATE';
    END IF;
  END IF;

  PERFORM audit_append(v_tenant, v_action, TG_TABLE_NAME,
                       coalesce(v_row->>'id', v_row->>'contact_id'), v_old, v_new, v_changed);
  RETURN NULL;
END $$;
--> statement-breakpoint

-- Interacciones de IA: entrada compacta en el audit trail (el detalle completo vive en ai_decision_logs).
CREATE OR REPLACE FUNCTION audit_ai_interaction() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM audit_append(NEW.tenant_id, 'AI_INTERACTION', 'ai_decision_logs', NEW.id::text, NULL,
    jsonb_build_object('engine', NEW.engine, 'model', NEW.model, 'task', NEW.task, 'outcome', NEW.outcome,
                       'conversation_id', NEW.conversation_id, 'routing_reason', NEW.routing_reason,
                       'input_tokens', NEW.input_tokens, 'output_tokens', NEW.output_tokens), NULL);
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER audit_ai AFTER INSERT ON ai_decision_logs FOR EACH ROW EXECUTE FUNCTION audit_ai_interaction();
--> statement-breakpoint

-- Eventos de aplicación sin mutación (acceso a capa privada, exportación de fichas).
CREATE OR REPLACE FUNCTION audit_event(p_action audit_action, p_entity text, p_entity_id text, p_payload jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_action NOT IN ('PRIVATE_ACCESS', 'EXPORT') THEN
    RAISE EXCEPTION 'audit_event solo admite PRIVATE_ACCESS / EXPORT';
  END IF;
  PERFORM audit_append(app_current_tenant(), p_action, p_entity, p_entity_id, NULL, p_payload, NULL);
END $$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION audit_event(audit_action, text, text, jsonb) TO crm_app, crm_system;
--> statement-breakpoint

-- Verificación de integridad de la cadena: devuelve la primera entrada alterada (o ninguna).
CREATE OR REPLACE FUNCTION audit_verify_chain(p_tenant uuid)
RETURNS TABLE (entries int, first_broken_seq int) LANGUAGE plpgsql STABLE AS $$
DECLARE
  r audit_logs%ROWTYPE;
  v_prev text := 'GENESIS';
  v_n int := 0;
BEGIN
  FOR r IN SELECT * FROM audit_logs WHERE tenant_id = p_tenant ORDER BY seq LOOP
    v_n := v_n + 1;
    IF r.seq <> v_n OR r.prev_hash <> v_prev OR r.hash <> audit_entry_hash(r.prev_hash, r.tenant_id, r.seq, r.action,
         r.entity_name, r.entity_id, r.actor_type, r.user_id, r.agent_id, r.old_state, r.new_state, r.occurred_at) THEN
      entries := v_n; first_broken_seq := r.seq; RETURN NEXT; RETURN;
    END IF;
    v_prev := r.hash;
  END LOOP;
  entries := v_n; first_broken_seq := NULL; RETURN NEXT;
END $$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION audit_verify_chain(uuid) TO crm_app, crm_system;
--> statement-breakpoint

DO $$
DECLARE
  t text;
  audited text[] := ARRAY[
    'tenants', 'users', 'tenant_secrets', 'channel_accounts', 'properties', 'developments',
    'property_units', 'price_lists', 'price_list_items', 'listing_private_data', 'contacts',
    'contact_identities', 'leads', 'pipeline_stages', 'assignment_rules', 'lead_requirements',
    'property_matches', 'visits', 'conversations', 'messages', 'agent_drafts', 'contracts',
    'contract_parties', 'contract_documents', 'contract_adjustments', 'payment_schedules',
    'payment_receipts', 'settlements'
  ];
BEGIN
  FOREACH t IN ARRAY audited LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_audit ON %I', t);
    EXECUTE format('CREATE TRIGGER trg_audit AFTER INSERT OR UPDATE OR DELETE ON %I
                    FOR EACH ROW EXECUTE FUNCTION audit_row_change()', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- ── Soft delete + versionado ──
-- DELETE físico → UPDATE deleted_at/deleted_by. Escape controlado para la
-- baja definitiva de un tenant o un pedido de supresión (Ley 25.326):
-- SET LOCAL app.allow_hard_delete = 'on' (solo roles owner/system).
CREATE OR REPLACE FUNCTION soft_delete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_prev text;
BEGIN
  IF app_setting('app.allow_hard_delete') = 'on' AND current_user <> 'crm_app' THEN
    RETURN OLD;
  END IF;
  IF OLD.deleted_at IS NULL THEN
    -- La fila marcada deja de ser visible (política hide_deleted): se habilita
    -- la lectura de borrados solo durante este UPDATE y se restaura el valor previo.
    v_prev := coalesce(current_setting('app.include_deleted', true), 'off');
    PERFORM set_config('app.include_deleted', 'on', true);
    EXECUTE format('UPDATE %I.%I SET deleted_at = now(), deleted_by = $1 WHERE id = $2', TG_TABLE_SCHEMA, TG_TABLE_NAME)
      USING app_actor_label(), OLD.id;
    PERFORM set_config('app.include_deleted', v_prev, true);
  END IF;
  RETURN NULL; -- cancela el borrado físico
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION bump_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF to_jsonb(NEW) - ARRAY['updated_at', 'version'] IS DISTINCT FROM to_jsonb(OLD) - ARRAY['updated_at', 'version'] THEN
    NEW.version := OLD.version + 1;
  ELSE
    NEW.version := OLD.version;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DO $$
DECLARE
  t text;
  lifecycle_tables text[] := ARRAY[
    'properties', 'developments', 'property_units', 'price_lists', 'listing_private_data',
    'contacts', 'leads', 'messages', 'visits', 'contracts', 'payment_schedules', 'payment_receipts'
  ];
BEGIN
  FOREACH t IN ARRAY lifecycle_tables LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_soft_delete ON %I', t);
    EXECUTE format('CREATE TRIGGER trg_soft_delete BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION soft_delete()', t);
    EXECUTE format('DROP TRIGGER IF EXISTS trg_version ON %I', t);
    EXECUTE format('CREATE TRIGGER trg_version BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION bump_version()', t);
    -- Las filas borradas desaparecen de las lecturas salvo pedido explícito (papelera / auditoría).
    EXECUTE format('DROP POLICY IF EXISTS hide_deleted ON %I', t);
    EXECUTE format($p$CREATE POLICY hide_deleted ON %I AS RESTRICTIVE FOR SELECT
                      USING (deleted_at IS NULL OR app_setting('app.include_deleted') = 'on')$p$, t);
  END LOOP;
END $$;
--> statement-breakpoint

-- ── Pipeline por defecto ──
CREATE OR REPLACE FUNCTION seed_default_pipeline(p_tenant uuid) RETURNS void LANGUAGE sql AS $$
  INSERT INTO pipeline_stages (tenant_id, key, name, position, is_won, is_lost, sla_hours) VALUES
    (p_tenant, 'new',             'Nuevo lead',        1, false, false, 2),
    (p_tenant, 'qualified',       'Calificado',        2, false, false, 24),
    (p_tenant, 'visit_scheduled', 'Visita coordinada', 3, false, false, 72),
    (p_tenant, 'appraisal',       'Tasación',          4, false, false, 120),
    (p_tenant, 'negotiation',     'Negociación',       5, false, false, 168),
    (p_tenant, 'reservation',     'Reserva',           6, false, false, 168),
    (p_tenant, 'closed_won',      'Cierre',            7, true,  false, NULL),
    (p_tenant, 'closed_lost',     'Perdido',           8, false, true,  NULL)
  ON CONFLICT (tenant_id, key) DO NOTHING $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION trg_seed_pipeline() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM seed_default_pipeline(NEW.id); RETURN NULL; END $$;
--> statement-breakpoint
CREATE TRIGGER tenants_seed_pipeline AFTER INSERT ON tenants FOR EACH ROW EXECUTE FUNCTION trg_seed_pipeline();
--> statement-breakpoint
SELECT seed_default_pipeline(id) FROM tenants;
--> statement-breakpoint

-- Lead sin etapa → primera etapa del tenant.
CREATE OR REPLACE FUNCTION leads_default_stage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.stage_id IS NULL THEN
    SELECT id INTO NEW.stage_id FROM pipeline_stages WHERE tenant_id = NEW.tenant_id ORDER BY position LIMIT 1;
  END IF;
  IF TG_OP = 'INSERT' OR NEW.stage_id IS DISTINCT FROM OLD.stage_id THEN
    NEW.stage_changed_at := now();
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER leads_stage BEFORE INSERT OR UPDATE OF stage_id ON leads FOR EACH ROW EXECUTE FUNCTION leads_default_stage();
--> statement-breakpoint

-- Backfill del enum anterior a las etapas configurables.
UPDATE leads l SET stage_id = s.id
  FROM pipeline_stages s
 WHERE s.tenant_id = l.tenant_id AND l.stage_id IS NULL
   AND s.key = CASE l.stage::text
     WHEN 'new' THEN 'new' WHEN 'contacted' THEN 'new' WHEN 'qualified' THEN 'qualified'
     WHEN 'visit_scheduled' THEN 'visit_scheduled' WHEN 'negotiation' THEN 'negotiation'
     WHEN 'won' THEN 'closed_won' WHEN 'lost' THEN 'closed_lost' END;
--> statement-breakpoint

-- Datos de propietario: se mueven de properties a la capa privada.
INSERT INTO listing_private_data (tenant_id, property_id, owner_contact_id)
SELECT tenant_id, id, owner_contact_id FROM properties WHERE owner_contact_id IS NOT NULL
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- Historial de agent_runs → ai_decision_logs.
INSERT INTO ai_decision_logs (tenant_id, engine, model, task, input_ref, input_tokens, output_tokens, latency_ms, outcome, detail, created_at)
SELECT tenant_id, engine, model, task, input_ref, input_tokens, output_tokens, latency_ms, outcome, detail, created_at FROM agent_runs;
--> statement-breakpoint

-- ── Visitas: un asesor no puede tener dos visitas superpuestas ──
ALTER TABLE visits ADD CONSTRAINT visits_no_overlap
  EXCLUDE USING gist (user_id WITH =, tstzrange(starts_at, ends_at) WITH &&)
  WHERE (status = 'scheduled' AND deleted_at IS NULL);
--> statement-breakpoint
ALTER TABLE visits ADD CONSTRAINT visits_valid_range CHECK (ends_at > starts_at);
--> statement-breakpoint
ALTER TABLE listing_private_data ADD CONSTRAINT listing_private_one_target
  CHECK ((property_id IS NULL) <> (development_id IS NULL));
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON
  developments, property_units, price_lists, price_list_items, listing_private_data, pipeline_stages,
  assignment_rules, assignment_state, lead_requirements, property_matches, visits
  TO crm_app, crm_system;
--> statement-breakpoint
GRANT SELECT, INSERT ON ai_decision_logs TO crm_app, crm_system;
--> statement-breakpoint
GRANT SELECT ON audit_logs TO crm_app, crm_system;
--> statement-breakpoint

-- Triggers updated_at para las tablas nuevas.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT table_name FROM information_schema.columns
            WHERE table_schema = 'public' AND column_name = 'updated_at'
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_touch ON %I', r.table_name);
    EXECUTE format('CREATE TRIGGER trg_touch BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION touch_updated_at()', r.table_name);
  END LOOP;
END $$;
