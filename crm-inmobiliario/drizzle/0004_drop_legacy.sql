ALTER TABLE "agent_runs" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "agent_runs" CASCADE;--> statement-breakpoint
ALTER TABLE "properties" DROP CONSTRAINT "properties_owner_contact_id_contacts_id_fk";
--> statement-breakpoint
DROP INDEX "leads_stage_idx";--> statement-breakpoint
ALTER TABLE "leads" ALTER COLUMN "stage_id" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "leads_stage_idx" ON "leads" USING btree ("tenant_id","stage_id");--> statement-breakpoint
ALTER TABLE "leads" DROP COLUMN "stage";--> statement-breakpoint
ALTER TABLE "properties" DROP COLUMN "owner_contact_id";--> statement-breakpoint
DROP TYPE "public"."lead_stage";