// Run pending Drizzle migrations. Usage: npm run db:migrate
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { DATABASE_URL } from '../env.js';

const sql = postgres(DATABASE_URL, { max: 1 });
const db  = drizzle(sql);
await migrate(db, { migrationsFolder: './src/db/migrations' });
await sql.end();
console.log('Migrations complete.');
