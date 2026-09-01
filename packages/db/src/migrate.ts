import fs from 'fs/promises';
import path from 'path';
import postgres from 'postgres';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required');
}

const sql = postgres(DATABASE_URL, { max: 1 });

async function migrate() {
  await sql`
    create table if not exists _migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )`;

  const applied = new Set(
    (await sql`select name from _migrations`).map((r) => r['name'] as string),
  );

  // Baseline: a database created before the ledger existed already has the
  // 0000 schema; record it instead of re-running it.
  if (!applied.has('0000_init.sql')) {
    const t = await sql`select to_regclass('public.users') as t`;
    if (t[0]?.['t']) {
      await sql`insert into _migrations (name) values ('0000_init.sql')`;
      applied.add('0000_init.sql');
      console.log('baselined existing schema as 0000_init.sql');
    }
  }

  const migrationsDir = path.join(__dirname, '../migrations');
  const files = (await fs.readdir(migrationsDir))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const body = await fs.readFile(path.join(migrationsDir, file), 'utf-8');
    console.log(`applying ${file}...`);
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`insert into _migrations (name) values (${file})`;
    });
    console.log(`applied ${file}`);
  }

  console.log('migrations up to date');
}

try {
  await migrate();
} finally {
  await sql.end();
}
