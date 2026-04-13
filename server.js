// Frayt backend
// Node/Express + SQLite + JWT + real QR codes
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const QRCode = require('qrcode');
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

// ---------- Config (env-driven) ----------
const PORT = process.env.PORT || 3001;
const NODE_ENV = process.env.NODE_ENV || 'development';
const DEMO_MODE = process.env.DEMO_MODE === 'true' || NODE_ENV !== 'production';
const JWT_SECRET = process.env.JWT_SECRET || (DEMO_MODE ? 'frayt-dev-secret-do-not-use-in-prod' : null);
const DEV_OTP = process.env.DEV_OTP || '1234';
const MERCHANT_API_KEY = process.env.MERCHANT_API_KEY || (DEMO_MODE ? 'demo-merchant-key' : null);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:8765,http://127.0.0.1:8765').split(',').map(s => s.trim());

// Fail fast in production if secrets aren't set
if (NODE_ENV === 'production') {
  if (!JWT_SECRET || JWT_SECRET.includes('do-not-use')) { console.error('FATAL: JWT_SECRET must be set in production'); process.exit(1); }
  if (!MERCHANT_API_KEY) { console.error('FATAL: MERCHANT_API_KEY must be set in production'); process.exit(1); }
  if (DEMO_MODE) { console.error('FATAL: DEMO_MODE must not be true in production'); process.exit(1); }
}

// ---------- Input validators ----------
function isPhone(p) { return typeof p === 'string' && /^\+?\d{8,15}$/.test(p); }
function isPositiveNumber(v, max = 10000) { const n = parseFloat(v); return Number.isFinite(n) && n >= 0 && n <= max; }
function isString(v, minLen = 1, maxLen = 100) { return typeof v === 'string' && v.length >= minLen && v.length <= maxLen; }
function isInt(v, min = 0, max = 1e9) { const n = parseInt(v); return Number.isInteger(n) && n >= min && n <= max; }

