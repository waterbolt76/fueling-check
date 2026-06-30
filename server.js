require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const { Pool } = require('pg');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');

const app  = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'fuel-finder-secret-change-in-prod';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const locationCache = new Map();
const CACHE_TTL = 1000 * 60 * 60;

// ── JWT middleware ─────────────────────────────────────────────────────────
function authRequired(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function adminRequired(req, res, next) {
  authRequired(req, res, function() {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    next();
  });
}

// ── Postcode geocode (Neon postcodes table) ───────────────────────────────
async function geocodePostcode(postcode) {
  const clean  = postcode.replace(/\s+/g, '').toUpperCase();
  const cached = locationCache.get(clean);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return { lat: cached.lat, lon: cached.lon, display: postcode.toUpperCase() };
  }
  const { rows } = await pool.query(
    'SELECT latitude, longitude FROM postcodes WHERE pcd2 = $1 LIMIT 1', [clean]
  );
  if (rows.length === 0) throw new Error('Postcode not found: ' + clean);
  const lat = parseFloat(rows[0].latitude);
  const lon = parseFloat(rows[0].longitude);
  locationCache.set(clean, { lat, lon, timestamp: Date.now() });
  return { lat, lon, display: postcode.toUpperCase() };
}

// ── Stations from DB ───────────────────────────────────────────────────────
async function fetchStationsFromDB(lat, lon, radiusKm) {
  const radiusMiles = radiusKm * 0.621371;
  const latRange    = radiusKm / 110.574;
  const lonRange    = radiusKm / (111.32 * Math.cos(lat * Math.PI / 180));
  const { rows } = await pool.query(
    'SELECT * FROM (' +
    'SELECT fs.osm_id, fs.name, fs.brand, fs.lat, fs.lon, fs.address, fs.opening_hours, ' +
    '(3959 * acos(LEAST(1.0, cos(radians($1)) * cos(radians(fs.lat)) * cos(radians(fs.lon) - radians($2)) + sin(radians($1)) * sin(radians(fs.lat))))) AS distance_miles, ' +
    "STRING_AGG(sp.fuel_type || ':' || sp.price_pence::text, '|' ORDER BY sp.fuel_type) AS prices " +
    'FROM fuel_stations fs ' +
    'LEFT JOIN station_prices sp ON sp.station_id = fs.osm_id ' +
    'WHERE fs.lat BETWEEN $3 AND $4 AND fs.lon BETWEEN $5 AND $6 ' +
    'GROUP BY fs.osm_id, fs.name, fs.brand, fs.lat, fs.lon, fs.address, fs.opening_hours' +
    ') sub WHERE distance_miles < $7 ORDER BY distance_miles ASC',
    [lat, lon, lat - latRange, lat + latRange, lon - lonRange, lon + lonRange, radiusMiles]
  );
  return rows.map(function(r) {
    const distMiles = parseFloat(parseFloat(r.distance_miles).toFixed(2));
    const prices    = {};
    if (r.prices) {
      r.prices.split('|').forEach(function(p) {
        const parts = p.split(':');
        prices[parts[0]] = parseFloat(parts[1]);
      });
    }
    return {
      id: r.osm_id, name: r.name, brand: r.brand,
      lat: parseFloat(r.lat), lon: parseFloat(r.lon),
      address: r.address, opening_hours: r.opening_hours,
      prices: prices,
      distanceKm: parseFloat((distMiles / 0.621371).toFixed(2)),
      distanceMiles: distMiles,
    };
  });
}

// ── AUTH ROUTES ────────────────────────────────────────────────────────────
app.post('/api/auth/register', async function(req, res) {
  const { username, email, password } = req.body;
  if (!username || !email || !password) return res.status(400).json({ error: 'All fields required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  try {
    const hash = await bcrypt.hash(password, 12);
    const { rows: [newUser] } = await pool.query(
      'INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id',
      [username.trim(), email.trim().toLowerCase(), hash]
    );
    const token = jwt.sign({ id: newUser.id, username: username.trim(), role: 'user' }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: newUser.id, username: username.trim(), role: 'user' } });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Username or email already taken' });
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/auth/login', async function(req, res) {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1 LIMIT 1', [email.trim().toLowerCase()]);
    if (rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });
    const user  = rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/auth/me', authRequired, function(req, res) {
  res.json({ user: req.user });
});

