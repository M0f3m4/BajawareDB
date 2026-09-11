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
// Tablas: SOFIPO_REPORTES (estructura de campos por reporte regulatorio)
// Permisos: autenticado (requireAuth)
// Nota: FECHA_CARGA es la más antigua (MIN) por reporte
// Uso: para descubrir qué reportes existen en el sistema y cuántos campos cada uno tiene
router.get('/', requireAuth, async (req, res) => {
  try {
    // Agrupa SOFIPO_REPORTES por ID_REPORTE, contea campos y obtiene fecha carga más antigua
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
// Lista todos los campos de un reporte específico con sus definiciones técnicas
// Params: :id = ID_REPORTE (ej. "R001")
// Retorna: { ok: true, id_reporte, data: [{ ORDEN, NOMBRE_CAMPO, TIPO_DATO, LONGITUD,
//            DECIMALES, FORMATO_CAPTURA, CATALOGO, LAYOUTS_QUE_USAN }, ...] }
// Tablas: SOFIPO_REPORTES (estructura de campos), SOFIPO_LAYOUT_USO (mapeo a layouts)
// Permisos: autenticado (requireAuth)
// Nota: LAYOUTS_QUE_USAN es subconsulta que agrupa layouts usando este campo/reporte
// Uso: descubrir estructura exacta de un reporte, qué campos contiene y en qué layouts se usa
router.get('/:id/campos', requireAuth, async (req, res) => {
  try {
    const id = req.params.id;
    // Query con subconsulta: obtiene campos del reporte + lista de layouts que los usan
    const campos = await query(`
      SELECT
        r.ORDEN, r.NOMBRE_CAMPO, r.TIPO_DATO, r.LONGITUD,
        r.DECIMALES, r.FORMATO_CAPTURA, r.CATALOGO,
        -- Subconsulta: layouts que usan este campo en este reporte
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
// Obtiene qué reportes usa un layout específico y sus campos mappados
// Params: :clave = CLAVE_LAYOUT (ej. "LAYOUT_SOFOM")
// Retorna: { ok: true, clave_layout, reportes: [{ id_reporte, campos: [...] }, ...] }
//          Agrupado por reporte para visualizar estructura jerárquica
// Tablas: SOFIPO_LAYOUT_USO (vinculación layout→reporte), SOFIPO_LAYOUT_DESC (definiciones de layout)
// Permisos: autenticado (requireAuth)
// Nota: usa LEFT JOIN para incluir campos sin descripción (NULL si no existe en LAYOUT_DESC)
// Uso: ver cómo un layout específico mapea a múltiples reportes, con columnas y validaciones
router.get('/layout/:clave', requireAuth, async (req, res) => {
  try {
    const clave = req.params.clave;
    // Query: obtiene campos del layout con su mapeo a reportes y definiciones
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

    // Post-procesamiento: agrupa resultados por reporte para estructura jerárquica
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
// Búsqueda de un campo en reportes (búsqueda parcial case-insensitive)
// Params: :nombre = nombre o parte del nombre del campo (ej. "empresa", "%mpr%")
// Retorna: { ok: true, campo, data: [{ ID_REPORTE, CLAVE_LAYOUT, NOMBRE_CAMPO,
//            TIPO_DATO, OBLIGATORIO, DESCRIPCION, FUENTE: "layout"|"reporte" }, ...] }
// FUENTE indica procedencia: "layout" (SOFIPO_LAYOUT_USO) o "reporte" (SOFIPO_REPORTES directo)
// Tablas: SOFIPO_LAYOUT_USO + SOFIPO_LAYOUT_DESC (búsqueda 1)
//         SOFIPO_REPORTES (búsqueda 2)
// Permisos: autenticado (requireAuth)
// Nota: busca en ambas tablas y retorna resultados combinados DISTINCT
// Uso: descubrir dónde aparece un campo específico en la estructura de reportes
router.get('/campo/:nombre', requireAuth, async (req, res) => {
  try {
    const nombre = req.params.nombre.replace(/'/g,"''");

    // Búsqueda 1: campos vinculados a layouts (SOFIPO_LAYOUT_USO + SOFIPO_LAYOUT_DESC)
    // Busca por NOMBRE_CAMPO en layout y obtiene definiciones
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

    // Búsqueda 2: estructura directa de reportes (SOFIPO_REPORTES)
    // Busca por NOMBRE_CAMPO directo en reportes (sin layout)
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

    // Combinar resultados de ambas búsquedas
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
// Tablas: SOFIPO_LAYOUT_DESC (definiciones de layouts)
// Permisos: autenticado (requireAuth)
// Nota: agrupa por layout/empresa/país; CAMPOS_OBLIGATORIOS cuenta cuando OBLIGATORIO='Si'
// Uso: obtener lista de layouts disponibles y ver cuántos campos son obligatorios
router.get('/layouts', requireAuth, async (req, res) => {
  try {
    // Query: agrupa SOFIPO_LAYOUT_DESC por clave/empresa/país
    // Cuenta total de campos y campos obligatorios
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