const db = new Database(path.join(__dirname, 'frayt.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ---------- Schema ----------
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT UNIQUE NOT NULL,
  name TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS merchants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  store_name TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS wallets (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  balance REAL NOT NULL DEFAULT 0,
  savings REAL NOT NULL DEFAULT 0,
  points INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  type TEXT NOT NULL,          -- 'in' | 'out' | 'rewards'
  amount REAL NOT NULL,
  meta TEXT,                   -- merchant name or reward name
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS qr_codes (
  id TEXT PRIMARY KEY,
  merchant_id INTEGER REFERENCES merchants(id),
  amount REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'consumed' | 'expired'
  consumed_by INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  consumed_at TEXT
);
CREATE TABLE IF NOT EXISTS billers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,       -- electricity | water | mobile | internet | education | government
  name_en TEXT NOT NULL,
  name_ar TEXT NOT NULL,
  icon TEXT,                    -- emoji
  ref_label_en TEXT,
  ref_label_ar TEXT
);
CREATE TABLE IF NOT EXISTS bills (
  id TEXT PRIMARY KEY,
  biller_id INTEGER REFERENCES billers(id),
  reference TEXT NOT NULL,
  amount REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',   -- 'pending' | 'paid'
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  paid_by INTEGER REFERENCES users(id),
  paid_at TEXT
);
CREATE TABLE IF NOT EXISTS saved_billers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  biller_id INTEGER NOT NULL REFERENCES billers(id),
  nickname TEXT NOT NULL,
  reference TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, biller_id, reference)
);
`);

// ---------- Seed ----------
const seedUser = db.prepare('INSERT OR IGNORE INTO users (id, phone, name) VALUES (?, ?, ?)');
const seedWallet = db.prepare('INSERT OR IGNORE INTO wallets (user_id, balance, savings, points) VALUES (?, ?, ?, ?)');
const seedMerchant = db.prepare('INSERT OR IGNORE INTO merchants (id, name, store_name) VALUES (?, ?, ?)');
seedUser.run(1, '+962791114821', 'Leen');
seedWallet.run(1, 3.65, 12.40, 340);
seedMerchant.run(1, 'cafe-solo', 'Cafe Solo');

const seedTx = db.prepare('INSERT INTO transactions (user_id, type, amount, meta) VALUES (?, ?, ?, ?)');
const countBillers = db.prepare('SELECT COUNT(*) AS c FROM billers').get();
if (countBillers.c === 0) {
  const ins = db.prepare('INSERT INTO billers (category, name_en, name_ar, icon, ref_label_en, ref_label_ar) VALUES (?, ?, ?, ?, ?, ?)');
  ins.run('electricity', 'JEPCO', 'شركة الكهرباء الأردنية', '⚡', 'Meter number', 'رقم العداد');
  ins.run('electricity', 'IDECO', 'كهرباء إربد', '⚡', 'Meter number', 'رقم العداد');
  ins.run('water', 'Miyahuna', 'مياهنا', '💧', 'Subscription number', 'رقم الاشتراك');
  ins.run('water', 'Yarmouk Water', 'مياه اليرموك', '💧', 'Subscription number', 'رقم الاشتراك');
  ins.run('mobile', 'Zain', 'زين', '📱', 'Mobile number', 'رقم الهاتف');
  ins.run('mobile', 'Orange', 'أورنج', '🔶', 'Mobile number', 'رقم الهاتف');
  ins.run('mobile', 'Umniah', 'أمنية', '🟢', 'Mobile number', 'رقم الهاتف');
  ins.run('internet', 'Orange Fiber', 'أورنج فايبر', '🌐', 'Account number', 'رقم الحساب');
  ins.run('internet', 'Zain Fiber', 'زين فايبر', '🛰️', 'Account number', 'رقم الحساب');
  ins.run('education', 'University of Jordan', 'الجامعة الأردنية', '🎓', 'Student ID', 'الرقم الجامعي');
  ins.run('government', 'Traffic Fines', 'المخالفات المرورية', '🚦', 'Vehicle plate', 'رقم المركبة');
  ins.run('government', 'Civil Status', 'الأحوال المدنية', '🏛️', 'National ID', 'الرقم الوطني');
}

const countTx = db.prepare('SELECT COUNT(*) AS c FROM transactions WHERE user_id = ?').get(1);
if (countTx.c === 0) {
  seedTx.run(1, 'in', 0.35, 'Cafe Solo');
  seedTx.run(1, 'in', 0.80, 'Super Store');
  seedTx.run(1, 'rewards', -100, 'Free coffee');
  seedTx.run(1, 'in', 1.25, 'Manaseer Gas');
  seedTx.run(1, 'in', 0.45, 'Al-Dawaa Pharmacy');
}

// ---------- App ----------
const app = express();
app.set('trust proxy', 1); // needed for rate-limit behind proxies (Render/Fly)
app.use(helmet({
  contentSecurityPolicy: false, // CSP handled on frontend side for static HTML
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // allow curl / server-to-server
    if (ALLOWED_ORIGINS.includes(origin) || ALLOWED_ORIGINS.includes('*')) return cb(null, true);
    return cb(new Error('Origin not allowed: ' + origin));
  },
  credentials: false,
}));
app.use(express.json({ limit: '64kb' }));

// Generic rate limit: 300 req/min per IP
app.use(rateLimit({ windowMs: 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false }));

// Tight rate limit for auth endpoints: 10 req / 15 min per IP
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false, message: { error: 'too many auth attempts, try later' } });

// Merchant API key middleware (optional in demo, required in prod)
function merchantAuth(req, res, next) {
  const key = req.headers['x-merchant-key'];
  if (!MERCHANT_API_KEY) return next();
  if (key !== MERCHANT_API_KEY) return res.status(401).json({ error: 'invalid merchant key' });
  next();
}

// Health
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ---------- Auth ----------
app.post('/api/auth/request-otp', authLimiter, (req, res) => {
  const { phone } = req.body || {};
  if (!isPhone(phone)) return res.status(400).json({ error: 'invalid phone format' });
  const existing = db.prepare('SELECT id FROM users WHERE phone = ?').get(phone);
  if (!existing) {
    const info = db.prepare('INSERT INTO users (phone, name) VALUES (?, ?)').run(phone, phone.slice(-4));
    db.prepare('INSERT INTO wallets (user_id, balance, savings, points) VALUES (?, 0, 0, 0)').run(info.lastInsertRowid);
  }
  // Never leak the OTP in production
  res.json({ ok: true, ...(DEMO_MODE ? { dev_otp: DEV_OTP } : {}) });
});

app.post('/api/auth/verify-otp', authLimiter, (req, res) => {
  const { phone, otp } = req.body || {};
  if (!isPhone(phone)) return res.status(400).json({ error: 'invalid phone format' });
  if (!isString(otp, 4, 6)) return res.status(400).json({ error: 'invalid otp format' });
  if (otp !== DEV_OTP) return res.status(401).json({ error: 'invalid otp' });
  const user = db.prepare('SELECT id, phone, name FROM users WHERE phone = ?').get(phone);
  if (!user) return res.status(404).json({ error: 'user not found' });
  const token = jwt.sign({ userId: user.id, phone: user.phone }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user });
});

// ---------- Auth middleware ----------
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'missing token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    res.status(401).json({ error: 'invalid token' });
  }
}

// ---------- Wallet ----------
app.get('/api/wallet', auth, (req, res) => {
  const w = db.prepare('SELECT balance, savings, points FROM wallets WHERE user_id = ?').get(req.user.userId);
  const tx = db.prepare('SELECT id, type, amount, meta, created_at FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 20').all(req.user.userId);
  // today's received change
  const today = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS today
    FROM transactions
    WHERE user_id = ? AND type = 'in' AND date(created_at) = date('now')
  `).get(req.user.userId);
  res.json({ ...w, today: +today.today.toFixed(2), transactions: tx });
});

