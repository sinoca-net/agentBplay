require('./env');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const { Server } = require('socket.io');
const webpush = require('web-push');
const store = require('./db');
const agent = require('./agent');
const wa = require('./whatsapp');

const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: true } });

// ---------- secretos autogenerados (persisten en la base) ----------
function persistentSecret(key, gen) {
  const s = store.db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  if (s) return JSON.parse(s.value);
  const v = gen();
  store.setSetting(key, v);
  return v;
}
const SESSION_SECRET = process.env.SESSION_SECRET || persistentSecret('_session_secret', () => crypto.randomBytes(32).toString('hex'));
const vapid = persistentSecret('_vapid', () => webpush.generateVAPIDKeys());
webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', vapid.publicKey, vapid.privateKey);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'cambiar123';
if (!process.env.ADMIN_PASSWORD) console.warn('⚠️  ADMIN_PASSWORD no configurada: usando "cambiar123". Cambiala en las variables de entorno.');

const adminToken = () => crypto.createHmac('sha256', SESSION_SECRET).update('admin:' + ADMIN_PASSWORD).digest('hex');
const isAdminReq = req => req.cookies?.adm && req.cookies.adm === adminToken();

app.use(express.json({ limit: '25mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

const publicSettings = s => ({
  brand_name: s.brand_name, agent_name: s.agent_name, agent_status: s.agent_status, welcome_message: s.welcome_message,
  provinces: Object.fromEntries(Object.entries(s.provinces).map(([k, p]) => [k, { label: p.label, bonus: p.bonus || '' }])),
  landing: s.landing,
  vapidPublicKey: vapid.publicKey,
});

// ---------- envío saliente (bot / asesor / sistema) por el canal del contacto ----------
function sendOutbound(contactId, sender, body) {
  const contact = store.getContact(contactId);
  if (!contact) return null;
  const channel = sender === 'system' ? 'internal' : contact.channel;
  const msg = store.addMessage(contactId, sender, body, { channel });
  io.to('admins').emit('message', msg);
  io.to('admins').emit('contact', store.getContact(contactId));
  if (sender === 'system') return msg;

  if (channel === 'whatsapp') {
    const hoursSince = contact.last_client_at ? (Date.now() - Date.parse(contact.last_client_at + 'Z')) / 36e5 : 999;
    if (hoursSince > 24) {
      failMessage(msg, 'Pasaron más de 24 h desde el último mensaje del cliente: WhatsApp sólo permite plantillas aprobadas.');
      return msg;
    }
    if (!wa.enabled()) { failMessage(msg, 'WhatsApp API no configurada (WA_TOKEN / WA_PHONE_NUMBER_ID).'); return msg; }
    wa.sendText(contact.phone, body)
      .then(id => { store.db.prepare('UPDATE messages SET wa_id=? WHERE id=?').run(id, msg.id); })
      .catch(err => failMessage(msg, err.message));
  } else {
    io.to(`c:${contactId}`).emit('message', clientMsg(msg));
    // si no tiene el chat abierto → notificación push
    const room = io.sockets.adapter.rooms.get(`c:${contactId}`);
    if (!room || room.size === 0) pushTo(contactId, body);
  }
  return msg;
}
function failMessage(msg, reason) {
  store.db.prepare("UPDATE messages SET status='failed' WHERE id=?").run(msg.id);
  io.to('admins').emit('status', { id: msg.id, status: 'failed', error: reason });
  const note = store.addMessage(msg.contact_id, 'system', `⚠️ No se pudo enviar: ${reason}`, { channel: 'internal' });
  io.to('admins').emit('message', note);
}
const clientMsg = m => ({ id: m.id, from: m.sender === 'client' ? 'me' : 'them', body: m.body, status: m.status, created_at: m.created_at });

async function pushTo(contactId, body) {
  const s = store.getSettings();
  const subs = store.db.prepare('SELECT * FROM push_subs WHERE contact_id=?').all(contactId);
  for (const row of subs) {
    try {
      await webpush.sendNotification(JSON.parse(row.sub), JSON.stringify({ title: s.agent_name, body: body.slice(0, 140), url: '/chat' }));
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) store.db.prepare('DELETE FROM push_subs WHERE endpoint=?').run(row.endpoint);
    }
  }
}

agent.init({ io, sendOutbound });

// ---------- recepción unificada de mensajes del cliente ----------
function receiveClientMessage(contactId, body, extra = {}) {
  store.updateContact(contactId, { channel: extra.channel || 'web' });
  const msg = store.addMessage(contactId, 'client', body.slice(0, 4000), extra);
  io.to('admins').emit('message', msg);
  io.to('admins').emit('contact', store.getContact(contactId));
  agent.onClientMessage(contactId);
  return msg;
}

// ================= CHAT WEB (cliente) =================
app.get('/api/chat/config', (_req, res) => res.json(publicSettings(store.getSettings())));

app.post('/api/chat/start', (req, res) => {
  const { name, phone, province, adult, optin, source } = req.body || {};
  const p = store.normalizePhone(phone);
  if (!String(name || '').trim()) return res.status(400).json({ error: 'Ingresá tu nombre' });
  if (!p) return res.status(400).json({ error: 'Ingresá un celular válido con código de área (ej: 223 1234567)' });
  if (!adult) return res.status(400).json({ error: 'Tenés que ser mayor de 18 años' });
  const settings = store.getSettings();
  const prov = settings.provinces[province] ? province : null;

  let contact = store.getContactByPhone(p);
  let isNew = false;
  if (!contact) {
    const id = store.db.prepare('INSERT INTO contacts(name, phone, province, source, channel, marketing_optin) VALUES(?,?,?,?,?,?)')
      .run(String(name).trim().slice(0, 60), p, prov, String(source || 'web').slice(0, 120), 'web', optin ? 1 : 0).lastInsertRowid;
    contact = store.getContact(id);
    store.logEvent(id, 'created', { channel: 'web', source });
    isNew = true;
  } else {
    contact = store.updateContact(contact.id, {
      channel: 'web', ...(prov && !contact.province ? { province: prov } : {}),
      ...(optin ? { marketing_optin: 1 } : {}),
    });
  }
  const token = crypto.randomBytes(24).toString('hex');
  store.db.prepare('INSERT INTO sessions(token, contact_id) VALUES(?,?)').run(token, contact.id);

  if (isNew || !store.db.prepare("SELECT 1 FROM messages WHERE contact_id=? AND sender!='system' LIMIT 1").get(contact.id)) {
    sendOutbound(contact.id, 'bot', settings.welcome_message);
    // arranque automático del bot con la info del formulario
    receiveClientMessage(contact.id, prov ? `Hola, soy ${contact.name}, de ${settings.provinces[prov].label}.` : `Hola, soy ${contact.name}.`, { channel: 'web' });
  }
  io.to('admins').emit('contact', store.getContact(contact.id));
  res.json({ token });
});

function sessionFor(token) {
  return token ? store.db.prepare('SELECT * FROM sessions WHERE token=?').get(String(token)) : null;
}

app.get('/api/chat/history', (req, res) => {
  const sess = sessionFor(req.query.token);
  if (!sess) return res.status(401).json({ error: 'sesión inválida' });
  // sólo los mensajes desde que empezó esta sesión (privacidad si alguien usa el teléfono de otro)
  const msgs = store.db.prepare("SELECT * FROM messages WHERE contact_id=? AND sender!='system' AND created_at>=? ORDER BY id")
    .all(sess.contact_id, sess.started_at);
  const c = store.getContact(sess.contact_id);
  res.json({ name: c.name, messages: msgs.map(clientMsg) });
});

app.post('/api/chat/push', (req, res) => {
  const sess = sessionFor(req.body?.token);
  const sub = req.body?.subscription;
  if (!sess || !sub?.endpoint) return res.status(400).json({ error: 'datos inválidos' });
  store.db.prepare('INSERT INTO push_subs(endpoint, contact_id, sub) VALUES(?,?,?) ON CONFLICT(endpoint) DO UPDATE SET contact_id=excluded.contact_id, sub=excluded.sub')
    .run(sub.endpoint, sess.contact_id, JSON.stringify(sub));
  res.json({ ok: true });
});

// ================= WEBHOOK WHATSAPP =================
app.get('/webhook/whatsapp', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === wa.VERIFY_TOKEN) return res.send(req.query['hub.challenge']);
  res.sendStatus(403);
});

