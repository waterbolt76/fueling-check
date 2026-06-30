/**
 * migrate-postcodes.js
 * Copies the Postcode table from Bangor MySQL → Neon Postgres.
 *
 * Run ONCE:
 *   npm install mysql2 --save-dev
 *   node migrate-postcodes.js
 *   npm uninstall mysql2 --save-dev
 *
 * The full UK dataset is ~2.6 million rows; expect 5-15 minutes.
 * Safe to re-run — uses ON CONFLICT DO NOTHING.
 */
require('dotenv').config();
const mysql    = require('mysql2/promise');
const { Pool } = require('pg');

// ── Source: Bangor MySQL ───────────────────────────────────────────────────
const mysqlPool = mysql.createPool({
  host:             'mysql.cs.bangor.ac.uk',
  user:             'jcr23gxs',
  password:         '32392a0d3f',
  database:         'jcr23gxs',
  port:             3306,
  waitForConnections: true,
  connectionLimit:  5,
});

// ── Destination: Neon Postgres ─────────────────────────────────────────────
const pgPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const BATCH_SIZE = 20000; // 20k rows × 3 cols = 60k params, within pg's 65535 limit

// ---------------------------------------------------------------------------
async function createTable(pgClient) {
  await pgClient.query(`
    CREATE TABLE IF NOT EXISTS postcodes (
      pcd2      VARCHAR(8)   PRIMARY KEY,
      latitude  DECIMAL(9,6) NOT NULL,
      longitude DECIMAL(9,6) NOT NULL
    )
  `);
  console.log('Table postcodes: ready on Neon.');
}

// ---------------------------------------------------------------------------
async function getTotal(mysqlConn) {
  const [rows] = await mysqlConn.query('SELECT COUNT(*) AS n FROM Postcode');
  return parseInt(rows[0].n);
}

// ---------------------------------------------------------------------------
async function migrateBatch(mysqlConn, pgClient, offset, total) {
  const [rows] = await mysqlConn.query(
    'SELECT pcd2, latitude, longitude FROM Postcode LIMIT ? OFFSET ?',
    [BATCH_SIZE, offset]
  );
  if (rows.length === 0) return 0;

  // Build $1,$2,$3 ... placeholders dynamically
  const placeholders = rows.map(function(_, i) {
    const b = i * 3;
    return '($' + (b + 1) + ',$' + (b + 2) + ',$' + (b + 3) + ')';
  }).join(',');

  const values = rows.flatMap(function(r) {
    return [r.pcd2, r.latitude, r.longitude];
  });

  await pgClient.query(
    'INSERT INTO postcodes (pcd2, latitude, longitude) VALUES ' + placeholders +
    ' ON CONFLICT (pcd2) DO NOTHING',
    values
  );

  const done = Math.min(offset + rows.length, total);
  const pct  = ((done / total) * 100).toFixed(1);
  process.stdout.write('\r[' + pct + '%] ' + done.toLocaleString() + ' / ' + total.toLocaleString() + ' postcodes migrated...');

  return rows.length;
}

// ---------------------------------------------------------------------------
async function main() {
  console.log('Fuel Finder — Postcode Migration (MySQL → Neon Postgres)\n');

  const mysqlConn = await mysqlPool.getConnection();
  const pgClient  = await pgPool.connect();

  try {
    await createTable(pgClient);

    const total = await getTotal(mysqlConn);
    console.log('Total postcodes in Bangor DB: ' + total.toLocaleString());
    console.log('Batch size: ' + BATCH_SIZE.toLocaleString() + ' rows\n');

    let offset = 0;
    const start = Date.now();

    while (true) {
      const fetched = await migrateBatch(mysqlConn, pgClient, offset, total);
      if (fetched === 0) break;
      offset += fetched;
    }

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log('\n\nMigration complete in ' + elapsed + 's.');

    // Verify
    const { rows: [count] } = await pgClient.query('SELECT COUNT(*) AS n FROM postcodes');
    console.log('Postcodes now in Neon: ' + parseInt(count.n).toLocaleString());

  } catch (err) {
    console.error('\nMigration failed:', err.message);
    process.exit(1);
  } finally {
    mysqlConn.release();
    pgClient.release();
    await mysqlPool.end();
    await pgPool.end();
  }
}

main();
