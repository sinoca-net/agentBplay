const Anthropic = require('@anthropic-ai/sdk');
const store = require('./db');
const { SAFETY_RULES } = require('./defaults');
const wa = require('./whatsapp');

const client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
const pending = new Map();   // contactId -> timeout (debounce: el cliente suele mandar varios mensajes seguidos)
const running = new Set();   // contactId en proceso

let io = null;
let sendOutbound = null;     // (contactId, sender, body) => msg
function init(deps) { io = deps.io; sendOutbound = deps.sendOutbound; }

const STAGE_LABELS = {
  nuevo: 'Nuevo', datos_carga: 'Datos de carga enviados', cargo: 'Cargó', link_enviado: 'Link enviado',
  registrado: 'Registrado', cpa_confirmado: 'CPA confirmado', activo: 'Activo', perdido: 'Perdido',
};
const BOT_STAGES = store.STAGES.filter(s => s !== 'cpa_confirmado');
// el bot sólo hace avanzar la etapa (o marca perdido), nunca la hace retroceder
function advance(contactId, stage) {
  const c = store.getContact(contactId);
  if (!c || !stage) return;
  if (stage === 'perdido' || (store.STAGE_RANK[stage] ?? -1) > (store.STAGE_RANK[c.stage] ?? -1)) store.updateContact(contactId, { stage });
}

function examplesBlock() {
  const rows = store.db.prepare(`SELECT * FROM examples WHERE active=1
    ORDER BY CASE kind WHEN 'correction' THEN 0 WHEN 'manual' THEN 1 ELSE 2 END, id DESC LIMIT 30`).all();
  if (!rows.length) return '';
  return `\n=== EJEMPLOS REALES DE CÓMO RESPONDE EL DUEÑO (imitá el tono, el largo y la forma de cerrar; no copies datos personales) ===\n` +
    rows.map(r => `Cliente: ${r.context}\n${r.bad_reply ? `NO respondas así: ${r.bad_reply}\n` : ''}Respuesta ideal: ${r.reply}`).join('\n---\n') + '\n';
}

function buildSystemPrompt(settings, contact) {
  const provs = Object.entries(settings.provinces).map(([k, p]) =>
    `- ${k} (${p.label}): bono → ${p.bonus || '(no cargado: decí que el bono se ve al registrarse)'}`).join('\n');
  const prov = contact.province && settings.provinces[contact.province];
  const account = prov ? (prov.deposit_account || '(no hay cuenta cargada para esta provincia: explicá la carga desde Depositar en BPLAY)') : '(primero averiguá la provincia)';
  return `Sos ${settings.agent_name}, ${settings.agent_title || 'agente oficial afiliado de BPLAY'}. Atendés el chat de clientes de BPLAY Argentina.

${SAFETY_RULES}
${settings.style_guide ? `\n=== TU FORMA DE ESCRIBIR (sacada de chats reales del dueño: respondé como él) ===\n${settings.style_guide}\n` : ''}${examplesBlock()}
=== GUION COMERCIAL ===
${settings.script}

=== PROVINCIAS Y BONOS ===
${provs}
(El link de registro NUNCA lo escribas vos: usá siempre la herramienta enviar_link_registro.)

=== CÓMO HACER LA PRIMERA CARGA ===
${settings.deposit_instructions}
Cuenta oficial BPLAY para transferencias en la provincia de este cliente: ${account}

=== DATOS DEL CONTACTO ===
Nombre: ${contact.name || '(sin nombre)'}
Provincia: ${contact.province ? `${contact.province} (${settings.provinces[contact.province]?.label || ''})` : '(desconocida)'}
Etapa actual: ${contact.stage} (${STAGE_LABELS[contact.stage] || ''})
Carga reportada: ${contact.deposit_amount ? `sí — $${contact.deposit_amount}, DNI ${contact.dni}, titular ${contact.titular}` : 'todavía no'}
Canal: ${contact.channel === 'whatsapp' ? 'WhatsApp' : 'chat web'}

Usá actualizar_contacto cada vez que sepas la provincia o la persona avance de etapa. Etapas: ${BOT_STAGES.join(', ')}.`;
}