app.post('/webhook/whatsapp', (req, res) => {
  if (!wa.verifySignature(req)) return res.sendStatus(401);
  res.sendStatus(200); // responder rápido a Meta
  const { messages, statuses } = wa.parseWebhook(req.body || {});
  for (const m of messages) {
    if (store.db.prepare('SELECT 1 FROM messages WHERE wa_id=?').get(m.id)) continue; // reintento de Meta
    const phone = store.normalizePhone(m.from) || '+' + m.from;
    let contact = store.getContactByPhone(phone);
    if (!contact) {
      const source = m.referral ? `anuncio:${m.referral.source_id || ''} ${m.referral.headline || ''}`.trim() : 'whatsapp';
      const id = store.db.prepare('INSERT INTO contacts(name, phone, source, channel) VALUES(?,?,?,?)')
        .run((m.name || '').slice(0, 60), phone, source.slice(0, 120), 'whatsapp').lastInsertRowid;
      store.logEvent(id, 'created', { channel: 'whatsapp', source });
      contact = store.getContact(id);
    } else if (!contact.name && m.name) {
      store.updateContact(contact.id, { name: m.name.slice(0, 60) });
    }
    receiveClientMessage(contact.id, m.text, { channel: 'whatsapp', wa_id: m.id });
  }
  for (const s of statuses) {
    const row = store.db.prepare('SELECT id, contact_id FROM messages WHERE wa_id=?').get(s.id);
    if (!row) continue;
    store.db.prepare('UPDATE messages SET status=? WHERE id=?').run(s.status, row.id);
    io.to('admins').emit('status', { id: row.id, status: s.status, error: s.error });
    if (s.status === 'failed') {
      const note = store.addMessage(row.contact_id, 'system', `⚠️ WhatsApp rechazó el mensaje: ${s.error || 'sin detalle'}`, { channel: 'internal' });
      io.to('admins').emit('message', note);
    }
  }
});

