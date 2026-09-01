// ════════════════════════════════════════════════════════════════════════════════
// services/monitor.js — Monitor de paquetes (PAQUETES) y alertas QA (Jira)
//
// FUNCIONES PRINCIPALES:
//  • revisarPaquetes() — Detecta cambios de estado en paquetes de clientes,
//    registra alertas en Jira tickets vía comentarios automáticos.
//  • revisarQA() — Monitorea tickets de proyectos QA (CDL, QD) en Jira,
//    crea registros de alerta en tabla QA_ALERTAS y marca como PROCESADO
//    cuando alcanzan estado final.
//
// CICLO: cada 5 minutos ejecuta ambas revisiones en paralelo.
// ════════════════════════════════════════════════════════════════════════════════

const { query } = require('../db/connection');
const https = require('https');
const http  = require('http');

// Configuración de credenciales para autenticación Basic a API Jira
const JIRA_HOST  = process.env.JIRA_HOST  || '';
const JIRA_EMAIL = process.env.JIRA_EMAIL || '';
const JIRA_TOKEN = process.env.JIRA_TOKEN || '';
const AUTH_TOKEN = Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');
// Intervalo entre ciclos de revisión (5 minutos)
const INTERVALO  = 5 * 60 * 1000; // 5 minutos

// Proyectos QA y el estado que dispara la alerta en cada uno
const STATUS_POR_PROYECTO = {
  CDL: 'Instalado en QA',
  QD:  'Solicitud de Revisión',
};

// Memoria de cambios: almacena el estado anterior de cada paquete para detectar transiciones
let estadoPrevio = {};   // { ID_PAQUETE: ESTATUS }
// Bandera que indica si ya se han cargado los paquetes iniciales
let iniciado     = false;

// ── Helper GET a Jira ─────────────────────────────────────
// Realiza una solicitud GET a la API Jira con autenticación Basic.
// Retorna { status, data } donde data es parseado como JSON si es posible,
// si no retorna el body crudo como string.
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
// Realiza una solicitud POST a la API Jira con autenticación Basic.
// Serializa body como JSON y retorna { status, data } (data es body crudo).
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
// Agrega un comentario de texto a un ticket Jira usando el formato Jira
// (tipo 'doc' para compatibility con Atlassian). Captura y loguea errores.
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
// Busca en summary + description nombres que coincidan con layouts en BD.
// Itera sobre LAYOUTS conocidas y devuelve la primera coincidencia (case-insensitive).
// Si no hay coincidencia o falla la consulta, retorna null.
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

// Estados finales que cierran el ciclo
// Flujo QD: Solicitud de Revisión → EN CORRECCIÓN → EN PRUEBAS → APROBADO POR QA
//           → POR INSTALAR CON CLIENTE → ENVIADO AL CLIENTE → INSTALADO CON CLIENTE
//           → INSTALADO EN SOPORTE → INSTALADO TEMPORAL
//
// Cuando un ticket alcanza uno de estos estados, la alerta en BD se marca como
// PROCESADO con timestamp FECHA_PROCESADO = GETDATE().
const ESTADOS_PROCESADO = new Set([
  'APROBADO POR QA',
  'POR INSTALAR CON CLIENTE',
  'ENVIADO AL CLIENTE',
  'INSTALADO CON CLIENTE',
  'INSTALADO EN SOPORTE',
  'INSTALADO TEMPORAL',
]);

