const express = require('express');
const router  = express.Router();
const { query } = require('../db/connection');

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ ok: false, message: 'No autenticado' });
  next();
}

// ── GET /api/reportes ─────────────────────────────────────
// Lista de reportes únicos con conteo de campos
router.get('/', requireAuth, async (req, res) => {
  try {
    const rows = await query(`
      SELECT
        ID_REPORTE,
        COUNT(*) AS TOTAL_CAMPOS,
        MIN(FECHA_CARGA) AS FECHA_CARGA
      FROM SOFIPO_REPORTES
      GROUP BY ID_REPORTE
      ORDER BY ID_REPORTE
    `);
    res.json({ ok: true, data: rows });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ── GET /api/reportes/:id/campos ──────────────────────────
// Campos de un reporte específico
router.get('/:id/campos', requireAuth, async (req, res) => {
  try {
    const id = req.params.id;
    const campos = await query(`
      SELECT
        r.ORDEN, r.NOMBRE_CAMPO, r.TIPO_DATO, r.LONGITUD,
        r.DECIMALES, r.FORMATO_CAPTURA, r.CATALOGO,
        -- layouts que usan este campo
        (
          SELECT STRING_AGG(u.CLAVE_LAYOUT, ', ')
          FROM SOFIPO_LAYOUT_USO u
          WHERE u.ID_REPORTE = r.ID_REPORTE
            AND u.NOMBRE_CAMPO = r.NOMBRE_CAMPO
        ) AS LAYOUTS_QUE_USAN
      FROM SOFIPO_REPORTES r
      WHERE r.ID_REPORTE = '${id.replace(/'/g,"''")}'
      ORDER BY r.ORDEN
    `);
    res.json({ ok: true, id_reporte: id, data: campos });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ── GET /api/reportes/layout/:clave ──────────────────────
// Qué reportes usa un layout (con sus campos)
router.get('/layout/:clave', requireAuth, async (req, res) => {
  try {
    const clave = req.params.clave;
    const rows = await query(`
      SELECT
        u.ID_REPORTE,
        u.NOMBRE_CAMPO,
        u.COLUMNA_REPORTE,
        d.TIPO_DATO,
        d.OBLIGATORIO,
        d.DESCRIPCION
      FROM SOFIPO_LAYOUT_USO u
      LEFT JOIN SOFIPO_LAYOUT_DESC d
        ON d.CLAVE_LAYOUT = u.CLAVE_LAYOUT AND d.NOMBRE_CAMPO = u.NOMBRE_CAMPO
      WHERE u.CLAVE_LAYOUT = '${clave.replace(/'/g,"''")}'
      ORDER BY u.ID_REPORTE, u.COLUMNA_REPORTE
    `);

    // Agrupar por reporte
    const porReporte = {};
    for (const r of rows) {
      if (!porReporte[r.ID_REPORTE]) porReporte[r.ID_REPORTE] = { id_reporte: r.ID_REPORTE, campos: [] };
      porReporte[r.ID_REPORTE].campos.push({
        nombre: r.NOMBRE_CAMPO,
        columna: r.COLUMNA_REPORTE,
        tipo: r.TIPO_DATO,
        obligatorio: r.OBLIGATORIO,
        descripcion: r.DESCRIPCION,
      });
    }

    res.json({ ok: true, clave_layout: clave, reportes: Object.values(porReporte) });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ── GET /api/reportes/campo/:nombre ──────────────────────
// En qué reportes aparece un campo específico
router.get('/campo/:nombre', requireAuth, async (req, res) => {
  try {
    const nombre = req.params.nombre;
    const rows = await query(`
      SELECT DISTINCT
        u.ID_REPORTE,
        u.CLAVE_LAYOUT,
        u.COLUMNA_REPORTE,
        d.TIPO_DATO,
        d.OBLIGATORIO,
        d.DESCRIPCION
      FROM SOFIPO_LAYOUT_USO u
      LEFT JOIN SOFIPO_LAYOUT_DESC d
        ON d.CLAVE_LAYOUT = u.CLAVE_LAYOUT AND d.NOMBRE_CAMPO = u.NOMBRE_CAMPO
      WHERE u.NOMBRE_CAMPO = '${nombre.replace(/'/g,"''")}'
      ORDER BY u.ID_REPORTE
    `);
    res.json({ ok: true, campo: nombre, data: rows });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ── GET /api/reportes/layouts ─────────────────────────────
// Lista de layouts únicos en SOFIPO_LAYOUT_DESC con conteo
router.get('/layouts', requireAuth, async (req, res) => {
  try {
    const rows = await query(`
      SELECT
        CLAVE_LAYOUT,
        EMPRESA,
        PAIS,
        COUNT(*) AS TOTAL_CAMPOS,
        SUM(CASE WHEN OBLIGATORIO = 'Si' THEN 1 ELSE 0 END) AS CAMPOS_OBLIGATORIOS
      FROM SOFIPO_LAYOUT_DESC
      GROUP BY CLAVE_LAYOUT, EMPRESA, PAIS
      ORDER BY CLAVE_LAYOUT
    `);
    res.json({ ok: true, data: rows });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

module.exports = router;
