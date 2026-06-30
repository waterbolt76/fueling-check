/**
 * import-stations.js
 * One-time script to fetch ALL UK fuel stations from OpenStreetMap
 * and upsert them into Neon Postgres.
 *
 * Run with:  node import-stations.js
 * Re-run monthly to pick up new/closed stations (upsert, safe to re-run).
 */
require('dotenv').config();
const fetch    = require('node-fetch');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ---------------------------------------------------------------------------
// Step 1: Create the table if it doesn't exist
// ---------------------------------------------------------------------------
async function createTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS fuel_stations (
      osm_id        BIGINT PRIMARY KEY,
      name          VARCHAR(255),
      brand         VARCHAR(100),
      lat           DECIMAL(9,6) NOT NULL,
      lon           DECIMAL(9,6) NOT NULL,
      address       VARCHAR(255),
      opening_hours VARCHAR(255),
      last_updated  TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await client.query(
    'CREATE INDEX IF NOT EXISTS idx_fuel_stations_lat_lon ON fuel_stations(lat, lon)'
  );
  console.log('Table fuel_stations ready.');
}

// ---------------------------------------------------------------------------
// Step 2: Fetch from Overpass (all UK, ~8000-10000 stations)
// ---------------------------------------------------------------------------
async function fetchFromOverpass() {
  console.log('Fetching UK fuel stations from Overpass API...');
  console.log('(This may take 30-60 seconds for the full UK dataset)');
  const bbox  = '49.8,-8.2,61.0,2.0';
  const query =
    '[out:json][timeout:90];\n' +
    '(\n' +
    '  node["amenity"="fuel"](' + bbox + ');\n' +
    '  way["amenity"="fuel"](' + bbox + ');\n' +
    ');\n' +
    'out center tags;';
  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    body: 'data=' + encodeURIComponent(query),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 100000,
  });
  if (!res.ok) throw new Error('Overpass error: ' + res.status + ' ' + res.statusText);
  const data = await res.json();
  console.log('Overpass returned ' + data.elements.length + ' elements.');
  return data.elements;
}

// ---------------------------------------------------------------------------
// Step 3: Parse elements into clean rows
// ---------------------------------------------------------------------------
function parseElements(elements) {
  return elements
    .map(function(el) {
      const tags = el.tags || {};
      const lat  = el.lat != null ? el.lat : (el.center ? el.center.lat : null);
      const lon  = el.lon != null ? el.lon : (el.center ? el.center.lon : null);
      if (lat == null || lon == null) return null;
      const addr = [
        tags['addr:housenumber'],
        tags['addr:street'],
        tags['addr:city'] || tags['addr:town'] || tags['addr:village'],
      ].filter(Boolean).join(', ');
      return {
        osm_id:        el.id,
        name:          (tags.name || tags.brand || 'Petrol Station').substring(0, 254),
        brand:         tags.brand ? tags.brand.substring(0, 99) : null,
        lat:           lat,
        lon:           lon,
        address:       addr.substring(0, 254) || null,
        opening_hours: tags.opening_hours ? tags.opening_hours.substring(0, 254) : null,
      };
    })
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Step 4: Bulk upsert in batches of 200
// (Postgres uses $1/$2/... placeholders, built dynamically per batch)
// ---------------------------------------------------------------------------
async function upsertStations(client, rows) {
  const BATCH   = 200;
  let inserted  = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch        = rows.slice(i, i + BATCH);
    const placeholders = batch.map(function(_, j) {
      const b = j * 7;
      return '($' + (b+1) + ',$' + (b+2) + ',$' + (b+3) + ',$' + (b+4) + ',$' + (b+5) + ',$' + (b+6) + ',$' + (b+7) + ')';
    }).join(',');
    const values = batch.flatMap(function(r) {
      return [r.osm_id, r.name, r.brand, r.lat, r.lon, r.address, r.opening_hours];
    });
    await client.query(
      'INSERT INTO fuel_stations (osm_id, name, brand, lat, lon, address, opening_hours) VALUES ' + placeholders +
      ' ON CONFLICT (osm_id) DO UPDATE SET ' +
      'name=EXCLUDED.name, brand=EXCLUDED.brand, lat=EXCLUDED.lat, lon=EXCLUDED.lon, ' +
      'address=EXCLUDED.address, opening_hours=EXCLUDED.opening_hours, last_updated=NOW()',
      values
    );
    inserted += batch.length;
    process.stdout.write('\rUpserted ' + inserted + ' / ' + rows.length + ' stations...');
  }
  console.log('\nDone.');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const client = await pool.connect();
  try {
    await createTable(client);
    const elements = await fetchFromOverpass();
    const rows     = parseElements(elements);
    console.log('Parsed ' + rows.length + ' valid stations with coordinates.');
    await upsertStations(client, rows);
    const { rows: [count] } = await client.query('SELECT COUNT(*) AS total FROM fuel_stations');
    console.log('Total stations in DB: ' + count.total);
  } catch (err) {
    console.error('Import failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
