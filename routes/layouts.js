const express  = require('express');
const router   = express.Router();
const multer   = require('multer');
const XLSX     = require('xlsx');
const path     = require('path');
const fs       = require('fs');
const { query } = require('../db/connection');

// ── Auth ──────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ ok: false, message: 'No autenticado' });
  next();
}

// ── Multer ────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    ['.xlsx', '.xls'].includes(ext) ? cb(null, true) : cb(new Error('Solo .xlsx/.xls'));
  }
});

// ── JSON local de versiones (respaldo) ───────────────────
const VERSIONES_JSON = path.join(__dirname, '../data/layout-versiones.json');
function leerVersionesJSON() {
  try { return JSON.parse(fs.readFileSync(VERSIONES_JSON, 'utf8')); } catch (_) { return []; }
}
function guardarVersionJSON(entrada) {
  const v = leerVersionesJSON(); v.unshift(entrada);
  fs.writeFileSync(VERSIONES_JSON, JSON.stringify(v, null, 2));
}

// ── Mapeo columnas Excel → BD ─────────────────────────────
const COL_MAP = {
  CLAVE_PAIS:            ['CLAVE_PAIS','PAIS','COUNTRY'],
  CLAVE_ENTIDADREGULADA: ['CLAVE_ENTIDADREGULADA','ENTIDAD','ENTIDAD_REGULADA','CLAVE_ENTIDAD'],
  CLAVE_LAYOUT:          ['CLAVE_LAYOUT','LAYOUT','CLAVE LAYOUT'],
  CLAVE_LAYOUT_CITI:     ['CLAVE_LAYOUT_CITI','LAYOUT_CITI','CITI'],
  ORDEN:                 ['ORDEN','ORDER','NUM','NUMERO','#'],
  NOMBRE_CAMPO:          ['NOMBRE_CAMPO','CAMPO','FIELD','NOMBRE CAMPO','FIELD NAME'],
  LLAVE:                 ['LLAVE','KEY','PK','LLAVE PRIMARIA'],
  TIPO_DATO:             ['TIPO_DATO','TIPO','TYPE','DATA TYPE','TIPO DATO'],
  FORMATO:               ['FORMATO','FORMAT','MASK'],
  OBLIGATORIO:           ['OBLIGATORIO','REQUIRED','REQUERIDO'],
  VALIDACION:            ['VALIDACION','VALIDACIÓN','VALIDATION','RULE'],
  CATALOGO:              ['CATALOGO','CATÁLOGO','CATALOG'],
  DESCRIPCION_ESP:       ['DESCRIPCION_ESP','DESCRIPCION','DESCRIPCIÓN','DESCRIPTION'],
};
function mapColumns(headers) {
  const mapping = {};
  const upper = headers.map(h => (h||'').toString().toUpperCase().trim());
  for (const [dbCol, aliases] of Object.entries(COL_MAP)) {
    for (const alias of aliases) {
      const idx = upper.indexOf(alias.toUpperCase());
      if (idx !== -1) { mapping[dbCol] = idx; break; }
    }
  }
  return mapping;
}

// ── Parsear Excel → rows + header ────────────────────────
function parseExcel(buffer) {
  const wb    = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows  = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });
  let headerIdx = -1, colMapping = {};
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const candidate = (rows[i]||[]).map(h => (h||'').toString().trim());
    if (candidate.filter(Boolean).length >= 3) {
      const m = mapColumns(candidate);
      if (m.CLAVE_LAYOUT || m.NOMBRE_CAMPO) { headerIdx = i; colMapping = m; break; }
    }
  }
  return { rows, headerIdx, colMapping };
}

const esc = v => v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g,"''")}'`;

// ── Versión semántica ─────────────────────────────────────
// Lee la versión actual desde SQL Server; si no existe arranca en 0.0.0
async function getVersionActual(claveLayout) {
  const rows = await query(`
    SELECT TOP 1 VER_MAJOR, VER_MINOR, VER_PATCH
    FROM LAYOUT_VERSIONES
    WHERE CLAVE_LAYOUT = ${esc(claveLayout)}
    ORDER BY FECHA_CARGA DESC
  `);
  if (!rows.length) return { major: 0, minor: 0, patch: 0 };
  return { major: rows[0].VER_MAJOR, minor: rows[0].VER_MINOR, patch: rows[0].VER_PATCH };
}