function tools(settings) {
  const keys = Object.keys(settings.provinces);
  return [
    {
      name: 'enviar_datos_carga',
      description: 'Envía al cliente, como mensaje aparte y fácil de copiar, la cuenta oficial de BPLAY de su provincia para transferir la carga mínima de $1.000. Usala apenas sepas la provincia.',
      input_schema: { type: 'object', properties: { provincia: { type: 'string', enum: keys } }, required: ['provincia'] },
    },
    {
      name: 'registrar_carga',
      description: 'Guarda en el CRM que el cliente transfirió: su número de DNI, el nombre completo del titular de la cuenta desde la que transfirió y el monto. Usala cuando el cliente te pasó esos datos después de transferir.',
      input_schema: {
        type: 'object',
        properties: {
          dni: { type: 'string', description: 'Sólo números, 7 u 8 dígitos' },
          titular: { type: 'string', description: 'Nombre y apellido del titular de la cuenta' },
          monto: { type: 'string', description: 'Monto transferido en pesos, sólo números' },
        },
        required: ['dni', 'titular'],
      },
    },
    {
      name: 'enviar_link_registro',
      description: 'Envía al cliente, como mensaje aparte, el link de registro con tracking de afiliado de su provincia. Usala cuando ya sabés la provincia y la persona está lista para registrarse (o lo pide).',
      input_schema: { type: 'object', properties: { provincia: { type: 'string', enum: keys } }, required: ['provincia'] },
    },
    {
      name: 'actualizar_contacto',
      description: 'Guarda en el CRM la provincia, la etapa del embudo o el nombre del contacto.',
      input_schema: {
        type: 'object',
        properties: {
          provincia: { type: 'string', enum: keys },
          etapa: { type: 'string', enum: BOT_STAGES },
          nombre: { type: 'string' },
        },
      },
    },
    {
      name: 'derivar_a_humano',
      description: 'Pausa el bot y avisa a un asesor humano para que tome la conversación.',
      input_schema: { type: 'object', properties: { motivo: { type: 'string' } }, required: ['motivo'] },
    },
  ];
}

function historyFor(contactId) {
  const rows = store.db.prepare(
    "SELECT sender, body FROM messages WHERE contact_id=? AND sender!='system' ORDER BY id DESC LIMIT 40").all(contactId).reverse();
  // Agrupar en turnos user/assistant alternados
  const msgs = [];
  for (const r of rows) {
    const role = r.sender === 'client' ? 'user' : 'assistant';
    const text = r.sender === 'agent' ? `[asesor humano] ${r.body}` : r.body;
    if (msgs.length && msgs[msgs.length - 1].role === role) msgs[msgs.length - 1].content += '\n\n' + text;
    else msgs.push({ role, content: text });
  }
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  return msgs;
}

function setTyping(contactId, on) {
  if (io) io.to(`c:${contactId}`).emit('typing', on);
  if (io) io.to('admins').emit('typing', { contactId, on });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Mandar texto partido en burbujas, con "escribiendo…" proporcional al largo
async function sendBubbles(contactId, text) {
  const parts = text.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean).slice(0, 4);
  for (const p of parts) {
    setTyping(contactId, true);
    await sleep(Math.min(600 + p.length * 18, 3500));
    setTyping(contactId, false);
    sendOutbound(contactId, 'bot', p);
  }
}

