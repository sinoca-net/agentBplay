const path = require('path');
const fs = require('fs');
// SQLite nativo de Node (>= 22.13): sin dependencias que compilar
const { DatabaseSync } = require('node:sqlite');
const { DEFAULT_SETTINGS } = require('./defaults');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'crm.sqlite'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
db.transaction = fn => (...args) => {
  db.exec('BEGIN');
  try { const r = fn(...args); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
};

db.exec(`
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  phone TEXT UNIQUE,
  province TEXT,
  stage TEXT DEFAULT 'nuevo',
  tags TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  source TEXT DEFAULT '',
  channel TEXT DEFAULT 'web',
  bot_enabled INTEGER DEFAULT 1,
  needs_human INTEGER DEFAULT 0,
  unread INTEGER DEFAULT 0,
  marketing_optin INTEGER DEFAULT 0,
  prompt_version INTEGER,
  followups_sent INTEGER DEFAULT 0,
  last_client_at TEXT,
  last_outbound_at TEXT,
  last_message_at TEXT,
  last_message_preview TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  started_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  sender TEXT NOT NULL,          -- client | bot | agent | system
  body TEXT NOT NULL,
  status TEXT DEFAULT 'sent',    -- sent | delivered | read | failed
  channel TEXT DEFAULT 'web',
  wa_id TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_contact ON messages(contact_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_wa ON messages(wa_id);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  data TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS push_subs (
  endpoint TEXT PRIMARY KEY,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
  sub TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS examples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,            -- chat (aprendido de tus chats) | correction (corregido en la bandeja) | manual
  context TEXT NOT NULL,         -- lo que dijo el cliente
  reply TEXT NOT NULL,           -- cómo respondés vos
  bad_reply TEXT,                -- lo que dijo el bot y NO había que decir (correcciones)
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS prompt_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  script TEXT NOT NULL,
  note TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
`);

// ---------- settings ----------
function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const s = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  for (const r of rows) {
    try { s[r.key] = JSON.parse(r.value); } catch { /* ignore */ }
  }
  return s;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, JSON.stringify(value));
}

function currentPromptVersion() {
  let v = db.prepare('SELECT * FROM prompt_versions ORDER BY id DESC LIMIT 1').get();
  if (!v) {
    const s = getSettings();
    const id = db.prepare('INSERT INTO prompt_versions(script, note) VALUES(?,?)').run(s.script, 'Versión inicial').lastInsertRowid;
    v = db.prepare('SELECT * FROM prompt_versions WHERE id=?').get(id);
  }
  return v;
}

// ---------- contacts ----------
// Embudo: carga primero (transferencia + DNI), después registro. "cpa_confirmado" lo marcás vos al verificar con tu afiliador.
const STAGES = ['nuevo', 'datos_carga', 'cargo', 'link_enviado', 'registrado', 'cpa_confirmado', 'activo', 'perdido'];
const STAGE_RANK = Object.fromEntries(STAGES.map((s, i) => [s, i]));

function normalizePhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('54')) d = d.slice(2);
  if (d.startsWith('9') && d.length === 11) d = d.slice(1);
  if (d.startsWith('0')) d = d.slice(1);
  // remove the "15" after area code (2-4 digit area codes)
  if (d.length === 12) {
    for (const len of [2, 3, 4]) {
      if (d.slice(len, len + 2) === '15') { d = d.slice(0, len) + d.slice(len + 2); break; }
    }
  }
  if (d.length !== 10) return ''; // invalid AR mobile
  return '+549' + d;
}

