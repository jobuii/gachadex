import { readFileSync } from 'node:fs';
import { getDb } from './client.ts';
import { applyMarketGuards } from './market-guards.ts';

/** Apply the schema (idempotent — uses CREATE ... IF NOT EXISTS throughout), then the switch/data-dependent guards. */
export async function migrate(): Promise<void> {
  const db = await getDb();
  const sql = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
  await db.exec(sql);
  await applyMarketGuards(db);
}

// Allow `tsx src/db/migrate.ts`
if (process.argv[1]?.endsWith('migrate.ts')) {
  migrate()
    .then(() => {
      console.log('schema applied');
      process.exit(0);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
