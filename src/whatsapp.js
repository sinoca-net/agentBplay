// WhatsApp Cloud API (oficial de Meta). El cliente escribe a WhatsApp normal; todo entra al CRM.
const crypto = require('crypto');

const TOKEN = process.env.WA_TOKEN;
const PHONE_ID = process.env.WA_PHONE_NUMBER_ID;
const VERSION = process.env.WA_API_VERSION || 'v23.0';
const APP_SECRET = process.env.WA_APP_SECRET;
const VERIFY_TOKEN = process.env.WA_VERIFY_TOKEN || 'bplay-crm-verify';

const enabled = () => !!(TOKEN && PHONE_ID);

async function call(payload) {
  const res = await fetch(`${process.env.WA_GRAPH_URL || 'https://graph.facebook.com'}/${VERSION}/${PHONE_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
  return data;
}

// "+5492235939522" -> "5492235939522"
const toWa = phone => String(phone).replace(/\D/g, '');

async function sendText(phone, body) {
  const data = await call({ to: toWa(phone), type: 'text', text: { body, preview_url: true } });
  return data.messages?.[0]?.id;
}

async function sendTemplate(phone, name, lang, params = []) {
  const components = params.length
    ? [{ type: 'body', parameters: params.map(t => ({ type: 'text', text: String(t) })) }] : undefined;
  const data = await call({ to: toWa(phone), type: 'template', template: { name, language: { code: lang || 'es_AR' }, components } });
  return data.messages?.[0]?.id;
}

// Marca como leído (tildes azules) y muestra "escribiendo…" al cliente
async function markReadTyping(waMessageId, typing = true) {
  if (!enabled() || !waMessageId) return;
  try {
    await call({ status: 'read', message_id: waMessageId, ...(typing ? { typing_indicator: { type: 'text' } } : {}) });
  } catch (e) { /* no crítico */ }
}

function verifySignature(req) {
  if (!APP_SECRET) return true;
  const sig = req.get('x-hub-signature-256') || '';
  const expected = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(req.rawBody || '').digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)); } catch { return false; }
}

const TYPE_LABELS = {
  image: '📷 [El cliente envió una imagen — mirala en el WhatsApp del negocio si hace falta]',
  audio: '🎤 [El cliente envió un audio — pedile que lo escriba]',
  video: '🎬 [El cliente envió un video]',
  document: '📄 [El cliente envió un documento]',
  sticker: '[sticker]',
  location: '📍 [ubicación]',
};

// Normaliza el payload del webhook a eventos simples
function parseWebhook(body) {
  const out = { messages: [], statuses: [] };
  for (const entry of body.entry || []) {
    for (const ch of entry.changes || []) {
      const v = ch.value || {};
      const names = Object.fromEntries((v.contacts || []).map(c => [c.wa_id, c.profile?.name]));
      for (const m of v.messages || []) {
        let text = '';
        if (m.type === 'text') text = m.text?.body || '';
        else if (m.type === 'button') text = m.button?.text || '';
        else if (m.type === 'interactive') text = m.interactive?.button_reply?.title || m.interactive?.list_reply?.title || '';
        else if (m.type === 'image' && m.image?.caption) text = `${TYPE_LABELS.image}\n${m.image.caption}`;
        else text = TYPE_LABELS[m.type] || `[${m.type}]`;
        out.messages.push({ from: m.from, name: names[m.from] || '', id: m.id, text, referral: m.referral || null });
      }
      for (const s of v.statuses || []) {
        out.statuses.push({ id: s.id, status: s.status, error: s.errors?.[0]?.title || s.errors?.[0]?.message });
      }
    }
  }
  return out;
}

module.exports = { enabled, sendText, sendTemplate, markReadTyping, verifySignature, parseWebhook, VERIFY_TOKEN };
