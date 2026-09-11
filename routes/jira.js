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

// ── Helper: Realiza llamadas a Jira REST API v3 ─────────────
// Abstrae detalles de HTTPS, autenticación Basic, manejo de respuestas
// Params:
//   method = 'GET' | 'POST' | 'PUT' | 'DELETE' (verbo HTTP)
//   path = ruta relativa a JIRA_HOST (ej. /rest/api/3/issue/KEY, /rest/agile/1.0/board)
//   body = objeto JS a serializar como JSON (para POST/PUT), null para GET/DELETE
// Retorna: Promise<{...}> respuesta JSON parseada de Jira
//          Rechaza con Error si statusCode >= 400 (usa errorMessages o message de respuesta)
// Nota: usa AUTH_TOKEN (Basic auth desde JIRA_EMAIL + JIRA_TOKEN en .env)
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
// Tablas: ninguna (consulta directa Jira API)
// Permisos: autenticado (requireAuth)
// Nota: expand=lead para incluir información del lead del proyecto
router.get('/proyectos', requireAuth, async (req, res) => {
  try {
    // Llamada a Jira: GET /rest/api/3/project
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

// ── GET /api/jira/tickets ─────────────────────────────────
// Busca issues (tickets) en Jira con filtros opcionales (construye JQL)
// Query params:
//   project=KEY: filtrar por clave de proyecto (ej. QA_DEPLOYMENT)
//   status=: estado del ticket (ej. "Done", "In Progress")
//   assignee=: nombre usuario o 'currentUser'
//   texto=: búsqueda de texto en resumen/descripción
//   max=: máximo de resultados (default 100)
//   jql=: JQL directo (si se pasa, ignora otros filtros; permite queries complejas)
// Retorna: { ok: true, total: N, data: [{ id, key, resumen, estado, asignado, prioridad, tipo, creado, actualizado }, ...] }
// Tablas: ninguna (consulta directa Jira API /rest/api/3/search/jql)
// Permisos: autenticado (requireAuth)
// Nota: default si no hay project = "sprint in openSprints()" (búsqueda en sprints activos)
router.get('/tickets', requireAuth, async (req, res) => {
  const { project, status, assignee, texto, max = 100, jql: jqlRaw } = req.query;

  // Construir JQL: si viene directo se usa tal cual; si no, armar dinámicamente desde filtros
  let jql;
  if (jqlRaw) {
    // JQL directo (ej: "sprint in openSprints()") — se usa tal cual sin validación
    jql = jqlRaw;
  } else {
    // Armar JQL desde parámetros: project + status + assignee + texto
    jql = project ? `project = "${project}"` : 'sprint in openSprints()';
    if (status)   jql += ` AND status = "${status}"`;
    if (assignee === 'currentUser') {
      // Función especial de Jira para usuario actual
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
// Params: :key = clave de Jira (ej. "QAD-123")
// Retorna: { ok: true, data: { id, key, resumen, estado, asignado, prioridad, tipo, comentarios } }
// Tablas: ninguna (consulta directa Jira API)
// Permisos: autenticado (requireAuth)
// Nota: incluye comentarios parseados de formato ADF a texto plano
router.get('/tickets/:key', requireAuth, async (req, res) => {
  try {
    const i = await jiraRequest(
      'GET',
      `/rest/api/3/issue/${req.params.key}?fields=summary,status,assignee,priority,issuetype,description,comment,transitions`
    );

    // Extraer comentarios y parsear su contenido (formato ADF = Atlassian Document Format)
    // ADF es un formato JSON anidado; extraemos el primer nivel de texto
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
// Params: :key = clave de Jira (ej. "QAD-123")
// Retorna: { ok: true, data: [{ id, nombre }, ...] }
// Tablas: ninguna (consulta directa Jira API)
// Permisos: autenticado (requireAuth)
// Nota: intenta primero endpoint /transitions, fallback a expand si viene vacío
router.get('/tickets/:key/transiciones', requireAuth, async (req, res) => {
  try {
    // Intento 1: endpoint de transiciones directo (/rest/api/3/issue/:key/transitions)
    const data = await jiraRequest('GET', `/rest/api/3/issue/${req.params.key}/transitions`);
    let trans = (data.transitions || []).map(t => ({ id: t.id, nombre: t.name }));

    // Fallback: si viene vacío, intentar expandir del issue completo (expand=transitions)
    if (trans.length === 0) {
      try {
        const issue = await jiraRequest('GET', `/rest/api/3/issue/${req.params.key}?expand=transitions`);
        const expanded = (issue.transitions || []).map(t => ({ id: t.id, nombre: t.name }));
        if (expanded.length > 0) trans = expanded;
      } catch (_) { /* ignorar error del fallback — retornar array vacío */ }
    }

    res.json({ ok: true, data: trans });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ── POST /api/jira/tickets ────────────────────────────────
// Crea un nuevo issue (ticket) en Jira
// Body requerido:
//   project: clave de proyecto (ej. "QAD")
//   resumen: título del issue (descripción corta)
//   tipo: tipo de issue (default: "Task"; puede ser "Bug", "Story", etc.)
//   descripcion: cuerpo del issue (default: vacío)
//   prioridad: prioridad (default: "Medium"; ej. "Low", "High", "Critical")
// Retorna: { ok: true, key: "QAD-999", id: "12345" } = identificadores del nuevo issue
// Tablas: ninguna (creación directa en Jira API)
// Permisos: autenticado (requireAuth)
// Nota: descripción se formatea en ADF (Atlassian Document Format)
router.post('/tickets', requireAuth, async (req, res) => {
  const { project, tipo = 'Task', resumen, descripcion = '', prioridad = 'Medium' } = req.body;

  if (!project || !resumen) {
    return res.status(400).json({ ok: false, message: 'project y resumen son requeridos' });
  }

  // Armar estructura de campos Jira según formato esperado por Jira REST API v3
  // description usa formato ADF (Atlassian Document Format) con structure: doc → paragraph → text
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
// Cambia el estado/transición de un ticket (workflow action)
// Params: :key = clave de Jira (ej. "QAD-123")
// Body requerido: { transitionId: "11" } (obtener IDs del endpoint /transiciones previo)
// Retorna: { ok: true }
// Tablas: ninguna (actualización directa en Jira API)
// Permisos: autenticado (requireAuth)
// Nota: transitionId varía según tipos de proyecto; usar /transiciones para obtener valores válidos
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
// Params: :key = clave de Jira (ej. "QAD-123")
// Body requerido: { texto: "contenido del comentario" }
// Retorna: { ok: true, id: "12345" } = id del comentario creado
// Tablas: ninguna (creación directa en Jira API)
// Permisos: autenticado (requireAuth)
// Nota: texto se formatea en ADF (Atlassian Document Format)
router.post('/tickets/:key/comentario', requireAuth, async (req, res) => {
  const { texto } = req.body;
  if (!texto) return res.status(400).json({ ok: false, message: 'texto requerido' });

  // Formatear comentario en formato ADF (Atlassian Document Format)
  // Estructura: body → doc → paragraph → text
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
//          data[].epics[] = [{key, resumen, estado, categoria, proyecto, proyectoKey}, ...]
// Tablas: ninguna (consulta directa Jira API)
// Permisos: autenticado (requireAuth)
// Nota: búsqueda por issuetype=Epic; agrupa resultados por proyecto
router.get('/epics', requireAuth, async (req, res) => {
  try {
    const data = await jiraRequest(
      'GET',
      `/rest/api/3/search/jql?jql=${encodeURIComponent('issuetype = Epic ORDER BY project ASC, status ASC')}&maxResults=200&fields=summary,status,project,priority,issuetype`
    );

    // Mapear issues/epics extrayendo campos clave (key, resumen, estado, proyecto)
    const epics = (data.issues || []).map(i => ({
      key:        i.key,
      resumen:    i.fields.summary,
      estado:     i.fields.status?.name,
      categoria:  i.fields.status?.statusCategory?.name,
      proyecto:   i.fields.project?.name,
      proyectoKey: i.fields.project?.key
    }));

    // Post-procesamiento: agrupar por proyecto para retorno jerárquico
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
// Status categories: new=pendientes, indeterminate=en progreso, done=hechos
// Retorna: { ok: true, data: { pendientes: N, enProgreso: N, hechos: N, total: N } }
// Tablas: ninguna (consulta directa Jira API con paginación)
// Permisos: autenticado (requireAuth)
// Nota: paginación limitada a 4 páginas (máx ~2000 issues) para evitar timeouts;
//       excluye epics (issuetype != Epic) para contar solo tickets
router.get('/stats', requireAuth, async (req, res) => {
  try {
    const counts = { new: 0, indeterminate: 0, done: 0 };
    const pageSize = 500;
    let nextPageToken = null;
    let pages = 0;

    // Paginación de resultados: Jira retorna máx 500 por página (pageSize=500)
    do {
      // Construir URL con nextPageToken si existe (paginación)
      const url = nextPageToken
        ? `/rest/api/3/search/jql?jql=${encodeURIComponent('issuetype != Epic ORDER BY updated DESC')}&maxResults=${pageSize}&fields=status&nextPageToken=${encodeURIComponent(nextPageToken)}`
        : `/rest/api/3/search/jql?jql=${encodeURIComponent('issuetype != Epic ORDER BY updated DESC')}&maxResults=${pageSize}&fields=status`;

      const data = await jiraRequest('GET', url);
      const issues = data.issues || [];

      // Contar issues por categoría de estado (key = new, indeterminate, done)
      issues.forEach(i => {
        const key = i.fields?.status?.statusCategory?.key;
        if (key in counts) counts[key]++;
      });

      nextPageToken = data.nextPageToken || null;
      pages++;

      // Límite de seguridad: máximo 4 páginas (2000 issues) para evitar timeouts
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
// Lista sprints que están activos en todos los tableros (Jira Agile API)
// Retorna: { ok: true, data: [{ id, name, boardName, state, ... }, ...] }
// Tablas: ninguna (consulta directa Jira Agile API)
// Permisos: autenticado (requireAuth)
// Nota: usa /rest/agile/1.0/board para obtener tableros, luego /board/:id/sprint para activos
router.get('/sprints/activos', requireAuth, async (req, res) => {
  try {
    // Obtener lista de todos los tableros (Agile API)
    const boards = await jiraRequest('GET', '/rest/agile/1.0/board?maxResults=50');
    const boardList = boards.values || [];

    // Para cada tablero, obtener sus sprints activos en paralelo (Promise.all)
    const sprintPromises = boardList.map(b =>
      jiraRequest('GET', `/rest/agile/1.0/board/${b.id}/sprint?state=active`)
        .then(r => (r.values || []).map(s => ({ ...s, boardName: b.name })))
        .catch(() => [])  // Fallback: si falla, retornar array vacío
    );

    const results  = await Promise.all(sprintPromises);
    const sprints  = results.flat();
    res.json({ ok: true, data: sprints });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ── GET /api/jira/sprints/:sprintId/tickets ───────────────
// Lista tickets de un sprint, agrupados por epic padre (estructura jerárquica)
// Params: :sprintId = ID del sprint
// Retorna: { ok: true, data: [{ key, resumen, estado, tickets: [...] }, ...] }
//          Agrupa tickets por epic (key=epic.key, estado, resumen)
//          Incluye grupo "Sin epic" (key=null) si hay tickets sin padre
// Tablas: ninguna (consulta directa Jira Agile API)
// Permisos: autenticado (requireAuth)
// Nota: filtra epics mismos (issuetype=Epic) para retornar solo tickets
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
      if (tipo === 'Epic') return; // skip epics mismos (contar solo tickets)

      const parent = i.fields.parent;
      const isEpic = parent?.fields?.issuetype?.name === 'Epic';

      // Construir objeto ticket normalizado
      const ticket = {
        key:      i.key,
        resumen:  i.fields.summary,
        estado:   i.fields.status?.name,
        categoria: i.fields.status?.statusCategory?.name,
        asignado: i.fields.assignee?.displayName || 'Sin asignar',
        prioridad: i.fields.priority?.name,
        tipo
      };

      // Agrupar por epic padre o en lista "sin epic"
      if (isEpic) {
        const eKey = parent.key;
        // Crear entry de epic si no existe
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
// Tablas: ninguna (consulta directa Jira Agile API)
// Permisos: autenticado (requireAuth)
// Nota: tipo puede ser "scrum" o "kanban"
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
// Tablas: ninguna (consulta directa Jira API)
// Permisos: autenticado (requireAuth)
// Nota: filtra solo accountType='atlassian' y active=true (excluye service accounts)
router.get('/usuarios', requireAuth, async (req, res) => {
  try {
    const data = await jiraRequest('GET', '/rest/api/3/users/search?maxResults=200');
    // Filtrar solo usuarios activos reales (account type = 'atlassian', no service accounts)
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
// Obtiene información COMPLETA de un ticket (para vistas detalladas)
// Incluye: campos, comentarios, worklogs, historial de cambios, transiciones disponibles
// Params: :key = clave de Jira (ej. "QAD-123")
// Retorna: { ok: true, data: { key, resumen, descripcion, estado, tipo, prioridad,
//            asignado, reportero, proyecto, etiquetas, componentes, versiones, padre,
//            creado, actualizado, vence, resuelto, tiempo, comentarios, worklogs, historial, transiciones } }
// Tablas: ninguna (consulta directa Jira API + expand=changelog)
// Permisos: autenticado (requireAuth)
// Nota: historial limitado a últimos 30 cambios (slice(0,30)) para no retornar demasiado
router.get('/tickets/:key/completo', requireAuth, async (req, res) => {
  try {
    const fields = 'summary,description,status,assignee,reporter,priority,issuetype,labels,components,fixVersions,created,updated,duedate,resolutiondate,parent,project,comment,worklog,timetracking';
    // Obtener issue completo + historial de cambios y transiciones en paralelo
    const [i, trans] = await Promise.all([
      jiraRequest('GET', `/rest/api/3/issue/${req.params.key}?fields=${fields}&expand=changelog`),
      jiraRequest('GET', `/rest/api/3/issue/${req.params.key}/transitions`).catch(() => ({ transitions: [] }))
    ]);

    // Helper: parsear formato ADF (Atlassian Document Format) a texto plano
    // ADF es estructura anidada JSON; se hace walk recursivo por árbol content
    const extraerTexto = doc => {
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
// Funcionalidad CLAVE para integración entre Jira y Bajaware:
// Cruza tickets de Jira con registros en tabla ESTATUS_REPORTE usando el campo
// custom "VersionBC" como llave (VersionBC = CLAVE_REP en la BD)
// Esto permite ver qué tickets de Jira (con VersionBC lleno) se corresponden
// con qué registros de estado en la BD y su estatus actual (DOCUMENTADO, PROGRAMADO, CERTIFICADO)

// Helper: Escapa valor SQL (similar a esc() pero usando comilla simple)
const escSql = v => `'${String(v).replace(/'/g, "''")}'`;

// Cache del id interno del campo VersionBC (customfield_XXXXX)
// Jira usa IDs como customfield_10123 para campos personalizados; se cachea tras primer uso
let _versionBCField = null;
async function getVersionBCField() {
  if (_versionBCField) return _versionBCField;
  // Obtener lista de campos de Jira
  const fields = await jiraRequest('GET', '/rest/api/3/field');
  // Buscar campo "VersionBC" (case-insensitive)
  const f = (fields || []).find(x => (x.name || '').trim().toLowerCase() === 'versionbc');
  if (!f) throw new Error('No se encontró el campo "VersionBC" en Jira');
  // Cachear ID (ej. customfield_10123)
  _versionBCField = f.id;
  return _versionBCField;
}

// ── GET /api/jira/campos ──────────────────────────────────
// Lista todos los campos de Jira, incluyendo custom fields
// Útil para descubrir IDs de custom fields (ej. "VersionBC" -> customfield_10123)
// Query params: buscar=texto para filtrar por nombre o ID (case-insensitive)
// Retorna: { ok: true, total: N, data: [{ id, nombre, custom: bool }, ...] }
// Tablas: ninguna (consulta directa Jira API)
// Permisos: autenticado (requireAuth)
// Nota: custom=true para custom fields (ej. customfield_10123); false para campos estándar
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
// (ej. si viene nombre de plataforma, VersionBC, etc. en algún custom field)
// Params: :key = clave de Jira (ej. "QAD-123")
// Retorna: { ok: true, key, total: N, data: [{ id, nombre, valor }, ...] }
//          valor es string: resume arrays (join ', '), objetos (extrae name/value/displayName)
// Tablas: ninguna (consulta directa Jira API)
// Permisos: autenticado (requireAuth)
// Nota: útil para discovery de campos custom que pueden aportar información
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
    // Maneja: null, undefined, arrays (join con ', '), objetos (extrae name/value/displayName), strings
    const resumir = v => {
      if (v === null || v === undefined || v === '') return null;
      if (Array.isArray(v)) {
        if (!v.length) return null;
        // Para cada elemento del array: si es objeto, extrae nombre; si es string, lo usa
        return v.map(x => (x && typeof x === 'object') ? (x.name || x.value || x.displayName || x.key || JSON.stringify(x)) : x).join(', ');
      }
      if (typeof v === 'object') {
        // Para objeto: intenta extraer nombre legible, fallback a JSON (primeros 300 chars)
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

// ── GET /api/jira/crosscheck ──────────────────────────────
// ENDPOINT CENTRAL DE INTEGRACIÓN: cruza tickets Jira con ESTATUS_REPORTE
// Busca tickets del proyecto con VersionBC lleno, luego en BD busca registros
// que coincidan por CLAVE_REP o CLAVE_REP_GENERAL
// Query params:
//   dias=: filtrar tickets actualizados en últimos N días (default 30)
//   project=: clave de proyecto en Jira (default "QA_DEPLOYMENT")
// Retorna: { ok: true, campo: "customfield_XXXXX", jql: "...", total: N,
//            data: [{ key, resumen, estadoJira, asignado, actualizado, clave, enBD: [...] }, ...] }
// Tablas: ESTATUS_REPORTE (consulta SELECT con campos de estatus)
// Permisos: autenticado (requireAuth)
// Donde enBD es array de registros ESTATUS_REPORTE que coinciden:
//   {plataforma, documentado, programado, certificado, estatus, fecha, usuario, claveRep}
router.get('/crosscheck', requireAuth, async (req, res) => {
  try {
    const dias    = parseInt(req.query.dias, 10) || 30;
    const project = req.query.project || 'QA_DEPLOYMENT';
    const cfId    = await getVersionBCField();           // customfield_XXXXX
    const cfNum   = cfId.replace('customfield_', '');

    // Buscar tickets del proyecto con VersionBC (cfId) no vacío, actualizados en últimos N días
    // JQL: project=QA_DEPLOYMENT AND cf[<num>] is not EMPTY AND updated >= -30d
    const jql = `project = "${project}" AND cf[${cfNum}] is not EMPTY AND updated >= -${dias}d ORDER BY updated DESC`;
    const data = await jiraRequest(
      'GET',
      `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=100&fields=summary,status,assignee,updated,${cfId}`
    );

    // Mapear tickets extrayendo el valor de VersionBC (puede ser string o objeto con .value)
    const tickets = (data.issues || []).map(i => ({
      key:         i.key,
      resumen:     i.fields.summary,
      estadoJira:  i.fields.status?.name,
      asignado:    i.fields.assignee?.displayName || 'Sin asignar',
      actualizado: i.fields.updated,
      // VersionBC puede venir como string directo o como objeto {value: "..."}
      clave:       (typeof i.fields[cfId] === 'object' ? i.fields[cfId]?.value : i.fields[cfId]) || null
    })).filter(t => t.clave);  // Filtrar solo tickets con clave no vacía

    // Una sola consulta a BD con todas las claves de tickets encontrados
    // Busca por CLAVE_REP (legacy con _22) y CLAVE_REP_GENERAL (nuevo formato)
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

    // Post-procesamiento: indexar registros BD por clave para búsqueda rápida (O(1))
    const porClave = {};
    dbRows.forEach(r => {
      // Normalizar campos de estatus en estructura plana
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
      // Indexar por AMBAS claves (CLAVE_REP legacy + CLAVE_REP_GENERAL nuevo)
      // Permite encontrar registros sin importar cuál se use en la búsqueda
      const llaves = new Set([(r.CLAVE_REP || '').trim(), (r.CLAVE_REP_GENERAL || '').trim()]);
      llaves.forEach(k => { if (k) (porClave[k] = porClave[k] || []).push(fila); });
    });

    // Enriquecer tickets Jira con sus registros BD correspondientes
    const resultado = tickets.map(t => ({
      ...t,
      enBD: porClave[String(t.clave).trim()] || []  // Retorna array vacío si no hay matches
    }));

    res.json({ ok: true, campo: cfId, jql, total: resultado.length, data: resultado });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ── GET /api/jira/test-transiciones/:key ──────────────────
// Endpoint de prueba: obtiene transiciones sin validar autenticación
// (útil para debugging en frontend)
// Params: :key = clave de Jira (ej. "QAD-123")
// Retorna: { ok: true, transiciones: [...] }
// Nota: NO requiere autenticación (requireAuth) — useful para pruebas públicas
// Tablas: ninguna (consulta directa Jira API)
router.get('/test-transiciones/:key', async (req, res) => {
  try {
    const data = await jiraRequest('GET', `/rest/api/3/issue/${req.params.key}/transitions`);
    res.json({ ok: true, transiciones: data.transitions || [] });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

module.exports = router;
