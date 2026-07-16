const express = require('express');
const router  = express.Router();
const { query } = require('../db/connection');

// ── Middleware: requiere sesión activa ────────────────────
function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ ok: false, message: 'No autenticado' });
  next();
}

// ── GET /api/status ───────────────────────────────────────
router.get('/status', async (req, res) => {
  try {
    await query('SELECT 1 AS ping');
    res.json({ ok: true, db: 'connected' });
  } catch (err) {
    res.json({ ok: false, db: 'disconnected', error: err.message });
  }
});

// ── GET /api/buscar-tabla?q=layout ───────────────────────
router.get('/buscar-tabla', async (req, res) => {
  const q = (req.query.q || '').toUpperCase();
  try {
    const rows = await query(`
      SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_TYPE = 'BASE TABLE'
        AND UPPER(TABLE_NAME) LIKE '%${q.replace(/'/g,"''")}%'
      ORDER BY TABLE_NAME
    `);
    res.json({ ok: true, data: rows.map(r => r.TABLE_NAME) });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// ── GET /api/explorar ─────────────────────────────────────
// Lista todas las tablas con sus columnas y cantidad de filas
router.get('/explorar', async (req, res) => {
  try {
    const tablas = await query(`
      SELECT t.TABLE_NAME,
             c.COLUMN_NAME,
             c.DATA_TYPE,
             c.CHARACTER_MAXIMUM_LENGTH,
             c.IS_NULLABLE
      FROM INFORMATION_SCHEMA.TABLES t
      JOIN INFORMATION_SCHEMA.COLUMNS c ON c.TABLE_NAME = t.TABLE_NAME
      WHERE t.TABLE_TYPE = 'BASE TABLE'
      ORDER BY t.TABLE_NAME, c.ORDINAL_POSITION
    `);

    // Agrupar columnas por tabla
    const mapa = {};
    for (const row of tablas) {
      if (!mapa[row.TABLE_NAME]) mapa[row.TABLE_NAME] = [];
      mapa[row.TABLE_NAME].push({
        columna:  row.COLUMN_NAME,
        tipo:     row.DATA_TYPE + (row.CHARACTER_MAXIMUM_LENGTH ? `(${row.CHARACTER_MAXIMUM_LENGTH})` : ''),
        nullable: row.IS_NULLABLE === 'YES'
      });
    }

    // Contar filas por tabla
    const resultado = [];
    for (const [tabla, columnas] of Object.entries(mapa)) {
      let filas = '?';
      try {
        const r = await query(`SELECT COUNT(*) AS n FROM [${tabla}]`);
        filas = r[0].n;
      } catch (_) {}
      resultado.push({ tabla, filas, columnas });
    }

    res.json({ ok: true, data: resultado });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// ── GET /api/debug-tabla/:tabla ───────────────────────────
// Ver primeras filas + columnas de cualquier tabla (solo admin)
router.get('/debug-tabla/:tabla', requireAuth, async (req, res) => {
  const tabla = req.params.tabla.replace(/[^a-zA-Z0-9_]/g, '');
  try {
    const cols = await query(`
      SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_NAME = '${tabla}' ORDER BY ORDINAL_POSITION
    `);
    const filas = await query(`SELECT TOP 10 * FROM [${tabla}]`);
    const count = await query(`SELECT COUNT(*) AS total FROM [${tabla}]`);
    res.json({ ok: true, tabla, total: count[0].total, columnas: cols, data: filas });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── GET /api/debug-validaciones/:contrato ─────────────────
// Diagnosticar por qué no hay validaciones para un contrato
router.get('/debug-validaciones/:contrato', requireAuth, async (req, res) => {
  const clave = req.params.contrato.replace(/[^a-zA-Z0-9_]/g, '');
  try {
    // Claves en CONTRATOS_REPORTES para ese contrato
    const clavesCR = await query(`
      SELECT TOP 5 CLAVE_REP FROM CONTRATOS_REPORTES WHERE CLAVE_CONTRATO='${clave}'
    `);
    // Muestra de CLAVE_REP en REPORTE_VALIDACION
    const muestraRV = await query(`SELECT DISTINCT TOP 10 CLAVE_REP FROM REPORTE_VALIDACION`);
    // Intento de match con LIKE
    const matchLike = clavesCR.length ? await query(`
      SELECT TOP 5 rv.CLAVE_REP FROM REPORTE_VALIDACION rv
      WHERE rv.CLAVE_REP LIKE '${clavesCR[0].CLAVE_REP}%'
    `) : [];
    // Match con LEFT
    const matchLeft = clavesCR.length ? await query(`
      SELECT TOP 5 rv.CLAVE_REP FROM REPORTE_VALIDACION rv
      WHERE LEFT(rv.CLAVE_REP, ${clavesCR[0].CLAVE_REP.length}) = '${clavesCR[0].CLAVE_REP}'
    `) : [];
    res.json({ ok: true, clavesCR, muestraRV, matchLike, matchLeft });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── GET /api/paquetes ─────────────────────────────────────
// Paquetes agrupados por ticket con progreso por cliente
router.get('/paquetes', requireAuth, async (req, res) => {
  try {
    const { estatus, grupo, cliente } = req.query;

    let where = '1=1';
    if (estatus)  where += ` AND ESTATUS = '${estatus.replace(/'/g,"''")}'`;
    if (grupo)    where += ` AND CLAVE_GRUPO = '${grupo.replace(/'/g,"''")}'`;
    if (cliente)  where += ` AND CLAVE_CLIENTE LIKE '%${cliente.replace(/'/g,"''")}%'`;

    const rows = await query(`
      SELECT
        ID_PAQUETE, ID_TICKET, CLAVE_CLIENTE, CLAVE_ENTIDADREGULADA,
        CLAVE_GRUPO, DESCRIPCION, FECHA_LIBERACION, ESTATUS, TIPO, REPORTES
      FROM PAQUETES
      WHERE ${where}
      ORDER BY ID_TICKET DESC, ID_PAQUETE DESC
    `);

    // Agrupar por ticket
    const mapa = {};
    for (const r of rows) {
      if (!mapa[r.ID_TICKET]) {
        mapa[r.ID_TICKET] = {
          ticket:      r.ID_TICKET,
          descripcion: r.DESCRIPCION,
          tipo:        r.TIPO,
          grupo:       r.CLAVE_GRUPO,
          reportes:    r.REPORTES,
          clientes:    [],
          cerrados:    0,
          total:       0
        };
      }
      mapa[r.ID_TICKET].clientes.push({
        id:             r.ID_PAQUETE,
        cliente:        r.CLAVE_CLIENTE,
        entidad:        r.CLAVE_ENTIDADREGULADA,
        estatus:        r.ESTATUS,
        fechaLibera:    r.FECHA_LIBERACION
      });
      mapa[r.ID_TICKET].total++;
      if (r.ESTATUS === 'CERRADO') mapa[r.ID_TICKET].cerrados++;
    }

    res.json({ ok: true, data: Object.values(mapa) });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// ── GET /api/paquetes/grupos ──────────────────────────────
router.get('/paquetes/grupos', requireAuth, async (req, res) => {
  try {
    const rows = await query(`SELECT DISTINCT CLAVE_GRUPO FROM PAQUETES WHERE CLAVE_GRUPO IS NOT NULL ORDER BY CLAVE_GRUPO`);
    res.json({ ok: true, data: rows.map(r => r.CLAVE_GRUPO) });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// ── GET /api/paquetes/estatus-distintos ───────────────────
router.get('/paquetes/estatus-distintos', async (req, res) => {
  try {
    const rows = await query(`
      SELECT ESTATUS, COUNT(*) AS total
      FROM PAQUETES
      GROUP BY ESTATUS
      ORDER BY total DESC
    `);
    res.json({ ok: true, data: rows });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// ── GET /api/inventario/layouts ───────────────────────────
router.get('/inventario/layouts', requireAuth, async (req, res) => {
  const { layout, entidad, texto } = req.query;
  let where = 'WHERE 1=1';
  if (layout)  where += ` AND CLAVE_LAYOUT = '${layout.replace(/'/g,"''")}'`;
  if (entidad) where += ` AND CLAVE_ENTIDADREGULADA = '${entidad.replace(/'/g,"''")}'`;
  if (texto)   where += ` AND (NOMBRE_CAMPO LIKE '%${texto.replace(/'/g,"''")}%' OR CLAVE_LAYOUT LIKE '%${texto.replace(/'/g,"''")}%')`;
  try {
    const rows = await query(`
      SELECT TOP 500
        CLAVE_PAIS, CLAVE_ENTIDADREGULADA, CLAVE_LAYOUT,
        CLAVE_LAYOUT_CITI, ORDEN, NOMBRE_CAMPO,
        LLAVE, TIPO_DATO, FORMATO, OBLIGATORIO, VALIDACION
      FROM LAYOUTS
      ${where}
      ORDER BY CLAVE_LAYOUT, ORDEN
    `);
    res.json({ ok: true, total: rows.length, data: rows });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// ── GET /api/sprints/activo ───────────────────────────────
router.get('/sprints/activo', requireAuth, async (req, res) => {
  try {
    const rows = await query(`
      SELECT id, nombre, fecha_inicio, fecha_fin, estado
      FROM sprints
      WHERE estado = 'activo'
    `);
    res.json({ ok: true, data: rows[0] || null });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// ── GET /api/sprints/tickets ──────────────────────────────
router.get('/sprints/tickets', requireAuth, async (req, res) => {
  try {
    const rows = await query(`
      SELECT t.id, t.titulo, t.descripcion, t.estado, t.asignado_a,
             t.sprint_id, t.fecha_creacion
      FROM tickets t
      INNER JOIN sprints s ON t.sprint_id = s.id
      WHERE s.estado = 'activo'
      ORDER BY t.id
    `);
    res.json({ ok: true, data: rows });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// ── GET /api/dashboard/stats ──────────────────────────────
router.get('/dashboard/stats', requireAuth, async (req, res) => {
  try {
    const [layouts] = await query('SELECT COUNT(*) AS total FROM inventario_layouts');
    const [tickets] = await query("SELECT COUNT(*) AS total FROM tickets WHERE estado != 'cerrado'");
    const [sprints] = await query("SELECT COUNT(*) AS total FROM sprints WHERE estado = 'activo'");
    const [usuarios] = await query("SELECT COUNT(*) AS total FROM usuarios WHERE activo = 1");
    res.json({
      ok: true,
      data: {
        layouts:  layouts.total,
        tickets:  tickets.total,
        sprints:  sprints.total,
        usuarios: usuarios.total
      }
    });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// ── GET /api/soporte/clientes ─────────────────────────────
router.get('/soporte/clientes', requireAuth, async (req, res) => {
  try {
    const rows = await query(`
      SELECT CLAVE_CLIENTE, NOMBRE_CLIENTE, CLAVE_PAIS, ACTIVO
      FROM CLIENTE
      WHERE ACTIVO = 1
      ORDER BY NOMBRE_CLIENTE
    `);
    res.json({ ok: true, data: rows });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// ── GET /api/soporte/cliente/:clave ───────────────────────
// Info técnica del cliente: contratos, reportes, última modificación
router.get('/soporte/cliente/:clave', requireAuth, async (req, res) => {
  const clave = req.params.clave;
  try {
    // Contratos del cliente
    const contratos = await query(`
      SELECT c.CLAVE_CONTRATO, c.NOMBRE_CONTRATO, c.CLAVE_PLATAFORMA,
             c.FECHA_ALTA, c.FECHA_MODIFICA
      FROM CONTRATOS c
      WHERE c.CLAVE_CLIENTE = '${clave.replace(/'/g,"''")}'
      ORDER BY c.FECHA_MODIFICA DESC
    `);

    // Reportes por contrato
    const reportes = await query(`
      SELECT cr.CLAVE_CONTRATO, cr.CLAVE_REP,
             cr.ETAPA, cr.EN_USO,
             cr.FECHA_INSTALADO_PROD, cr.FECHA_ESTIMADA_PROD
      FROM CONTRATOS_REPORTES cr
      INNER JOIN CONTRATOS c ON c.CLAVE_CONTRATO = cr.CLAVE_CONTRATO
      WHERE c.CLAVE_CLIENTE = '${clave.replace(/'/g,"''")}'
      ORDER BY cr.FECHA_INSTALADO_PROD DESC
    `);

    // Última modificación en CAMBIOS relacionada con reportes del cliente
    const claveContratos = contratos.map(c => `'${c.CLAVE_CONTRATO}'`).join(',');
    let ultimoCambio = null;
    if (claveContratos.length) {
      const cambios = await query(`
        SELECT TOP 1 USER_NAME, DESCRIPCION, FECHA
        FROM CAMBIOS
        ORDER BY FECHA DESC
      `);
      ultimoCambio = cambios[0] || null;
    }

    // Paquetes activos (no cerrados)
    const paquetes = await query(`
      SELECT ID_TICKET, ESTATUS, COUNT(*) as total
      FROM PAQUETES
      WHERE CLAVE_CLIENTE = '${clave.replace(/'/g,"''")}'
      GROUP BY ID_TICKET, ESTATUS
    `);

    res.json({
      ok: true,
      data: {
        contratos,
        totalReportes: reportes.length,
        reportesEnUso: reportes.filter(r => r.EN_USO === 'SI').length,
        ultimoCambio,
        paquetesActivos:  paquetes.filter(p => p.ESTATUS !== 'CERRADO').length,
        paquetesCerrados: paquetes.filter(p => p.ESTATUS === 'CERRADO').length
      }
    });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// ── GET /api/soporte/cliente/:clave/fixes ─────────────────
// Paquetes del cliente agrupados por ticket de Jira
router.get('/soporte/cliente/:clave/fixes', requireAuth, async (req, res) => {
  const clave = req.params.clave;
  try {
    const rows = await query(`
      SELECT ID_PAQUETE, ID_TICKET, DESCRIPCION, FECHA_LIBERACION,
             ESTATUS, TIPO, REPORTES, CLAVE_GRUPO
      FROM PAQUETES
      WHERE CLAVE_CLIENTE = '${clave.replace(/'/g,"''")}'
      ORDER BY ID_TICKET DESC
    `);

    // Agrupar por ticket y enriquecer con progreso global del ticket
    const tickets = {};
    for (const r of rows) {
      if (!tickets[r.ID_TICKET]) {
        tickets[r.ID_TICKET] = {
          ticket:      r.ID_TICKET,
          descripcion: r.DESCRIPCION,
          tipo:        r.TIPO,
          grupo:       r.CLAVE_GRUPO,
          reportes:    r.REPORTES,
          paquete:     { id: r.ID_PAQUETE, estatus: r.ESTATUS, fechaLibera: r.FECHA_LIBERACION }
        };
      }
    }

    // Para cada ticket obtener progreso global (todos los clientes)
    const ticketKeys = Object.keys(tickets);
    for (const key of ticketKeys) {
      const global = await query(`
        SELECT COUNT(*) AS total,
               SUM(CASE WHEN ESTATUS = 'CERRADO' THEN 1 ELSE 0 END) AS cerrados
        FROM PAQUETES WHERE ID_TICKET = '${key.replace(/'/g,"''")}'
      `);
      tickets[key].globalTotal    = global[0]?.total    || 0;
      tickets[key].globalCerrados = global[0]?.cerrados || 0;
    }

    res.json({ ok: true, data: Object.values(tickets) });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// ── GET /api/inventario/reportes ─────────────────────────
router.get('/inventario/reportes', requireAuth, async (req, res) => {
  const { reg, entidad, grupo, periodo, texto } = req.query;
  let where = 'WHERE 1=1';
  if (reg)     where += ` AND CLAVE_REG = '${reg.replace(/'/g,"''")}'`;
  if (entidad) where += ` AND CLAVE_ENTIDADREGULADA = '${entidad.replace(/'/g,"''")}'`;
  if (grupo)   where += ` AND CLAVE_GRUPO = '${grupo.replace(/'/g,"''")}'`;
  if (periodo) where += ` AND CLAVE_PERIODO = '${periodo.replace(/'/g,"''")}'`;
  if (texto)   where += ` AND (CLAVE_REP LIKE '%${texto.replace(/'/g,"''")}%' OR REPORTE LIKE '%${texto.replace(/'/g,"''")}%' OR DESCRIPCION_ESP LIKE '%${texto.replace(/'/g,"''")}%')`;
  try {
    const rows = await query(`
      SELECT TOP 200
        ir.CLAVE_REP, ir.REPORTE, ir.CLAVE_ENTIDADREGULADA, ir.CLAVE_REG,
        ir.CLAVE_GRUPO, ir.CLAVE_PERIODO, ir.CLAVE_VERSION_REPORTE,
        ir.DESCRIPCION_ESP, ir.VIGENTE, ir.FECHA_ACTUALIZADA,
        ir.VERSION_CARGA,
        r.REGULADOR AS REGULADOR_NOMBRE
      FROM INVENTARIO_REPORTES ir
      LEFT JOIN CAT_REGULADORES r ON r.CLAVE_REG = ir.CLAVE_REG
      ${where}
      ORDER BY ir.CLAVE_REP
    `);
    res.json({ ok: true, total: rows.length, data: rows });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// ── GET /api/inventario/filtros ───────────────────────────
router.get('/inventario/filtros', requireAuth, async (req, res) => {
  try {
    const [regs, entidades, grupos, periodos] = await Promise.all([
      query(`SELECT CLAVE_REG, REGULADOR FROM CAT_REGULADORES ORDER BY REGULADOR`),
      query(`SELECT CLAVE_ENTIDADREGULADA, ENTIDAD_REGULADA FROM CAT_ENTIDAD_REGULADA ORDER BY ENTIDAD_REGULADA`),
      query(`SELECT DISTINCT CLAVE_GRUPO FROM INVENTARIO_REPORTES WHERE CLAVE_GRUPO IS NOT NULL ORDER BY CLAVE_GRUPO`),
      query(`SELECT CLAVE_PERIODO, PERIODO FROM CAT_PERIODICIDAD ORDER BY PERIODO`)
    ]);
    res.json({ ok: true, data: { regs, entidades, grupos: grupos.map(g => g.CLAVE_GRUPO), periodos } });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// ── GET /api/estatus-reportes ─────────────────────────────
router.get('/estatus-reportes', requireAuth, async (req, res) => {
  const { plataforma, estatus, texto } = req.query;
  let where = 'WHERE 1=1';
  if (plataforma) where += ` AND er.CLAVE_PLATAFORMA = '${plataforma.replace(/'/g,"''")}'`;
  if (estatus)    where += ` AND er.ESTATUS = '${estatus.replace(/'/g,"''")}'`;
  if (texto)      where += ` AND er.CLAVE_REP LIKE '%${texto.replace(/'/g,"''")}%'`;
  try {
    const rows = await query(`
      SELECT TOP 200
        er.CLAVE_REP, er.CLAVE_PLATAFORMA, er.VERSION, er.ESTATUS,
        er.DOCUMENTADO, er.DOC_FECHA_ESTIMADA, er.DOC_FECHA_REAL, er.USER_DOC,
        er.PROGRAMADO,  er.PROG_FECHA_ESTIMADA, er.PROG_FECHA_REAL, er.USER_PROG,
        er.CERTIFICADO, er.CERT_FECHA_ESTIMADA, er.CERT_FECHA_REAL, er.USER_CERT,
        er.QA_ALPHA, er.QA_BETA,
        ir.VERSION_CARGA
      FROM ESTATUS_REPORTE er
      LEFT JOIN INVENTARIO_REPORTES ir ON ir.CLAVE_REP = er.CLAVE_REP
      ${where}
      ORDER BY er.CERT_FECHA_ESTIMADA ASC
    `);
    res.json({ ok: true, total: rows.length, data: rows });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// ── GET /api/estatus-reportes/plataformas ─────────────────
router.get('/estatus-reportes/plataformas', requireAuth, async (req, res) => {
  try {
    const rows = await query(`SELECT DISTINCT CLAVE_PLATAFORMA FROM ESTATUS_REPORTE ORDER BY CLAVE_PLATAFORMA`);
    res.json({ ok: true, data: rows.map(r => r.CLAVE_PLATAFORMA) });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// ── GET /api/estatus-reportes/estatus-valores ─────────────
router.get('/estatus-reportes/estatus-valores', requireAuth, async (req, res) => {
  try {
    const rows = await query(`SELECT DISTINCT ESTATUS FROM ESTATUS_REPORTE WHERE ESTATUS IS NOT NULL ORDER BY ESTATUS`);
    res.json({ ok: true, data: rows.map(r => r.ESTATUS) });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// ── GET /api/sprints/historial ────────────────────────────
router.get('/sprints/historial', requireAuth, async (req, res) => {
  try {
    const rows = await query(`
      SELECT ID_SPRINT, DESC_SPRINT, FECHA_INICIO_SPRINT, FECHA_FIN_SPRINT,
             DOC_ESTIMADOS, DOC_REAL, PROG_ESTIMADOS, PROG_REAL,
             CERT_ESTIMADOS, CERT_REAL,
             VAL_DOC_ESTIMADOS, VAL_DOC_REAL,
             VAL_PROG_ESTIMADOS, VAL_PROG_REAL,
             VAL_CERT_ESTIMADOS, VAL_CERT_REAL
      FROM CAT_SPRINTS_ENTREGAS_HIST
      ORDER BY FECHA_INICIO_SPRINT ASC
    `);
    res.json({ ok: true, data: rows });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// ── GET /api/actividad ────────────────────────────────────
router.get('/actividad', requireAuth, async (req, res) => {
  const { limit = 50, usuario, tipo } = req.query;
  let where = 'WHERE 1=1';
  if (usuario) where += ` AND USER_NAME LIKE '%${usuario.replace(/'/g,"''")}%'`;
  if (tipo)    where += ` AND TIPO_CAMBIO = '${tipo.replace(/'/g,"''")}'`;
  try {
    const rows = await query(`
      SELECT TOP ${parseInt(limit)}
        ID_CAMBIOS, USER_NAME, TIPO_CAMBIO, TIPO_IDENTIDAD, CLAVE, DESCRIPCION, FECHA
      FROM CAMBIOS
      ${where}
      ORDER BY FECHA DESC
    `);
    res.json({ ok: true, data: rows });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// ── GET /api/chi/clientes ─────────────────────────────────
router.get('/chi/clientes', requireAuth, async (req, res) => {
  try {
    const rows = await query(`
      SELECT cc.CLAVE_CLIENTE, cc.SOPORTE_SLA, cc.PMRV, cc.CCI,
             cc.P_ACTIVOS, cc.CARTERA, cc.ACT_PRODUCTO, cc.SUMA, cc.EDS,
             c.NOMBRE_CLIENTE
      FROM CHI_CLIENTE cc
      LEFT JOIN CLIENTE c ON c.CLAVE_CLIENTE = cc.CLAVE_CLIENTE
      ORDER BY cc.SUMA DESC
    `);
    res.json({ ok: true, data: rows });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// ── GET /api/chi/proyectos ────────────────────────────────
router.get('/chi/proyectos', requireAuth, async (req, res) => {
  try {
    const rows = await query(`
      SELECT cp.CLAVE_CONTRATO, cp.PROYECTO_COSTO, cp.CEH, cp.CEAP,
             cp.REP_CERT, cp.VAL_CERT, cp.SUMA,
             c.NOMBRE_CONTRATO, c.CLAVE_CLIENTE
      FROM CHI_PROYECTO cp
      LEFT JOIN CONTRATOS c ON c.CLAVE_CONTRATO = cp.CLAVE_CONTRATO
      ORDER BY cp.SUMA DESC
    `);
    res.json({ ok: true, data: rows });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

module.exports = router;
