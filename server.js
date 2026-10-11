'use strict';

require('dotenv').config();
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const session = require('express-session');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const OpenAI = require('openai');

const app = express();
const isProduction = process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT || 3000);
const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'marko.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

if (isProduction && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) {
  throw new Error('SESSION_SECRET muss in Production gesetzt sein und mindestens 32 Zeichen enthalten.');
}
const sessionSecret = process.env.SESSION_SECRET || 'local-development-only-session-secret-change-me';

// Schema for accounts, audit events and server-side sessions.
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_hash TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('chat','screen')),
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    last_login TEXT
  );
  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    sess TEXT NOT NULL,
    expired INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_expired_idx ON sessions(expired);
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id INTEGER,
    action TEXT NOT NULL,
    target TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
`);

class SQLiteSessionStore extends session.Store {
  constructor(database) {
    super();
    this.db = database;
    this.getStmt = database.prepare('SELECT sess, expired FROM sessions WHERE sid = ?');
    this.setStmt = database.prepare('INSERT INTO sessions(sid,sess,expired) VALUES(?,?,?) ON CONFLICT(sid) DO UPDATE SET sess=excluded.sess, expired=excluded.expired');
    this.delStmt = database.prepare('DELETE FROM sessions WHERE sid = ?');
    this.touchStmt = database.prepare('UPDATE sessions SET expired = ?, sess = ? WHERE sid = ?');
  }
  get(sid, callback) {
    try {
      const row = this.getStmt.get(sid);
      if (!row) return callback(null, null);
      if (row.expired <= Date.now()) {
        this.delStmt.run(sid);
        return callback(null, null);
      }
      return callback(null, JSON.parse(row.sess));
    } catch (err) { return callback(err); }
  }
  set(sid, sess, callback = () => {}) {
    try {
      const expiry = sess.cookie && sess.cookie.expires
        ? new Date(sess.cookie.expires).getTime()
        : Date.now() + 24 * 60 * 60 * 1000;
      this.setStmt.run(sid, JSON.stringify(sess), expiry);
      callback(null);
    } catch (err) { callback(err); }
  }
  destroy(sid, callback = () => {}) {
    try { this.delStmt.run(sid); callback(null); } catch (err) { callback(err); }
  }
  touch(sid, sess, callback = () => {}) {
    try {
      const expiry = sess.cookie && sess.cookie.expires
        ? new Date(sess.cookie.expires).getTime()
        : Date.now() + 24 * 60 * 60 * 1000;
      this.touchStmt.run(expiry, JSON.stringify(sess), sid);
      callback(null);
    } catch (err) { callback(err); }
  }
}

if (isProduction) app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", 'data:'],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      mediaSrc: ["'self'", 'blob:'],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      upgradeInsecureRequests: isProduction ? [] : null
    }
  },
  crossOriginEmbedderPolicy: false
}));
app.use(express.json({ limit: '5mb' }));
app.use(session({
  name: 'marko.sid',
  secret: sessionSecret,
  store: new SQLiteSessionStore(db),
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000
  }
}));

// Same-origin guard for state-changing API requests; no cross-origin API is exposed.
app.use('/api', (req, res, next) => {
  if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (!origin) return next();
  try {
    if (new URL(origin).host !== req.get('host')) return res.status(403).json({ error: 'Anfrage wurde aus Sicherheitsgründen blockiert.' });
  } catch {
    return res.status(403).json({ error: 'Ungültiger Request-Origin.' });
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public'), { maxAge: isProduction ? '1h' : 0, etag: true }));

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 25, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Zu viele Login-Versuche. Bitte warte 15 Minuten.' } });
const chatLimiter = rateLimit({ windowMs: 60 * 1000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Zu viele Nachrichten in kurzer Zeit. Bitte warte einen Moment.' } });
const setupLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Zu viele Einrichtungsversuche. Bitte warte 15 Minuten.' } });
const countUsers = db.prepare('SELECT COUNT(*) AS count FROM users');
const userById = db.prepare('SELECT id, username, password_hash, mode, role, is_active, created_at, last_login FROM users WHERE id = ?');
const audit = db.prepare('INSERT INTO audit_log(actor_id, action, target) VALUES(?,?,?)');

function currentUser(req) { return req.session && req.session.user ? req.session.user : null; }
function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Bitte melde dich zuerst an.' });
  const live = userById.get(user.id);
  if (!live || !live.is_active) {
    req.session.destroy(() => {});
    return res.status(401).json({ error: 'Dieses Konto ist deaktiviert. Bitte wende dich an den Admin.' });
  }
  if (live.mode !== user.mode) return res.status(403).json({ error: 'Für diesen Modus ist dieses Konto nicht freigeschaltet.' });
  req.currentUser = { id: live.id, username: live.username, mode: live.mode, role: live.role };
  next();
}
function requireAdmin(req, res, next) {
  if (!req.currentUser || req.currentUser.mode !== 'chat' || req.currentUser.role !== 'admin') {
    return res.status(403).json({ error: 'Nur der Admin im Chat-Modus darf das Admin-Panel öffnen.' });
  }
  next();
}
function randomPassword() {
  // URL-safe, high-entropy password; the plaintext is shown only once at setup/reset.
  return crypto.randomBytes(18).toString('base64url');
}
function safeUser(row) {
  return {
    id: row.id,
    username: row.username,
    mode: row.mode,
    role: row.role,
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
    lastLogin: row.last_login
  };
}
function tokenMatches(candidate, expected) {
  if (typeof candidate !== 'string' || typeof expected !== 'string' || !candidate || !expected) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function logAudit(actorId, action, target) {
  try { audit.run(actorId ?? null, action, String(target ?? '').slice(0, 120)); } catch (err) { console.error('Audit log konnte nicht geschrieben werden.'); }
}

app.get('/api/health', (_req, res) => res.json({ ok: true, name: 'Marko AI' }));
app.get('/api/status', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    setupRequired: countUsers.get().count === 0,
    aiReady: Boolean(process.env.OPENAI_API_KEY),
    appName: 'Marko AI'
  });
});
app.post('/api/setup/initialize', setupLimiter, async (req, res) => {
  if (countUsers.get().count !== 0) return res.status(409).json({ error: 'Marko wurde bereits eingerichtet. Die Erst-Einrichtung ist gesperrt.' });
  if (!process.env.SETUP_TOKEN || process.env.SETUP_TOKEN.length < 16) return res.status(503).json({ error: 'Der Server-Admin muss zuerst einen geheimen SETUP_TOKEN mit mindestens 16 Zeichen in den Umgebungsvariablen setzen.' });
  const token = req.body && req.body.token;
  if (!tokenMatches(token, process.env.SETUP_TOKEN)) return res.status(403).json({ error: 'Einrichtungs-Code falsch.' });

  const accounts = [];
  accounts.push({ username: 'marko-admin', password: randomPassword(), mode: 'chat', role: 'admin' });
  for (let i = 1; i <= 9; i++) accounts.push({ username: `marko${String(i).padStart(2, '0')}`, password: randomPassword(), mode: 'chat', role: 'user' });
  for (let i = 1; i <= 10; i++) accounts.push({ username: `screen${String(i).padStart(2, '0')}`, password: randomPassword(), mode: 'screen', role: 'user' });

  try {
    const insert = db.prepare('INSERT INTO users(username,password_hash,mode,role) VALUES(?,?,?,?)');
    const createAll = db.transaction((rows) => {
      for (const account of rows) insert.run(account.username, account.passwordHash, account.mode, account.role);
    });
    for (const account of accounts) account.passwordHash = await bcrypt.hash(account.password, 12);
    if (countUsers.get().count !== 0) return res.status(409).json({ error: 'Die Erst-Einrichtung wurde parallel bereits abgeschlossen. Bitte melde dich normal an.' });
    createAll(accounts);
    logAudit(null, 'initial_setup', '20 accounts generated');
    // Send all passwords exactly once. Only hashes are kept in the database.
    return res.status(201).json({
      success: true,
      message: '20 Konten wurden angelegt. Sichere diese Zugangsdaten jetzt; sie werden später nicht erneut angezeigt.',
      accounts: accounts.map(({ username, password, mode, role }) => ({ username, password, mode, role }))
    });
  } catch (err) {
    console.error('Setup fehlgeschlagen:', err.message);
    return res.status(500).json({ error: 'Konten konnten nicht vollständig erstellt werden. Prüfe das Server-Log und versuche es erneut, falls noch kein Konto existiert.' });
  }
});

app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const mode = req.body?.mode === 'screen' ? 'screen' : 'chat';
  if (!username || !password || username.length > 80 || password.length > 256) return res.status(400).json({ error: 'Bitte Benutzername und Passwort eingeben.' });
  if (countUsers.get().count === 0) return res.status(428).json({ error: 'Marko muss zuerst eingerichtet werden.' });

  const row = db.prepare('SELECT * FROM users WHERE username = ? AND mode = ?').get(username, mode);
  const validPassword = row ? await bcrypt.compare(password, row.password_hash) : await bcrypt.compare(password, '$2a$12$gJLqZa8u3M8p4Z3Y5AFw3e6.PvKk2pJQk7Lz3gF2z8u4p9VY7k3m2');
  if (!row || !validPassword || !row.is_active) return res.status(401).json({ error: 'Benutzername oder Passwort ist falsch – oder das Konto ist deaktiviert.' });

  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Sichere Anmeldung fehlgeschlagen. Bitte erneut versuchen.' });
    req.session.user = { id: row.id, username: row.username, mode: row.mode };
    db.prepare("UPDATE users SET last_login = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(row.id);
    logAudit(row.id, 'login', mode);
    req.session.save((saveErr) => {
      if (saveErr) return res.status(500).json({ error: 'Sitzung konnte nicht gespeichert werden. Bitte erneut versuchen.' });
      return res.json({ user: { id: row.id, username: row.username, mode: row.mode, role: row.role } });
    });
  });
});
app.get('/api/me', requireAuth, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ user: req.currentUser, aiReady: Boolean(process.env.OPENAI_API_KEY) });
});
app.post('/api/auth/logout', (req, res) => {
  if (req.session?.user) logAudit(req.session.user.id, 'logout', req.session.user.mode);
  req.session.destroy((err) => {
    res.clearCookie('marko.sid', { httpOnly: true, secure: isProduction, sameSite: 'lax' });
    if (err) return res.status(500).json({ error: 'Abmeldung fehlgeschlagen.' });
    res.json({ ok: true });
  });
});
app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  const currentPassword = typeof req.body?.currentPassword === 'string' ? req.body.currentPassword : '';
  const newPassword = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.currentUser.id);
  if (!row || !(await bcrypt.compare(currentPassword, row.password_hash))) return res.status(400).json({ error: 'Das aktuelle Passwort stimmt nicht.' });
  if (newPassword.length < 12 || newPassword.length > 128) return res.status(400).json({ error: 'Das neue Passwort muss 12 bis 128 Zeichen lang sein.' });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await bcrypt.hash(newPassword, 12), req.currentUser.id);
  logAudit(req.currentUser.id, 'change_password', req.currentUser.username);
  res.json({ ok: true, message: 'Passwort erfolgreich geändert.' });
});

app.get('/api/admin/users', requireAuth, requireAdmin, (_req, res) => {
  const users = db.prepare('SELECT id, username, mode, role, is_active, created_at, last_login FROM users ORDER BY mode, role DESC, username').all();
  const events = db.prepare(`SELECT a.action, a.target, a.created_at, u.username AS actor FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.id DESC LIMIT 12`).all();
  res.set('Cache-Control', 'no-store');
  res.json({ users: users.map(safeUser), events, summary: { total: users.length, chat: users.filter(u => u.mode === 'chat').length, screen: users.filter(u => u.mode === 'screen').length, disabled: users.filter(u => !u.is_active).length } });
});
app.patch('/api/admin/users/:id/status', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const active = req.body?.active;
  if (!Number.isInteger(id) || id <= 0 || typeof active !== 'boolean') return res.status(400).json({ error: 'Ungültige Kontodaten.' });
  const target = userById.get(id);
  if (!target) return res.status(404).json({ error: 'Konto nicht gefunden.' });
  if (target.id === req.currentUser.id && !active) return res.status(400).json({ error: 'Du kannst dein eigenes Admin-Konto nicht deaktivieren.' });
  if (target.role === 'admin' && target.mode === 'chat' && !active) {
    const activeAdmins = db.prepare("SELECT COUNT(*) AS count FROM users WHERE mode='chat' AND role='admin' AND is_active=1").get().count;
    if (activeAdmins <= 1) return res.status(400).json({ error: 'Der letzte aktive Admin kann nicht deaktiviert werden.' });
  }
  db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(active ? 1 : 0, id);
  // Existing sessions for disabled accounts are rejected by requireAuth on their next API request.
  logAudit(req.currentUser.id, active ? 'account_enabled' : 'account_disabled', target.username);
  res.json({ ok: true, user: safeUser(userById.get(id)) });
});
app.post('/api/admin/users/:id/reset-password', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Ungültige Konto-ID.' });
  const target = userById.get(id);
  if (!target) return res.status(404).json({ error: 'Konto nicht gefunden.' });
  if (!target.is_active) return res.status(400).json({ error: 'Aktiviere das Konto zuerst.' });
  const password = randomPassword();
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await bcrypt.hash(password, 12), id);
  logAudit(req.currentUser.id, 'password_reset', target.username);
  res.json({ username: target.username, password, mode: target.mode, message: 'Dieses Passwort wird nur jetzt angezeigt. Übergib es sicher an die Person.' });
});

app.post('/api/chat', chatLimiter, requireAuth, async (req, res) => {
  if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: 'Der KI-Schlüssel fehlt. Trage OPENAI_API_KEY in den Umgebungsvariablen des Servers ein und starte ihn neu.' });
  const messages = req.body?.messages;
  const screenshot = req.body?.screenshot;
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 24) return res.status(400).json({ error: 'Nachrichtenverlauf ist ungültig.' });
  let totalChars = 0;
  const validMessages = [];
  for (const item of messages) {
    if (!item || !['user', 'assistant'].includes(item.role) || typeof item.content !== 'string' || item.content.length > 10000) return res.status(400).json({ error: 'Eine Nachricht hat ein ungültiges Format.' });
    totalChars += item.content.length;
    validMessages.push({ role: item.role, content: item.content });
  }
  if (totalChars > 26000) return res.status(413).json({ error: 'Der Chat ist zu lang. Starte einen neuen Chat oder kürze die Nachricht.' });
  if (validMessages[validMessages.length - 1].role !== 'user') return res.status(400).json({ error: 'Die letzte Nachricht muss von dir stammen.' });
  let imageUrl = null;
  if (screenshot !== undefined && screenshot !== null) {
    if (req.currentUser.mode !== 'screen') return res.status(403).json({ error: 'Screenshots dürfen nur im separaten Bildschirm-Modus gesendet werden.' });
    if (typeof screenshot !== 'string' || screenshot.length > 3_800_000 || !/^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(screenshot)) {
      return res.status(400).json({ error: 'Screenshot ist ungültig oder zu groß. Bitte erneut aufnehmen.' });
    }
    imageUrl = screenshot;
  }

  const input = validMessages.slice(-20).map((message, index, arr) => {
    if (imageUrl && index === arr.length - 1) {
      return { role: message.role, content: [
        { type: 'input_text', text: message.content },
        { type: 'input_image', image_url: imageUrl, detail: 'high' }
      ] };
    }
    return { role: message.role, content: message.content };
  });
  const modeInstructions = req.currentUser.mode === 'screen'
    ? 'Du bist Marko im Bildschirm-Modus. Der Nutzer muss eine Freigabe im Browser selbst auslösen. Analysiere bereitgestellte Screenshots nur im Kontext seiner Frage. Behaupte niemals, den ganzen Bildschirm live zu sehen, wenn kein Screenshot übermittelt wurde. Weise bei Passwörtern, privaten Nachrichten oder sensiblen Daten auf Umsicht hin. Du steuerst den Computer nicht selbst und führst keine Klicks aus.'
    : 'Du bist Marko, ein hilfreicher, kreativer und kompetenter KI-Assistent. Antworte standardmäßig auf Deutsch, strukturiert und ehrlich. Hilf unter anderem beim Lernen, Schreiben, Programmieren, Planen, Erklären und Ideenfinden. Behaupte nicht, Zugang zu Live-Informationen, Dateien oder Geräten zu haben, wenn diese nicht tatsächlich bereitgestellt wurden. Wenn du unsicher bist, sag es offen.';
  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 65000, maxRetries: 1 });
    const response = await client.responses.create({
      model: process.env.OPENAI_MODEL || 'gpt-5-mini',
      instructions: modeInstructions,
      input,
      max_output_tokens: 1400,
      store: false
    });
    const answer = (response.output_text || '').trim();
    if (!answer) return res.status(502).json({ error: 'Die KI hat keine Textantwort zurückgegeben. Bitte probiere es erneut.' });
    res.json({ answer, model: process.env.OPENAI_MODEL || 'gpt-5-mini' });
  } catch (err) {
    const status = Number(err?.status || 0);
    if (status === 401) return res.status(502).json({ error: 'Der KI-Anbieter hat den API-Schlüssel abgelehnt. Prüfe OPENAI_API_KEY.' });
    if (status === 429) return res.status(429).json({ error: 'Das KI-Kontingent ist erreicht oder es gibt zu viele Anfragen. Prüfe Guthaben und Limits beim API-Anbieter.' });
    if (status === 400) return res.status(502).json({ error: 'Die KI-Anfrage wurde abgelehnt. Prüfe das gewählte Modell in OPENAI_MODEL.' });
    console.error('KI-Anfrage fehlgeschlagen:', status || 'unknown', err?.message || 'unbekannter Fehler');
    return res.status(502).json({ error: 'Marko konnte gerade keine Antwort abrufen. Prüfe die Serververbindung und versuche es erneut.' });
  }
});

app.get('*path', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use((err, _req, res, _next) => {
  console.error('Unbehandelter Serverfehler:', err?.message || err);
  res.status(500).json({ error: 'Interner Serverfehler.' });
});

const server = app.listen(port, '0.0.0.0', () => {
  console.log(`Marko AI läuft auf Port ${port}.`);
  console.log(`Datenbank: ${path.join(dataDir, 'marko.sqlite')}`);
  if (!process.env.OPENAI_API_KEY) console.warn('Hinweis: OPENAI_API_KEY fehlt – Anmeldung funktioniert, KI-Antworten erst nach Konfiguration.');
  if (countUsers.get().count === 0) console.log('Erst-Einrichtung offen: öffne die Website und gib den SETUP_TOKEN ein.');
});

function shutDown(signal) {
  console.log(`${signal} erhalten – Marko wird sauber beendet.`);
  server.close(() => {
    try { db.close(); } finally { process.exit(0); }
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutDown('SIGTERM'));
process.on('SIGINT', () => shutDown('SIGINT'));
