import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const MIGRATIONS = [
  '001_create_watchlist.sql',
  '002_create_alerts.sql',
];

export async function runMigrations(): Promise<void> {
  await pool.query('SELECT 1'); // verify connection
  console.log('[db] connected');

  for (const filename of MIGRATIONS) {
    const sql = fs.readFileSync(path.join(__dirname, 'migrations', filename), 'utf-8');
    await pool.query(sql);
  }
  console.log('[db] migrations complete');
}
