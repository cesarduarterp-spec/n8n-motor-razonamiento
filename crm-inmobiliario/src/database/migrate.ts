import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

/** Corre las migraciones con el rol dueño del esquema (DATABASE_OWNER_URL). */
const url = process.env.DATABASE_OWNER_URL;
if (!url) throw new Error('DATABASE_OWNER_URL es requerido para migrar');

const pool = new pg.Pool({ connectionString: url, max: 1 });
await migrate(drizzle(pool), { migrationsFolder: process.env.MIGRATIONS_DIR ?? './drizzle' });
await pool.end();
console.log('Migraciones aplicadas');