// Calcula el bump de versión según nivel de cambio
// MAJOR = campos nuevos/eliminados → sube MAJOR, reset minor+patch
// MINOR = tipo_dato, obligatorio, llave, validacion → sube MINOR, reset patch
// PATCH = descripcion, formato, catalogo → sube PATCH
function calcularNuevoSem(actual, nivel) {
  if (nivel === 'MAJOR') return { major: actual.major + 1, minor: 0, patch: 0 };
  if (nivel === 'MINOR') return { major: actual.major, minor: actual.minor + 1, patch: 0 };
  return { major: actual.major, minor: actual.minor, patch: actual.patch + 1 };
}

// Determina el nivel de cambio comparando campos nuevos vs existentes en BD
function detectarNivel(cambios) {
  if (cambios.nuevos > 0 || cambios.eliminados > 0) return 'MAJOR';
  if (cambios.minor  > 0) return 'MINOR';
  return 'PATCH';
}

// Campos que definen MINOR vs PATCH
const CAMPOS_MINOR = ['TIPO_DATO','OBLIGATORIO','LLAVE','VALIDACION'];
const CAMPOS_PATCH = ['DESCRIPCION_ESP','FORMATO','CATALOGO','CLAVE_LAYOUT_CITI'];

// ─────────────────────────────────────────────────────────
// PASO 1: POST /api/layouts/preview
// Parsea el Excel, detecta layouts, sugiere mapeo con layouts BD.
// No escribe nada.
// ─────────────────────────────────────────────────────────
router.post('/preview', requireAuth, upload.single('archivo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, message: 'No se recibió archivo' });
  try {
    const { rows, headerIdx, colMapping } = parseExcel(req.file.buffer);
    if (headerIdx === -1) {
      const preview = [];
      for (let i = 0; i < Math.min(rows.length, 8); i++) {
        const vals = (rows[i]||[]).map(h=>(h||'').toString().trim()).filter(Boolean);
        if (vals.length) preview.push({ fila: i+1, cols: vals });
      }
      return res.status(400).json({
        ok: false,
        message: 'No se encontraron columnas requeridas en las primeras 30 filas',
        preview,
        tip: 'El Excel debe tener CLAVE_LAYOUT (o LAYOUT) y NOMBRE_CAMPO (o CAMPO, FIELD)'
      });
    }

    const get = (row, col) => {
      if (colMapping[col] === undefined) return null;
      const v = row[colMapping[col]];
      return v !== null && v !== undefined ? String(v).trim() : null;
    };

    const dataRows = rows.slice(headerIdx + 1).filter(r =>
      r[colMapping.CLAVE_LAYOUT] && r[colMapping.NOMBRE_CAMPO]
    );
    if (!dataRows.length) return res.status(400).json({ ok: false, message: 'No hay filas válidas' });

    const layoutsExcel = [...new Set(dataRows.map(r => get(r,'CLAVE_LAYOUT')).filter(Boolean))];
    const bdLayouts    = (await query(`SELECT DISTINCT CLAVE_LAYOUT FROM LAYOUTS ORDER BY CLAVE_LAYOUT`))
                          .map(r => r.CLAVE_LAYOUT);

    // Auto-sugerir por similitud
    const sugerencias = {};
    for (const ex of layoutsExcel) {
      const exact   = bdLayouts.find(b => b.toUpperCase() === ex.toUpperCase());
      const partial = bdLayouts.find(b =>
        b.toUpperCase().includes(ex.toUpperCase()) || ex.toUpperCase().includes(b.toUpperCase())
      );
      sugerencias[ex] = exact || partial || null;
    }

    // Versión actual por layout
    const versionesActuales = {};
    for (const bd of [...new Set(Object.values(sugerencias).filter(Boolean))]) {
      const v = await getVersionActual(bd);
      versionesActuales[bd] = `${v.major}.${v.minor}.${v.patch}`;
    }

    // Guardar en sesión para paso 2
    req.session.layoutUpload = {
      filename:   req.file.originalname,
      rows:       rows.slice(headerIdx + 1),
      colMapping,
    };

    res.json({
      ok: true, archivo: req.file.originalname,
      total_filas: dataRows.length,
      layouts_excel: layoutsExcel,
      layouts_bd:    bdLayouts,
      sugerencias,
      versiones_actuales: versionesActuales,
    });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ─────────────────────────────────────────────────────────
// PASO 2: POST /api/layouts/upload
// Body JSON: { mapeo: { excelLayout: bdLayout }, jiraTicket?: "QD-42" }
// Hace upsert real en LAYOUTS, calcula versión semántica,
// guarda en LAYOUT_VERSIONES + JSON local.
// Si viene jiraTicket, marca la alerta QA como PROCESADA.
// ─────────────────────────────────────────────────────────
router.post('/upload', requireAuth, async (req, res) => {
  const session = req.session.layoutUpload;
  if (!session) return res.status(400).json({ ok: false, message: 'No hay Excel pendiente. Sube primero el archivo.' });

  const { mapeo, jiraTicket, notas: notasExtra } = req.body;
  if (!mapeo || typeof mapeo !== 'object') return res.status(400).json({ ok: false, message: 'Falta el parámetro "mapeo"' });

  const usuario  = req.session.user.username || req.session.user.nombre || 'desconocido';
  const filename = session.filename;
  const { rows, colMapping } = session;

  const get = (row, col) => {
    if (colMapping[col] === undefined) return null;
    const v = row[colMapping[col]];
    return v !== null && v !== undefined ? String(v).trim() : null;
  };

  const dataRows = rows.filter(r => r[colMapping.CLAVE_LAYOUT] && r[colMapping.NOMBRE_CAMPO]);

  // Agrupar filas por layout destino
  const porLayout = {};
  for (const row of dataRows) {
    const claveExcel = get(row, 'CLAVE_LAYOUT');
    const claveBD    = mapeo[claveExcel] || claveExcel;
    if (!claveBD) continue;
    if (!porLayout[claveBD]) porLayout[claveBD] = [];
    porLayout[claveBD].push({ row, claveExcel });
  }

  const resultados = [];

  for (const [claveBD, items] of Object.entries(porLayout)) {
    // ── Leer estado actual en BD para comparar ────────────
    const existentes = await query(`
      SELECT NOMBRE_CAMPO, TIPO_DATO, OBLIGATORIO, LLAVE, VALIDACION,
             DESCRIPCION_ESP, FORMATO, CATALOGO, CLAVE_LAYOUT_CITI, ORDEN
      FROM LAYOUTS WHERE CLAVE_LAYOUT = ${esc(claveBD)}
    `);
    const mapExistentes = Object.fromEntries(existentes.map(r => [r.NOMBRE_CAMPO, r]));
    const nombresExcel  = new Set(items.map(i => get(i.row, 'NOMBRE_CAMPO')));
    const nombresDB     = new Set(Object.keys(mapExistentes));

    // ── Contadores de cambio ──────────────────────────────
    const cambios = { nuevos: 0, eliminados: 0, minor: 0, patch: 0, sin_cambio: 0 };

    // Campos en BD que ya no están en el Excel → MAJOR
    for (const n of nombresDB) {
      if (!nombresExcel.has(n)) cambios.eliminados++;
    }

    let camposNuevos = 0, camposActualizados = 0, errores = [];

    for (const { row } of items) {
      const nombreCampo = get(row, 'NOMBRE_CAMPO');
      if (!nombreCampo) continue;

      const campos = {
        CLAVE_PAIS:            get(row, 'CLAVE_PAIS'),
        CLAVE_ENTIDADREGULADA: get(row, 'CLAVE_ENTIDADREGULADA'),
        CLAVE_LAYOUT_CITI:     get(row, 'CLAVE_LAYOUT_CITI'),
        ORDEN:                 get(row, 'ORDEN'),
        LLAVE:                 get(row, 'LLAVE'),
        TIPO_DATO:             get(row, 'TIPO_DATO'),
        FORMATO:               get(row, 'FORMATO'),
        OBLIGATORIO:           get(row, 'OBLIGATORIO'),
        VALIDACION:            get(row, 'VALIDACION'),
        CATALOGO:              get(row, 'CATALOGO'),
        DESCRIPCION_ESP:       get(row, 'DESCRIPCION_ESP'),
      };

      try {
        if (mapExistentes[nombreCampo]) {
          // ── UPDATE: detectar nivel de cambio ─────────────
          const existing = mapExistentes[nombreCampo];
          let nivelFila = 'sin_cambio';
          for (const c of CAMPOS_MINOR) {
            if (campos[c] !== null && String(campos[c]) !== String(existing[c]||'')) {
              nivelFila = 'MINOR'; break;
            }
          }
          if (nivelFila === 'sin_cambio') {
            for (const c of CAMPOS_PATCH) {
              if (campos[c] !== null && String(campos[c]) !== String(existing[c]||'')) {
                nivelFila = 'PATCH'; break;
              }
            }
          }
          if (nivelFila === 'MINOR') cambios.minor++;
          else if (nivelFila === 'PATCH') cambios.patch++;
          else cambios.sin_cambio++;

          const sets = Object.entries(campos)
            .filter(([,v]) => v !== null)
            .map(([k,v]) => `${k}=${esc(v)}`)
            .join(', ');
          if (sets) {
            await query(`UPDATE LAYOUTS SET ${sets}
              WHERE CLAVE_LAYOUT=${esc(claveBD)} AND NOMBRE_CAMPO=${esc(nombreCampo)}`);
          }
          camposActualizados++;
        } else {
          // ── INSERT: campo nuevo → MAJOR ───────────────────
          cambios.nuevos++;
          await query(`
            INSERT INTO LAYOUTS (
              CLAVE_PAIS, CLAVE_ENTIDADREGULADA, CLAVE_LAYOUT, NOMBRE_CAMPO,
              CLAVE_LAYOUT_CITI, ORDEN, LLAVE, TIPO_DATO, FORMATO, OBLIGATORIO,
              VALIDACION, CATALOGO, DESCRIPCION_ESP
            ) VALUES (
              ${esc(campos.CLAVE_PAIS||'MX')}, ${esc(campos.CLAVE_ENTIDADREGULADA||'MX')},
              ${esc(claveBD)}, ${esc(nombreCampo)},
              ${esc(campos.CLAVE_LAYOUT_CITI)}, ${esc(campos.ORDEN)}, ${esc(campos.LLAVE)},
              ${esc(campos.TIPO_DATO)}, ${esc(campos.FORMATO)}, ${esc(campos.OBLIGATORIO)},
              ${esc(campos.VALIDACION)}, ${esc(campos.CATALOGO)}, ${esc(campos.DESCRIPCION_ESP)}
            )`);
          camposNuevos++;
        }
      } catch (rowErr) {
        errores.push({ campo: nombreCampo, error: rowErr.message });
      }
    }

    // ── Calcular versión semántica ────────────────────────
    const nivel    = detectarNivel(cambios);
    const actual   = await getVersionActual(claveBD);
    const nuevaSem = calcularNuevoSem(actual, nivel);
    const versionStr = `${nuevaSem.major}.${nuevaSem.minor}.${nuevaSem.patch}`;

    // ── Insertar en LAYOUT_VERSIONES ──────────────────────
    let jiraSummary = null, jiraStatus = null;
    if (jiraTicket) {
      try {
        const tk = await query(`SELECT TOP 1 JIRA_SUMMARY, JIRA_STATUS FROM QA_ALERTAS WHERE JIRA_TICKET=${esc(jiraTicket)}`);
        if (tk.length) { jiraSummary = tk[0].JIRA_SUMMARY; jiraStatus = tk[0].JIRA_STATUS; }
      } catch (_) {}
    }

    const notas = [
      notasExtra || null,
      cambios.nuevos     ? `${cambios.nuevos} campos nuevos`      : null,
      cambios.eliminados ? `${cambios.eliminados} campos eliminados` : null,
      cambios.minor      ? `${cambios.minor} cambios MINOR`        : null,
      cambios.patch      ? `${cambios.patch} cambios PATCH`        : null,
    ].filter(Boolean).join(' | ') || null;

    await query(`
      INSERT INTO LAYOUT_VERSIONES (
        CLAVE_LAYOUT, VER_MAJOR, VER_MINOR, VER_PATCH, NIVEL_CAMBIO,
        JIRA_TICKET, JIRA_STATUS, JIRA_SUMMARY,
        ARCHIVO_NOMBRE, FILAS_PROCESADAS, CAMPOS_NUEVOS, CAMPOS_ACTUALIZADOS,
        CAMPOS_ELIMINADOS, USUARIO, NOTAS
      ) VALUES (
        ${esc(claveBD)}, ${nuevaSem.major}, ${nuevaSem.minor}, ${nuevaSem.patch}, ${esc(nivel)},
        ${esc(jiraTicket||null)}, ${esc(jiraStatus)}, ${esc(jiraSummary)},
        ${esc(filename)}, ${items.length}, ${camposNuevos}, ${camposActualizados},
        ${cambios.eliminados}, ${esc(usuario)}, ${esc(notas)}
      )`);

    // ── Marcar alerta QA como PROCESADA ──────────────────
    if (jiraTicket) {
      try {
        await query(`
          UPDATE QA_ALERTAS SET
            ESTADO='PROCESADO', FECHA_PROCESADO=GETDATE(), PROCESADO_POR=${esc(usuario)},
            CLAVE_LAYOUT_FINAL=${esc(claveBD)}, LAYOUT_CONFIRMADO=1
          WHERE JIRA_TICKET=${esc(jiraTicket)}`);
      } catch (_) {}
    }

    // ── Guardar en JSON local (respaldo) ──────────────────
    guardarVersionJSON({
      id: Date.now(), clave_layout: claveBD,
      version: versionStr, nivel_cambio: nivel,
      jira_ticket: jiraTicket || null,
      archivo: filename,
      filas_procesadas: items.length,
      filas_nuevas: camposNuevos, filas_actualizadas: camposActualizados,
      errores: errores.length, usuario, fecha: new Date().toISOString(),
      cambios,
    });

    resultados.push({
      clave_layout: claveBD, version: versionStr, nivel_cambio: nivel,
      campos_nuevos: camposNuevos, campos_actualizados: camposActualizados,
      campos_eliminados: cambios.eliminados, errores,
    });
  }

  delete req.session.layoutUpload;

  res.json({ ok: true, jira_ticket: jiraTicket || null, resultados });
});

// ─────────────────────────────────────────────────────────
// GET /api/layouts/versiones
// ─────────────────────────────────────────────────────────
router.get('/versiones', requireAuth, async (req, res) => {
  const { layout } = req.query;
  try {
    const where = layout ? `WHERE CLAVE_LAYOUT=${esc(layout)}` : '';
    const rows  = await query(`
      SELECT TOP 100
        ID_VERSION, CLAVE_LAYOUT, VERSION_SEM, NIVEL_CAMBIO,
        VER_MAJOR, VER_MINOR, VER_PATCH,
        JIRA_TICKET, JIRA_STATUS, JIRA_SUMMARY,
        ARCHIVO_NOMBRE, FILAS_PROCESADAS, CAMPOS_NUEVOS,
        CAMPOS_ACTUALIZADOS, CAMPOS_ELIMINADOS,
        USUARIO, FECHA_CARGA, NOTAS
      FROM LAYOUT_VERSIONES ${where}
      ORDER BY FECHA_CARGA DESC
    `);
    res.json({ ok: true, data: rows });
  } catch (e) {
    // Fallback a JSON local si la tabla aún no existe
    let data = leerVersionesJSON();
    if (layout) data = data.filter(v => v.clave_layout === layout);
    res.json({ ok: true, data, source: 'json_local' });
  }
});

// ─────────────────────────────────────────────────────────
// GET /api/layouts/alertas-qa
// Tickets QD/CDL en "Instalados en QA" pendientes de procesar
// ─────────────────────────────────────────────────────────
router.get('/alertas-qa', requireAuth, async (req, res) => {
  try {
    const rows = await query(`
      SELECT TOP 50
        ID_ALERTA, JIRA_TICKET, JIRA_PROJECT, JIRA_SUMMARY,
        JIRA_STATUS, JIRA_UPDATED, JIRA_ASSIGNEE,
        CLAVE_LAYOUT_DETECTADO, LAYOUT_CONFIRMADO, CLAVE_LAYOUT_FINAL,
        ESTADO, FECHA_DETECTADO
      FROM QA_ALERTAS
      WHERE ESTADO = 'PENDIENTE'
      ORDER BY FECHA_DETECTADO DESC
    `);
    res.json({ ok: true, data: rows });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// PUT /api/layouts/alertas-qa/:id/ignorar
router.put('/alertas-qa/:id/ignorar', requireAuth, async (req, res) => {
  try {
    await query(`UPDATE QA_ALERTAS SET ESTADO='IGNORADO' WHERE ID_ALERTA=${parseInt(req.params.id)}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// PUT /api/layouts/alertas-qa/:id/layout  — confirmar el layout manualmente
router.put('/alertas-qa/:id/layout', requireAuth, async (req, res) => {
  const { clave_layout } = req.body;
  if (!clave_layout) return res.status(400).json({ ok: false, message: 'Falta clave_layout' });
  try {
    await query(`
      UPDATE QA_ALERTAS SET
        CLAVE_LAYOUT_FINAL=${esc(clave_layout)},
        LAYOUT_CONFIRMADO=1
      WHERE ID_ALERTA=${parseInt(req.params.id)}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

module.exports = router;
