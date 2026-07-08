import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export async function runMigrations(): Promise<void> {
  await pool.query('SELECT 1'); // verify connection
  console.log('[db] connected');

  const migrationPath = path.join(__dirname, 'migrations', '001_create_watchlist.sql');
  const sql = fs.readFileSync(migrationPath, 'utf-8');
  await pool.query(sql);
  console.log('[db] migration complete');
}