function getContact(id) {
  return db.prepare('SELECT * FROM contacts WHERE id=?').get(id);
}
function getContactByPhone(phone) {
  return db.prepare('SELECT * FROM contacts WHERE phone=?').get(phone);
}
function updateContact(id, fields) {
  const allowed = ['name', 'phone', 'province', 'stage', 'tags', 'notes', 'source', 'channel', 'dni', 'titular', 'deposit_amount', 'deposit_at', 'cpa_confirmed_at', 'bot_enabled', 'needs_human',
    'unread', 'marketing_optin', 'prompt_version', 'followups_sent', 'last_client_at', 'last_outbound_at',
    'last_message_at', 'last_message_preview'];
  const keys = Object.keys(fields).filter(k => allowed.includes(k));
  if (!keys.length) return getContact(id);
  const prev = getContact(id);
  const params = { id: Number(id) };
  for (const k of keys) {
    const v = fields[k];
    params[k] = typeof v === 'boolean' ? (v ? 1 : 0) : v === undefined ? null : v;
  }
  db.prepare(`UPDATE contacts SET ${keys.map(k => `${k}=@${k}`).join(',')} WHERE id=@id`).run(params);
  if (fields.stage && prev && prev.stage !== fields.stage) {
    logEvent(id, 'stage', { from: prev.stage, to: fields.stage });
  }
  return getContact(id);
}
function logEvent(contactId, type, data) {
  db.prepare('INSERT INTO events(contact_id,type,data) VALUES(?,?,?)').run(contactId, type, JSON.stringify(data || {}));
}

function addMessage(contactId, sender, body, extra = {}) {
  const info = db.prepare('INSERT INTO messages(contact_id,sender,body,channel,wa_id) VALUES(?,?,?,?,?)')
    .run(contactId, sender, body, extra.channel || 'web', extra.wa_id || null);
  const msg = db.prepare('SELECT * FROM messages WHERE id=?').get(info.lastInsertRowid);
  const now = msg.created_at;
  const preview = body.slice(0, 120);
  if (sender === 'client') {
    db.prepare('UPDATE contacts SET last_client_at=?, last_message_at=?, last_message_preview=?, unread=unread+1, followups_sent=0 WHERE id=?')
      .run(now, now, preview, contactId);
  } else if (sender === 'bot' || sender === 'agent') {
    db.prepare('UPDATE contacts SET last_outbound_at=?, last_message_at=?, last_message_preview=? WHERE id=?')
      .run(now, now, preview, contactId);
  }
  return msg;
}

// ---------- migraciones (bases ya creadas en Railway) ----------
(function migrate() {
  const cols = db.prepare('PRAGMA table_info(contacts)').all().map(c => c.name);
  for (const [col, type] of [['dni', 'TEXT'], ['titular', 'TEXT'], ['deposit_amount', 'TEXT'], ['deposit_at', 'TEXT'], ['cpa_confirmed_at', 'TEXT']]) {
    if (!cols.includes(col)) db.exec(`ALTER TABLE contacts ADD COLUMN ${col} ${type}`);
  }
  db.exec("UPDATE contacts SET stage='cargo' WHERE stage='primera_carga'");
  db.exec("UPDATE contacts SET stage='registrado' WHERE stage='validado'");

  // Flujo "carga primero": actualiza guion, seguimientos y textos que todavía estén con los valores viejos
  const has = db.prepare("SELECT 1 FROM settings WHERE key='_flow_v3'").get();
  if (!has) {
    const D = DEFAULT_SETTINGS;
    const stored = Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map(r => [r.key, JSON.parse(r.value)]));
    const put = (k, v) => db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, JSON.stringify(v));
    if (stored.script !== undefined) put('script', D.script);
    if (stored.followups !== undefined) put('followups', D.followups);
    if (stored.welcome_message !== undefined) put('welcome_message', D.welcome_message);
    if (stored.provinces) {
      for (const [k, p] of Object.entries(stored.provinces)) if (!p.bonus) p.bonus = D.provinces[k]?.bonus || '';
      put('provinces', stored.provinces);
    }
    if (stored.landing) {
      stored.landing.headline = D.landing.headline; stored.landing.subheadline = D.landing.subheadline; stored.landing.steps = D.landing.steps;
      put('landing', stored.landing);
    }
    if (db.prepare('SELECT 1 FROM prompt_versions LIMIT 1').get()) {
      db.prepare('INSERT INTO prompt_versions(script, note) VALUES(?,?)').run(D.script, 'Flujo carga primero: $1.000 → bono $10.000 + DNI');
    }
    put('_flow_v3', true);
  }
})();

module.exports = {
  STAGE_RANK,
  db, STAGES, getSettings, setSetting, currentPromptVersion, normalizePhone,
  getContact, getContactByPhone, updateContact, logEvent, addMessage,
};