async function runTool(contact, name, input, settings) {
  if (name === 'enviar_datos_carga') {
    const p = settings.provinces[input.provincia];
    if (!p) return 'Provincia inválida';
    store.updateContact(contact.id, { province: input.provincia });
    if (!p.deposit_account) {
      store.updateContact(contact.id, { needs_human: 1 });
      sendOutbound(contact.id, 'system', `⚠️ Falta cargar la cuenta oficial de ${p.label} en Bot → Provincias.`);
      return 'No hay cuenta cargada para esta provincia. No inventes datos: mandale el link de registro y decile que en un ratito un asesor le pasa la cuenta.';
    }
    advance(contact.id, 'datos_carga');
    store.logEvent(contact.id, 'deposit_info_sent', { province: input.provincia });
    setTyping(contact.id, true); await sleep(900); setTyping(contact.id, false);
    sendOutbound(contact.id, 'bot', `🏦 Cuenta oficial BPLAY ${p.label}\n${p.deposit_account}\n\nMínimo $1.000 · desde una cuenta a tu nombre`);
    return `Datos de carga de ${p.label} enviados. Recordale que transfiera desde una cuenta a su nombre y que cuando lo haga te pase DNI, titular y monto.`;
  }
  if (name === 'registrar_carga') {
    const dni = String(input.dni || '').replace(/\D/g, '');
    if (dni.length < 7 || dni.length > 8) return 'El DNI no parece válido (tienen 7 u 8 números). Pedíselo de nuevo.';
    const monto = String(input.monto || '').replace(/[^\d]/g, '');
    const titular = String(input.titular || '').slice(0, 80);
    store.updateContact(contact.id, { dni, titular, deposit_amount: monto || null, deposit_at: new Date().toISOString().slice(0, 19).replace('T', ' ') });
    advance(contact.id, 'cargo');
    store.logEvent(contact.id, 'deposit_reported', { dni, titular, monto });
    sendOutbound(contact.id, 'system', `💰 Carga reportada: $${monto || '?'} · DNI ${dni} · titular ${titular}. Verificala con tu afiliador.`);
    if (io) io.to(`c:${contact.id}`).emit('track', 'CargaReportada');
    const c = store.getContact(contact.id);
    return (c.name && titular && !titular.toLowerCase().includes(String(c.name).toLowerCase().split(' ')[0])
      ? 'Ojo: el titular no coincide con el nombre del contacto. Confirmá amablemente que la cuenta es a su nombre. ' : '') +
      'Carga registrada. Ahora mandale el link de registro y recordale usar el mismo nombre y DNI.';
  }
  if (name === 'enviar_link_registro') {
    const p = settings.provinces[input.provincia];
    if (!p) return 'Provincia inválida';
    store.updateContact(contact.id, { province: input.provincia });
    advance(contact.id, 'link_enviado');
    store.logEvent(contact.id, 'link_sent', { province: input.provincia });
    if (io) io.to(`c:${contact.id}`).emit('track', 'LinkRegistro');
    setTyping(contact.id, true); await sleep(900); setTyping(contact.id, false);
    sendOutbound(contact.id, 'bot', `👉 ${p.link}`);
    return `Link de ${p.label} enviado al cliente. Bono: ${p.bonus || 'no cargado'}.`;
  }
  if (name === 'actualizar_contacto') {
    const f = {};
    if (input.provincia && settings.provinces[input.provincia]) f.province = input.provincia;
    if (input.nombre) f.name = input.nombre.slice(0, 60);
    store.updateContact(contact.id, f);
    if (input.etapa && BOT_STAGES.includes(input.etapa)) advance(contact.id, input.etapa);
    return 'Contacto actualizado.';
  }
  if (name === 'derivar_a_humano') {
    store.updateContact(contact.id, { bot_enabled: 0, needs_human: 1 });
    store.logEvent(contact.id, 'handoff', { motivo: input.motivo });
    sendOutbound(contact.id, 'system', `Bot pausado → asesor humano. Motivo: ${input.motivo}`);
    return 'Derivado. Avisale al cliente que en un ratito lo atiende un asesor.';
  }
  return 'Herramienta desconocida';
}

