require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const { google }   = require('googleapis');
const { Readable } = require('stream');
const jwt      = require('jsonwebtoken');

const app    = express();
const upload = multer({ storage: multer.memoryStorage() });

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

app.use(cors({
  origin: function(origin, cb) {
    // allow server-to-server (no origin), localhost, and configured origins
    if (!origin) return cb(null, true);
    if (origin.startsWith('http://localhost') || origin.startsWith('http://127.')) return cb(null, true);
    if (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.indexOf(origin) >= 0) return cb(null, true);
    cb(new Error('CORS: origin not allowed: ' + origin));
  },
  credentials: true,
}));
app.use(express.json({ limit: '50mb' }));

// ── Static files — serves index.html at / ────────────────────────────────────
app.use(express.static(path.join(__dirname, '..')));

// ── Config ───────────────────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || 'crm-change-this-secret-in-production';
const DATA_FILE  = process.env.DATA_FILE  || path.join(__dirname, 'crm-data.json');
const PORT       = parseInt(process.env.PORT || '3001', 10);

// ── Ensure data directory exists ─────────────────────────────────────────────
const DATA_DIR = path.dirname(DATA_FILE);
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ── JSON file storage (no native dependencies) ────────────────────────────────
function readDb() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch(e) { return {}; }
}

function writeDb(data) {
  // Write to temp file then rename for safer writes
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, DATA_FILE);
}

function dbGet(key) {
  return readDb()[key] ?? null;
}

function dbSet(key, val) {
  const data = readDb();
  data[key] = val;
  writeDb(data);
}

function dbGetAll() {
  return readDb();
}

function dbSetMany(entries) {
  const data = readDb();
  for (const [key, val] of entries) {
    if (val !== null && val !== undefined) data[key] = val;
  }
  writeDb(data);
}

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const auth  = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch(e) {
    res.status(401).json({ ok: false, error: 'Invalid or expired token' });
  }
}

function requireOwner(req, res, next) {
  if (req.user && req.user.role === 'owner') return next();
  res.status(403).json({ ok: false, error: 'Owner access required' });
}

// ── Google Drive OAuth2 (optional) ───────────────────────────────────────────
const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;

let drive = null;
if (CLIENT_ID && CLIENT_SECRET && REFRESH_TOKEN) {
  const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
  oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
  drive = google.drive({ version: 'v3', auth: oauth2Client });
  console.log('[Drive] Google Drive integration enabled.');
} else {
  console.warn('[Drive] Google Drive credentials not set — Drive upload disabled.');
}

// ══════════════════════════════════════════════════════════════════════════════
// AUTH ENDPOINTS
// ══════════════════════════════════════════════════════════════════════════════

// Is first-run setup needed?
app.get('/api/auth/needs-setup', (req, res) => {
  const accounts = dbGet('crm_accounts') || [];
  res.json({ needsSetup: accounts.length === 0 });
});

// First-run: create owner account
app.post('/api/auth/setup', (req, res) => {
  const existing = dbGet('crm_accounts') || [];
  if (existing.length > 0) {
    return res.status(403).json({ ok: false, error: 'Setup already complete' });
  }
  const { account } = req.body;
  if (!account || !account.email || !account.password) {
    return res.status(400).json({ ok: false, error: 'Invalid account data' });
  }
  dbSet('crm_accounts', [account]);
  const user  = { email: account.email, role: account.role, firstName: account.firstName, lastName: account.lastName };
  const token = jwt.sign(user, JWT_SECRET, { expiresIn: '7d' });
  res.json({ ok: true, token, user });
});

// Login — browser sends SHA-256 hash (same as existing auth)
app.post('/api/auth/login', (req, res) => {
  const { email, passwordHash } = req.body;
  if (!email || !passwordHash) {
    return res.status(400).json({ ok: false, error: 'Missing credentials' });
  }
  const accounts = dbGet('crm_accounts') || [];
  const account  = accounts.find(
    a => a.email.toLowerCase() === email.toLowerCase() && a.active !== false
  );
  if (!account || account.password !== passwordHash) {
    return res.status(401).json({ ok: false, error: 'Invalid credentials' });
  }
  const user  = { email: account.email, role: account.role, firstName: account.firstName, lastName: account.lastName };
  const token = jwt.sign(user, JWT_SECRET, { expiresIn: '7d' });
  res.json({ ok: true, token, user });
});

// Verify / refresh token
app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ ok: true, user: req.user });
});

// ══════════════════════════════════════════════════════════════════════════════
// DATA ENDPOINTS  (all require auth)
// ══════════════════════════════════════════════════════════════════════════════

// Fetch ALL data at once — called after login to populate the browser
app.get('/api/data', requireAuth, (req, res) => {
  res.json({ ok: true, data: dbGetAll() });
});

// Sync one key — called transparently by lsSet() in the browser
app.put('/api/data/:key', requireAuth, (req, res) => {
  const key = decodeURIComponent(req.params.key);
  const { value } = req.body;
  if (value === undefined) return res.status(400).json({ ok: false, error: 'No value' });
  dbSet(key, value);
  res.json({ ok: true });
});

// Bulk import from backup JSON — owner only
app.post('/api/data/import', requireAuth, requireOwner, (req, res) => {
  const { data } = req.body;
  if (!data || typeof data !== 'object') {
    return res.status(400).json({ ok: false, error: 'No data provided' });
  }
  dbSetMany(Object.entries(data));
  res.json({ ok: true, count: Object.keys(data).length });
});

// ══════════════════════════════════════════════════════════════════════════════
// GOOGLE DRIVE — Upload proxy (unchanged)
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/status', async (req, res) => {
  if (!drive) return res.json({ ok: true, drive: false });
  try {
    await drive.files.list({ pageSize: 1, fields: 'files(id)' });
    res.json({ ok: true, drive: true });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/upload', upload.single('file'), async (req, res) => {
  if (!drive) return res.status(503).json({ ok: false, error: 'Drive not configured' });
  try {
    const folderId = (req.body.folderId || '').trim();
    if (!folderId) return res.status(400).json({ ok: false, error: 'folderId is required' });
    if (!req.file)  return res.status(400).json({ ok: false, error: 'No file provided' });

    const filename = req.file.originalname;
    try {
      const existing = await drive.files.list({
        q: `'${folderId}' in parents and name='${filename.replace(/'/g,"\\'")}' and trashed=false`,
        fields: 'files(id,name,webViewLink)',
        pageSize: 1,
      });
      if (existing.data.files.length > 0) {
        return res.json({ ok: true, skipped: true, file: existing.data.files[0] });
      }
    } catch(e) { /* non-fatal */ }

    const stream   = Readable.from(req.file.buffer);
    const response = await drive.files.create({
      requestBody: { name: filename, parents: [folderId] },
      media: { mimeType: req.file.mimetype || 'application/octet-stream', body: stream },
      fields: 'id,name,webViewLink',
    });
    res.json({ ok: true, file: response.data });
  } catch(e) {
    console.error('[Upload]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\nCRM server running  →  http://localhost:${PORT}`);
  console.log(`Data file           →  ${DATA_FILE}`);
  console.log(`Open the CRM at     →  http://localhost:${PORT}\n`);
});
