// Docker healthcheck for the indexer: healthy while idx_checkpoints keeps advancing.
// The follow loop logs and swallows per-tick errors, so a stuck indexer stays "running";
// checkpoint freshness is the signal that it is actually making progress.
import postgres from 'postgres';

const maxAgeS = Number(process.env.INDEXER_HEALTH_MAX_AGE_S ?? 600);
const sql = postgres(process.env.DATABASE_URL, { max: 1, connect_timeout: 5 });

try {
  const [row] = await sql`SELECT EXTRACT(EPOCH FROM (NOW() - MAX(updated_at)))::int AS age FROM idx_checkpoints`;
  const age = row?.age;
  if (age == null) { console.error('no checkpoint yet'); process.exit(1); }
  if (age > maxAgeS) { console.error(`checkpoint stale: ${age}s`); process.exit(1); }
  process.exit(0);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
} finally {
  await sql.end({ timeout: 1 });
}