// ================= PANEL ADMIN =================
app.post('/api/admin/login', (req, res) => {
  const ok = req.body?.password && crypto.timingSafeEqual(
    crypto.createHash('sha256').update(String(req.body.password)).digest(),
    crypto.createHash('sha256').update(ADMIN_PASSWORD).digest());
  if (!ok) return res.status(401).json({ error: 'Contraseña incorrecta' });
  res.cookie('adm', adminToken(), { httpOnly: true, sameSite: 'lax', secure: req.secure || req.get('x-forwarded-proto') === 'https', maxAge: 30 * 864e5 });
  res.json({ ok: true });
});
app.post('/api/admin/logout', (_req, res) => { res.clearCookie('adm'); res.json({ ok: true }); });

const admin = express.Router();
admin.use((req, res, next) => (isAdminReq(req) ? next() : res.status(401).json({ error: 'no autorizado' })));

admin.get('/status', (req, res) => {
  const base = `${req.get('x-forwarded-proto') || req.protocol}://${req.get('host')}`;
  res.json({ ai: agent.hasAI(), whatsapp: wa.enabled(), webhook_url: `${base}/webhook/whatsapp`, verify_token: wa.VERIFY_TOKEN, landing_url: `${base}/`, chat_url: `${base}/chat`, widget: `<script src="${base}/widget.js" defer></script>`, default_password: !process.env.ADMIN_PASSWORD });
});

