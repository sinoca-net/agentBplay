// Líneas de WhatsApp conectadas por QR (como WhatsApp Web), integradas a la bandeja del CRM.
// Uso pensado: atender a quien escribe y recontactar UNO A UNO a jugadores propios. Sin envíos masivos.
const path = require('path');
const fs = require('fs');
const QR = require('qrcode');
const pino = require('pino');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const BASE = path.join(DATA_DIR, 'wa-lines');
fs.mkdirSync(BASE, { recursive: true });

let B = null;
const lib = async () => (B ||= await import('@whiskeysockets/baileys'));
const lines = new Map();            // lineId -> { sock, status, qr, stopped }
const sentIds = new Set();          // ids de mensajes que mandó el CRM (para no duplicarlos)
let hooks = {};                     // onInbound, onFromPhone, onStatus, onReceipt

function init(h) { hooks = h; }
const dirOf = id => path.join(BASE, String(id));

function setState(id, patch) {
  const e = lines.get(id) || {};
  Object.assign(e, patch);
  lines.set(id, e);
  hooks.onStatus && hooks.onStatus(id, { status: e.status, qr: e.qr || null, phone: e.phone || null });
}

function unwrap(msg) {
  let m = msg || {};
  for (let i = 0; i < 4; i++) {
    const inner = m.ephemeralMessage?.message || m.viewOnceMessage?.message || m.viewOnceMessageV2?.message || m.documentWithCaptionMessage?.message || m.editedMessage?.message;
    if (!inner) break;
    m = inner;
  }
  return m;
}
function textOf(msg) {
  const m = unwrap(msg);
  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  if (m.imageMessage) return `📷 [imagen]${m.imageMessage.caption ? '\n' + m.imageMessage.caption : ''}`;
  if (m.videoMessage) return `🎬 [video]${m.videoMessage.caption ? '\n' + m.videoMessage.caption : ''}`;
  if (m.audioMessage) return '🎤 [El cliente mandó un audio — pedile que lo escriba]';
  if (m.documentMessage) return '📄 [documento]';
  if (m.stickerMessage) return '[sticker]';
  if (m.buttonsResponseMessage?.selectedDisplayText) return m.buttonsResponseMessage.selectedDisplayText;
  if (m.listResponseMessage?.title) return m.listResponseMessage.title;
  return '';
}

async function start(id) {
  const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers,
    isJidGroup, isJidBroadcast, isJidNewsletter, isJidStatusBroadcast } = await lib();
  const prev = lines.get(id);
  if (prev?.sock) { try { prev.sock.end(undefined); } catch { /* */ } }
  setState(id, { status: 'connecting', qr: null, stopped: false });

  const { state, saveCreds } = await useMultiFileAuthState(dirOf(id));
  let version;
  try { ({ version } = await fetchLatestBaileysVersion()); } catch { /* usa la versión incluida */ }
  const sock = makeWASocket({
    auth: state, version, logger: pino({ level: 'silent' }),
    browser: Browsers.macOS('Chrome'), markOnlineOnConnect: false, syncFullHistory: false,
  });
  setState(id, { sock });
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async u => {
    if (u.qr) setState(id, { status: 'qr', qr: await QR.toDataURL(u.qr, { margin: 1, width: 280 }) });
    if (u.connection === 'open') {
      const phone = (sock.user?.id || '').split(':')[0].split('@')[0];
      setState(id, { status: 'connected', qr: null, phone });
    }
    if (u.connection === 'close') {
      const code = u.lastDisconnect?.error?.output?.statusCode;
      const e = lines.get(id);
      if (code === DisconnectReason.loggedOut) {
        fs.rmSync(dirOf(id), { recursive: true, force: true });
        setState(id, { status: 'logged_out', qr: null, sock: null });
      } else if (code === DisconnectReason.forbidden) {
        setState(id, { status: 'banned', qr: null, sock: null });
      } else if (!e?.stopped) {
        setState(id, { status: 'reconnecting' });
        setTimeout(() => { if (!lines.get(id)?.stopped) start(id).catch(() => {}); }, 4000);
      }
    }
  });

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) {
      const jid = m.key?.remoteJid;
      if (!jid || isJidGroup(jid) || isJidBroadcast(jid) || isJidStatusBroadcast(jid) || isJidNewsletter(jid)) continue;
      const pnJid = jid.endsWith('@lid') ? (m.key.remoteJidAlt || null) : jid;
      const phone = pnJid ? pnJid.split('@')[0].split(':')[0] : null;
      const text = textOf(m.message);
      if (!text) continue;
      if (m.key.fromMe) {
        if (sentIds.has(m.key.id)) continue;            // lo mandó el CRM
        hooks.onFromPhone && hooks.onFromPhone(id, { jid, phone, text, id: m.key.id });
      } else {
        hooks.onInbound && hooks.onInbound(id, { jid, phone, name: m.pushName || '', text, key: m.key });
      }
    }
  });

  // tildes: 3 = entregado, 4/5 = leído
  sock.ev.on('messages.update', ups => {
    for (const u of ups) {
      const st = u.update?.status;
      if (!st || !u.key?.fromMe) continue;
      hooks.onReceipt && hooks.onReceipt(u.key.id, st >= 4 ? 'read' : st >= 3 ? 'delivered' : 'sent');
    }
  });
}

function get(id) {
  const e = lines.get(id);
  if (!e?.sock || e.status !== 'connected') throw new Error('La línea no está conectada');
  return e.sock;
}

async function send(id, jid, text) {
  const sock = get(id);
  const r = await sock.sendMessage(jid, { text });
  if (r?.key?.id) { sentIds.add(r.key.id); if (sentIds.size > 5000) sentIds.delete(sentIds.values().next().value); }
  return r?.key?.id;
}

// ¿El número tiene WhatsApp? Devuelve el jid correcto o null
async function check(id, phoneDigits) {
  const sock = get(id);
  const res = await sock.onWhatsApp(phoneDigits);
  const hit = (res || []).find(x => x.exists);
  return hit ? hit.jid : null;
}

async function typing(id, jid, on) {
  try { const s = get(id); await s.sendPresenceUpdate(on ? 'composing' : 'paused', jid); } catch { /* */ }
}
async function read(id, key) {
  try { const s = get(id); await s.readMessages([key]); } catch { /* */ }
}

async function stop(id, logout = false) {
  const e = lines.get(id);
  if (!e) return;
  setState(id, { stopped: true });
  try { logout ? await e.sock?.logout() : e.sock?.end(undefined); } catch { /* */ }
  if (logout) fs.rmSync(dirOf(id), { recursive: true, force: true });
  setState(id, { status: logout ? 'logged_out' : 'stopped', sock: null, qr: null });
}
async function remove(id) { await stop(id, true); lines.delete(id); }

function status(id) {
  const e = lines.get(id);
  return e ? { status: e.status, qr: e.qr || null, phone: e.phone || null } : { status: 'stopped', qr: null, phone: null };
}
const hasSession = id => fs.existsSync(path.join(dirOf(id), 'creds.json'));

module.exports = { init, start, stop, remove, send, check, typing, read, status, hasSession, _hooks: () => hooks };
