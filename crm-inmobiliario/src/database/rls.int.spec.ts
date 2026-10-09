import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Test de integración contra Postgres real (requiere DATABASE_URL y
 * DATABASE_SYSTEM_URL con los roles crm_app / crm_system y migraciones
 * aplicadas). Se saltea si no hay base configurada.
 */
const enabled = Boolean(process.env.DATABASE_URL && process.env.DATABASE_SYSTEM_URL);

describe.skipIf(!enabled)('RLS multi-tenant', async () => {
  const { DatabaseService } = await import('./database.service.js');
  const schema = await import('./schema.js');
  const { BillingService } = await import('../modules/finance/billing.service.js');

  const db = new DatabaseService();
  const billing = new BillingService(db);
  let tenantA = '';
  let tenantB = '';
  let contractA = '';

  beforeAll(async () => {
    const suffix = Date.now();
    const [a, b] = await db.system
      .insert(schema.tenants)
      .values([
        { name: 'Inmobiliaria A', slug: `a-${suffix}` },
        { name: 'Inmobiliaria B', slug: `b-${suffix}` },
      ])
      .returning({ id: schema.tenants.id });
    tenantA = a!.id;
    tenantB = b!.id;

    await db.system
      .insert(schema.indexRates)
      .values([
        { indexType: 'ICL', date: '2024-03-01', value: '8.5', source: 'test' },
        { indexType: 'ICL', date: '2025-03-01', value: '17', source: 'test' },
      ])
      .onConflictDoNothing();

    contractA = await db.withTenant(tenantA, async (tx) => {
      const [c] = await tx
        .insert(schema.contracts)
        .values({
          tenantId: tenantA,
          status: 'active',
          startDate: '2024-03-01',
          endDate: '2027-03-01',
          baseRent: '300000',
          indexType: 'ICL',
          adjustmentFrequencyMonths: 12,
        })
        .returning();
      await billing.syncSchedule(tx, c!);
      return c!.id;
    });
  });

  afterAll(async () => {
    // Hard delete explícito (los datos de negocio tienen soft delete por trigger).
    await db.system.transaction(async (tx) => {
      const { sql } = await import('drizzle-orm');
      await tx.execute(sql`select set_config('app.allow_hard_delete', 'on', true)`);
      await tx.delete(schema.tenants).where(eq(schema.tenants.id, tenantA));
      await tx.delete(schema.tenants).where(eq(schema.tenants.id, tenantB));
    });
    await db.onModuleDestroy();
  });

  it('el tenant dueño ve su contrato y su cronograma ajustado por ICL', async () => {
    const rows = await db.withTenant(tenantA, (tx) =>
      tx.select().from(schema.paymentSchedules).where(eq(schema.paymentSchedules.contractId, contractA)).orderBy(schema.paymentSchedules.periodNumber),
    );
    expect(rows).toHaveLength(36);
    expect(rows[11]!.amount).toBe('300000.00');
    expect(rows[12]!.amount).toBe('600000.00'); // marzo 2025: ICL 17 / 8.5
    expect(rows[12]!.provisional).toBe(false);
    expect(rows[24]!.provisional).toBe(true); // marzo 2026: sin ICL cargado
  });

  it('otro tenant no ve ni puede modificar datos ajenos', async () => {
    const visible = await db.withTenant(tenantB, (tx) => tx.select().from(schema.contracts));
    expect(visible).toHaveLength(0);

    const updated = await db.withTenant(tenantB, (tx) =>
      tx.update(schema.contracts).set({ status: 'terminated' }).where(eq(schema.contracts.id, contractA)).returning(),
    );
    expect(updated).toHaveLength(0);
  });

  it('no permite insertar filas con tenant_id ajeno (WITH CHECK)', async () => {
    await expect(
      db.withTenant(tenantB, (tx) =>
        tx.insert(schema.contacts).values({ tenantId: tenantA, fullName: 'Intruso' }),
      ),
    ).rejects.toThrow();
  });

  it('sin contexto de tenant no se ve nada (deny by default)', async () => {
    const { drizzle } = await import('drizzle-orm/node-postgres');
    const pg = (await import('pg')).default;
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const rows = await drizzle(pool).select().from(schema.contracts);
    await pool.end();
    expect(rows).toHaveLength(0);
  });
});