admin.get('/contacts', (req, res) => {
  const { q, stage, filter } = req.query;
  const where = []; const params = {};
  if (q) { where.push('(name LIKE @q OR phone LIKE @q OR notes LIKE @q OR tags LIKE @q)'); params.q = `%${q}%`; }
  if (stage) { where.push('stage=@stage'); params.stage = stage; }
  if (filter === 'human') where.push('needs_human=1');
  if (filter === 'unread') where.push('unread>0');
  if (filter === 'bot_off') where.push('bot_enabled=0');
  if (req.query.channel) { where.push('channel=@channel'); params.channel = req.query.channel; }
  const rows = store.db.prepare(`SELECT * FROM contacts ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY COALESCE(last_message_at, created_at) DESC LIMIT ${Math.min(Number(req.query.limit) || 300, 5000)}`).all(params);
  res.json(rows);
});

admin.post('/contacts', (req, res) => {
  const { name, phone, province, notes } = req.body || {};
  const p = store.normalizePhone(phone);
  if (!p) return res.status(400).json({ error: 'Teléfono inválido' });
  if (store.getContactByPhone(p)) return res.status(409).json({ error: 'Ya existe un contacto con ese teléfono' });
  const id = store.db.prepare('INSERT INTO contacts(name, phone, province, notes, source, channel) VALUES(?,?,?,?,?,?)')
    .run(name || '', p, province || null, notes || '', 'manual', 'whatsapp').lastInsertRowid;
  res.json(store.getContact(id));
});

admin.get('/contacts/:id/messages', (req, res) => {
  res.json(store.db.prepare('SELECT * FROM messages WHERE contact_id=? ORDER BY id').all(req.params.id));
});

