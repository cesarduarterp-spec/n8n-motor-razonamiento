-- Agenda propia (reemplaza Google Calendar): RLS, auditoría y validaciones de availability_blocks.
ALTER TABLE availability_blocks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE availability_blocks FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON availability_blocks
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
--> statement-breakpoint
ALTER TABLE availability_blocks ADD CONSTRAINT availability_blocks_valid_range CHECK (ends_at > starts_at);
--> statement-breakpoint
CREATE TRIGGER trg_audit AFTER INSERT OR UPDATE OR DELETE ON availability_blocks
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
--> statement-breakpoint
CREATE TRIGGER trg_touch BEFORE UPDATE ON availability_blocks FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON availability_blocks TO crm_app, crm_system;