// ---------- Merchant ----------
app.post('/api/merchant/qr', merchantAuth, async (req, res) => {
  const { amount, paid, merchantId = 1 } = req.body || {};
  if (!isPositiveNumber(amount) || !isPositiveNumber(paid)) return res.status(400).json({ error: 'invalid amounts' });
  if (!isInt(merchantId, 1)) return res.status(400).json({ error: 'invalid merchantId' });
  const a = parseFloat(amount), p = parseFloat(paid);
  if (p < a) return res.status(400).json({ error: 'paid must be >= amount' });
  const change = +(p - a).toFixed(2);
  if (change <= 0) return res.status(400).json({ error: 'no change due' });
  if (change > 100) return res.status(400).json({ error: 'change exceeds per-transaction limit' });
  const merchant = db.prepare('SELECT id FROM merchants WHERE id = ?').get(merchantId);
  if (!merchant) return res.status(404).json({ error: 'merchant not found' });
  const qrId = crypto.randomBytes(8).toString('hex');
  db.prepare('INSERT INTO qr_codes (id, merchant_id, amount) VALUES (?, ?, ?)').run(qrId, merchantId, change);
  const payload = JSON.stringify({ v: 1, qr: qrId, amt: change, merchant: merchantId });
  const qrDataUrl = await QRCode.toDataURL(payload, { margin: 1, width: 300, color: { dark: '#0F766E', light: '#FFFFFF' } });
  res.json({ qrId, change, qrDataUrl });
});

