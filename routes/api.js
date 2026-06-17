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
  try {
    // Ajusta la query a tu schema real
    const rows = await query(`
      SELECT TOP 100
        clave_layout,
        clave_layout_citi,
        reporte_que_aplica,
        columna_que_aplica,
        orden,
        nombre_campo,
        llave,
        tipo_dato,
        formato,
        obligatorio,
        validacion
      FROM inventario_layouts
      ORDER BY clave_layout
    `);
    res.json({ ok: true, data: rows });
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

module.exports = router;