// ── Revisar tickets QD/CDL ────────────────────────────────
// Monitorea tickets de proyectos QA (CDL, QD) en Jira.
// - Busca tickets actualizados en últimos 10 minutos
// - Para cada ticket: crea alerta si es nuevo y está en estado trigger,
//   o actualiza estado/asignado si ya existe y cambió
// - Marca alerta como PROCESADO si alcanza estado final
async function revisarQA() {
  if (!JIRA_HOST || !JIRA_TOKEN) return;

  // JQL: todos los tickets de los proyectos monitoreados actualizados recientemente
  const proyectos = Object.keys(STATUS_POR_PROYECTO).join(', ');
  const jql = `project in (${proyectos}) AND updated >= "-10m" ORDER BY updated DESC`;

  try {
    // Solicitar lista de tickets actualizados recientemente de proyectos QA
    const { status, data } = await jiraGet(
      `/rest/api/3/search?jql=${encodeURIComponent(jql)}&fields=summary,status,assignee,updated,description&maxResults=50`
    );

    if (status !== 200 || !data.issues) return;

    // Procesar cada ticket encontrado
    for (const issue of data.issues) {
      const ticketKey  = issue.key;
      const projectKey = ticketKey.split('-')[0];
      const summary    = issue.fields?.summary || '';
      const assignee   = issue.fields?.assignee?.displayName || null;
      const jiraStatus = issue.fields?.status?.name || '';
      const updated    = issue.fields?.updated || null;
      // Convertir timestamp Jira (ISO 8601) a formato SQL: "YYYY-MM-DD HH:MM:SS"
      const updatedStr = updated ? `'${updated.slice(0,19).replace('T',' ')}'` : 'NULL';
      const desc       = issue.fields?.description?.content?.[0]?.content?.[0]?.text || '';

      // Buscar si ya existe registro de alerta para este ticket
      const [existeRec] = await query(`SELECT ID_ALERTA, ESTADO, JIRA_STATUS FROM QA_ALERTAS WHERE JIRA_TICKET=${esc(ticketKey)}`);

      if (existeRec) {
        // RAMA 1: Ticket ya existe en BD — revisar si su estado cambió
        if (existeRec.JIRA_STATUS !== jiraStatus) {
          // Detectar si el nuevo estado es terminal (ESTADOS_PROCESADO)
          const esProcessado = ESTADOS_PROCESADO.has(jiraStatus) && existeRec.ESTADO === 'PENDIENTE';
          if (esProcessado) {
            // Ticket alcanzó estado final: marcar alerta como PROCESADO
            await query(`UPDATE QA_ALERTAS SET JIRA_STATUS=${esc(jiraStatus)}, JIRA_UPDATED=${updatedStr}, JIRA_ASSIGNEE=${esc(assignee)}, ESTADO='PROCESADO', FECHA_PROCESADO=GETDATE() WHERE ID_ALERTA=${existeRec.ID_ALERTA}`);
            console.log(`[Monitor QA] ✅ ${ticketKey} → ${jiraStatus} → PROCESADO`);
          } else {
            // Solo transición intermedia: actualizar status y asignado sin cambiar ESTADO
            await query(`UPDATE QA_ALERTAS SET JIRA_STATUS=${esc(jiraStatus)}, JIRA_UPDATED=${updatedStr}, JIRA_ASSIGNEE=${esc(assignee)} WHERE ID_ALERTA=${existeRec.ID_ALERTA}`);
            console.log(`[Monitor QA] 🔄 ${ticketKey} → ${jiraStatus}`);
          }
        }
        continue;
      }

      // RAMA 2: Ticket nuevo — solo crear alerta si es el estado trigger del proyecto
      // (si no, ignorar el ticket porque no es relevante aún)
      if (jiraStatus !== STATUS_POR_PROYECTO[projectKey]) continue;

      // Detectar CLAVE_LAYOUT a partir del ticket summary/description
      const layoutDetectado = await detectarLayout(summary, desc);
      // Insertar nuevo registro de alerta en estado PENDIENTE
      await query(`
        INSERT INTO QA_ALERTAS (JIRA_TICKET, JIRA_PROJECT, JIRA_SUMMARY, JIRA_STATUS, JIRA_UPDATED, JIRA_ASSIGNEE, CLAVE_LAYOUT_DETECTADO)
        VALUES (${esc(ticketKey)}, ${esc(projectKey)}, ${esc(summary)}, ${esc(jiraStatus)}, ${updatedStr}, ${esc(assignee)}, ${esc(layoutDetectado)})
      `);
      console.log(`[Monitor QA] 🚨 ${ticketKey} — "${summary}" → Layout: ${layoutDetectado || 'no detectado'}`);
    }
  } catch (e) {
    console.error('[Monitor QA] Error revisando Jira:', e.message);
  }
}