// ── PRICE ROUTES ───────────────────────────────────────────────────────────
app.post('/api/prices/submit', authRequired, async function(req, res) {
  const { station_id, fuel_type, price_pence } = req.body;
  const validFuels = ['E10', 'Diesel', 'Super Unleaded', 'Electric'];
  if (!station_id || !fuel_type || !price_pence) return res.status(400).json({ error: 'All fields required' });
  if (!validFuels.includes(fuel_type)) return res.status(400).json({ error: 'Invalid fuel type' });
  if (price_pence < 50 || price_pence > 999) return res.status(400).json({ error: 'Price must be between 50p and 999p' });
  try {
    const { rows: [sub] } = await pool.query(
      'INSERT INTO price_submissions (station_id, user_id, fuel_type, price_pence) VALUES ($1, $2, $3, $4) RETURNING id',
      [station_id, req.user.id, fuel_type, price_pence]
    );
    res.json({ ok: true, submission_id: sub.id, message: 'Price submitted for review' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/prices/:station_id', async function(req, res) {
  try {
    const { rows } = await pool.query(
      'SELECT fuel_type, price_pence, updated_at FROM station_prices WHERE station_id = $1',
      [req.params.station_id]
    );
    const prices = {};
    rows.forEach(function(r) { prices[r.fuel_type] = { price: parseFloat(r.price_pence), updated_at: r.updated_at }; });
    res.json(prices);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── ADMIN ROUTES ───────────────────────────────────────────────────────────
app.get('/api/admin/submissions', adminRequired, async function(req, res) {
  const status = req.query.status || 'pending';
  try {
    const { rows } = await pool.query(
      'SELECT ps.*, u.username AS submitted_by_name, fs.name AS station_name, fs.address AS station_address, ' +
      'ru.username AS reviewed_by_name ' +
      'FROM price_submissions ps ' +
      'JOIN users u ON u.id = ps.user_id ' +
      'JOIN fuel_stations fs ON fs.osm_id = ps.station_id ' +
      'LEFT JOIN users ru ON ru.id = ps.reviewed_by ' +
      'WHERE ps.status = $1 ORDER BY ps.submitted_at DESC LIMIT 100',
      [status]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/submissions/:id/approve', adminRequired, async function(req, res) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      "SELECT * FROM price_submissions WHERE id = $1 AND status = 'pending'", [req.params.id]
    );
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Submission not found or already reviewed' });
    }
    const sub = rows[0];
    await client.query(
      "UPDATE price_submissions SET status='approved', reviewed_by=$1, reviewed_at=NOW() WHERE id=$2",
      [req.user.id, sub.id]
    );
    await client.query(
      'INSERT INTO station_prices (station_id, fuel_type, price_pence, approved_by, submission_id, updated_at) ' +
      'VALUES ($1, $2, $3, $4, $5, NOW()) ' +
      'ON CONFLICT (station_id, fuel_type) DO UPDATE SET ' +
      'price_pence=EXCLUDED.price_pence, approved_by=EXCLUDED.approved_by, submission_id=EXCLUDED.submission_id, updated_at=NOW()',
      [sub.station_id, sub.fuel_type, sub.price_pence, req.user.id, sub.id]
    );
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

app.post('/api/admin/submissions/:id/reject', adminRequired, async function(req, res) {
  try {
    const { rowCount } = await pool.query(
      "UPDATE price_submissions SET status='rejected', reviewed_by=$1, reviewed_at=NOW() WHERE id=$2 AND status='pending'",
      [req.user.id, req.params.id]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Submission not found or already reviewed' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/admin/stats', adminRequired, async function(req, res) {
  try {
    const { rows: [pending] }  = await pool.query("SELECT COUNT(*) AS n FROM price_submissions WHERE status='pending'");
    const { rows: [approved] } = await pool.query("SELECT COUNT(*) AS n FROM price_submissions WHERE status='approved'");
    const { rows: [rejected] } = await pool.query("SELECT COUNT(*) AS n FROM price_submissions WHERE status='rejected'");
    const { rows: [users] }    = await pool.query('SELECT COUNT(*) AS n FROM users');
    res.json({
      pending:  parseInt(pending.n),
      approved: parseInt(approved.n),
      rejected: parseInt(rejected.n),
      users:    parseInt(users.n),
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── STATION SEARCH ─────────────────────────────────────────────────────────
app.get('/api/stations', async function(req, res) {
  const postcode = req.query.postcode;
  if (!postcode) return res.status(400).json({ error: 'postcode is required' });
  const radiusKm = Math.min(parseFloat(req.query.radius) || 10, 50);
  try {
    const origin   = await geocodePostcode(postcode);
    const stations = await fetchStationsFromDB(origin.lat, origin.lon, radiusKm);
    res.json({ origin, radiusKm, count: stations.length, stations });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/geocode', async function(req, res) {
  try {
    res.json(await geocodePostcode(req.query.postcode || ''));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.listen(PORT, '0.0.0.0', function() {
  console.log('Fuel Finder running at http://localhost:' + PORT);
});