app.get('/api/merchant/today', merchantAuth, (req, res) => {
  const merchantId = parseInt(req.query.merchantId || '1');
  if (!isInt(merchantId, 1)) return res.status(400).json({ error: 'invalid merchantId' });
  const row = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total
    FROM qr_codes
    WHERE merchant_id = ? AND status = 'consumed' AND date(consumed_at) = date('now')
  `).get(merchantId);
  res.json({ count: row.count, total: +row.total.toFixed(2) });
});

// ---------- Scan (credit change) ----------
app.post('/api/scan', auth, (req, res) => {
  const { qrId } = req.body || {};
  if (!isString(qrId, 4, 64) || !/^[a-f0-9]+$/i.test(qrId)) return res.status(400).json({ error: 'invalid qrId' });
  const qr = db.prepare('SELECT * FROM qr_codes WHERE id = ?').get(qrId);
  if (!qr) return res.status(404).json({ error: 'qr not found' });
  if (qr.status !== 'pending') return res.status(409).json({ error: 'qr already ' + qr.status });

  const userId = req.user.userId;
  const half = +(qr.amount / 2).toFixed(2);
  const points = Math.round(qr.amount * 100);
  const merchant = db.prepare('SELECT store_name FROM merchants WHERE id = ?').get(qr.merchant_id);
  const meta = merchant ? merchant.store_name : 'Merchant';

  const tx = db.transaction(() => {
    db.prepare('UPDATE wallets SET balance = balance + ?, savings = savings + ?, points = points + ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?')
      .run(half, half, points, userId);
    db.prepare('INSERT INTO transactions (user_id, type, amount, meta) VALUES (?, ?, ?, ?)').run(userId, 'in', qr.amount, meta);
    db.prepare('UPDATE qr_codes SET status = ?, consumed_by = ?, consumed_at = CURRENT_TIMESTAMP WHERE id = ?').run('consumed', userId, qrId);
  });
  tx();

  const w = db.prepare('SELECT balance, savings, points FROM wallets WHERE user_id = ?').get(userId);
  res.json({ ok: true, received: qr.amount, wallet: w });
});

// ---------- Redeem ----------
const REWARDS = {
  coffee: { cost: 200, name: 'Free coffee' },
  voucher: { cost: 150, name: '1 JOD voucher' },
  discount: { cost: 300, name: '10% off' },
  charity: { cost: 100, name: 'Donate to charity' },
};

app.post('/api/redeem', auth, (req, res) => {
  const { rewardId } = req.body || {};
  const r = typeof rewardId === 'string' ? REWARDS[rewardId] : null;
  if (!r) return res.status(400).json({ error: 'unknown reward' });
  const userId = req.user.userId;
  const w = db.prepare('SELECT points FROM wallets WHERE user_id = ?').get(userId);
  if (w.points < r.cost) return res.status(402).json({ error: 'insufficient points' });
  const tx = db.transaction(() => {
    db.prepare('UPDATE wallets SET points = points - ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?').run(r.cost, userId);
    db.prepare('INSERT INTO transactions (user_id, type, amount, meta) VALUES (?, ?, ?, ?)').run(userId, 'rewards', -r.cost, r.name);
  });
  tx();
  const newW = db.prepare('SELECT balance, savings, points FROM wallets WHERE user_id = ?').get(userId);
  res.json({ ok: true, wallet: newW });
});

// ---------- Billers ----------
app.get('/api/billers', (req, res) => {
  const rows = db.prepare('SELECT id, category, name_en, name_ar, icon, ref_label_en, ref_label_ar FROM billers ORDER BY category, id').all();
  res.json({ billers: rows });
});

// Lookup mock bill — deterministic but varies with reference
app.post('/api/bills/lookup', auth, (req, res) => {
  const { billerId, reference } = req.body || {};
  if (!isInt(billerId, 1)) return res.status(400).json({ error: 'invalid billerId' });
  if (!isString(reference, 1, 40)) return res.status(400).json({ error: 'reference 1-40 chars' });
  const biller = db.prepare('SELECT * FROM billers WHERE id = ?').get(billerId);
  if (!biller) return res.status(404).json({ error: 'biller not found' });
  // Deterministic pseudo amount based on reference + category
  const base = { electricity: 28, water: 12, mobile: 8, internet: 22, education: 320, government: 45 }[biller.category] || 20;
  const hash = [...String(reference)].reduce((a, c) => a + c.charCodeAt(0), 0);
  const amount = +((base + (hash % 30) - 5 + (hash % 100) / 100).toFixed(2));
  const dueDate = new Date(Date.now() + (7 + (hash % 20)) * 86400000).toISOString().slice(0, 10);
  const billId = crypto.randomBytes(6).toString('hex');
  db.prepare('INSERT INTO bills (id, biller_id, reference, amount) VALUES (?, ?, ?, ?)').run(billId, billerId, reference, amount);
  res.json({ billId, billerId, biller: { name_en: biller.name_en, name_ar: biller.name_ar, icon: biller.icon, category: biller.category }, reference, amount, dueDate });
});

app.post('/api/bills/pay', auth, (req, res) => {
  const { billId } = req.body || {};
  if (!isString(billId, 4, 64) || !/^[a-f0-9]+$/i.test(billId)) return res.status(400).json({ error: 'invalid billId' });
  const bill = db.prepare('SELECT bills.*, billers.name_en AS biller_name FROM bills JOIN billers ON bills.biller_id = billers.id WHERE bills.id = ?').get(billId);
  if (!bill) return res.status(404).json({ error: 'bill not found' });
  if (bill.status === 'paid') return res.status(409).json({ error: 'bill already paid' });
  const userId = req.user.userId;
  const w = db.prepare('SELECT balance FROM wallets WHERE user_id = ?').get(userId);
  if (w.balance < bill.amount) return res.status(402).json({ error: 'insufficient balance', need: bill.amount, have: w.balance });
  const tx = db.transaction(() => {
    db.prepare('UPDATE wallets SET balance = balance - ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?').run(bill.amount, userId);
    db.prepare('INSERT INTO transactions (user_id, type, amount, meta) VALUES (?, ?, ?, ?)').run(userId, 'out', -bill.amount, bill.biller_name);
    db.prepare('UPDATE bills SET status = ?, paid_by = ?, paid_at = CURRENT_TIMESTAMP WHERE id = ?').run('paid', userId, billId);
  });
  tx();
  const newW = db.prepare('SELECT balance, savings, points FROM wallets WHERE user_id = ?').get(userId);
  res.json({ ok: true, paid: bill.amount, biller: bill.biller_name, wallet: newW });
});

// ---------- Saved billers ----------
app.get('/api/saved-billers', auth, (req, res) => {
  const rows = db.prepare(`
    SELECT sb.id, sb.biller_id AS billerId, sb.nickname, sb.reference,
           b.name_en, b.name_ar, b.icon, b.category, b.ref_label_en, b.ref_label_ar
    FROM saved_billers sb JOIN billers b ON sb.biller_id = b.id
    WHERE sb.user_id = ? ORDER BY sb.id DESC
  `).all(req.user.userId);
  res.json({ saved: rows });
});

app.post('/api/saved-billers', auth, (req, res) => {
  const { billerId, nickname, reference } = req.body || {};
  if (!isInt(billerId, 1)) return res.status(400).json({ error: 'invalid billerId' });
  if (!isString(nickname, 1, 40)) return res.status(400).json({ error: 'nickname 1-40 chars' });
  if (!isString(reference, 1, 40)) return res.status(400).json({ error: 'reference 1-40 chars' });
  try {
    const info = db.prepare('INSERT INTO saved_billers (user_id, biller_id, nickname, reference) VALUES (?, ?, ?, ?)')
      .run(req.user.userId, billerId, nickname, reference);
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'already saved' });
    throw e;
  }
});

app.delete('/api/saved-billers/:id', auth, (req, res) => {
  if (!isInt(req.params.id, 1)) return res.status(400).json({ error: 'invalid id' });
  const info = db.prepare('DELETE FROM saved_billers WHERE id = ? AND user_id = ?').run(req.params.id, req.user.userId);
  res.json({ ok: true, deleted: info.changes });
});

// Recent paid bills
app.get('/api/bills/recent', auth, (req, res) => {
  const rows = db.prepare(`
    SELECT bills.id, bills.amount, bills.reference, bills.paid_at,
           billers.id AS billerId, billers.name_en, billers.name_ar, billers.icon, billers.category
    FROM bills JOIN billers ON bills.biller_id = billers.id
    WHERE bills.paid_by = ? AND bills.status = 'paid'
    ORDER BY bills.paid_at DESC LIMIT 5
  `).all(req.user.userId);
  res.json({ recent: rows });
});

// ---------- QR image (raw PNG) ----------
app.get('/api/qr/:id.png', async (req, res) => {
  if (!/^[a-f0-9]{4,64}$/i.test(req.params.id)) return res.status(400).send('invalid id');
  const qr = db.prepare('SELECT * FROM qr_codes WHERE id = ?').get(req.params.id);
  if (!qr) return res.status(404).send('not found');
  const payload = JSON.stringify({ v: 1, qr: qr.id, amt: qr.amount, merchant: qr.merchant_id });
  const png = await QRCode.toBuffer(payload, { margin: 1, width: 400, color: { dark: '#0F766E', light: '#FFFFFF' } });
  res.type('png').send(png);
});

// ---------- Error handler (don't leak stack traces) ----------
app.use((err, req, res, next) => {
  if (err && err.message && err.message.startsWith('Origin not allowed')) {
    return res.status(403).json({ error: 'origin not allowed' });
  }
  console.error('[error]', err);
  res.status(500).json({ error: 'internal error' });
});

// ---------- Listen ----------
app.listen(PORT, () => {
  console.log(`Frayt backend listening on http://localhost:${PORT}`);
  console.log(`Mode: ${NODE_ENV} | DEMO_MODE: ${DEMO_MODE}`);
  console.log(`Allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
  if (DEMO_MODE) console.log(`Dev OTP: ${DEV_OTP} | Demo merchant key: ${MERCHANT_API_KEY}`);
  console.log(`Seeded user: +962791114821 (Leen)`);
});
