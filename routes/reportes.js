// ════════════════════════════════════════════════════════════════════════════════
// MÓDULO: Gestión de Reportes Regulatorios y Layouts
// ════════════════════════════════════════════════════════════════════════════════
// Propósito: APIs para consultar estructura de reportes regulatorios SOFIPO
//   - Listar reportes y sus campos (SOFIPO_REPORTES)
//   - Consultar layouts y su mapeo a reportes (SOFIPO_LAYOUT_USO, SOFIPO_LAYOUT_DESC)
//   - Buscar campos por nombre o layout
// Nota: Solo lectura de metadatos de estructura; no incluye datos de reportes.

const express = require('express');
const router  = express.Router();
const { query } = require('../db/connection');

// Middleware: Requiere sesión activa
function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ ok: false, message: 'No autenticado' });
  next();
}

// ── GET /api/reportes ─────────────────────────────────────
// Lista de todos los reportes regulatorios SOFIPO con conteo de campos
// Retorna: { ok: true, data: [{ ID_REPORTE, TOTAL_CAMPOS, FECHA_CARGA }, ...] }
// Tabla: SOFIPO_REPORTES (estructura de campos por reporte)
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
// Lista todos los campos de un reporte específico con sus definiciones
// Params: :id = ID_REPORTE (ej. "R001")
// Retorna: { ok: true, id_reporte, data: [{ ORDEN, NOMBRE_CAMPO, TIPO_DATO, LONGITUD,
//            DECIMALES, FORMATO_CAPTURA, CATALOGO, LAYOUTS_QUE_USAN }, ...] }
// Tablas: SOFIPO_REPORTES (estructura), SOFIPO_LAYOUT_USO (mapeo a layouts)
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
// Obtiene qué reportes usa un layout específico y sus campos
// Params: :clave = CLAVE_LAYOUT (ej. "LAYOUT_SOFOM")
// Retorna: { ok: true, clave_layout, reportes: [{ id_reporte, campos: [...] }, ...] }
//          Agrupado por reporte para visualizar estructura
// Tablas: SOFIPO_LAYOUT_USO (vinculación layout-reporte), SOFIPO_LAYOUT_DESC (definiciones)
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

    // Agrupar resultados por reporte para estructura jerárquica
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
// Busca en qué reportes aparece un campo específico (búsqueda parcial)
// Params: :nombre = nombre o parte del nombre del campo (ej. "empresa")
// Retorna: { ok: true, campo, data: [{ ID_REPORTE, CLAVE_LAYOUT, NOMBRE_CAMPO,
//            TIPO_DATO, OBLIGATORIO, DESCRIPCION, FUENTE: "layout"|"reporte" }, ...] }
// FUENTE indica si viene de layout o estructura directa de reporte
// Tablas: SOFIPO_LAYOUT_USO + SOFIPO_LAYOUT_DESC (vía layouts)
//         SOFIPO_REPORTES (estructura directa)
router.get('/campo/:nombre', requireAuth, async (req, res) => {
  try {
    const nombre = req.params.nombre.replace(/'/g,"''");

    // Búsqueda 1: En campos vinculados a layouts (SOFIPO_LAYOUT_USO)
    const porLayout = await query(`
      SELECT DISTINCT
        u.ID_REPORTE,
        u.CLAVE_LAYOUT,
        u.COLUMNA_REPORTE,
        u.NOMBRE_CAMPO,
        d.TIPO_DATO,
        d.OBLIGATORIO,
        d.DESCRIPCION,
        'layout' AS FUENTE
      FROM SOFIPO_LAYOUT_USO u
      LEFT JOIN SOFIPO_LAYOUT_DESC d
        ON d.CLAVE_LAYOUT = u.CLAVE_LAYOUT
        AND UPPER(d.NOMBRE_CAMPO) = UPPER(u.NOMBRE_CAMPO)
      WHERE UPPER(u.NOMBRE_CAMPO) LIKE UPPER('%${nombre}%')
      ORDER BY u.ID_REPORTE
    `);

    // Búsqueda 2: En estructura directa de reportes (SOFIPO_REPORTES)
    const porReporte = await query(`
      SELECT DISTINCT
        r.ID_REPORTE,
        NULL AS CLAVE_LAYOUT,
        r.ORDEN AS COLUMNA_REPORTE,
        r.NOMBRE_CAMPO,
        r.TIPO_DATO,
        NULL AS OBLIGATORIO,
        NULL AS DESCRIPCION,
        'reporte' AS FUENTE
      FROM SOFIPO_REPORTES r
      WHERE UPPER(r.NOMBRE_CAMPO) LIKE UPPER('%${nombre}%')
      ORDER BY r.ID_REPORTE
    `);

    const data = [...porLayout, ...porReporte];
    res.json({ ok: true, campo: req.params.nombre, data });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ── GET /api/reportes/layouts ─────────────────────────────
// Lista todos los layouts disponibles con estadísticas de campos
// Retorna: { ok: true, data: [{ CLAVE_LAYOUT, EMPRESA, PAIS, TOTAL_CAMPOS,
//            CAMPOS_OBLIGATORIOS }, ...] }
// Tabla: SOFIPO_LAYOUT_DESC (definiciones de layouts)
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