async function respond(contactId) {
  if (running.has(contactId)) { schedule(contactId, 1500); return; }
  running.add(contactId);
  try {
    const settings = store.getSettings();
    let contact = store.getContact(contactId);
    if (!contact || !contact.bot_enabled) return;
    if (!contact.prompt_version) {
      contact = store.updateContact(contactId, { prompt_version: store.currentPromptVersion().id });
    }
    // marcar como leídos los mensajes del cliente (tildes azules + "escribiendo…" en WhatsApp)
    markRead(contactId, true);

    if (!client) return fallbackReply(contact, settings);

    const messages = historyFor(contactId);
    if (!messages.length) return;
    const tl = tools(settings);
    for (let i = 0; i < 5; i++) {
      setTyping(contactId, true);
      const res = await client.messages.create({
        model: settings.model || 'claude-sonnet-5-5',
        max_tokens: 700,
        system: buildSystemPrompt(settings, store.getContact(contactId)),
        tools: tl,
        messages,
      });
      setTyping(contactId, false);
      // si un humano tomó la conversación mientras pensaba, no mandamos nada
      if (!store.getContact(contactId).bot_enabled && !res.content.some(b => b.type === 'tool_use' && b.name === 'derivar_a_humano')) return;

      const toolResults = [];
      for (const block of res.content) {
        if (block.type === 'text' && block.text.trim()) await sendBubbles(contactId, block.text);
        if (block.type === 'tool_use') {
          const out = await runTool(store.getContact(contactId), block.name, block.input || {}, settings);
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: out });
        }
      }
      if (res.stop_reason !== 'tool_use') break;
      messages.push({ role: 'assistant', content: res.content });
      messages.push({ role: 'user', content: toolResults });
    }
  } catch (err) {
    console.error('[agent]', err.message);
    store.updateContact(contactId, { needs_human: 1 });
    sendOutbound(contactId, 'system', `Error del bot: ${err.message.slice(0, 200)}`);
  } finally {
    setTyping(contactId, false);
    running.delete(contactId);
    if (io) io.to('admins').emit('contact', store.getContact(contactId));
  }
}

// Respuesta sin IA (si todavía no cargaste ANTHROPIC_API_KEY): flujo básico por reglas
async function fallbackReply(contact, settings) {
  const last = store.db.prepare("SELECT body FROM messages WHERE contact_id=? AND sender='client' ORDER BY id DESC LIMIT 1").get(contact.id);
  const text = (last?.body || '').toLowerCase();
  const match = Object.entries(settings.provinces).find(([k, p]) =>
    text.includes(k.toLowerCase()) || text.includes(p.label.toLowerCase()) ||
    (k === 'PBA' && /provincia|bs ?as|buenos aires/.test(text)) || (k === 'CBA' && /c[oó]rdoba/.test(text)) ||
    (k === 'SF' && /santa ?fe|rosario/.test(text)) || (k === 'CABA' && /capital/.test(text)));
  const prov = contact.province || (match && match[0]);
  if (!prov) {
    await sendBubbles(contact.id, `¡Hola ${contact.name || ''}! ¿De qué provincia sos? Así te paso el link con tu bono 🙌`);
    return;
  }
  if (contact.stage === 'nuevo') {
    await sendBubbles(contact.id, '¡Genial! Cargando $1.000 te llevás $10.000 de bono 🎁 Transferí desde una cuenta a tu nombre y después pasame tu DNI 👇');
    await runTool(contact, 'enviar_datos_carga', { provincia: prov }, settings);
    await runTool(store.getContact(contact.id), 'enviar_link_registro', { provincia: prov }, settings);
    await sendBubbles(contact.id, 'Registrate con el mismo nombre y DNI de la cuenta desde la que transferís 🙌');
    return;
  }
  store.updateContact(contact.id, { needs_human: 1 });
  await sendBubbles(contact.id, 'Dale, en un ratito te responde un asesor 🙌');
}

