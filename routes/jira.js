// ════════════════════════════════════════════════════════════════════════════════
// MÓDULO: Integración con Jira REST API v3
// ════════════════════════════════════════════════════════════════════════════════
// Propósito: Conectar la aplicación Bajaware con Jira para:
//   - Consultar proyectos, issues (tickets), tableros y sprints
//   - Crear issues y gestionar transiciones de estado
//   - Agregar comentarios a issues y acceder a worklogs
//   - Hacer crosscheck entre tickets de Jira y registros en tabla ESTATUS_REPORTE
//     (mediante campo custom "VersionBC" = CLAVE_REP)
//   - Listar usuarios, campos y obtener historial completo de cambios
// Este módulo es parte del plan de integración Jira para actualización automática
// de tickets desde Bajaware.

const express = require('express');
const router  = express.Router();
const https   = require('https');
const http    = require('http');
const { query } = require('../db/connection');

// ── Configuración ─────────────────────────────────────────
// Credenciales y host de Jira tomadas de variables de entorno.
// AUTH_TOKEN se codifica en base64 para autenticación HTTP Basic.
const JIRA_HOST  = process.env.JIRA_HOST  || '';
const JIRA_EMAIL = process.env.JIRA_EMAIL || '';
const JIRA_TOKEN = process.env.JIRA_TOKEN || '';
const AUTH_TOKEN = Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');

// ── Helper: Realiza llamadas a Jira REST API ─────────────
// Params:
//   method (GET|POST|PUT|DELETE): verbo HTTP
//   path: ruta relativa a JIRA_HOST (ej. /rest/api/3/issue/KEY)
//   body: objeto a serializar como JSON (para POST/PUT)
// Retorna: Promise que resuelve con respuesta parseada o rechaza con Error
function jiraRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url     = new URL(JIRA_HOST + path);
    const isHttps = url.protocol === 'https:';
    const lib     = isHttps ? https : http;

    const payload = body ? JSON.stringify(body) : null;

    // Configurar opciones de la solicitud HTTP/HTTPS con autenticación Basic
    const options = {
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method,
      headers: {
        'Authorization': `Basic ${AUTH_TOKEN}`,
        'Accept':        'application/json',
        'Content-Type':  'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
      }
    };

    // Ejecutar solicitud y procesar respuesta
    const req = lib.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = data ? JSON.parse(data) : {};
          // HTTP 400+ indica error en Jira
          if (res.statusCode >= 400) {
            reject(new Error(parsed.errorMessages?.[0] || parsed.message || `HTTP ${res.statusCode}`));
          } else {
            resolve(parsed);
          }
        } catch (e) {
          // Si no se puede parsear JSON, retornar vacío
          resolve({});
        }
      });
    });

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── Middleware: Requiere sesión activa ────────────────────
// Verifica que el usuario está autenticado; rechaza con 401 si no
function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ ok: false, message: 'No autenticado' });
  next();
}

