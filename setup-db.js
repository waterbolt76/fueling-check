/**
 * setup-db.js
 * Creates the users, price_submissions, and station_prices tables in Neon Postgres.
 * Run once: node setup-db.js
 */
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function main() {
  const client = await pool.connect();
  try {
    // Users table
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id            SERIAL PRIMARY KEY,
        username      VARCHAR(50)  UNIQUE NOT NULL,
        email         VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role          VARCHAR(10)  NOT NULL DEFAULT 'user'
                        CHECK (role IN ('user','admin')),
        created_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('Table users: OK');

    // Price submissions (pending review)
    await client.query(`
      CREATE TABLE IF NOT EXISTS price_submissions (
        id           SERIAL PRIMARY KEY,
        station_id   BIGINT NOT NULL,
        user_id      INT NOT NULL,
        fuel_type    VARCHAR(20) NOT NULL
                       CHECK (fuel_type IN ('E10','Diesel','Super Unleaded','Electric')),
        price_pence  DECIMAL(6,1) NOT NULL,
        submitted_at TIMESTAMPTZ DEFAULT NOW(),
        status       VARCHAR(10) NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','approved','rejected')),
        reviewed_by  INT DEFAULT NULL,
        reviewed_at  TIMESTAMPTZ DEFAULT NULL
      )
    `);
    await client.query('CREATE INDEX IF NOT EXISTS idx_submissions_station ON price_submissions(station_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_submissions_status  ON price_submissions(status)');
    console.log('Table price_submissions: OK');

    // Live approved prices per station per fuel type
    await client.query(`
      CREATE TABLE IF NOT EXISTS station_prices (
        station_id    BIGINT NOT NULL,
        fuel_type     VARCHAR(20) NOT NULL
                        CHECK (fuel_type IN ('E10','Diesel','Super Unleaded','Electric')),
        price_pence   DECIMAL(6,1) NOT NULL,
        updated_at    TIMESTAMPTZ DEFAULT NOW(),
        approved_by   INT NOT NULL,
        submission_id INT NOT NULL,
        PRIMARY KEY (station_id, fuel_type)
      )
    `);
    console.log('Table station_prices: OK');

    console.log('\nAll tables ready. Run import-stations.js next.');
  } catch (err) {
    console.error('Setup failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