function markRead(contactId, typing = true) {
  const last = store.db.prepare("SELECT wa_id FROM messages WHERE contact_id=? AND sender='client' AND wa_id IS NOT NULL ORDER BY id DESC LIMIT 1").get(contactId);
  const r = store.db.prepare("UPDATE messages SET status='read' WHERE contact_id=? AND sender='client' AND status!='read'").run(contactId);
  if (r.changes && io) io.to(`c:${contactId}`).emit('read');
  if (last && r.changes) wa.markReadTyping(last.wa_id, typing);
}

function schedule(contactId, delay) {
  clearTimeout(pending.get(contactId));
  pending.set(contactId, setTimeout(() => { pending.delete(contactId); respond(contactId); }, delay));
}

function onClientMessage(contactId) {
  const c = store.getContact(contactId);
  if (!c || !c.bot_enabled) return;
  schedule(contactId, store.getSettings().bot_reply_delay_ms || 2500);
}

// ---------- Laboratorio: analizar conversaciones ganadas vs perdidas ----------
async function analyze() {
  if (!client) throw new Error('Falta ANTHROPIC_API_KEY');
  const settings = store.getSettings();
  const pick = (where) => store.db.prepare(`SELECT id, name, stage FROM contacts WHERE ${where} ORDER BY last_message_at DESC LIMIT 12`).all();
  const won = pick("dni IS NOT NULL AND stage IN ('registrado','cpa_confirmado','activo')");
  const lost = pick("(dni IS NULL OR stage NOT IN ('registrado','cpa_confirmado','activo')) AND last_message_at < datetime('now','-1 day') AND (SELECT COUNT(*) FROM messages m WHERE m.contact_id=contacts.id AND m.sender='client')>0");
  if (won.length + lost.length < 3) throw new Error('Todavía hay muy pocas conversaciones para analizar (mínimo 3).');
  const transcript = (c) => {
    const msgs = store.db.prepare("SELECT sender, body FROM messages WHERE contact_id=? ORDER BY id LIMIT 60").all(c.id);
    return `--- Contacto #${c.id} (etapa final: ${c.stage})\n` + msgs.map(m => `${m.sender === 'client' ? 'CLIENTE' : m.sender.toUpperCase()}: ${m.body}`).join('\n');
  };
  const res = await client.messages.create({
    model: settings.model || 'claude-sonnet-5-5',
    max_tokens: 3000,
    system: 'Sos un especialista en conversión de chats de venta para una plataforma de casino online legal en Argentina. Respetás juego responsable: nunca sugerís presionar, prometer ganancias ni apuntar a personas vulnerables. Respondés en español rioplatense, directo y práctico.',
    messages: [{
      role: 'user',
      content: `Este es el guion actual del bot:\n\n${settings.script}\n\n=== CONVERSACIONES QUE CONVIRTIERON (${won.length}) ===\n${won.map(transcript).join('\n\n')}\n\n=== CONVERSACIONES QUE NO CONVIRTIERON (${lost.length}) ===\n${lost.map(transcript).join('\n\n')}\n\nAnalizá:\n1. En qué momento exacto se caen las que no convierten (patrones concretos, citá ejemplos).\n2. Qué hizo distinto el bot en las que sí convirtieron.\n3. Objeciones que aparecen y no están bien resueltas.\n4. Cambios concretos al guion (máximo 6), cada uno con el texto exacto a agregar o reemplazar.\nAl final, devolvé el GUION COMPLETO MEJORADO entre las etiquetas <guion> y </guion>.`,
    }],
  });
  const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  const m = text.match(/<guion>([\s\S]*?)<\/guion>/);
  return { analysis: text.replace(/<guion>[\s\S]*?<\/guion>/, '').trim(), proposed_script: m ? m[1].trim() : null, won: won.length, lost: lost.length };
}

