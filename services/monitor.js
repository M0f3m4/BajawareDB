const { query } = require('../db/connection');
const https = require('https');
const http  = require('http');

const JIRA_HOST  = process.env.JIRA_HOST  || '';
const JIRA_EMAIL = process.env.JIRA_EMAIL || '';
const JIRA_TOKEN = process.env.JIRA_TOKEN || '';
const AUTH_TOKEN = Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');
const INTERVALO  = 5 * 60 * 1000; // 5 minutos

// Proyectos QA y el estado que dispara la alerta en cada uno
const STATUS_POR_PROYECTO = {
  CDL: 'Instalado en QA',
  QD:  'Aprobado por QA',
};

let estadoPrevio = {};   // { ID_PAQUETE: ESTATUS }
let iniciado     = false;

// ── Helper GET a Jira ─────────────────────────────────────
function jiraGet(path) {
  return new Promise((resolve, reject) => {
    const url = new URL(JIRA_HOST + path);
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: url.hostname,
      path:     url.pathname + (url.search || ''),
      method:   'GET',
      headers: {
        'Authorization': `Basic ${AUTH_TOKEN}`,
        'Accept':        'application/json',
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch (_) { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Helper POST a Jira ────────────────────────────────────
function jiraPost(path, body) {
  return new Promise((resolve, reject) => {
    const url     = new URL(JIRA_HOST + path);
    const payload = JSON.stringify(body);
    const lib     = url.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: url.hostname,
      path:     url.pathname,
      method:   'POST',
      headers: {
        'Authorization':  `Basic ${AUTH_TOKEN}`,
        'Accept':         'application/json',
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── Comentar en ticket Jira ───────────────────────────────
async function comentarJira(ticketKey, texto) {
  try {
    await jiraPost(`/rest/api/3/issue/${ticketKey}/comment`, {
      body: {
        type: 'doc', version: 1,
        content: [{ type: 'paragraph', content: [{ type: 'text', text: texto }] }]
      }
    });
    console.log(`[Monitor] Comentario → ${ticketKey}`);
  } catch (e) {
    console.error(`[Monitor] Error comentando ${ticketKey}:`, e.message);
  }
}

// ── Detectar CLAVE_LAYOUT desde texto del ticket ──────────
// Busca en summary + description nombres que coincidan con layouts en BD
async function detectarLayout(summary = '', description = '') {
  try {
    const layouts = await query(`SELECT DISTINCT CLAVE_LAYOUT FROM LAYOUTS`);
    const texto   = `${summary} ${description}`.toUpperCase();
    for (const { CLAVE_LAYOUT } of layouts) {
      if (texto.includes(CLAVE_LAYOUT.toUpperCase())) return CLAVE_LAYOUT;
    }
  } catch (_) {}
  return null;
}

// ── Revisar tickets QD/CDL en "Instalados en QA" ──────────
async function revisarQA() {
  if (!JIRA_HOST || !JIRA_TOKEN) return;

  // Construir JQL dinámico: cada proyecto con su propio estado trigger
  const condiciones = Object.entries(STATUS_POR_PROYECTO)
    .map(([proj, estado]) => `(project = ${proj} AND status = "${estado}")`)
    .join(' OR ');
  const jql    = `(${condiciones}) AND updated >= "-10m" ORDER BY updated DESC`;
  const encJql = encodeURIComponent(jql);

  try {
    const { status, data } = await jiraGet(
      `/rest/api/3/search?jql=${encJql}&fields=summary,status,assignee,updated,description&maxResults=20`
    );

    if (status !== 200 || !data.issues) return;

    for (const issue of data.issues) {
      const ticketKey  = issue.key;
      const projectKey = ticketKey.split('-')[0];
      const summary    = issue.fields?.summary || '';
      const assignee   = issue.fields?.assignee?.displayName || null;
      const jiraStatus = issue.fields?.status?.name || STATUS_POR_PROYECTO[projectKey] || '';
      const updated    = issue.fields?.updated || null;
      const desc       = issue.fields?.description?.content?.[0]?.content?.[0]?.text || '';

      // ¿Ya existe en QA_ALERTAS?
      const existe = await query(`SELECT 1 FROM QA_ALERTAS WHERE JIRA_TICKET=${esc(ticketKey)}`);
      if (existe.length) continue; // ya registrado, no duplicar

      // Intentar detectar el layout automáticamente
      const layoutDetectado = await detectarLayout(summary, desc);

      // Insertar alerta
      await query(`
        INSERT INTO QA_ALERTAS (
          JIRA_TICKET, JIRA_PROJECT, JIRA_SUMMARY, JIRA_STATUS,
          JIRA_UPDATED, JIRA_ASSIGNEE, CLAVE_LAYOUT_DETECTADO
        ) VALUES (
          ${esc(ticketKey)}, ${esc(projectKey)}, ${esc(summary)}, ${esc(jiraStatus)},
          ${updated ? `'${updated.slice(0,19).replace('T',' ')}'` : 'NULL'},
          ${esc(assignee)}, ${esc(layoutDetectado)}
        )
      `);

      console.log(`[Monitor QA] 🚨 ${ticketKey} — "${summary}" → Layout: ${layoutDetectado || 'no detectado'}`);
    }
  } catch (e) {
    console.error('[Monitor QA] Error revisando Jira:', e.message);
  }
}

const esc = v => v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g,"''")}'`;

// ── Revisar cambios en PAQUETES (lógica original) ─────────
async function revisarPaquetes() {
  try {
    const paquetes = await query(`
      SELECT ID_PAQUETE, ID_TICKET, CLAVE_CLIENTE, ESTATUS, DESCRIPCION
      FROM PAQUETES ORDER BY ID_TICKET
    `);

    const porTicket = {};
    for (const p of paquetes) {
      if (!porTicket[p.ID_TICKET]) porTicket[p.ID_TICKET] = { total: 0, cerrados: 0, desc: p.DESCRIPCION };
      porTicket[p.ID_TICKET].total++;
      if (p.ESTATUS === 'CERRADO') porTicket[p.ID_TICKET].cerrados++;
    }

    if (!iniciado) {
      for (const p of paquetes) estadoPrevio[p.ID_PAQUETE] = p.ESTATUS;
      iniciado = true;
      console.log(`[Monitor] Iniciado. ${paquetes.length} paquetes en seguimiento.`);
      return;
    }

    const cambiosPorTicket = {};
    for (const p of paquetes) {
      const anterior = estadoPrevio[p.ID_PAQUETE];
      if (anterior === undefined) {
        if (!cambiosPorTicket[p.ID_TICKET]) cambiosPorTicket[p.ID_TICKET] = [];
        cambiosPorTicket[p.ID_TICKET].push(`🆕 Nuevo paquete cliente ${p.CLAVE_CLIENTE} (${p.ESTATUS})`);
      } else if (anterior !== p.ESTATUS) {
        if (!cambiosPorTicket[p.ID_TICKET]) cambiosPorTicket[p.ID_TICKET] = [];
        cambiosPorTicket[p.ID_TICKET].push(`📦 Cliente ${p.CLAVE_CLIENTE}: ${anterior} → ${p.ESTATUS}`);
      }
      estadoPrevio[p.ID_PAQUETE] = p.ESTATUS;
    }

    for (const [ticket, mensajes] of Object.entries(cambiosPorTicket)) {
      const info    = porTicket[ticket];
      const resumen = `${info.cerrados}/${info.total} clientes cerrados`;
      const todo    = info.cerrados === info.total ? '\n✅ Todos los clientes cerrados.' : '';
      await comentarJira(ticket, `[Bajaware Monitor]\n${mensajes.join('\n')}\nProgreso: ${resumen}${todo}`);
    }

  } catch (e) {
    console.error('[Monitor] Error en revisión paquetes:', e.message);
  }
}

// ── Ciclo combinado ───────────────────────────────────────
async function revisar() {
  await revisarPaquetes();
  await revisarQA();
}

function iniciar() {
  console.log(`[Monitor] Arrancando — revisión cada ${INTERVALO / 60000} min`);
  revisar();
  setInterval(revisar, INTERVALO);
}

module.exports = { iniciar };