admin.patch('/contacts/:id', (req, res) => {
  const f = { ...req.body };
  if (f.phone !== undefined) { f.phone = store.normalizePhone(f.phone); if (!f.phone) return res.status(400).json({ error: 'Teléfono inválido' }); }
  if (f.stage && !store.STAGES.includes(f.stage)) return res.status(400).json({ error: 'Etapa inválida' });
  if (f.bot_enabled === 1 || f.bot_enabled === true) { f.bot_enabled = 1; f.needs_human = 0; }
  try {
    const c = store.updateContact(Number(req.params.id), f);
    io.to('admins').emit('contact', c);
    res.json(c);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

admin.delete('/contacts/:id', (req, res) => {
  store.db.prepare('DELETE FROM contacts WHERE id=?').run(req.params.id);
  io.to('admins').emit('contact_deleted', Number(req.params.id));
  res.json({ ok: true });
});

const csvCell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
admin.get('/export.csv', (_req, res) => {
  const rows = store.db.prepare('SELECT * FROM contacts ORDER BY id').all();
  const cols = ['id', 'name', 'phone', 'province', 'stage', 'channel', 'source', 'tags', 'notes', 'marketing_optin', 'created_at', 'last_message_at'];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="contactos-bplay.csv"');
  res.send('﻿' + [cols.join(','), ...rows.map(r => cols.map(c => csvCell(r[c])).join(','))].join('\n'));
});

// Importar contactos (CSV con columnas nombre/name, telefono/phone, provincia/province opcional)
admin.post('/import', express.text({ type: '*/*', limit: '20mb' }), (req, res) => {
  const text = typeof req.body === 'string' ? req.body : '';
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return res.status(400).json({ error: 'CSV vacío' });
  const sep = (lines[0].match(/;/g) || []).length > (lines[0].match(/,/g) || []).length ? ';' : ',';
  const split = l => (l.match(new RegExp(`("([^"]|"")*"|[^${sep}]*)(${sep}|$)`, 'g')) || []).map(c => c.replace(new RegExp(`${sep}$`), '').replace(/^"|"$/g, '').replace(/""/g, '"').trim());
  const head = split(lines[0]).map(h => h.toLowerCase());
  const idx = names => head.findIndex(h => names.some(n => h.includes(n)));
  const iName = idx(['nombre', 'name']), iPhone = idx(['tel', 'phone', 'cel', 'whatsapp', 'numero', 'número']), iProv = idx(['prov']);
  if (iPhone < 0) return res.status(400).json({ error: 'No encontré una columna de teléfono' });
  let added = 0, dup = 0, invalid = 0;
  const ins = store.db.prepare("INSERT OR IGNORE INTO contacts(name, phone, province, source, channel) VALUES(?,?,?,'importado','whatsapp')");
  const provs = store.getSettings().provinces;
  store.db.transaction(() => {
    for (const l of lines.slice(1)) {
      const c = split(l);
      const p = store.normalizePhone(c[iPhone]);
      if (!p) { invalid++; continue; }
      const prov = iProv >= 0 && provs[String(c[iProv]).toUpperCase()] ? String(c[iProv]).toUpperCase() : null;
      const r = ins.run(iName >= 0 ? (c[iName] || '').slice(0, 60) : '', p, prov);
      r.changes ? added++ : dup++;
    }
  })();
  res.json({ added, dup, invalid });
});

admin.get('/settings', (_req, res) => {
  const s = store.getSettings();
  delete s._session_secret; delete s._vapid;
  res.json({ ...s, prompt_version: store.currentPromptVersion() });
});

admin.put('/settings', (req, res) => {
  const editable = ['brand_name', 'agent_name', 'agent_title', 'style_guide', 'landing', 'agent_status', 'welcome_message', 'model', 'bot_reply_delay_ms', 'provinces',
    'deposit_instructions', 'script', 'followups', 'max_followups', 'wa_followup_template', 'wa_template_lang'];
  const prev = store.getSettings();
  for (const k of editable) if (req.body[k] !== undefined) store.setSetting(k, req.body[k]);
  if (req.body.script !== undefined && req.body.script !== prev.script) {
    store.db.prepare('INSERT INTO prompt_versions(script, note) VALUES(?,?)').run(req.body.script, req.body.version_note || '');
  }
  res.json({ ok: true, prompt_version: store.currentPromptVersion() });
});

admin.get('/prompt_versions', (_req, res) => {
  res.json(store.db.prepare('SELECT id, note, created_at, substr(script,1,140) AS preview FROM prompt_versions ORDER BY id DESC').all());
});
admin.get('/prompt_versions/:id', (req, res) => res.json(store.db.prepare('SELECT * FROM prompt_versions WHERE id=?').get(req.params.id)));

// Métricas del embudo
const ORDER = ['nuevo', 'link_enviado', 'registrado', 'validado', 'primera_carga', 'activo'];
admin.get('/metrics', (req, res) => {
  const days = Number(req.query.days) || 30;
  const contacts = store.db.prepare(`SELECT id, stage, channel, source, prompt_version, needs_human FROM contacts WHERE created_at >= datetime('now', ?)`).all(`-${days} days`);
  const reachedRows = store.db.prepare("SELECT contact_id, json_extract(data,'$.to') AS st FROM events WHERE type='stage'").all();
  const reached = new Map();
  for (const r of reachedRows) {
    const i = ORDER.indexOf(r.st);
    if (i >= 0) reached.set(r.contact_id, Math.max(reached.get(r.contact_id) ?? 0, i));
  }
  const maxIdx = c => Math.max(reached.get(c.id) ?? 0, ORDER.indexOf(c.stage));
  const funnel = ORDER.map((st, i) => ({ stage: st, label: agent.STAGE_LABELS[st], count: contacts.filter(c => maxIdx(c) >= i).length }));
  const group = key => {
    const g = {};
    for (const c of contacts) {
      const k = c[key] ?? '—';
      g[k] = g[k] || { key: k, total: 0, registrados: 0, ftd: 0 };
      g[k].total++;
      if (maxIdx(c) >= 2) g[k].registrados++;
      if (maxIdx(c) >= 4) g[k].ftd++;
    }
    return Object.values(g).sort((a, b) => b.total - a.total);
  };
  const ftd = funnel[4].count;
  const daily = store.db.prepare(`SELECT date(created_at) AS d, COUNT(*) AS n FROM contacts WHERE created_at >= datetime('now', ?) GROUP BY d ORDER BY d`).all(`-${days} days`);
  const ftdDaily = store.db.prepare(`SELECT date(created_at) AS d, COUNT(DISTINCT contact_id) AS n FROM events WHERE type='stage' AND json_extract(data,'$.to')='primera_carga' AND created_at >= datetime('now', ?) GROUP BY d`).all(`-${days} days`);
  res.json({
    days, total: contacts.length, funnel, ftd, cpa_income_usd: ftd * 10,
    perdidos: contacts.filter(c => c.stage === 'perdido').length,
    by_version: group('prompt_version'), by_channel: group('channel'), by_source: group('source').slice(0, 15),
    daily, ftd_daily: ftdDaily,
  });
});

// ---------- Entrenamiento ----------
admin.get('/examples', (_req, res) => res.json(store.db.prepare('SELECT * FROM examples ORDER BY id DESC').all()));
admin.post('/examples', (req, res) => {
  const { context, reply } = req.body || {};
  if (!context || !reply) return res.status(400).json({ error: 'Completá el mensaje del cliente y tu respuesta' });
  const id = store.db.prepare("INSERT INTO examples(kind, context, reply) VALUES('manual',?,?)").run(String(context).slice(0, 600), String(reply).slice(0, 1200)).lastInsertRowid;
  res.json(store.db.prepare('SELECT * FROM examples WHERE id=?').get(id));
});
admin.patch('/examples/:id', (req, res) => {
  const { active, context, reply } = req.body || {};
  const cur = store.db.prepare('SELECT * FROM examples WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'No existe' });
  store.db.prepare('UPDATE examples SET active=?, context=?, reply=? WHERE id=?')
    .run(active === undefined ? cur.active : (active ? 1 : 0), context ?? cur.context, reply ?? cur.reply, cur.id);
  res.json(store.db.prepare('SELECT * FROM examples WHERE id=?').get(cur.id));
});
admin.delete('/examples/:id', (req, res) => { store.db.prepare('DELETE FROM examples WHERE id=?').run(req.params.id); res.json({ ok: true }); });

// Corregir una respuesta del bot desde la bandeja → queda como ejemplo
admin.post('/messages/:id/correct', (req, res) => {
  const reply = String(req.body?.reply || '').trim();
  const msg = store.db.prepare('SELECT * FROM messages WHERE id=?').get(req.params.id);
  if (!msg || msg.sender !== 'bot' || !reply) return res.status(400).json({ error: 'Datos inválidos' });
  const prev = store.db.prepare("SELECT body FROM messages WHERE contact_id=? AND id<? AND sender='client' ORDER BY id DESC LIMIT 3").all(msg.contact_id, msg.id).reverse();
  const context = prev.map(m => m.body).join(' / ') || '(inicio de la conversación)';
  const id = store.db.prepare("INSERT INTO examples(kind, context, reply, bad_reply) VALUES('correction',?,?,?)")
    .run(context.slice(0, 600), reply.slice(0, 1200), msg.body.slice(0, 600)).lastInsertRowid;
  res.json(store.db.prepare('SELECT * FROM examples WHERE id=?').get(id));
});

admin.post('/learn', express.json({ limit: '25mb' }), async (req, res) => {
  const { text, owner } = req.body || {};
  if (!owner) return res.status(400).json({ error: 'Poné cómo figurás vos en el chat' });
  try {
    const r = await agent.learnFromChats(text || '', owner);
    if (r.style_guide) store.setSetting('style_guide', r.style_guide);
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

admin.post('/analyze', async (_req, res) => {
  try { res.json(await agent.analyze()); } catch (e) { res.status(400).json({ error: e.message }); }
});

app.use('/api/admin', admin);

// ================= SOCKETS =================
io.on('connection', socket => {
  const cookies = Object.fromEntries((socket.handshake.headers.cookie || '').split(';').map(c => c.trim().split('=').map(decodeURIComponent)));
  const auth = socket.handshake.auth || {};

  if (auth.role === 'admin') {
    if (cookies.adm !== adminToken()) return socket.disconnect(true);
    socket.join('admins');
    socket.on('agent:send', ({ contactId, body, keepBot }, ack) => {
      const text = String(body || '').trim();
      if (!text) return;
      // cuando un humano escribe, el bot se pausa (salvo que se indique lo contrario)
      if (!keepBot) store.updateContact(contactId, { bot_enabled: 0, needs_human: 0 });
      else store.updateContact(contactId, { needs_human: 0 });
      agent.markRead(contactId, false);
      const m = sendOutbound(contactId, 'agent', text);
      ack && ack(m);
    });
    socket.on('agent:open', contactId => {
      store.updateContact(contactId, { unread: 0 });
      agent.markRead(contactId, false);
      io.to('admins').emit('contact', store.getContact(contactId));
    });
    return;
  }

  // cliente del chat web
  const sess = sessionFor(auth.token);
  if (!sess) return socket.disconnect(true);
  const room = `c:${sess.contact_id}`;
  socket.join(room);
  // al conectarse, lo enviado mientras no estaba pasa a "entregado"
  store.db.prepare("UPDATE messages SET status='delivered' WHERE contact_id=? AND sender IN ('bot','agent') AND status='sent'").run(sess.contact_id);
  socket.on('message', (body, ack) => {
    const text = String(body || '').trim();
    if (!text) return;
    const m = receiveClientMessage(sess.contact_id, text, { channel: 'web' });
    ack && ack(clientMsg(m));
  });
  socket.on('typing', on => io.to('admins').emit('client_typing', { contactId: sess.contact_id, on: !!on }));
  socket.on('seen', () => {
    const r = store.db.prepare("UPDATE messages SET status='read' WHERE contact_id=? AND sender IN ('bot','agent') AND status!='read'").run(sess.contact_id);
    if (r.changes) io.to('admins').emit('seen', { contactId: sess.contact_id });
  });
});

// ================= SEGUIMIENTOS AUTOMÁTICOS =================
async function runFollowups() {
  const s = store.getSettings();
  for (const f of s.followups || []) {
    if (!f.text || !f.stage) continue;
    const rows = store.db.prepare(`SELECT * FROM contacts WHERE stage=? AND bot_enabled=1 AND followups_sent < ?
      AND last_outbound_at IS NOT NULL AND (last_client_at IS NULL OR last_outbound_at > last_client_at)
      AND last_outbound_at < datetime('now', ?)`).all(f.stage, s.max_followups || 2, `-${Number(f.after_hours) || 2} hours`);
    for (const c of rows) {
      const text = f.text.replace(/\{nombre\}/g, (c.name || '').split(' ')[0] || '').replace(/\s+,/g, ',').trim();
      store.updateContact(c.id, { followups_sent: c.followups_sent + 1 });
      store.logEvent(c.id, 'followup', { stage: f.stage });
      const hoursSinceClient = c.last_client_at ? (Date.now() - Date.parse(c.last_client_at + 'Z')) / 36e5 : 999;
      if (c.channel === 'whatsapp' && hoursSinceClient > 24) {
        // fuera de la ventana de 24 h: sólo plantilla aprobada (si está configurada)
        if (s.wa_followup_template && wa.enabled()) {
          try {
            const id = await wa.sendTemplate(c.phone, s.wa_followup_template, s.wa_template_lang || 'es_AR', [(c.name || '').split(' ')[0] || 'hola']);
            const m = store.addMessage(c.id, 'bot', `[Plantilla: ${s.wa_followup_template}]`, { channel: 'whatsapp', wa_id: id });
            io.to('admins').emit('message', m);
          } catch (e) { console.error('[followup template]', e.message); }
        }
        continue;
      }
      sendOutbound(c.id, 'bot', text);
    }
  }
}
setInterval(() => runFollowups().catch(e => console.error('[followups]', e)), 5 * 60 * 1000);

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'landing.html')));

server.listen(PORT, () => {
  console.log(`BPLAY CRM en http://localhost:${PORT}  (panel: /admin · chat: /chat)`);
  console.log(`IA: ${agent.hasAI() ? 'activa' : 'SIN API KEY (modo básico)'} · WhatsApp API: ${wa.enabled() ? 'conectada' : 'no configurada'}`);
});

module.exports = { app, server, runFollowups };
