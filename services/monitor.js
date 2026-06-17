const { query } = require('../db/connection');
const https = require('https');
const http  = require('http');

const JIRA_HOST  = process.env.JIRA_HOST  || '';
const JIRA_EMAIL = process.env.JIRA_EMAIL || '';
const JIRA_TOKEN = process.env.JIRA_TOKEN || '';
const AUTH_TOKEN = Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');
const INTERVALO  = 5 * 60 * 1000; // 5 minutos

// Estado previo en memoria: { ID_PAQUETE: ESTATUS }
let estadoPrevio = {};
let iniciado     = false;

// ── Llamada a Jira ────────────────────────────────────────
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
        'Authorization': `Basic ${AUTH_TOKEN}`,
        'Accept':        'application/json',
        'Content-Type':  'application/json',
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

// ── Comentario en Jira ────────────────────────────────────
async function comentarJira(ticketKey, texto) {
  try {
    await jiraPost(`/rest/api/3/issue/${ticketKey}/comment`, {
      body: {
        type: 'doc', version: 1,
        content: [{ type: 'paragraph', content: [{ type: 'text', text: texto }] }]
      }
    });
    console.log(`[Monitor] Comentario enviado a ${ticketKey}`);
  } catch (e) {
    console.error(`[Monitor] Error comentando ${ticketKey}:`, e.message);
  }
}

// ── Ciclo de revisión ─────────────────────────────────────
async function revisar() {
  try {
    const paquetes = await query(`
      SELECT ID_PAQUETE, ID_TICKET, CLAVE_CLIENTE, ESTATUS, DESCRIPCION
      FROM PAQUETES
      ORDER BY ID_TICKET
    `);

    // Agrupar por ticket para detectar completados
    const porTicket = {};
    for (const p of paquetes) {
      if (!porTicket[p.ID_TICKET]) porTicket[p.ID_TICKET] = { total: 0, cerrados: 0, desc: p.DESCRIPCION };
      porTicket[p.ID_TICKET].total++;
      if (p.ESTATUS === 'CERRADO') porTicket[p.ID_TICKET].cerrados++;
    }

    // Primera corrida: solo guardar estado, no comentar
    if (!iniciado) {
      for (const p of paquetes) estadoPrevio[p.ID_PAQUETE] = p.ESTATUS;
      iniciado = true;
      console.log(`[Monitor] Iniciado. ${paquetes.length} paquetes en seguimiento.`);
      return;
    }

    // Detectar cambios
    const cambiosPorTicket = {}; // ticket → [mensajes]

    for (const p of paquetes) {
      const anterior = estadoPrevio[p.ID_PAQUETE];

      if (anterior === undefined) {
        // Paquete nuevo
        if (!cambiosPorTicket[p.ID_TICKET]) cambiosPorTicket[p.ID_TICKET] = [];
        cambiosPorTicket[p.ID_TICKET].push(`🆕 Nuevo paquete para cliente ${p.CLAVE_CLIENTE} (${p.ESTATUS})`);
      } else if (anterior !== p.ESTATUS) {
        // Cambio de estatus
        if (!cambiosPorTicket[p.ID_TICKET]) cambiosPorTicket[p.ID_TICKET] = [];
        cambiosPorTicket[p.ID_TICKET].push(`📦 Cliente ${p.CLAVE_CLIENTE}: ${anterior} → ${p.ESTATUS}`);
      }

      estadoPrevio[p.ID_PAQUETE] = p.ESTATUS;
    }

    // Enviar comentarios agrupados por ticket
    for (const [ticket, mensajes] of Object.entries(cambiosPorTicket)) {
      const info    = porTicket[ticket];
      const resumen = `${info.cerrados}/${info.total} clientes cerrados`;
      const todo    = info.cerrados === info.total ? '\n✅ Todos los clientes cerrados — listo para cerrar el ticket.' : '';

      const texto = `[Bajaware Monitor]\n${mensajes.join('\n')}\nProgreso: ${resumen}${todo}`;
      await comentarJira(ticket, texto);
    }

  } catch (e) {
    console.error('[Monitor] Error en revisión:', e.message);
  }
}

// ── Arranque ──────────────────────────────────────────────
function iniciar() {
  console.log(`[Monitor] Arrancando — revisión cada ${INTERVALO / 60000} min`);
  revisar(); // primera revisión inmediata (solo carga estado)
  setInterval(revisar, INTERVALO);
}

module.exports = { iniciar };