// ── GET /api/jira/proyectos ───────────────────────────────
// Lista todos los proyectos disponibles en Jira
// Retorna: { ok: true, data: [{ id, key, name, tipo }, ...] }
router.get('/proyectos', requireAuth, async (req, res) => {
  try {
    const data = await jiraRequest('GET', '/rest/api/3/project?expand=lead');
    const proyectos = data.map(p => ({
      id:   p.id,
      key:  p.key,
      name: p.name,
      tipo: p.projectTypeKey
    }));
    res.json({ ok: true, data: proyectos });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ── GET /api/jira/tickets?project=KEY&status=&assignee=&texto=&max=100&jql=
// Busca issues (tickets) en Jira con filtros opcionales
// Params:
//   ?project=KEY: filtrar por clave de proyecto (ej. QA_DEPLOYMENT)
//   ?status=: estado del ticket (ej. Done, In Progress)
//   ?assignee=: nombre o 'currentUser' para asignado
//   ?texto=: texto a buscar en descripción/resumen
//   ?max=: máximo de resultados (default 100)
//   ?jql=: JQL directo (si se pasa, ignora otros filtros)
// Retorna: { ok: true, total: N, data: [{ id, key, resumen, estado, ... }, ...] }
router.get('/tickets', requireAuth, async (req, res) => {
  const { project, status, assignee, texto, max = 100, jql: jqlRaw } = req.query;

  // Construir JQL: si viene directo se usa tal cual; si no, armar desde filtros
  let jql;
  if (jqlRaw) {
    // JQL directo (ej: "sprint in openSprints()")
    jql = jqlRaw;
  } else {
    jql = project ? `project = "${project}"` : 'sprint in openSprints()';
    if (status)   jql += ` AND status = "${status}"`;
    if (assignee === 'currentUser') {
      jql += ' AND assignee = currentUser()';
    } else if (assignee) {
      jql += ` AND assignee = "${assignee}"`;
    }
    if (texto) jql += ` AND text ~ "${texto}"`;
    jql += ' ORDER BY updated DESC';
  }

  const fields = 'summary,status,assignee,priority,issuetype,created,updated,description,comment';

  try {
    const data = await jiraRequest(
      'GET',
      `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=${max}&fields=${fields}`
    );

    // Mapear campos de Jira a estructura simplificada
    const tickets = (data.issues || []).map(i => ({
      id:        i.id,
      key:       i.key,
      resumen:   i.fields.summary,
      estado:    i.fields.status?.name,
      asignado:  i.fields.assignee?.displayName || 'Sin asignar',
      prioridad: i.fields.priority?.name,
      tipo:      i.fields.issuetype?.name,
      creado:    i.fields.created,
      actualizado: i.fields.updated
    }));

    res.json({ ok: true, total: data.total, data: tickets });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ── GET /api/jira/tickets/:key ────────────────────────────
// Obtiene detalles básicos de un ticket (issue) por su clave
// Params: :key = clave de Jira (ej. QAD-123)
// Retorna: { ok: true, data: { id, key, resumen, estado, asignado, prioridad, tipo, comentarios } }
router.get('/tickets/:key', requireAuth, async (req, res) => {
  try {
    const i = await jiraRequest(
      'GET',
      `/rest/api/3/issue/${req.params.key}?fields=summary,status,assignee,priority,issuetype,description,comment,transitions`
    );

    // Extraer comentarios y parsear su contenido (formato ADF)
    const comentarios = (i.fields.comment?.comments || []).map(c => ({
      id:       c.id,
      autor:    c.author?.displayName,
      cuerpo:   c.body?.content?.[0]?.content?.[0]?.text || '',
      creado:   c.created
    }));

    res.json({
      ok: true,
      data: {
        id:        i.id,
        key:       i.key,
        resumen:   i.fields.summary,
        estado:    i.fields.status?.name,
        asignado:  i.fields.assignee?.displayName || 'Sin asignar',
        prioridad: i.fields.priority?.name,
        tipo:      i.fields.issuetype?.name,
        comentarios
      }
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ── GET /api/jira/tickets/:key/transiciones ───────────────
// Lista los estados/transiciones disponibles para un ticket
// (estados a los que puede moverse desde su estado actual)
// Params: :key = clave de Jira (ej. QAD-123)
// Retorna: { ok: true, data: [{ id, nombre }, ...] }
router.get('/tickets/:key/transiciones', requireAuth, async (req, res) => {
  try {
    // Intentar primero el endpoint de transiciones directo
    const data = await jiraRequest('GET', `/rest/api/3/issue/${req.params.key}/transitions`);
    let trans = (data.transitions || []).map(t => ({ id: t.id, nombre: t.name }));

    // Si viene vacío, intentar expandir del issue completo
    if (trans.length === 0) {
      try {
        const issue = await jiraRequest('GET', `/rest/api/3/issue/${req.params.key}?expand=transitions`);
        const expanded = (issue.transitions || []).map(t => ({ id: t.id, nombre: t.name }));
        if (expanded.length > 0) trans = expanded;
      } catch (_) { /* ignorar error del fallback */ }
    }

    res.json({ ok: true, data: trans });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ── POST /api/jira/tickets ────────────────────────────────
// Crea un nuevo issue (ticket) en Jira
// Body requerido:
//   project: clave de proyecto (ej. QAD)
//   resumen: título del issue
//   tipo: tipo de issue (default: Task)
//   descripcion: cuerpo del issue (default: vacío)
//   prioridad: prioridad (default: Medium)
// Retorna: { ok: true, key: "QAD-999", id: "12345" }
router.post('/tickets', requireAuth, async (req, res) => {
  const { project, tipo = 'Task', resumen, descripcion = '', prioridad = 'Medium' } = req.body;

  if (!project || !resumen) {
    return res.status(400).json({ ok: false, message: 'project y resumen son requeridos' });
  }

  // Armar estructura de campos Jira (descripción en formato ADF)
  const body = {
    fields: {
      project:   { key: project },
      issuetype: { name: tipo },
      summary:   resumen,
      priority:  { name: prioridad },
      description: {
        type:    'doc',
        version: 1,
        content: [{
          type:    'paragraph',
          content: [{ type: 'text', text: descripcion || resumen }]
        }]
      }
    }
  };

  try {
    const data = await jiraRequest('POST', '/rest/api/3/issue', body);
    res.json({ ok: true, key: data.key, id: data.id });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ── POST /api/jira/tickets/:key/estado ───────────────────
// Cambia el estado/transición de un ticket
// Params: :key = clave de Jira (ej. QAD-123)
// Body requerido: { transitionId: "11" } (obtener IDs de endpoint transiciones)
// Retorna: { ok: true }
router.post('/tickets/:key/estado', requireAuth, async (req, res) => {
  const { transitionId } = req.body;
  if (!transitionId) return res.status(400).json({ ok: false, message: 'transitionId requerido' });

  try {
    await jiraRequest('POST', `/rest/api/3/issue/${req.params.key}/transitions`, {
      transition: { id: transitionId }
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ── POST /api/jira/tickets/:key/comentario ────────────────
// Agrega un comentario a un ticket
// Params: :key = clave de Jira (ej. QAD-123)
// Body requerido: { texto: "contenido del comentario" }
// Retorna: { ok: true, id: "12345" } (id del comentario creado)
router.post('/tickets/:key/comentario', requireAuth, async (req, res) => {
  const { texto } = req.body;
  if (!texto) return res.status(400).json({ ok: false, message: 'texto requerido' });

  // Formatear comentario en formato ADF (Atlassian Document Format)
  const body = {
    body: {
      type:    'doc',
      version: 1,
      content: [{
        type:    'paragraph',
        content: [{ type: 'text', text: texto }]
      }]
    }
  };

  try {
    const data = await jiraRequest('POST', `/rest/api/3/issue/${req.params.key}/comment`, body);
    res.json({ ok: true, id: data.id });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ── GET /api/jira/epics ───────────────────────────────────
// Lista todos los epics disponibles, agrupados por proyecto
// Retorna: { ok: true, data: [{ nombre, key, epics: [...] }, ...], total: N }
router.get('/epics', requireAuth, async (req, res) => {
  try {
    const data = await jiraRequest(
      'GET',
      `/rest/api/3/search/jql?jql=${encodeURIComponent('issuetype = Epic ORDER BY project ASC, status ASC')}&maxResults=200&fields=summary,status,project,priority,issuetype`
    );

    // Mapear epics extrayendo campos clave
    const epics = (data.issues || []).map(i => ({
      key:        i.key,
      resumen:    i.fields.summary,
      estado:     i.fields.status?.name,
      categoria:  i.fields.status?.statusCategory?.name,
      proyecto:   i.fields.project?.name,
      proyectoKey: i.fields.project?.key
    }));

    // Agrupar por proyecto para retorno jerárquico
    const porProyecto = {};
    epics.forEach(e => {
      if (!porProyecto[e.proyectoKey]) {
        porProyecto[e.proyectoKey] = { nombre: e.proyecto, key: e.proyectoKey, epics: [] };
      }
      porProyecto[e.proyectoKey].epics.push(e);
    });

    res.json({ ok: true, data: Object.values(porProyecto), total: epics.length });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ── GET /api/jira/sprints/:sprintId/epics ─────────────────
// Lista epics involucrados en un sprint específico (vía Agile API)
// Params: :sprintId = ID del sprint
// Retorna: { ok: true, data: [{ key, resumen, estado, tickets: N }, ...] }
router.get('/sprints/:sprintId/epics', requireAuth, async (req, res) => {
  try {
    const data = await jiraRequest(
      'GET',
      `/rest/agile/1.0/sprint/${req.params.sprintId}/issue?maxResults=200&fields=summary,status,parent,issuetype`
    );

    // Extraer epics únicos de los issues del sprint y contar tickets por epic
    const epicKeys = new Set();
    const epicsMap = {};

    (data.issues || []).forEach(i => {
      const parent = i.fields.parent;
      if (parent && parent.fields?.issuetype?.name === 'Epic') {
        if (!epicKeys.has(parent.key)) {
          epicKeys.add(parent.key);
          epicsMap[parent.key] = {
            key:     parent.key,
            resumen: parent.fields.summary,
            estado:  parent.fields.status?.name,
            tickets: 0
          };
        }
        epicsMap[parent.key].tickets++;
      }
    });

    res.json({ ok: true, data: Object.values(epicsMap) });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ── GET /api/jira/stats ───────────────────────────────────
// Obtiene estadísticas globales de issues: contador por categoría de estado
// (new = pendientes, indeterminate = en progreso, done = hechos)
// Retorna: { ok: true, data: { pendientes: N, enProgreso: N, hechos: N, total: N } }
// Nota: limita a 4 páginas (máx 2000 issues) para no tardar demasiado
router.get('/stats', requireAuth, async (req, res) => {
  try {
    const counts = { new: 0, indeterminate: 0, done: 0 };
    const pageSize = 500;
    let nextPageToken = null;
    let pages = 0;

    // Paginación de resultados (Jira retorna máx 500 por página)
    do {
      const url = nextPageToken
        ? `/rest/api/3/search/jql?jql=${encodeURIComponent('issuetype != Epic ORDER BY updated DESC')}&maxResults=${pageSize}&fields=status&nextPageToken=${encodeURIComponent(nextPageToken)}`
        : `/rest/api/3/search/jql?jql=${encodeURIComponent('issuetype != Epic ORDER BY updated DESC')}&maxResults=${pageSize}&fields=status`;

      const data = await jiraRequest('GET', url);
      const issues = data.issues || [];

      // Contar issues por categoría de estado
      issues.forEach(i => {
        const key = i.fields?.status?.statusCategory?.key;
        if (key in counts) counts[key]++;
      });

      nextPageToken = data.nextPageToken || null;
      pages++;

      // Máximo 4 páginas (2000 issues) para no tardar demasiado
      if (pages >= 4) break;
    } while (nextPageToken);

    const total = counts.new + counts.indeterminate + counts.done;

    res.json({
      ok: true,
      data: {
        pendientes: counts.new,
        enProgreso: counts.indeterminate,
        hechos:     counts.done,
        total
      }
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ── GET /api/jira/sprints/activos ─────────────────────────
// Lista sprints que están activos en todos los tableros (Agile API)
// Retorna: { ok: true, data: [{ id, name, boardName, state, ... }, ...] }
router.get('/sprints/activos', requireAuth, async (req, res) => {
  try {
    // Obtener todos los tableros
    const boards = await jiraRequest('GET', '/rest/agile/1.0/board?maxResults=50');
    const boardList = boards.values || [];

    // Para cada tablero, obtener sus sprints activos
    const sprintPromises = boardList.map(b =>
      jiraRequest('GET', `/rest/agile/1.0/board/${b.id}/sprint?state=active`)
        .then(r => (r.values || []).map(s => ({ ...s, boardName: b.name })))
        .catch(() => [])
    );

    const results  = await Promise.all(sprintPromises);
    const sprints  = results.flat();
    res.json({ ok: true, data: sprints });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ── GET /api/jira/sprints/:sprintId/tickets ───────────────
// Lista tickets de un sprint, agrupados por epic padre
// Params: :sprintId = ID del sprint
// Retorna: { ok: true, data: [{ key, resumen, estado, tickets: [...] }, ...] }
//          (incluye grupo "Sin epic" si hay tickets sin padre)
router.get('/sprints/:sprintId/tickets', requireAuth, async (req, res) => {
  try {
    const data = await jiraRequest(
      'GET',
      `/rest/agile/1.0/sprint/${req.params.sprintId}/issue?maxResults=200&fields=summary,status,assignee,priority,issuetype,parent`
    );

    const issues = data.issues || [];
    const epicMap = {};
    const sinEpic = [];

    // Procesar cada issue del sprint
    issues.forEach(i => {
      const tipo   = i.fields.issuetype?.name;
      if (tipo === 'Epic') return; // skip epics themselves

      const parent = i.fields.parent;
      const isEpic = parent?.fields?.issuetype?.name === 'Epic';

      const ticket = {
        key:      i.key,
        resumen:  i.fields.summary,
        estado:   i.fields.status?.name,
        categoria: i.fields.status?.statusCategory?.name,
        asignado: i.fields.assignee?.displayName || 'Sin asignar',
        prioridad: i.fields.priority?.name,
        tipo
      };

      // Agrupar por epic o en "sin epic"
      if (isEpic) {
        const eKey = parent.key;
        if (!epicMap[eKey]) {
          epicMap[eKey] = {
            key:     eKey,
            resumen: parent.fields.summary,
            estado:  parent.fields.status?.name,
            tickets: []
          };
        }
        epicMap[eKey].tickets.push(ticket);
      } else {
        sinEpic.push(ticket);
      }
    });

    const epics = Object.values(epicMap);
    if (sinEpic.length) epics.push({ key: null, resumen: 'Sin epic', estado: null, tickets: sinEpic });

    res.json({ ok: true, data: epics });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ── GET /api/jira/boards ──────────────────────────────────
// Lista todos los tableros (Kanban o Scrum) con su proyecto asociado
// Retorna: { ok: true, data: [{ id, nombre, tipo, proyecto, proyectoKey }, ...] }
router.get('/boards', requireAuth, async (req, res) => {
  try {
    const data = await jiraRequest('GET', '/rest/agile/1.0/board?maxResults=50');
    const boards = (data.values || []).map(b => ({
      id:       b.id,
      nombre:   b.name,
      tipo:     b.type,                       // scrum | kanban
      proyecto: b.location?.projectName || '',
      proyectoKey: b.location?.projectKey || ''
    }));
    res.json({ ok: true, data: boards });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ── GET /api/jira/usuarios ────────────────────────────────
// Lista usuarios activos de Jira (solo cuentas Atlassian, excluye apps/bots)
// Retorna: { ok: true, data: [{ id, nombre, email, avatar }, ...] }
router.get('/usuarios', requireAuth, async (req, res) => {
  try {
    const data = await jiraRequest('GET', '/rest/api/3/users/search?maxResults=200');
    // Filtrar solo usuarios activos reales (account type = atlassian)
    const usuarios = (Array.isArray(data) ? data : [])
      .filter(u => u.accountType === 'atlassian' && u.active)
      .map(u => ({
        id:     u.accountId,
        nombre: u.displayName,
        email:  u.emailAddress || '',
        avatar: u.avatarUrls?.['24x24'] || ''
      }));
    res.json({ ok: true, data: usuarios });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ── GET /api/jira/tickets/:key/completo ───────────────────
// Obtiene información COMPLETA de un ticket: campos, comentarios, worklogs,
// historial de cambios y transiciones disponibles (para vistas detalladas)
// Params: :key = clave de Jira (ej. QAD-123)
// Retorna: { ok: true, data: { key, resumen, descripcion, estado, tipo, prioridad,
//            asignado, reportero, proyecto, etiquetas, componentes, versiones, padre,
//            creado, actualizado, vence, resuelto, tiempo, comentarios, worklogs, historial, transiciones } }
router.get('/tickets/:key/completo', requireAuth, async (req, res) => {
  try {
    const fields = 'summary,description,status,assignee,reporter,priority,issuetype,labels,components,fixVersions,created,updated,duedate,resolutiondate,parent,project,comment,worklog,timetracking';
    // Obtener issue completo + historial de cambios y transiciones en paralelo
    const [i, trans] = await Promise.all([
      jiraRequest('GET', `/rest/api/3/issue/${req.params.key}?fields=${fields}&expand=changelog`),
      jiraRequest('GET', `/rest/api/3/issue/${req.params.key}/transitions`).catch(() => ({ transitions: [] }))
    ]);

    // Helper: parsear formato ADF (Atlassian Document Format) a texto plano
    const extraerTexto = doc => {
      // El body de comentarios/descripción viene en formato ADF (árbol JSON)
      const walk = n => !n ? '' : (n.text || '') + (n.content || []).map(walk).join('');
      return walk(doc);
    };

    // Extraer comentarios con texto parseado
    const comentarios = (i.fields.comment?.comments || []).map(c => ({
      autor: c.author?.displayName, texto: extraerTexto(c.body), creado: c.created
    }));

    // Extraer worklogs (registros de tiempo trabajado)
    const worklogs = (i.fields.worklog?.worklogs || []).map(w => ({
      autor: w.author?.displayName, tiempo: w.timeSpent, comentario: extraerTexto(w.comment), fecha: w.started
    }));

    // Extraer historial de cambios (últimos 30 para no retornar demasiado)
    const historial = (i.changelog?.histories || []).slice(0, 30).map(h => ({
      autor: h.author?.displayName, fecha: h.created,
      cambios: (h.items || []).map(it => ({ campo: it.field, de: it.fromString, a: it.toString }))
    }));

    res.json({
      ok: true,
      data: {
        key:        i.key,
        resumen:    i.fields.summary,
        descripcion: extraerTexto(i.fields.description),
        estado:     i.fields.status?.name,
        tipo:       i.fields.issuetype?.name,
        prioridad:  i.fields.priority?.name,
        asignado:   i.fields.assignee?.displayName || 'Sin asignar',
        reportero:  i.fields.reporter?.displayName || '',
        proyecto:   i.fields.project?.name,
        etiquetas:  i.fields.labels || [],
        componentes:(i.fields.components || []).map(c => c.name),
        versiones:  (i.fields.fixVersions || []).map(v => v.name),
        padre:      i.fields.parent ? { key: i.fields.parent.key, resumen: i.fields.parent.fields?.summary } : null,
        creado:     i.fields.created,
        actualizado:i.fields.updated,
        vence:      i.fields.duedate,
        resuelto:   i.fields.resolutiondate,
        tiempo:     i.fields.timetracking || {},
        comentarios,
        worklogs,
        historial,
        transiciones: (trans.transitions || []).map(t => ({ id: t.id, nombre: t.name }))
      }
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ── Crosscheck Jira ↔ ESTATUS_REPORTE ─────────────────────
// Funcionalidad CLAVE para integración con Bajaware:
// Cruza tickets de Jira con registros en tabla ESTATUS_REPORTE usando el campo
// custom "VersionBC" como llave (VersionBC = CLAVE_REP en la BD)
// Esto permite ver qué tickets de Jira se corresponden con qué registros de estado

const escSql = v => `'${String(v).replace(/'/g, "''")}'`;

// Cache del id interno del campo VersionBC (customfield_XXXXX)
// Jira usa IDs como customfield_10123 para campos personalizados
let _versionBCField = null;
async function getVersionBCField() {
  if (_versionBCField) return _versionBCField;
  const fields = await jiraRequest('GET', '/rest/api/3/field');
  const f = (fields || []).find(x => (x.name || '').trim().toLowerCase() === 'versionbc');
  if (!f) throw new Error('No se encontró el campo "VersionBC" en Jira');
  _versionBCField = f.id; // ej. customfield_10123
  return _versionBCField;
}

// ── GET /api/jira/campos?buscar= ──────────────────────────
// Lista todos los campos de Jira, incluyendo custom fields
// Útil para descubrir IDs de custom fields (ej. "VersionBC" -> customfield_10123)
// Params: ?buscar=texto para filtrar por nombre o ID
// Retorna: { ok: true, total: N, data: [{ id, nombre, custom: bool }, ...] }
router.get('/campos', requireAuth, async (req, res) => {
  try {
    const buscar = (req.query.buscar || '').toLowerCase();
    const fields = await jiraRequest('GET', '/rest/api/3/field');
    let lista = (fields || []).map(f => ({ id: f.id, nombre: f.name, custom: !!f.custom }));
    if (buscar) lista = lista.filter(f => (f.nombre || '').toLowerCase().includes(buscar) || f.id.includes(buscar));
    lista.sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''));
    res.json({ ok: true, total: lista.length, data: lista });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ── GET /api/jira/tickets/:key/campos ─────────────────────
// Retorna TODOS los campos no vacíos de un ticket con nombres legibles
// Útil para debugging: descubrir qué custom fields contienen datos útiles
// (ej. si viene el nombre de plataforma en algún campo custom)
// Params: :key = clave de Jira (ej. QAD-123)
// Retorna: { ok: true, key, total: N, data: [{ id, nombre, valor }, ...] }
router.get('/tickets/:key/campos', requireAuth, async (req, res) => {
  try {
    // Obtener definiciones de campos + valores del issue
    const [fieldDefs, issue] = await Promise.all([
      jiraRequest('GET', '/rest/api/3/field'),
      jiraRequest('GET', `/rest/api/3/issue/${req.params.key}`)
    ]);
    const nombres = {};
    (fieldDefs || []).forEach(f => { nombres[f.id] = f.name; });

    // Helper: convertir valores complejos a strings legibles
    const resumir = v => {
      if (v === null || v === undefined || v === '') return null;
      if (Array.isArray(v)) {
        if (!v.length) return null;
        return v.map(x => (x && typeof x === 'object') ? (x.name || x.value || x.displayName || x.key || JSON.stringify(x)) : x).join(', ');
      }
      if (typeof v === 'object') {
        return v.name || v.value || v.displayName || v.key || v.emailAddress || JSON.stringify(v).slice(0, 300);
      }
      return String(v);
    };

    // Construir lista de campos no vacíos
    const campos = [];
    for (const [id, valor] of Object.entries(issue.fields || {})) {
      const r = resumir(valor);
      if (r !== null) campos.push({ id, nombre: nombres[id] || id, valor: r });
    }
    campos.sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''));
    res.json({ ok: true, key: issue.key, total: campos.length, data: campos });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ── GET /api/jira/crosscheck?dias=30&project=QA_DEPLOYMENT ─
// ENDPOINT CENTRAL DE INTEGRACIÓN: cruza tickets de Jira con ESTATUS_REPORTE
// Busca todos los tickets del proyecto con campo VersionBC lleno, luego en BD
// busca registros que coincidan por CLAVE_REP o CLAVE_REP_GENERAL.
// Params:
//   ?dias=: filtrar tickets actualizados en últimos N días (default 30)
//   ?project=: clave de proyecto en Jira (default QA_DEPLOYMENT)
// Retorna: { ok: true, campo: "customfield_XXXXX", jql: "...", total: N,
//            data: [{ key, resumen, estadoJira, asignado, actualizado, clave, enBD: [...] }, ...] }
// Donde enBD es array de registros ESTATUS_REPORTE que coinciden con la clave
router.get('/crosscheck', requireAuth, async (req, res) => {
  try {
    const dias    = parseInt(req.query.dias, 10) || 30;
    const project = req.query.project || 'QA_DEPLOYMENT';
    const cfId    = await getVersionBCField();           // customfield_XXXXX
    const cfNum   = cfId.replace('customfield_', '');

    // Buscar tickets del proyecto con VersionBC no vacío, actualizados recientemente
    const jql = `project = "${project}" AND cf[${cfNum}] is not EMPTY AND updated >= -${dias}d ORDER BY updated DESC`;
    const data = await jiraRequest(
      'GET',
      `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=100&fields=summary,status,assignee,updated,${cfId}`
    );

    // Mapear tickets extrayendo el valor de VersionBC
    const tickets = (data.issues || []).map(i => ({
      key:         i.key,
      resumen:     i.fields.summary,
      estadoJira:  i.fields.status?.name,
      asignado:    i.fields.assignee?.displayName || 'Sin asignar',
      actualizado: i.fields.updated,
      clave:       (typeof i.fields[cfId] === 'object' ? i.fields[cfId]?.value : i.fields[cfId]) || null
    })).filter(t => t.clave);

    // Una sola consulta a BD con todas las claves de tickets encontrados
    let dbRows = [];
    const claves = [...new Set(tickets.map(t => String(t.clave).trim()))];
    if (claves.length) {
      dbRows = await query(`
        SELECT CLAVE_REP, CLAVE_REP_GENERAL, CLAVE_PLATAFORMA, DOCUMENTADO, PROGRAMADO, CERTIFICADO,
               ESTATUS, FECHA_ESTATUS, USER_ESTATUS
        FROM ESTATUS_REPORTE
        WHERE CLAVE_REP IN (${claves.map(escSql).join(',')})
           OR CLAVE_REP_GENERAL IN (${claves.map(escSql).join(',')})
      `);
    }

    // Indexar registros BD por clave para búsqueda rápida
    const porClave = {};
    dbRows.forEach(r => {
      const fila = {
        plataforma:  r.CLAVE_PLATAFORMA,
        documentado: r.DOCUMENTADO,
        programado:  r.PROGRAMADO,
        certificado: r.CERTIFICADO,
        estatus:     r.ESTATUS,
        fecha:       r.FECHA_ESTATUS,
        usuario:     r.USER_ESTATUS,
        claveRep:    r.CLAVE_REP
      };
      // Indexar tanto por CLAVE_REP (legacy con _22) como por CLAVE_REP_GENERAL
      const llaves = new Set([(r.CLAVE_REP || '').trim(), (r.CLAVE_REP_GENERAL || '').trim()]);
      llaves.forEach(k => { if (k) (porClave[k] = porClave[k] || []).push(fila); });
    });

    // Enriquecer tickets con sus registros BD
    const resultado = tickets.map(t => ({
      ...t,
      enBD: porClave[String(t.clave).trim()] || []
    }));

    res.json({ ok: true, campo: cfId, jql, total: resultado.length, data: resultado });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ── GET /api/jira/test-transiciones/:key ──────────────────
// Endpoint de prueba: obtiene transiciones sin validar autenticación
// (útil para debugging en frontend)
// Params: :key = clave de Jira (ej. QAD-123)
// Retorna: { ok: true, transiciones: [...] }
router.get('/test-transiciones/:key', async (req, res) => {
  try {
    const data = await jiraRequest('GET', `/rest/api/3/issue/${req.params.key}/transitions`);
    res.json({ ok: true, transiciones: data.transitions || [] });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

module.exports = router;