// Helper para escapar valores SQL: retorna string SQL-safe o NULL literal
const esc = v => v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g,"''")}'`;

// ── Revisar cambios en PAQUETES (lógica original) ─────────
// Detecta cambios de estado en paquetes y comenta automáticamente en Jira.
// FLUJO:
//  1. Primera ejecución: carga estado inicial de todos los paquetes, se inicializa bandera
//  2. Siguientes ejecuciones: compara con estado anterior, detecta cambios y nuevos paquetes
//  3. Agrupa cambios por ticket y comenta en Jira con resumen de progreso
async function revisarPaquetes() {
  try {
    // Obtener lista completa de paquetes con estado agrupado por ticket
    const paquetes = await query(`
      SELECT ID_PAQUETE, ID_TICKET, CLAVE_CLIENTE, ESTATUS, DESCRIPCION
      FROM PAQUETES ORDER BY ID_TICKET
    `);

    // Calcular estadísticas por ticket: total de clientes y cuántos ya están cerrados
    const porTicket = {};
    for (const p of paquetes) {
      if (!porTicket[p.ID_TICKET]) porTicket[p.ID_TICKET] = { total: 0, cerrados: 0, desc: p.DESCRIPCION };
      porTicket[p.ID_TICKET].total++;
      if (p.ESTATUS === 'CERRADO') porTicket[p.ID_TICKET].cerrados++;
    }

    // PRIMERA EJECUCIÓN: almacenar estado inicial sin comentar
    if (!iniciado) {
      for (const p of paquetes) estadoPrevio[p.ID_PAQUETE] = p.ESTATUS;
      iniciado = true;
      console.log(`[Monitor] Iniciado. ${paquetes.length} paquetes en seguimiento.`);
      return;
    }

    // EJECUCIONES POSTERIORES: detectar cambios respecto a snapshot anterior
    const cambiosPorTicket = {};
    for (const p of paquetes) {
      const anterior = estadoPrevio[p.ID_PAQUETE];
      if (anterior === undefined) {
        // Paquete nuevo (no existía en snapshot anterior)
        if (!cambiosPorTicket[p.ID_TICKET]) cambiosPorTicket[p.ID_TICKET] = [];
        cambiosPorTicket[p.ID_TICKET].push(`🆕 Nuevo paquete cliente ${p.CLAVE_CLIENTE} (${p.ESTATUS})`);
      } else if (anterior !== p.ESTATUS) {
        // Cambio de estado
        if (!cambiosPorTicket[p.ID_TICKET]) cambiosPorTicket[p.ID_TICKET] = [];
        cambiosPorTicket[p.ID_TICKET].push(`📦 Cliente ${p.CLAVE_CLIENTE}: ${anterior} → ${p.ESTATUS}`);
      }
      // Actualizar snapshot para próxima iteración
      estadoPrevio[p.ID_PAQUETE] = p.ESTATUS;
    }

    // Comentar en Jira cada cambio agrupado por ticket
    for (const [ticket, mensajes] of Object.entries(cambiosPorTicket)) {
      const info    = porTicket[ticket];
      const resumen = `${info.cerrados}/${info.total} clientes cerrados`;
      // Agregar banner de completitud si todos los clientes están cerrados
      const todo    = info.cerrados === info.total ? '\n✅ Todos los clientes cerrados.' : '';
      await comentarJira(ticket, `[Bajaware Monitor]\n${mensajes.join('\n')}\nProgreso: ${resumen}${todo}`);
    }

  } catch (e) {
    console.error('[Monitor] Error en revisión paquetes:', e.message);
  }
}

// ── Ciclo combinado ───────────────────────────────────────
// Ejecuta ambas revisiones en secuencia (primero paquetes, luego QA)
async function revisar() {
  await revisarPaquetes();
  await revisarQA();
}

// Inicializa el monitor: ejecuta revisión inicial y programa ciclos periódicos
function iniciar() {
  console.log(`[Monitor] Arrancando — revisión cada ${INTERVALO / 60000} min`);
  revisar();
  setInterval(revisar, INTERVALO);
}

module.exports = { iniciar };
