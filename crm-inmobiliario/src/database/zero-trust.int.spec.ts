import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RequestContext } from '../common/audit/request-context.js';

/**
 * Integración contra Postgres real: auditoría, soft delete, versionado,
 * capa privada, cadena de hashes, pipeline, round-robin y anti doble reserva.
 * Requiere DATABASE_URL / DATABASE_SYSTEM_URL / DATABASE_OWNER_URL.
 */
const enabled = Boolean(process.env.DATABASE_URL && process.env.DATABASE_SYSTEM_URL && process.env.DATABASE_OWNER_URL);

describe.skipIf(!enabled)('zero-trust', async () => {
  const { DatabaseService } = await import('./database.service.js');
  const s = await import('./schema.js');
  const { PipelineService, stageIdSql } = await import('../modules/pipeline/pipeline.service.js');
  const pg = (await import('pg')).default;

  const db = new DatabaseService();
  const pipeline = new PipelineService(db);
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_OWNER_URL });
  let tenantId = '';
  let adminId = '';
  let agentA = '';
  let agentB = '';
  let propertyId = '';

  const asAdmin = <T>(fn: () => Promise<T>) =>
    RequestContext.run({ actorType: 'user', userId: adminId, role: 'admin', ip: '203.0.113.7', userAgent: 'vitest', requestId: 'req-1' }, fn);
  const auditOf = (entity: string, id: string) =>
    db.withTenant(tenantId, (tx) =>
      tx.select().from(s.auditLogs).where(and(eq(s.auditLogs.entityName, entity), eq(s.auditLogs.entityId, id))).orderBy(s.auditLogs.seq),
    );

  beforeAll(async () => {
    const [t] = await db.system.insert(s.tenants).values({ name: 'ZT', slug: `zt-${Date.now()}` }).returning({ id: s.tenants.id });
    tenantId = t!.id;
    const created = await db.withTenant(tenantId, (tx) =>
      tx
        .insert(s.users)
        .values([
          { tenantId, email: 'admin@zt', fullName: 'Admin', passwordHash: 'scrypt$x$y', role: 'admin' },
          { tenantId, email: 'a@zt', fullName: 'Asesora A', passwordHash: 'scrypt$x$y', role: 'sales_agent' },
          { tenantId, email: 'b@zt', fullName: 'Asesor B', passwordHash: 'scrypt$x$y', role: 'sales_agent' },
        ])
        .returning({ id: s.users.id, email: s.users.email }),
    );
    adminId = created.find((u) => u.email === 'admin@zt')!.id;
    agentA = created.find((u) => u.email === 'a@zt')!.id;
    agentB = created.find((u) => u.email === 'b@zt')!.id;
  });

  afterAll(async () => {
    // Baja definitiva del tenant de prueba: requiere el escape explícito de hard delete (rol system).
    await db.system.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.allow_hard_delete', 'on', true)`);
      await tx.delete(s.tenants).where(eq(s.tenants.id, tenantId));
    });
    await owner.end();
    await db.onModuleDestroy();
  });

  it('CREATE: registra actor, IP, user-agent y snapshot sin secretos', async () => {
    const [p] = await asAdmin(() =>
      db.withTenant(tenantId, (tx) =>
        tx.insert(s.properties).values({ tenantId, code: 'P1', title: 'Depto Palermo', operation: 'rent', propertyType: 'departamento', status: 'available', price: '500000' }).returning(),
      ),
    );
    propertyId = p!.id;
    const [log] = await auditOf('properties', propertyId);
    expect(log).toMatchObject({ action: 'CREATE', actorType: 'user', userId: adminId, ip: '203.0.113.7', userAgent: 'vitest', requestId: 'req-1', oldState: null });
    expect(Number((log!.newState as Record<string, unknown>).price)).toBe(500000);
    expect(log!.occurredAt).toBeInstanceOf(Date);

    const [userLog] = await auditOf('users', adminId);
    expect(userLog!.newState).not.toHaveProperty('password_hash');
  });

  it('UPDATE: incrementa version y guarda old/new + campos cambiados', async () => {
    const [p] = await asAdmin(() =>
      db.withTenant(tenantId, (tx) => tx.update(s.properties).set({ price: '550000' }).where(eq(s.properties.id, propertyId)).returning()),
    );
    expect(p!.version).toBe(2);
    const logs = await auditOf('properties', propertyId);
    const upd = logs.find((l) => l.action === 'UPDATE')!;
    expect(upd.changedFields).toEqual(['price']);
    expect(Number((upd.oldState as Record<string, unknown>).price)).toBe(500000);
    expect(Number((upd.newState as Record<string, unknown>).price)).toBe(550000);
  });

  it('DELETE físico se convierte en soft delete; RESTORE lo recupera', async () => {
    await asAdmin(() => db.withTenant(tenantId, (tx) => tx.delete(s.properties).where(eq(s.properties.id, propertyId))));
    const visible = await db.withTenant(tenantId, (tx) => tx.select().from(s.properties).where(eq(s.properties.id, propertyId)));
    expect(visible).toHaveLength(0);
    const [trashed] = await db.withTenant(tenantId, (tx) => tx.select().from(s.properties).where(eq(s.properties.id, propertyId)), { includeDeleted: true });
    expect(trashed!.deletedAt).not.toBeNull();
    expect(trashed!.deletedBy).toBe(`user:${adminId}`);

    await asAdmin(() =>
      db.withTenant(tenantId, (tx) => tx.update(s.properties).set({ deletedAt: null, deletedBy: null }).where(eq(s.properties.id, propertyId)), { includeDeleted: true }),
    );
    const actions = (await auditOf('properties', propertyId)).map((l) => l.action);
    expect(actions).toEqual(['CREATE', 'UPDATE', 'DELETE', 'RESTORE']);
  });

  it('el audit trail es inmutable para la app, el sistema y el dueño', async () => {
    await expect(db.withTenant(tenantId, (tx) => tx.execute(sql`update audit_logs set action = 'UPDATE'`))).rejects.toThrow();
    await expect(db.system.execute(sql`delete from audit_logs`)).rejects.toThrow();
    await expect(owner.query('delete from audit_logs')).rejects.toThrow(/append-only/);
    await expect(db.withTenant(tenantId, (tx) => tx.insert(s.auditLogs).values({} as never))).rejects.toThrow();
  });

  it('la cadena de hashes detecta una alteración aunque se desactiven los triggers', async () => {
    const verify = async () =>
      (await db.withTenant(tenantId, (tx) => tx.execute<{ entries: number; first_broken_seq: number | null }>(sql`select * from audit_verify_chain(${tenantId}::uuid)`))).rows[0]!;
    expect((await verify()).first_broken_seq).toBeNull();

    const client = await owner.connect();
    try {
      await client.query('begin');
      await client.query('alter table audit_logs disable trigger audit_logs_immutable');
      await client.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
      await client.query(`update audit_logs set new_state = '{"price":"1"}' where tenant_id = $1 and seq = 2`, [tenantId]);
      await client.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
      const { rows } = await client.query(`select * from audit_verify_chain($1::uuid)`, [tenantId]);
      expect(rows[0].first_broken_seq).toBe(2);
    } finally {
      await client.query('rollback'); // deshace la manipulación y re-habilita el trigger
      client.release();
    }
  });

  it('capa privada: visible para admin; invisible para agentes IA y asesores comerciales', async () => {
    await asAdmin(() =>
      db.withTenant(tenantId, (tx) => tx.insert(s.listingPrivateData).values({ tenantId, propertyId, commissionPct: '3.00', internalNotes: 'Dueño acepta 5% menos' })),
    );
    const read = () => db.withTenant(tenantId, (tx) => tx.select().from(s.listingPrivateData));
    expect(await asAdmin(read)).toHaveLength(1);
    expect(await RequestContext.asAgent('gemini-frontline', read)).toHaveLength(0);
    expect(await RequestContext.run({ actorType: 'user', userId: agentA, role: 'sales_agent' }, read)).toHaveLength(0);
    // Ni siquiera puede escribir: WITH CHECK de la política restrictiva.
    await expect(
      RequestContext.asAgent('gemini-frontline', () =>
        db.withTenant(tenantId, (tx) => tx.insert(s.listingPrivateData).values({ tenantId, developmentId: null, propertyId: null })),
      ),
    ).rejects.toThrow();
  });

  it('decisiones de IA: append-only y replicadas como AI_INTERACTION', async () => {
    const [run] = await RequestContext.asAgent('claude-specialist', () =>
      db.withTenant(tenantId, (tx) =>
        tx
          .insert(s.aiDecisionLogs)
          .values({ tenantId, engine: 'claude', model: 'claude-opus-5-5', task: 'specialist_decision', routingReason: 'claude: intent=legal_dispute', prompt: { user: 'x' }, rawResponse: { content: [] }, inputTokens: 10, outputTokens: 5, outcome: 'ok' })
          .returning(),
      ),
    );
    const [log] = await auditOf('ai_decision_logs', run!.id);
    expect(log).toMatchObject({ action: 'AI_INTERACTION', actorType: 'agent', agentId: 'claude-specialist' });
    await expect(db.withTenant(tenantId, (tx) => tx.update(s.aiDecisionLogs).set({ outcome: 'error' }).where(eq(s.aiDecisionLogs.id, run!.id)))).rejects.toThrow();
  });

  it('pipeline por defecto, avance solo hacia adelante y round-robin equitativo', async () => {
    const stages = await db.withTenant(tenantId, (tx) => tx.select().from(s.pipelineStages).orderBy(s.pipelineStages.position));
    expect(stages.map((x) => x.key)).toEqual(['new', 'qualified', 'visit_scheduled', 'appraisal', 'negotiation', 'reservation', 'closed_won', 'closed_lost']);

    const leadIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = await asAdmin(() =>
        db.withTenant(tenantId, async (tx) => {
          const [c] = await tx.insert(s.contacts).values({ tenantId, fullName: `Lead ${i}` }).returning({ id: s.contacts.id });
          const [l] = await tx.insert(s.leads).values({ tenantId, contactId: c!.id, stageId: stageIdSql(tenantId) }).returning({ id: s.leads.id });
          await pipeline.assign(tx, tenantId, l!.id);
          return l!.id;
        }),
      );
      leadIds.push(id);
    }
    const assigned = await db.withTenant(tenantId, (tx) => tx.select({ u: s.leads.assignedUserId }).from(s.leads));
    const counts = [agentA, agentB].map((u) => assigned.filter((a) => a.u === u).length).sort();
    expect(counts).toEqual([1, 2]); // 3 leads entre 2 asesores: reparto 2/1

    const lead = leadIds[0]!;
    expect(await db.withTenant(tenantId, (tx) => pipeline.advanceTo(tx, lead, 'negotiation'))).toBe(true);
    expect(await db.withTenant(tenantId, (tx) => pipeline.advanceTo(tx, lead, 'qualified'))).toBe(false); // no retrocede

    // Concurrencia optimista en el Kanban.
    const [cur] = await db.withTenant(tenantId, (tx) => tx.select({ v: s.leads.version }).from(s.leads).where(eq(s.leads.id, lead)));
    await asAdmin(() => pipeline.moveLead(tenantId, lead, { stageKey: 'reservation' }, cur!.v));
    await expect(asAdmin(() => pipeline.moveLead(tenantId, lead, { stageKey: 'closed_won' }, cur!.v))).rejects.toThrow(/modificado por otro usuario/);
  });

  it('PAYMENT_EXEC y anti doble reserva de visitas', async () => {
    const [lead] = await db.withTenant(tenantId, (tx) => tx.select().from(s.leads).limit(1));
    const slot = { startsAt: new Date('2026-11-02T13:00:00Z'), endsAt: new Date('2026-11-02T13:45:00Z') };
    await db.withTenant(tenantId, (tx) =>
      tx.insert(s.visits).values({ tenantId, leadId: lead!.id, propertyId, userId: agentA, ...slot, bookedBy: 'agent:booker' }),
    );
    const overlap = db.withTenant(tenantId, (tx) =>
      tx.insert(s.visits).values({
        tenantId,
        leadId: lead!.id,
        propertyId,
        userId: agentA,
        startsAt: new Date('2026-11-02T13:30:00Z'),
        endsAt: new Date('2026-11-02T14:15:00Z'),
        bookedBy: 'agent:booker',
      }),
    );
    await expect(overlap).rejects.toMatchObject({ cause: { code: '23P01' } });

    const scheduleId = await asAdmin(() =>
      db.withTenant(tenantId, async (tx) => {
        const [c] = await tx
          .insert(s.contracts)
          .values({ tenantId, status: 'active', startDate: '2026-01-01', endDate: '2027-01-01', baseRent: '100000', indexType: 'FIXED', adjustmentFrequencyMonths: 0 })
          .returning();
        const [ps] = await tx
          .insert(s.paymentSchedules)
          .values({ tenantId, contractId: c!.id, periodNumber: 1, periodMonth: '2026-01-01', dueDate: '2026-01-10', amount: '100000' })
          .returning();
        await tx.update(s.paymentSchedules).set({ status: 'paid', paidAmount: '100000' }).where(eq(s.paymentSchedules.id, ps!.id));
        return ps!.id;
      }),
    );
    const actions = (await auditOf('payment_schedules', scheduleId)).map((l) => l.action);
    expect(actions).toEqual(['CREATE', 'PAYMENT_EXEC']);
  });
});