// Los modelos a veces devuelven saltos de línea crudos dentro de strings JSON: los escapamos
function escapeControlInStrings(str) {
  let out = '', inStr = false, esc = false;
  for (const ch of str) {
    if (inStr) {
      if (esc) { esc = false; out += ch; continue; }
      if (ch === '\\') { esc = true; out += ch; continue; }
      if (ch === '"') { inStr = false; out += ch; continue; }
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') { continue; }
      if (ch === '\t') { out += '\\t'; continue; }
      out += ch;
    } else { if (ch === '"') inStr = true; out += ch; }
  }
  return out;
}

// ---------- Entrenar: aprender de chats reales exportados de WhatsApp ----------
async function learnFromChats(text, ownerName) {
  if (!client) throw new Error('Falta ANTHROPIC_API_KEY');
  const settings = store.getSettings();
  const clean = String(text)
    .split(/\r?\n/)
    .filter(l => !/(<Multimedia omitido>|<Media omitted>|cifrados de extremo a extremo|end-to-end encrypted|imagen omitida|audio omitido|sticker omitido)/i.test(l))
    .join('\n')
    .slice(-150000);
  if (clean.length < 300) throw new Error('El chat es muy corto. Subí conversaciones más largas.');
  const res = await client.messages.create({
    model: settings.model || 'claude-sonnet-5-5',
    max_tokens: 8000,
    system: 'Analizás conversaciones de venta reales para que un asistente de chat aprenda a escribir exactamente como el vendedor. Respondés en español rioplatense. Nunca incluís datos personales (teléfonos, CBU, DNI, apellidos, montos de cuentas personales) en lo que devolvés: reemplazalos por [dato].',
    messages: [{
      role: 'user',
      content: `Estos son chats exportados de WhatsApp. El vendedor (dueño) aparece como "${ownerName}". Los demás son clientes que llegan para registrarse en BPLAY (casino online legal) y hacer su primera carga.

<chats>
${clean}
</chats>

Devolvé SOLO un JSON dentro de <json></json> con esta forma:
{
  "style_guide": "Guía de estilo de 10-20 viñetas concretas: largo de mensajes, saludo, cómo trata al cliente, muletillas y palabras que usa, emojis, cómo pregunta, cómo maneja cada objeción frecuente, cómo empuja a la primera carga, qué NO hace nunca. Basado sólo en lo que se ve en los chats.",
  "examples": [ { "context": "mensaje del cliente (resumido si es largo)", "reply": "respuesta real del vendedor, textual o casi textual" } ]
}
Elegí entre 10 y 25 ejemplos que mejor muestren cómo convierte: objeciones, dudas del registro, verificación de identidad, empuje a la primera carga, reactivación de clientes que se enfriaron. Si "${ownerName}" no aparece en el chat, devolvé {"error":"no encontré a ${ownerName} en el chat"}.`,
    }],
  });
  const out = res.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const m = out.match(/<json>([\s\S]*?)<\/json>/) || out.match(/(\{[\s\S]*\})/);
  if (!m) throw new Error('No pude interpretar el análisis. Probá de nuevo.');
  let data;
  try { data = JSON.parse(m[1]); } catch {
    try { data = JSON.parse(escapeControlInStrings(m[1])); } catch { throw new Error('No pude interpretar el análisis. Probá de nuevo.'); }
  }
  if (data.error) throw new Error(data.error);
  const ins = store.db.prepare("INSERT INTO examples(kind, context, reply) VALUES('chat',?,?)");
  let added = 0;
  for (const e of data.examples || []) {
    if (e.context && e.reply) { ins.run(String(e.context).slice(0, 600), String(e.reply).slice(0, 1200)); added++; }
  }
  return { style_guide: data.style_guide || '', added };
}

module.exports = { learnFromChats, init, onClientMessage, markRead, analyze, hasAI: () => !!client, STAGE_LABELS };
