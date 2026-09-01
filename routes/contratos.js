// ──────────────────────────────────────────────────────────────────────────
// Archivo: routes/contratos.js
// Descripción: rutas Express de la API de gestión de reportes regulatorios (Bajaware).
// Responsabilidades principales:
//   1. Gestión de contratos (clientes, plataformas, reportes, validaciones)
//   2. Control de estatus de reportes y validaciones (cascada de hitos: DOC→PROG→CERT)
//   3. Carga masiva de inventarios (reportes y validaciones desde Excel)
//   4. Bitácora de auditoría (registra cambios con "antes" y "después" en JSON)
//   5. Candados y validaciones contra bugs históricos de truncamiento de versiones
// Tablas principales que toca:
//   - CONTRATOS, CLIENTE, CONTRATOS_REPORTES, CONTRATOS_VERSION_CLIENTE
//   - ESTATUS_REPORTE (identidad de negocio: CLAVE_REP|CLAVE_PLATAFORMA|VERSION_CARGA)
//   - REPORTE_VALIDACION, INVENTARIO_VALIDACIONES, INVENTARIO_VALIDACIONES_HIST
//   - INVENTARIO_REPORTES, INVENTARIO_REPORTES_HIST, INVENTARIO_VERSIONES
//   - AUDIT_LOG (bitácora de cambios)
// ──────────────────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const XLSX    = require('xlsx');
const path    = require('path');
const { query } = require('../db/connection');
const respaldos = require('../services/respaldos');

// Middleware: valida que la sesión tenga usuario autenticado, en caso contrario retorna 401.
function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ ok: false, message: 'No autenticado' });
  next();
}

// Configuración de multer: almacenamiento en memoria con límite de 20 MB para cargas de Excel.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// Helper: escapa valores SQL para prevenir inyecciones. Convierte null/vacío a NULL SQL;
// en otro caso, añade comillas simples y duplica comillas internas.
const esc = v => (v === null || v === undefined || v === '') ? 'NULL' : `'${String(v).trim().replace(/'/g,"''")}'`;

// ── GET /historial-versiones
// Descripción: devuelve historial de versiones de objetos (reportes, validaciones, etc.)
// del inventario, con filtros opcionales por tipo, clave y reporte base.
// Parámetros query: tipo (VALIDACION, REPORTE, etc.), clave (búsqueda parcial), rep (CLAVE_REP),
// limit (máximo registros, default 200).
// Tablas: INVENTARIO_VERSIONES (LEFT JOIN INVENTARIO_VALIDACIONES).
// Sin bitácora (consulta de solo lectura).
router.get('/historial-versiones', requireAuth, async (req, res) => {
  try {
    const { tipo, clave, rep, limit = 200 } = req.query;
    let where = ['iv.TIPO_OBJETO = COALESCE(' + esc(tipo||null) + ', iv.TIPO_OBJETO)'];
    if (clave) where.push(`iv.CLAVE_OBJ LIKE ${esc('%' + clave + '%')}`);
    if (rep)   where.push(`inv.CLAVE_REP = ${esc(rep)}`);
    const w = 'WHERE ' + where.join(' AND ');
    const rows = await query(`
      SELECT TOP ${parseInt(limit)}
        iv.ID_VERSION, iv.TIPO_OBJETO, iv.CLAVE_OBJ,
        inv.CLAVE_REP,
        iv.VERSION, iv.REGULACION, iv.TIPO_VERSION, iv.DESCRIPCION,
        iv.ESTATUS, iv.USUARIO, iv.FECHA_CARGA
      FROM INVENTARIO_VERSIONES iv
      LEFT JOIN INVENTARIO_VALIDACIONES inv ON inv.CLAVE_VALIDACION = iv.CLAVE_OBJ AND iv.TIPO_OBJETO = 'VALIDACION'
      ${w}
      ORDER BY iv.FECHA_CARGA DESC, iv.ID_VERSION DESC
    `);
    res.json({ ok: true, data: rows });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── POST /historial-versiones/migrar-base
// Descripción: carga inicial de versiones base (1.0.0) para todas las validaciones
// que no tienen versión aún en INVENTARIO_VERSIONES. Esta ruta se ejecuta manualmente
// para inicializar el historial de versiones.
// Tablas: INSERT en INVENTARIO_VERSIONES; lee de INVENTARIO_VALIDACIONES.
// Bitácora: registra resultado final (total de versiones creadas).
router.post('/historial-versiones/migrar-base', requireAuth, async (req, res) => {
  try {
    console.log('[migrar-base] iniciando...');
    await query(`
      INSERT INTO INVENTARIO_VERSIONES (TIPO_OBJETO, CLAVE_OBJ, VERSION, REGULACION, TIPO_VERSION, DESCRIPCION, ESTATUS, USUARIO)
      SELECT DISTINCT 'VALIDACION', iv.CLAVE_VALIDACION, '1.0.0', 'INICIAL', 'BASE', 'Version inicial', 'IDENTIFICADO', 'sistema'
      FROM INVENTARIO_VALIDACIONES iv
      WHERE NOT EXISTS (
        SELECT 1 FROM INVENTARIO_VERSIONES ivv
        WHERE ivv.CLAVE_OBJ = iv.CLAVE_VALIDACION AND ivv.TIPO_OBJETO = 'VALIDACION'
      )
    `);
    const cnt = await query(`SELECT COUNT(*) AS total FROM INVENTARIO_VERSIONES WHERE TIPO_OBJETO='VALIDACION'`);
    console.log('[migrar-base] listo:', cnt[0].total);
    res.json({ ok: true, total: cnt[0].total });
  } catch(e) {
    console.error('[migrar-base] error:', e.message);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ── Cache en memoria de claves de validaciones ──
// Optimización: REPORTE_VALIDACION tiene ~431k filas. En lugar de hacer DISTINCT
// repetidamente, se cachea en RAM con TTL de 10 minutos. Esto acelera filtros por
// reporte base que usan quitar sufijo _AÑO (ej: "ACLME_2024" → "ACLME").
let _rvClavesCache = null;
let _rvCacheTime   = 0;
const RV_TTL = 10 * 60 * 1000; // 10 minutos (tiempo de vida del cache en milisegundos).

// Helper: retorna array de CLAVE_REP únicas de REPORTE_VALIDACION.
// Si el cache es válido (< 10 min), devuelve el cache; en otro caso consulta BD y refresca.
async function getRVClaves() {
  if (_rvClavesCache && Date.now() - _rvCacheTime < RV_TTL) return _rvClavesCache;
  console.log('[cache] refrescando DISTINCT CLAVE_REP de REPORTE_VALIDACION...');
  const rows = await query(`SELECT DISTINCT CLAVE_REP FROM REPORTE_VALIDACION`);
  _rvClavesCache = rows.map(r => r.CLAVE_REP);
  _rvCacheTime   = Date.now();
  console.log(`[cache] listo: ${_rvClavesCache.length} claves distintas`);
  return _rvClavesCache;
}

// ── GET /clientes
// Descripción: lista todos los clientes activos (ACTIVO=1) ordenados por nombre.
// Tablas: CLIENTE.
// Sin bitácora (consulta de solo lectura).
router.get('/clientes', requireAuth, async (req, res) => {
  try {
    const rows = await query(`SELECT ID_CLIENTE, CLAVE_CLIENTE, NOMBRE_CLIENTE, CLAVE_PAIS, ACTIVO FROM CLIENTE WHERE ACTIVO=1 ORDER BY NOMBRE_CLIENTE`);
    res.json({ ok: true, data: rows });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── GET /clientes-con-contratos
// Descripción: devuelve solo los clientes que tienen al menos un contrato,
// evitando clientes sin uso. Útil para dropdowns en interfaces de contratación.
// Tablas: CONTRATOS (LEFT JOIN CLIENTE).
// Sin bitácora (consulta de solo lectura).
router.get('/clientes-con-contratos', requireAuth, async (req, res) => {
  try {
    const rows = await query(`
      SELECT DISTINCT c.CLAVE_CLIENTE, COALESCE(cl.NOMBRE_CLIENTE, c.CLAVE_CLIENTE) AS NOMBRE_CLIENTE
      FROM CONTRATOS c
      LEFT JOIN CLIENTE cl ON cl.CLAVE_CLIENTE = c.CLAVE_CLIENTE
      ORDER BY NOMBRE_CLIENTE
    `);
    res.json({ ok: true, data: rows });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── GET /contratos/lista
// Descripción: lista de contratos con filtros opcionales por estatus y cliente.
// Parámetros query: estatus (ACTIVO, INACTIVO, etc.), cliente (CLAVE_CLIENTE).
// Tablas: CONTRATOS (LEFT JOIN CLIENTE).
// Sin bitácora (consulta de solo lectura).
router.get('/contratos/lista', requireAuth, async (req, res) => {
  try {
    const { estatus, cliente } = req.query;
    let where = 'WHERE 1=1';
    if (estatus) where += ` AND c.ESTATUS=${esc(estatus)}`;
    if (cliente) where += ` AND c.CLAVE_CLIENTE=${esc(cliente)}`;
    const rows = await query(`
      SELECT c.CLAVE_CONTRATO, c.NOMBRE_CONTRATO, c.CLAVE_CLIENTE, c.CLAVE_PLATAFORMA,
             c.ESTATUS, c.ETAPA, cl.NOMBRE_CLIENTE
      FROM CONTRATOS c
      LEFT JOIN CLIENTE cl ON cl.CLAVE_CLIENTE = c.CLAVE_CLIENTE
      ${where}
      ORDER BY cl.NOMBRE_CLIENTE, c.NOMBRE_CONTRATO
    `);
    res.json({ ok: true, data: rows });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── PUT /contratos/:clave/estatus
// Descripción: actualiza el estatus general y la etapa (fase) de un contrato.
// Parámetros path: clave (CLAVE_CONTRATO).
// Parámetros body: estatus, etapa (fases del ciclo de vida del contrato).
// Tablas: UPDATE CONTRATOS; INSERT en AUDIT_LOG (bitácora).
// Bitácora: registra clave_contrato, estatus, etapa.
router.put('/contratos/:clave/estatus', requireAuth, async (req, res) => {
  try {
    const { estatus, etapa } = req.body;
    const usuario = req.session.user?.username || 'sistema';
    await query(`
      UPDATE CONTRATOS SET ESTATUS=${esc(estatus)}, ETAPA=${etapa != null ? parseInt(etapa) : 'NULL'}
      WHERE CLAVE_CONTRATO=${esc(req.params.clave)}
    `);
    await auditLog(usuario, 'contratos', 'ESTATUS', { clave_contrato: req.params.clave, estatus, etapa });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── GET /personalizaciones
// Descripción: obtiene personalizaciones de una combinación estatus_reporte+contrato.
// Parámetros query: estatus_reporte_id (ID_ESTATUS_REP), contrato_id (CLAVE_CONTRATO),
// tipo (opcional, filtro adicional).
// Tablas: PERSONALIZACIONES.
// Sin bitácora (consulta de solo lectura).
router.get('/personalizaciones', requireAuth, async (req, res) => {
  try {
    const { estatus_reporte_id, contrato_id } = req.query;
    if (!estatus_reporte_id || !contrato_id) return res.json({ ok: true, data: [] });
    const { tipo } = req.query;
    const tipoFilter = tipo ? `AND TIPO=${esc(tipo)}` : '';
    const rows = await query(`
      SELECT ID, ESTATUS_REPORTE_ID, CONTRATO_ID, SUBVERSION, ESTATUS, TIPO
      FROM PERSONALIZACIONES
      WHERE ESTATUS_REPORTE_ID=${parseInt(estatus_reporte_id)} AND CONTRATO_ID=${esc(contrato_id)} ${tipoFilter}
      ORDER BY ID
    `);
    res.json({ ok: true, data: rows });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── POST /personalizaciones
// Descripción: crea una personalización (configuración especial por contrato+reporte).
// Parámetros body: estatus_reporte_id, contrato_id, subversion, estatus, tipo.
// Tablas: INSERT en PERSONALIZACIONES; INSERT en AUDIT_LOG.
// Bitácora: registra los parámetros recibidos.
router.post('/personalizaciones', requireAuth, async (req, res) => {
  try {
    const { estatus_reporte_id, contrato_id, subversion, estatus, tipo } = req.body;
    const usuario = req.session.user?.username || 'sistema';
    await query(`
      INSERT INTO PERSONALIZACIONES (ESTATUS_REPORTE_ID, CONTRATO_ID, SUBVERSION, ESTATUS, TIPO)
      VALUES (${parseInt(estatus_reporte_id)}, ${esc(contrato_id)}, ${esc(subversion)}, ${esc(estatus)}, ${esc(tipo||null)})
    `);
    await auditLog(usuario, 'contratos', 'PERSONALIZACION_CREAR', { estatus_reporte_id, contrato_id, subversion, estatus });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── PUT /personalizaciones/:id
// Descripción: edita subversion y estatus de una personalización.
// Parámetros path: id (ID de PERSONALIZACIONES).
// Parámetros body: subversion, estatus.
// Tablas: UPDATE PERSONALIZACIONES; INSERT en AUDIT_LOG.
// Bitácora: registra id, subversion, estatus.
router.put('/personalizaciones/:id', requireAuth, async (req, res) => {
  try {
    const { subversion, estatus } = req.body;
    const usuario = req.session.user?.username || 'sistema';
    await query(`UPDATE PERSONALIZACIONES SET SUBVERSION=${esc(subversion)}, ESTATUS=${esc(estatus)} WHERE ID=${parseInt(req.params.id)}`);
    await auditLog(usuario, 'contratos', 'PERSONALIZACION_EDITAR', { id: req.params.id, subversion, estatus });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── DELETE /personalizaciones/:id
// Descripción: borra una personalización.
// Parámetros path: id (ID de PERSONALIZACIONES).
// Tablas: DELETE en PERSONALIZACIONES; INSERT en AUDIT_LOG.
// Bitácora: registra id borrado.
router.delete('/personalizaciones/:id', requireAuth, async (req, res) => {
  try {
    const usuario = req.session.user?.username || 'sistema';
    await query(`DELETE FROM PERSONALIZACIONES WHERE ID=${parseInt(req.params.id)}`);
    await auditLog(usuario, 'contratos', 'PERSONALIZACION_BORRAR', { id: req.params.id });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── PUT /contratos/:contrato/reporte/:rep/estatus
// Descripción: actualiza el estatus del proyecto (ESTATUS_PROYECTO) para una
// combinación de contrato+reporte. Usa UPSERT (insert o update según exista).
// Parámetros path: contrato (CLAVE_CONTRATO), rep (no se usa en esta versión).
// Parámetros body: estatus, id_estatus_rep (ID_ESTATUS_REP).
// Tablas: CONTRATOS_VERSION_CLIENTE (UPSERT); INSERT en AUDIT_LOG.
// Bitácora: registra clave_contrato, id_estatus_rep, estatus.
router.put('/contratos/:contrato/reporte/:rep/estatus', requireAuth, async (req, res) => {
  try {
    const { estatus, id_estatus_rep } = req.body;
    const usuario = req.session.user?.username || 'sistema';
    if (id_estatus_rep) {
      const id = parseInt(id_estatus_rep);
      const existe = await query(`SELECT 1 FROM CONTRATOS_VERSION_CLIENTE WHERE CLAVE_CONTRATO=${esc(req.params.contrato)} AND ID_ESTATUS_REP=${id}`);
      if (existe.length) {
        await query(`UPDATE CONTRATOS_VERSION_CLIENTE SET ESTATUS_PROYECTO=${esc(estatus)} WHERE CLAVE_CONTRATO=${esc(req.params.contrato)} AND ID_ESTATUS_REP=${id}`);
      } else {
        await query(`INSERT INTO CONTRATOS_VERSION_CLIENTE (CLAVE_CONTRATO, ID_ESTATUS_REP, ESTATUS_PROYECTO) VALUES (${esc(req.params.contrato)}, ${id}, ${esc(estatus)})`);
      }
    }
    await auditLog(usuario, 'contratos', 'ESTATUS_PROYECTO', { clave_contrato: req.params.contrato, id_estatus_rep, estatus });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── GET /contratos/:clave/validacion-estatus
// Descripción: obtiene mapa de estatus de proyecto de validaciones
// (ESTATUS_PROYECTO) para un contrato, agrupado por clave_validacion|clave_plataforma.
// Parámetros path: clave (CLAVE_CONTRATO).
// Parámetros query: clave_validacion, clave_plataforma, version_carga (filtros opcionales).
// Tablas: CONTRATOS_VALIDACION_ESTATUS.
// Sin bitácora (consulta de solo lectura).
router.get('/contratos/:clave/validacion-estatus', requireAuth, async (req, res) => {
  try {
    const { clave_validacion, clave_plataforma, version_carga } = req.query;
    let where = `WHERE CLAVE_CONTRATO=${esc(req.params.clave)}`;
    if (clave_validacion) where += ` AND CLAVE_VALIDACION=${esc(clave_validacion)}`;
    if (clave_plataforma) where += ` AND CLAVE_PLATAFORMA=${esc(clave_plataforma)}`;
    if (version_carga) where += ` AND VERSION_CARGA=${esc(version_carga)}`;
    const rows = await query(`SELECT CLAVE_VALIDACION, CLAVE_PLATAFORMA, VERSION_CARGA, ESTATUS_PROYECTO FROM CONTRATOS_VALIDACION_ESTATUS ${where}`);
    const mapa = {};
    rows.forEach(r => { mapa[`${r.CLAVE_VALIDACION}|${r.CLAVE_PLATAFORMA}`] = r.ESTATUS_PROYECTO; });
    res.json({ ok: true, data: mapa });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── PUT /contratos/:clave/validacion-estatus
// Descripción: actualiza el estatus del proyecto para una validación específica
// dentro de un contrato (UPSERT: inserta si no existe, actualiza si existe).
// Parámetros path: clave (CLAVE_CONTRATO).
// Parámetros body: clave_validacion, clave_plataforma, version_carga, estatus_proyecto.
// Tablas: CONTRATOS_VALIDACION_ESTATUS; INSERT en AUDIT_LOG.
// Bitácora: registra todos los parámetros + acción (ESTATUS_PROYECTO_VAL).
router.put('/contratos/:clave/validacion-estatus', requireAuth, async (req, res) => {
  try {
    const { clave_validacion, clave_plataforma, version_carga, estatus_proyecto } = req.body;
    const usuario = req.session.user?.username || 'sistema';
    const existe = await query(`SELECT 1 FROM CONTRATOS_VALIDACION_ESTATUS WHERE CLAVE_CONTRATO=${esc(req.params.clave)} AND CLAVE_VALIDACION=${esc(clave_validacion)} AND CLAVE_PLATAFORMA=${esc(clave_plataforma)} AND VERSION_CARGA=${esc(version_carga)}`);
    if (existe.length) {
      await query(`UPDATE CONTRATOS_VALIDACION_ESTATUS SET ESTATUS_PROYECTO=${esc(estatus_proyecto)} WHERE CLAVE_CONTRATO=${esc(req.params.clave)} AND CLAVE_VALIDACION=${esc(clave_validacion)} AND CLAVE_PLATAFORMA=${esc(clave_plataforma)} AND VERSION_CARGA=${esc(version_carga)}`);
    } else {
      await query(`INSERT INTO CONTRATOS_VALIDACION_ESTATUS (CLAVE_CONTRATO,CLAVE_VALIDACION,CLAVE_PLATAFORMA,VERSION_CARGA,ESTATUS_PROYECTO) VALUES (${esc(req.params.clave)},${esc(clave_validacion)},${esc(clave_plataforma)},${esc(version_carga)},${esc(estatus_proyecto)})`);
    }
    await auditLog(usuario, 'contratos', 'ESTATUS_PROYECTO_VAL', { clave_contrato: req.params.clave, clave_validacion, clave_plataforma, version_carga, estatus_proyecto });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── GET /contratos/:clave/validacion-cliente
// Descripción: obtiene la VERSION_CARGA de validaciones marcadas como "del cliente"
// para un contrato y reporte base.
// Parámetros path: clave (CLAVE_CONTRATO).
// Parámetros query: clave_rep (CLAVE_REP base del reporte).
// Tablas: CONTRATOS_VALIDACION_CLIENTE.
// Sin bitácora (consulta de solo lectura).
router.get('/contratos/:clave/validacion-cliente', requireAuth, async (req, res) => {
  try {
    const { clave_rep } = req.query;
    if (!clave_rep) return res.json({ ok: true, data: null });
    const rows = await query(`
      SELECT VERSION_CARGA FROM CONTRATOS_VALIDACION_CLIENTE
      WHERE CLAVE_CONTRATO=${esc(req.params.clave)} AND CLAVE_REP=${esc(clave_rep)}
    `);
    res.json({ ok: true, data: rows.length ? rows[0].VERSION_CARGA : null });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── PUT /contratos/:clave/validacion-cliente
// Descripción: marca o desmarca una versión de validaciones como "del cliente"
// (UPSERT si version_carga viene, DELETE si no viene).
// Parámetros path: clave (CLAVE_CONTRATO).
// Parámetros body: clave_rep (CLAVE_REP), version_carga (VERSION_CARGA o null para desmarcar).
// Tablas: CONTRATOS_VALIDACION_CLIENTE (UPSERT o DELETE); INSERT en AUDIT_LOG.
// Bitácora: registra clave_contrato, clave_rep, version_carga.
router.put('/contratos/:clave/validacion-cliente', requireAuth, async (req, res) => {
  try {
    const { clave_rep, version_carga } = req.body;
    const usuario = req.session.user?.username || 'sistema';
    if (version_carga) {
      const existe = await query(`SELECT 1 FROM CONTRATOS_VALIDACION_CLIENTE WHERE CLAVE_CONTRATO=${esc(req.params.clave)} AND CLAVE_REP=${esc(clave_rep)}`);
      if (existe.length) {
        await query(`UPDATE CONTRATOS_VALIDACION_CLIENTE SET VERSION_CARGA=${esc(version_carga)} WHERE CLAVE_CONTRATO=${esc(req.params.clave)} AND CLAVE_REP=${esc(clave_rep)}`);
      } else {
        await query(`INSERT INTO CONTRATOS_VALIDACION_CLIENTE (CLAVE_CONTRATO, CLAVE_REP, VERSION_CARGA) VALUES (${esc(req.params.clave)}, ${esc(clave_rep)}, ${esc(version_carga)})`);
      }
    } else {
      await query(`DELETE FROM CONTRATOS_VALIDACION_CLIENTE WHERE CLAVE_CONTRATO=${esc(req.params.clave)} AND CLAVE_REP=${esc(clave_rep)}`);
    }
    await auditLog(usuario, 'contratos', 'VERSION_VALIDACION_CLIENTE', { clave_contrato: req.params.clave, clave_rep, version_carga });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── GET /clientes/:clave/contratos
// Descripción: lista de contratos asociados a un cliente.
// Parámetros path: clave (CLAVE_CLIENTE).
// Tablas: CONTRATOS.
// Sin bitácora (consulta de solo lectura).
router.get('/clientes/:clave/contratos', requireAuth, async (req, res) => {
  try {
    const rows = await query(`
      SELECT ID_CONTRATO, CLAVE_CONTRATO, NOMBRE_CONTRATO, CLAVE_PLATAFORMA, FECHA_ALTA
      FROM CONTRATOS WHERE CLAVE_CLIENTE=${esc(req.params.clave)} ORDER BY NOMBRE_CONTRATO
    `);
    res.json({ ok: true, data: rows });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── GET /contratos/:clave/reportes
// Descripción: lista de reportes (CLAVE_REP) asignados a un contrato, con sus
// estatus y hitos (DOCUMENTADO/PROGRAMADO/CERTIFICADO) de ESTATUS_REPORTE.
// Parámetros path: clave (CLAVE_CONTRATO).
// Parámetros query: version_cliente (opcional: filtrar por VERSION_CLIENTE 0 o 1).
// Tablas: CONTRATOS_REPORTES, ESTATUS_REPORTE, INVENTARIO_REPORTES (LEFT JOIN),
//         CONTRATOS_VERSION_CLIENTE (LEFT JOIN).
// Validaciones: si version_cliente='1' solo reportes con VERSION_CLIENTE=1;
//               si version_cliente='0' solo sin VERSION_CLIENTE.
// Sin bitácora (consulta de solo lectura).
router.get('/contratos/:clave/reportes', requireAuth, async (req, res) => {
  try {
    const { version_cliente } = req.query;
    let vkFilter = '';
    if (version_cliente === '1') vkFilter = ` AND EXISTS (SELECT 1 FROM CONTRATOS_VERSION_CLIENTE WHERE CLAVE_CONTRATO=${esc(req.params.clave)} AND ID_ESTATUS_REP=er.ID_ESTATUS_REP AND VERSION_CLIENTE=1)`;
    if (version_cliente === '0') vkFilter = ` AND NOT EXISTS (SELECT 1 FROM CONTRATOS_VERSION_CLIENTE WHERE CLAVE_CONTRATO=${esc(req.params.clave)} AND ID_ESTATUS_REP=er.ID_ESTATUS_REP AND VERSION_CLIENTE=1)`;

    const rows = await query(`
      SELECT
        cr.CLAVE_REP AS CLAVE_REP_BASE,
        er.CLAVE_REP,
        cr.ETAPA,
        cvc.ESTATUS_PROYECTO,
        ir.DESCRIPCION_ESP,
        ir.CLAVE_ENTIDADREGULADA,
        COALESCE(ir.REPORTE, er.CLAVE_REP) AS REPORTE,
        er.ID_ESTATUS_REP,
        er.DOCUMENTADO,
        er.DOC_FECHA_REAL,
        er.PROGRAMADO,
        er.PROG_FECHA_REAL,
        er.CERTIFICADO,
        er.CERT_FECHA_REAL,
        er.ESTATUS,
        er.USER_DOC, er.USER_PROG, er.USER_CERT,
        er.USER_ESTATUS, er.FECHA_ESTATUS,
        er.CLAVE_PLATAFORMA,
        er.VERSION,
        COALESCE(er.VERSION_CARGA, ir.VERSION_CARGA) AS VERSION_CARGA,
        ISNULL(cvc.VERSION_CLIENTE, 0) AS VERSION_CLIENTE
      FROM CONTRATOS_REPORTES cr
      INNER JOIN CONTRATOS c ON c.CLAVE_CONTRATO = cr.CLAVE_CONTRATO
      INNER JOIN ESTATUS_REPORTE er ON er.CLAVE_REP_GENERAL = cr.CLAVE_REP
                                   AND er.CLAVE_PLATAFORMA = c.CLAVE_PLATAFORMA
      LEFT JOIN INVENTARIO_REPORTES ir ON ir.CLAVE_REP = er.CLAVE_REP
      LEFT JOIN CONTRATOS_VERSION_CLIENTE cvc ON cvc.ID_ESTATUS_REP = er.ID_ESTATUS_REP
                                              AND cvc.CLAVE_CONTRATO = cr.CLAVE_CONTRATO
      WHERE cr.CLAVE_CONTRATO=${esc(req.params.clave)}${vkFilter}
      ORDER BY er.CLAVE_REP, er.CLAVE_PLATAFORMA
    `);
    res.json({ ok: true, data: rows });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── GET /contratos/:clave/validaciones
// Descripción: lista de validaciones de un contrato, deducidas de los reportes
// asignados al contrato. Usa cache en memoria para optimizar búsqueda en 431k filas.
// Lógica: (1) Obtiene CLAVE_REP base del contrato; (2) consulta cache de REPORTE_VALIDACION
// para CLAVE_REP exactas O con sufijo _AÑO (ej: "ACLME_2024" → "ACLME"); (3) devuelve
// validaciones que coinciden con esos reportes base.
// Parámetros path: clave (CLAVE_CONTRATO).
// Tablas: CONTRATOS_REPORTES, cache de REPORTE_VALIDACION.
// Sin bitácora (consulta de solo lectura).
// Paso 1: obtener CLAVE_REP base del contrato.
router.get('/contratos/:clave/validaciones', requireAuth, async (req, res) => {
  try {
    const claves = await query(`
      SELECT DISTINCT CLAVE_REP FROM CONTRATOS_REPORTES
      WHERE CLAVE_CONTRATO=${esc(req.params.clave)}
    `);
    if (!claves.length) return res.json({ ok: true, data: [] });

    // Paso 2: obtener todos los CLAVE_REP distintos de REPORTE_VALIDACION (cache en memoria).
    // Evita scan lento de 431k filas cada vez.
    const todosRV = await getRVClaves();

    // Paso 3: filtrar en JS cuáles CLAVE_REP de validaciones corresponden a los
    // reportes base del contrato. Soporta sufijo _AÑO: si la base es "ACLME",
    // también cuenta "ACLME_2024" porque quita el sufijo (_2024) y compara el prefijo.
    const baseSet = new Set(claves.map(r => r.CLAVE_REP));
    const matched = todosRV.filter(c => {
        if (baseSet.has(c)) return true;          // coincidencia exacta
        const i = c.lastIndexOf('_');
        return i > 0 && baseSet.has(c.slice(0, i)); // quitar sufijo _AÑO
      });

    if (!matched.length) return res.json({ ok: true, data: [] });

    // Paso 4: construir lista IN con los claves exactos y consultar validaciones.
    // Rápido porque es IN directo, aunque no haya índice full-text.
    const inList = matched.map(c => `'${c.replace(/'/g, "''")}'`).join(',');
    const rows = await query(`
      SELECT
        rv.CLAVE_VALIDACION, rv.CLAVE_REP, rv.TIPO_VALIDACION, rv.DESCRIPCION,
        rv.DOCUMENTADO, rv.DOC_FECHA_REAL, rv.PROGRAMADO, rv.PROG_FECHA_REAL,
        rv.CERTIFICADO, rv.CERT_FECHA_REAL, rv.ESTATUS, rv.CLAVE_PLATAFORMA, rv.VERSION, rv.VERSION_CARGA
      FROM REPORTE_VALIDACION rv
      WHERE rv.CLAVE_REP IN (${inList})
      ORDER BY rv.CLAVE_REP, rv.CLAVE_VALIDACION
    `);
    res.json({ ok: true, data: rows });
  } catch(e) {
    console.error('[validaciones]', e.message);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ── GET /clientes/:clave/reportes
// Descripción: lista de reportes base (CLAVE_REP) contratados por un cliente.
// Parámetros path: clave (CLAVE_CLIENTE).
// Tablas: CONTRATOS_REPORTES, CONTRATOS.
// Sin bitácora (consulta de solo lectura).
router.get('/clientes/:clave/reportes', requireAuth, async (req, res) => {
  try {
    const rows = await query(`
      SELECT DISTINCT cr.CLAVE_REP
      FROM CONTRATOS_REPORTES cr
      INNER JOIN CONTRATOS con ON con.CLAVE_CONTRATO = cr.CLAVE_CONTRATO
      WHERE con.CLAVE_CLIENTE=${esc(req.params.clave)}
      ORDER BY cr.CLAVE_REP
    `);
    res.json({ ok: true, data: rows.map(r => r.CLAVE_REP) });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── GET /clientes/:clave/validaciones
// Descripción: lista de validaciones de un cliente, con filtros opcionales
// por reporte base y versión de carga. Incluye nombre único para UI (cliente_validacion).
// Parámetros path: clave (CLAVE_CLIENTE o 'todos' para todos los clientes).
// Parámetros query: rep (CLAVE_REP base, recomendado para rapidez),
//                   version_carga (filtro adicional por versión).
// Tablas: CLIENTE, CONTRATOS, REPORTE_VALIDACION, INVENTARIO_VALIDACIONES (LEFT JOIN).
// Cache: usa getRVClaves() para optimizar búsqueda de reportes con sufijo _AÑO.
// Sin bitácora (consulta de solo lectura).
// Lógica de ejecución:
//   1. Si viene ?rep: consulta ese reporte exacto (rápido).
//   2. Si no: obtiene todos los reportes del cliente (más lento si hay muchos).
//   3. En ambos casos, aplica filtro de plataformas contratadas y versión_carga.
router.get('/clientes/:clave/validaciones', requireAuth, async (req, res) => {
  try {
    const claveCliente = req.params.clave;
    const repFiltro       = req.query.rep || null; // CLAVE_REP base (opcional, mejora rendimiento).
    const versionCargaFiltro = req.query.version_carga || null; // filtro adicional por VERSION_CARGA.
    const esTodos = claveCliente === 'todos';  // verdadero si es búsqueda global sin cliente.

    // Obtener nombre del cliente y plataformas que ha contratado (para filtro en validaciones).
    let nombreCliente = '';
    let platFilter = ''; // Filtro SQL: AND rv.CLAVE_PLATAFORMA IN (...)
    if (!esTodos) {  // Si no es búsqueda global, obtener datos específicos del cliente.
      const [cli] = await query(`SELECT NOMBRE_CLIENTE FROM CLIENTE WHERE CLAVE_CLIENTE=${esc(claveCliente)}`);
      if (!cli) return res.json({ ok: true, data: [], cliente: '' });
      nombreCliente = cli.NOMBRE_CLIENTE;

      // Plataformas contratadas por este cliente
      const plats = await query(`
        SELECT DISTINCT CLAVE_PLATAFORMA FROM CONTRATOS
        WHERE CLAVE_CLIENTE=${esc(claveCliente)} AND CLAVE_PLATAFORMA IS NOT NULL
      `);
      if (plats.length) {
        const platList = plats.map(p => esc(p.CLAVE_PLATAFORMA)).join(',');
        platFilter = `AND rv.CLAVE_PLATAFORMA IN (${platList})`;
      }
    }

    // Rama 1: si viene ?rep (filtro por reporte base), consultar solo ese reporte.
    // Ventaja: rápido, evita IN gigante. Desventaja: usuario debe saber la clave.
    let rows;
    if (repFiltro) {
      const base = repFiltro.replace(/'/g, "''");
      const todosRV = await getRVClaves();
      // Buscar CLAVE_REP exactas Y con sufijo _AÑO (ej: "ACLME" y "ACLME_2024").
      const matched = todosRV.filter(c =>
        c === base || (c.lastIndexOf('_') > 0 && c.slice(0, c.lastIndexOf('_')) === base)
      );
      if (!matched.length) return res.json({ ok: true, data: [], cliente: nombreCliente });
      const inList = matched.map(c => `'${c.replace(/'/g, "''")}'`).join(',');
      rows = await query(`
        SELECT rv.CLAVE_VALIDACION, rv.CLAVE_REP, rv.TIPO_VALIDACION, rv.DESCRIPCION,
               rv.DOCUMENTADO, rv.DOC_FECHA_REAL, rv.USER_DOC,
               rv.PROGRAMADO, rv.PROG_FECHA_REAL, rv.USER_PROG,
               rv.CERTIFICADO, rv.CERT_FECHA_REAL, rv.USER_CERT,
               rv.ESTATUS, rv.USER_ESTATUS, rv.FECHA_ESTATUS,
               rv.CLAVE_PLATAFORMA, rv.VERSION, rv.VERSION_CARGA
        FROM REPORTE_VALIDACION rv
        WHERE rv.CLAVE_REP IN (${inList})
        ${platFilter}
        ${versionCargaFiltro ? `AND rv.VERSION_CARGA=${esc(versionCargaFiltro)}` : ''}
        ORDER BY rv.CLAVE_REP, rv.CLAVE_VALIDACION
      `);
    } else {
      // Rama 2: sin ?rep. Obtener todos los reportes del cliente o globales (más lento si hay muchos).
      const clavesBQ = esTodos  // Si es búsqueda global, traer todos los reportes; si no, solo los del cliente.
        ? await query(`SELECT DISTINCT CLAVE_REP FROM CONTRATOS_REPORTES`)
        : await query(`
            SELECT DISTINCT cr.CLAVE_REP
            FROM CONTRATOS_REPORTES cr
            INNER JOIN CONTRATOS con ON con.CLAVE_CONTRATO = cr.CLAVE_CONTRATO
            WHERE con.CLAVE_CLIENTE=${esc(claveCliente)}
          `);

      if (!clavesBQ.length) return res.json({ ok: true, data: [], cliente: nombreCliente });

      const todosRV = await getRVClaves();
      const baseSet = new Set(clavesBQ.map(r => r.CLAVE_REP));
      const matched = todosRV.filter(c => {
        if (baseSet.has(c)) return true;
        const i = c.lastIndexOf('_');
        return i > 0 && baseSet.has(c.slice(0, i));
      });

      if (!matched.length) return res.json({ ok: true, data: [], cliente: nombreCliente });

      const inList = matched.map(c => `'${c.replace(/'/g, "''")}'`).join(',');
      rows = await query(`
        SELECT rv.CLAVE_VALIDACION, rv.CLAVE_REP, rv.TIPO_VALIDACION, rv.DESCRIPCION,
               rv.DOCUMENTADO, rv.DOC_FECHA_REAL, rv.USER_DOC,
               rv.PROGRAMADO, rv.PROG_FECHA_REAL, rv.USER_PROG,
               rv.CERTIFICADO, rv.CERT_FECHA_REAL, rv.USER_CERT,
               rv.ESTATUS, rv.USER_ESTATUS, rv.FECHA_ESTATUS,
               rv.CLAVE_PLATAFORMA, rv.VERSION, rv.VERSION_CARGA
        FROM REPORTE_VALIDACION rv
        WHERE rv.CLAVE_REP IN (${inList})
        ${platFilter}
        ${versionCargaFiltro ? `AND rv.VERSION_CARGA=${esc(versionCargaFiltro)}` : ''}
        ORDER BY rv.CLAVE_REP, rv.CLAVE_VALIDACION
      `);
    }

    // Formatear resultado: agregar CLAVE_UNICA (nombre único para UI).
    // Si es búsqueda global (esTodos), usa solo CLAVE_VALIDACION;
    // si es cliente específico, prefija cliente + validación para evitar colisiones.
    const data = rows.map(r => ({
      ...r,
      CLAVE_UNICA: esTodos ? r.CLAVE_VALIDACION : `${nombreCliente}_${r.CLAVE_VALIDACION}`
    }));

    res.json({ ok: true, data, cliente: nombreCliente });
  } catch(e) {
    console.error('[validaciones-cliente]', e.message);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ── GET /estatus-reporte/versiones
// Descripción: lista de versiones de carga (VERSION_CARGA) para un reporte,
// usada en dropdowns para seleccionar qué versión actualizar.
// Parámetros query: clave_rep (CLAVE_REP, requerido), clave_plataforma (opcional).
// Tablas: INVENTARIO_REPORTES_HIST, ESTATUS_REPORTE, INVENTARIO_REPORTES (UNION).
// Lógica: combina versiones de tres tablas para cobertura completa.
// Sin bitácora (consulta de solo lectura).
router.get('/estatus-reporte/versiones', requireAuth, async (req, res) => {
  try {
    const clave = (req.query.clave_rep || '').trim();
    const plataforma = (req.query.clave_plataforma || '').trim();
    if (!clave) return res.json({ ok: true, data: [] });
    // Con plataforma: versiones de ESTATUS_REPORTE para ese (rep, plataforma)
    // Sin plataforma: versiones de INVENTARIO_REPORTES_HIST para el reporte
    // Combinar versiones de hist + estatus_reporte + inventario (con LIKE para cubrir sufijos de año)
    const clavePattern = `${clave.replace(/'/g, "''")}%`;
    const rows = await query(`
      SELECT DISTINCT VERSION_CARGA FROM (
        SELECT VERSION_CARGA FROM INVENTARIO_REPORTES_HIST
        WHERE CLAVE_REP LIKE '${clavePattern}' AND VERSION_CARGA IS NOT NULL
        UNION
        SELECT VERSION_CARGA FROM ESTATUS_REPORTE
        WHERE CLAVE_REP LIKE '${clavePattern}' AND VERSION_CARGA IS NOT NULL
        UNION
        SELECT VERSION_CARGA FROM INVENTARIO_REPORTES
        WHERE CLAVE_REP LIKE '${clavePattern}' AND VERSION_CARGA IS NOT NULL
      ) t
      ORDER BY VERSION_CARGA DESC
    `);
    res.json({ ok: true, data: rows.map(r => r.VERSION_CARGA) });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── GET /estatus-reporte/buscar-serie
// Descripción: búsqueda por serie/texto (ej. "ACLME") en ESTATUS_REPORTE,
// devolviendo todas las combinaciones reporte+plataforma+versión que coincidan.
// Útil para marcar/desmarcar en bulk todos los reportes de una serie regulatoria.
// Parámetros query: q (texto de búsqueda, mín 2 caracteres).
// Tablas: ESTATUS_REPORTE, INVENTARIO_REPORTES (LEFT JOIN OUTER APPLY).
// Búsqueda: LIKE en CLAVE_REP, CLAVE_REP_GENERAL, DESCRIPCION_ESP.
// Límite: TOP 300 resultados.
// Sin bitácora (consulta de solo lectura).
router.get('/estatus-reporte/buscar-serie', requireAuth, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (q.length < 2) return res.json({ ok: true, data: [] });
    const pat = `%${q.replace(/'/g, "''")}%`;
    const rows = await query(`
      SELECT TOP 300
        er.ID_ESTATUS_REP, er.CLAVE_REP, er.CLAVE_PLATAFORMA,
        er.VERSION_CARGA, er.ESTATUS,
        ir.DESCRIPCION_ESP
      FROM ESTATUS_REPORTE er
      OUTER APPLY (
        SELECT TOP 1 DESCRIPCION_ESP FROM INVENTARIO_REPORTES i
        WHERE i.CLAVE_REP = er.CLAVE_REP OR i.CLAVE_REP = er.CLAVE_REP_GENERAL
      ) ir
      WHERE er.CLAVE_REP LIKE '${pat}'
         OR er.CLAVE_REP_GENERAL LIKE '${pat}'
         OR ir.DESCRIPCION_ESP LIKE '${pat}'
      ORDER BY er.CLAVE_REP, er.CLAVE_PLATAFORMA, er.VERSION_CARGA DESC
    `);
    res.json({ ok: true, data: rows });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── GET /estatus-validacion/versiones
// Descripción: lista de versiones de carga (VERSION_CARGA) para validaciones
// de un reporte base.
// Parámetros query: clave_rep (CLAVE_REP, requerido).
// Tablas: REPORTE_VALIDACION (con sufijo _AÑO soportado).
// Lógica: obtiene CLAVE_REP exactas y con sufijo _AÑO (ej: "ACLME_2024" si busca "ACLME").
// Sin bitácora (consulta de solo lectura).
router.get('/estatus-validacion/versiones', requireAuth, async (req, res) => {
  try {
    const clave = (req.query.clave_rep || '').trim();
    if (!clave) return res.json({ ok: true, data: [] });
    const todosRV = await getRVClaves();
    const matched = todosRV.filter(c =>
      c === clave || (c.lastIndexOf('_') > 0 && c.slice(0, c.lastIndexOf('_')) === clave)
    );
    if (!matched.length) return res.json({ ok: true, data: [] });
    const inList = matched.map(c => `'${c.replace(/'/g, "''")}'`).join(',');
    const rows = await query(`
      SELECT DISTINCT VERSION_CARGA
      FROM REPORTE_VALIDACION
      WHERE CLAVE_REP IN (${inList}) AND VERSION_CARGA IS NOT NULL
      ORDER BY VERSION_CARGA DESC
    `);
    res.json({ ok: true, data: rows.map(r => r.VERSION_CARGA) });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── GET /estatus-reporte/:clave
// Descripción: obtiene todos los registros de ESTATUS_REPORTE para una CLAVE_REP.
// Parámetros path: clave (CLAVE_REP).
// Tablas: ESTATUS_REPORTE.
// Sin bitácora (consulta de solo lectura).
router.get('/estatus-reporte/:clave', requireAuth, async (req, res) => {
  try {
    const rows = await query(`
      SELECT * FROM ESTATUS_REPORTE WHERE CLAVE_REP=${esc(req.params.clave)}
    `);
    res.json({ ok: true, data: rows });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── Helper: auditLog(usuario, seccion, accion, detalle)
// Propósito: registra cambios en la tabla AUDIT_LOG para trazabilidad.
// Parámetros:
//   - usuario: nombre de usuario que hace el cambio.
//   - seccion: área/módulo (ej: 'estatus-reporte', 'contratos', 'inventario-reportes').
//   - accion: tipo de cambio (ej: 'MARCAR', 'DESMARCAR', 'UPLOAD', 'ESTATUS').
//   - detalle: objeto JS con datos del cambio (se convierte a JSON).
// Nota: los cambios críticos incluyen 'antes' y 'despues' para auditoría completa.
// Excepción: si AUDIT_LOG falla, no bloquea el flujo (silencio, pero registra en console).
async function auditLog(usuario, seccion, accion, detalle) {
  try {
    const det = typeof detalle === 'object' ? JSON.stringify(detalle) : String(detalle);
    await query(`
      INSERT INTO AUDIT_LOG (USUARIO, SECCION, ACCION, DETALLE)
      VALUES (${esc(usuario)}, ${esc(seccion)}, ${esc(accion)}, ${esc(det)})
    `);
  } catch(e) { /* no bloquear el flujo principal si audit falla */ }
}

// ── GET /reporte/:clave/clientes
// Descripción: lista de clientes que tienen contratado un reporte específico.
// Parámetros path: clave (CLAVE_REP base del reporte).
// Tablas: CONTRATOS_REPORTES, CONTRATOS, CLIENTE.
// Sin bitácora (consulta de solo lectura).
router.get('/reporte/:clave/clientes', requireAuth, async (req, res) => {
  try {
    const rows = await query(`
      SELECT
        cli.CLAVE_CLIENTE,
        cli.NOMBRE_CLIENTE,
        con.CLAVE_CONTRATO,
        con.NOMBRE_CONTRATO,
        con.CLAVE_PLATAFORMA,
        cr.ETAPA,
        cr.EN_USO
      FROM CONTRATOS_REPORTES cr
      INNER JOIN CONTRATOS con ON con.CLAVE_CONTRATO = cr.CLAVE_CONTRATO
      INNER JOIN CLIENTE cli   ON cli.CLAVE_CLIENTE  = con.CLAVE_CLIENTE
      WHERE cr.CLAVE_REP = ${esc(req.params.clave)}
      ORDER BY cli.NOMBRE_CLIENTE, con.NOMBRE_CONTRATO
    `);
    res.json({ ok: true, data: rows, total: rows.length });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── GET /reportes/search
// Descripción: autocompletar CLAVE_REP de reportes asignados a contratos.
// Parámetros query: q (texto de búsqueda).
// Tablas: CONTRATOS_REPORTES, INVENTARIO_REPORTES (LEFT JOIN).
// Límite: TOP 20 resultados.
// Sin bitácora (consulta de solo lectura).
router.get('/reportes/search', requireAuth, async (req, res) => {
  try {
    const q = (req.query.q || '').replace(/'/g, "''");
    const rows = await query(`
      SELECT DISTINCT TOP 20 cr.CLAVE_REP, ir.DESCRIPCION_ESP
      FROM CONTRATOS_REPORTES cr
      LEFT JOIN INVENTARIO_REPORTES ir ON ir.CLAVE_REP_GENERAL = cr.CLAVE_REP
      WHERE cr.CLAVE_REP LIKE '%${q}%'
      ORDER BY cr.CLAVE_REP
    `);
    res.json({ ok: true, data: rows });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── GET /bitacora
// Descripción: lista de cambios registrados en AUDIT_LOG con filtros opcionales.
// Parámetros query: usuario, seccion, desde (fecha inicio), hasta (fecha fin),
//                   limit (máximo registros, default 100).
// Tablas: AUDIT_LOG.
// Respuesta incluye: registros + lista de usuarios únicos (para filtros dinámicos).
// Sin bitácora (consulta de solo lectura, aunque lee la bitácora).
router.get('/bitacora', requireAuth, async (req, res) => {
  try {
    const { usuario, seccion, desde, hasta, limit = 100 } = req.query;
    let where = [];
    if (usuario) where.push(`USUARIO = ${esc(usuario)}`);
    if (seccion) where.push(`SECCION = ${esc(seccion)}`);
    if (desde)   where.push(`FECHA >= ${esc(desde)}`);
    if (hasta)   where.push(`FECHA <= ${esc(hasta)} + ' 23:59:59'`);
    const whereStr = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const rows = await query(`
      SELECT TOP ${parseInt(limit) || 100}
        ID_AUDIT, USUARIO, SECCION, ACCION, DETALLE,
        CONVERT(VARCHAR(19), FECHA, 120) AS FECHA
      FROM AUDIT_LOG
      ${whereStr}
      ORDER BY FECHA DESC
    `);
    // Usuarios únicos para el filtro
    const usuarios = await query(`SELECT DISTINCT USUARIO FROM AUDIT_LOG ORDER BY USUARIO`);
    res.json({ ok: true, data: rows, usuarios: usuarios.map(r => r.USUARIO) });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── PUT /estatus-reporte
// Descripción: actualiza los hitos (DOCUMENTADO/PROGRAMADO/CERTIFICADO) de un reporte,
// con cascada automática (marcar CERTIFICADO = marcar DOC+PROG+CERT;
// desmarcar DOC = desmarcar los 3). Implementa dos candados contra bugs históricos:
//   1. Candado 404: si viene ID y el registro ya no existe, retorna error en lugar de silencio.
//   2. Candado 409: si actualiza por clave+plataforma sin versión y hay varias versiones,
//      pide confirmación (confirmar_todas:true) para evitar planchar versiones históricas.
// Parámetros body:
//   - clave_rep, clave_plataforma: identifican el reporte.
//   - etapa: 'DOCUMENTADO'|'PROGRAMADO'|'CERTIFICADO' (hito a marcar/desmarcar).
//   - desmarcar: true para desmarcar (en lugar de marcar).
//   - version: VERSION_CARGA para actualizar solo esa versión (recomendado).
//   - id_estatus_rep: ID_ESTATUS_REP (si viene, actualiza directamente por ID).
//   - confirmar_todas: true para forzar UPDATE en todas las versiones (peligro: solicitar confirmación primero).
// Tablas: ESTATUS_REPORTE, INVENTARIO_REPORTES, CAT_REPORTES_GENERALES, AUDIT_LOG.
// Validaciones críticas:
//   - Si id_estatus_rep: foto "antes" de esa fila, UPDATE directo, bitácora con antes/después.
//   - Si sin id pero existe el par (clave_rep+plataforma):
//     * Si hay varias versiones y sin confirmar_todas → 409 con lista de versiones.
//     * Si confirmado o versión especificada → UPDATE todas/la especificada.
//   - Si no existe nada → INSERT alta nueva (también en INVENTARIO_VERSIONES si es la primera).
// Bitácora: registra antes/después (foto de filas), filas_afectadas, version, confirmación si aplica.
router.put('/estatus-reporte', requireAuth, async (req, res) => {
  try {
    const { clave_rep, clave_plataforma, etapa, fecha, desmarcar, version, id_estatus_rep } = req.body;
    const usuario       = req.session.user?.username || 'sistema';
    const fechaVal      = fecha ? esc(fecha) : 'GETDATE()';
    const versionFilter = version ? ` AND VERSION_CARGA=${esc(version)}` : '';

    // ── Cascada de hitos (regla de negocio) ──
    // MARCAR (desmarcar=false):
    //   - Si DOC:  DOCUMENTADO=SI, PROGRAMADO=NO, CERTIFICADO=NO, ESTATUS='DOCUMENTADO'.
    //   - Si PROG: DOCUMENTADO=SI, PROGRAMADO=SI, CERTIFICADO=NO, ESTATUS='PROGRAMADO'.
    //   - Si CERT: DOCUMENTADO=SI, PROGRAMADO=SI, CERTIFICADO=SI, ESTATUS='CERTIFICADO'.
    // DESMARCAR (desmarcar=true):
    //   - Si DOC:  limpia todo (los 3 pasan a NO).
    //   - Si PROG: desactiva PROG+CERT (quedan en NO), DOCUMENTADO=SI, ESTATUS='DOCUMENTADO'.
    //   - Si CERT: desactiva CERT (pasa a NO), resto=SI, ESTATUS='PROGRAMADO'.
    let docVal, progVal, certVal, nuevoEstatus;
    if (desmarcar) {
      docVal       = etapa === 'DOCUMENTADO' ? "'NO'" : "'SI'";
      progVal      = (etapa === 'DOCUMENTADO' || etapa === 'PROGRAMADO') ? "'NO'" : "'SI'";
      certVal      = "'NO'";
      nuevoEstatus = etapa === 'CERTIFICADO' ? 'PROGRAMADO'
                   : etapa === 'PROGRAMADO'  ? 'DOCUMENTADO'
                   : '';
    } else {
      docVal       = "'SI'";
      progVal      = (etapa === 'PROGRAMADO' || etapa === 'CERTIFICADO') ? "'SI'" : "'NO'";
      certVal      = etapa === 'CERTIFICADO' ? "'SI'" : "'NO'";
      nuevoEstatus = etapa;
    }
    // Valores planos de la cascada (para registrar el "después" en bitácora)
    const despues = {
      DOCUMENTADO: docVal.replace(/'/g, ''), PROGRAMADO: progVal.replace(/'/g, ''),
      CERTIFICADO: certVal.replace(/'/g, ''), ESTATUS: nuevoEstatus
    };

    // Rama 1: si viene ID_ESTATUS_REP, actualizar directamente por ID (seguro, evita duplicados).
    // Ventaja: rápido y preciso. Desventaja: requiere que el cliente sepa el ID.
    if (id_estatus_rep) {
      // Foto "antes" de la fila que se va a tocar (para bitácora).
      const antesRows = await query(`
        SELECT ID_ESTATUS_REP, VERSION_CARGA, DOCUMENTADO, PROGRAMADO, CERTIFICADO, ESTATUS
        FROM ESTATUS_REPORTE WHERE ID_ESTATUS_REP=${parseInt(id_estatus_rep)}
      `);
      // Candado 404: si el ID ya no existe (ej: borrado por otro usuario),
      // retorna error en lugar de silencio (esto evita confusión sobre qué pasó).
      if (!antesRows.length) {
        return res.status(404).json({
          ok: false,
          message: `El registro (ID ${id_estatus_rep}) ya no existe. No se modificó nada. Recarga la lista e intenta de nuevo.`
        });
      }
      await query(`
        UPDATE ESTATUS_REPORTE SET
          DOCUMENTADO=${docVal}, PROGRAMADO=${progVal}, CERTIFICADO=${certVal},
          ESTATUS=${esc(nuevoEstatus)}
        WHERE ID_ESTATUS_REP=${parseInt(id_estatus_rep)}
      `);
      await auditLog(usuario, 'estatus-reporte', desmarcar ? 'DESMARCAR' : 'MARCAR',
        { id_estatus_rep, clave_rep, clave_plataforma,
          version: antesRows[0].VERSION_CARGA == null ? 'NULL' : String(antesRows[0].VERSION_CARGA).trim(),
          etapa, resultado: nuevoEstatus,
          filas_afectadas: antesRows.length, antes: antesRows[0], despues });
      return res.json({ ok: true });
    }

    // Rama 2: sin ID, buscar por clave_rep+plataforma (y opcionalmente version).
    // Primero verificar si existe exactamente con la versión indicada, y además
    // si existen otras versiones de ese par (para candado de confirmación).
    const existeExacto = await query(`
      SELECT 1 FROM ESTATUS_REPORTE
      WHERE CLAVE_REP=${esc(clave_rep)} AND CLAVE_PLATAFORMA=${esc(clave_plataforma)}${versionFilter}
    `);
    const existeGeneral = await query(`
      SELECT 1 FROM ESTATUS_REPORTE
      WHERE CLAVE_REP=${esc(clave_rep)} AND CLAVE_PLATAFORMA=${esc(clave_plataforma)}
    `);

    // Rama 2.1: registros existen (exacto o general sin versionFilter).
    if (existeExacto.length || (!versionFilter && existeGeneral.length)) {
      // Foto "antes" de las filas que se van a tocar (para bitácora).
      const antesRows = await query(`
        SELECT ID_ESTATUS_REP, VERSION_CARGA, DOCUMENTADO, PROGRAMADO, CERTIFICADO, ESTATUS
        FROM ESTATUS_REPORTE
        WHERE CLAVE_REP=${esc(clave_rep)} AND CLAVE_PLATAFORMA=${esc(clave_plataforma)}${versionFilter}
      `);
      // Candado 409: sin versión especificada Y con varias versiones en el par →
      // pedir confirmación explícita (confirmar_todas:true) antes de actualizar todas.
      // Esto evita el bug histórico donde se planchaba VERSION_CARGA de versiones antiguas.
      if (!versionFilter && antesRows.length > 1 && !req.body.confirmar_todas) {
        const versiones = antesRows.map(a => a.VERSION_CARGA == null ? 'NULL' : String(a.VERSION_CARGA).trim());
        return res.status(409).json({
          ok: false, requiere_confirmacion: true, filas: antesRows.length, versiones,
          message: `${clave_rep} en ${clave_plataforma} tiene ${antesRows.length} versiones (${versiones.join(', ')}). Especifica la versión, o confirma que quieres aplicar a TODAS. No se modificó nada.`
        });
      }
      await query(`
        UPDATE ESTATUS_REPORTE SET
          DOCUMENTADO=${docVal}, PROGRAMADO=${progVal}, CERTIFICADO=${certVal},
          ESTATUS=${esc(nuevoEstatus)}
          ${version ? `, VERSION_CARGA=${esc(version)}` : ''}
        WHERE CLAVE_REP=${esc(clave_rep)} AND CLAVE_PLATAFORMA=${esc(clave_plataforma)}${versionFilter}
      `);
      await auditLog(usuario, 'estatus-reporte', desmarcar ? 'DESMARCAR' : 'MARCAR',
        { clave_rep, clave_plataforma, etapa, version: version || 'todas', resultado: nuevoEstatus,
          confirmo_todas: !version && antesRows.length > 1 ? true : undefined,
          filas_afectadas: antesRows.length, antes: antesRows.slice(0, 20), despues });
      return res.json({ ok: true });
    } else if (existeGeneral.length) {
      // Rama 2.2 (error): registros existen para clave_rep+plataforma, pero NO
      // con la versión especificada. En lugar de crear un fantasma o planchar,
      // se rechaza con error 400 (comportamiento seguro post-bug).
      return res.status(400).json({
        ok: false,
        message: `La versión ${version} no existe para ${clave_rep} en ${clave_plataforma}. No se modificó nada.`
      });
    } else {
      // Rama 2.3: alta nueva (no existe el par clave_rep+plataforma).
      const invRow = await query(`SELECT CLAVE_REP_GENERAL FROM INVENTARIO_REPORTES WHERE CLAVE_REP=${esc(clave_rep)}`);
      const claveRepGeneral = invRow.length ? invRow[0].CLAVE_REP_GENERAL : clave_rep;
      // Auto-insertar en CAT_REPORTES_GENERALES si no existe
      const existeRepGen = await query(`SELECT 1 FROM CAT_REPORTES_GENERALES WHERE CLAVE_REP_GENERAL=${esc(claveRepGeneral)}`);
      if (!existeRepGen.length) await query(`INSERT INTO CAT_REPORTES_GENERALES (CLAVE_REP_GENERAL) VALUES (${esc(claveRepGeneral)})`);
      await query(`
        INSERT INTO ESTATUS_REPORTE
          (CLAVE_REP, CLAVE_REP_GENERAL, CLAVE_PLATAFORMA, VERSION, VERSION_CARGA,
           DOCUMENTADO, PROGRAMADO, CERTIFICADO, ESTATUS)
        VALUES
          (${esc(clave_rep)}, ${esc(claveRepGeneral)}, ${esc(clave_plataforma)}, '00', ${esc(version || null)},
           ${docVal}, ${progVal}, ${certVal}, ${esc(nuevoEstatus)})
      `);
    }
    await auditLog(usuario, 'estatus-reporte', desmarcar ? 'DESMARCAR' : 'MARCAR',
      { clave_rep, clave_plataforma, etapa, version: version || null, resultado: nuevoEstatus,
        alta_nueva: true, filas_afectadas: 1, antes: null, despues });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── PUT /estatus-validacion/estatus
// Descripción: actualiza el ESTATUS secuencial (texto libre) de una validación,
// sin afectar las banderas DOCUMENTADO/PROGRAMADO/CERTIFICADO.
// Parámetros body: clave_validacion, clave_plataforma, estatus, version (opcional).
// Tablas: REPORTE_VALIDACION (UPDATE estatus + fechas); AUDIT_LOG.
// Sin cascada de hitos (solo actualiza ESTATUS + USER_ESTATUS + FECHA_ESTATUS).
router.put('/estatus-validacion/estatus', requireAuth, async (req, res) => {
  try {
    const { clave_validacion, clave_plataforma, estatus, version } = req.body;
    const usuario = req.session.user?.username || 'sistema';
    const versionFilter = version ? ` AND VERSION_CARGA=${esc(version)}` : '';

    const existe = await query(`
      SELECT 1 FROM REPORTE_VALIDACION
      WHERE CLAVE_VALIDACION=${esc(clave_validacion)} AND CLAVE_PLATAFORMA=${esc(clave_plataforma)}${versionFilter}
    `);

    if (existe.length) {
      await query(`
        UPDATE REPORTE_VALIDACION SET
          ESTATUS=${esc(estatus)}, FECHA_ESTATUS=GETDATE(), USER_ESTATUS=${esc(usuario)}
        WHERE CLAVE_VALIDACION=${esc(clave_validacion)} AND CLAVE_PLATAFORMA=${esc(clave_plataforma)}${versionFilter}
      `);
    }
    await auditLog(usuario, 'estatus-validacion', 'ESTATUS',
      { clave_validacion, clave_plataforma, version: version || 'todas', estatus });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── PUT /estatus-validacion
// Descripción: actualiza los hitos (DOCUMENTADO/PROGRAMADO/CERTIFICADO) de una validación,
// con cascada automática similar a reportes (marcar CERT = marcar DOC+PROG+CERT).
// Parámetros body:
//   - clave_validacion, clave_rep, clave_plataforma: identifican la validación.
//   - etapa: 'DOCUMENTADO'|'PROGRAMADO'|'CERTIFICADO'|'IDENTIFICADO' (últi retorna a inicial).
//   - desmarcar: true para desmarcar (en lugar de marcar).
//   - fecha: fecha personalizada (default: GETDATE()).
// Tablas: REPORTE_VALIDACION (UPSERT); AUDIT_LOG.
// Cascada de hitos (con banderas 'S'/'N' en lugar de 'SI'/'NO'):
//   - MARCAR DOC: DOCUMENTADO='S', PROGRAMADO='N', CERTIFICADO='N'.
//   - MARCAR PROG: DOCUMENTADO='S', PROGRAMADO='S', CERTIFICADO='N'.
//   - MARCAR CERT: DOCUMENTADO='S', PROGRAMADO='S', CERTIFICADO='S'.
//   - DESMARCAR: opuesto (limpia flags inferiores).
//   - IDENTIFICADO: limpia todo, ESTATUS='NO DOCUMENTADO' (regresa a inicial).
// Bitácora: registra cambios (sin "antes/después" detallado, solo parámetros).
router.put('/estatus-validacion', requireAuth, async (req, res) => {
  try {
    const { clave_validacion, clave_rep, clave_plataforma, etapa, fecha, desmarcar } = req.body;
    const usuario  = req.session.user?.username || 'sistema';
    const fechaVal = fecha ? esc(fecha) : 'GETDATE()';

    // Cascada de hitos para validaciones (similar a reportes, pero con 'S'/'N').
    let docVal, progVal, certVal, nuevoEstatus;
    if (etapa === 'IDENTIFICADO') {  // Retornar a inicial (limpia todo).
      // Regresa al estado inicial: limpia todo
      docVal = "'N'"; progVal = "'N'"; certVal = "'N'";
      nuevoEstatus = 'NO DOCUMENTADO';
    } else if (desmarcar) {
      docVal       = etapa === 'DOCUMENTADO' ? "'N'" : "'S'";
      progVal      = (etapa === 'DOCUMENTADO' || etapa === 'PROGRAMADO') ? "'N'" : "'S'";
      certVal      = "'N'";
      nuevoEstatus = etapa === 'CERTIFICADO' ? 'PROGRAMADO'
                   : etapa === 'PROGRAMADO'  ? 'DOCUMENTADO'
                   : 'NO DOCUMENTADO';
    } else {
      docVal       = "'S'";
      progVal      = (etapa === 'PROGRAMADO' || etapa === 'CERTIFICADO') ? "'S'" : "'N'";
      certVal      = etapa === 'CERTIFICADO' ? "'S'" : "'N'";
      nuevoEstatus = etapa;
    }

    const docFecha  = etapa === 'DOCUMENTADO' ? `, DOC_FECHA_REAL=${desmarcar ? 'NULL' : fechaVal}, USER_DOC=${esc(usuario)}` : '';
    const progFecha = etapa === 'PROGRAMADO'  ? `, PROG_FECHA_REAL=${desmarcar ? 'NULL' : fechaVal}, USER_PROG=${esc(usuario)}` : '';
    const certFecha = etapa === 'CERTIFICADO' ? `, CERT_FECHA_REAL=${desmarcar ? 'NULL' : fechaVal}, USER_CERT=${esc(usuario)}` : '';

    const existe = await query(`
      SELECT 1 FROM REPORTE_VALIDACION
      WHERE CLAVE_VALIDACION=${esc(clave_validacion)} AND CLAVE_PLATAFORMA=${esc(clave_plataforma)}
    `);

    if (existe.length) {
      await query(`
        UPDATE REPORTE_VALIDACION SET
          DOCUMENTADO=${docVal}, PROGRAMADO=${progVal}, CERTIFICADO=${certVal},
          ESTATUS=${esc(nuevoEstatus)}
          ${docFecha}${progFecha}${certFecha}
        WHERE CLAVE_VALIDACION=${esc(clave_validacion)} AND CLAVE_PLATAFORMA=${esc(clave_plataforma)}
      `);
    } else if (etapa !== 'IDENTIFICADO' && !desmarcar) {
      await query(`
        INSERT INTO REPORTE_VALIDACION
          (CLAVE_VALIDACION, CLAVE_REP, CLAVE_PLATAFORMA, DOCUMENTADO, PROGRAMADO, CERTIFICADO, ESTATUS
           ${etapa === 'DOCUMENTADO' ? ', DOC_FECHA_REAL, USER_DOC' : etapa === 'PROGRAMADO' ? ', PROG_FECHA_REAL, USER_PROG' : ', CERT_FECHA_REAL, USER_CERT'})
        VALUES
          (${esc(clave_validacion)}, ${esc(clave_rep)}, ${esc(clave_plataforma)},
           ${docVal}, ${progVal}, ${certVal}, ${esc(nuevoEstatus)}, ${fechaVal}, ${esc(usuario)})
      `);
    }
    await auditLog(usuario, 'estatus-validacion', desmarcar ? 'DESMARCAR' : 'MARCAR',
      { clave_validacion, clave_rep, clave_plataforma, etapa, resultado: nuevoEstatus });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── GET /validaciones-por-reporte
// Descripción: lista de validaciones de un reporte (para bulk update de hitos).
// Parámetros query: rep (CLAVE_REP, requerido), plataforma (CLAVE_PLATAFORMA, opcional).
// Tablas: REPORTE_VALIDACION, INVENTARIO_VALIDACIONES (LEFT JOIN).
// Lógica: soporta sufijo _AÑO (ej: "ACLME_2024" si busca "ACLME").
// Sin bitácora (consulta de solo lectura).
router.get('/validaciones-por-reporte', requireAuth, async (req, res) => {
  try {
    const { rep, plataforma } = req.query;
    if (!rep) return res.json({ ok: true, data: [] });
    const todosRV = await getRVClaves();
    const matched = todosRV.filter(c =>
      c === rep || (c.lastIndexOf('_') > 0 && c.slice(0, c.lastIndexOf('_')) === rep)
    );
    if (!matched.length) return res.json({ ok: true, data: [] });
    const inList = matched.map(c => `'${c.replace(/'/g, "''")}'`).join(',');
    const wherePlat = plataforma ? ` AND CLAVE_PLATAFORMA = ${esc(plataforma)}` : '';
    const rows = await query(`
      SELECT rv.CLAVE_VALIDACION, rv.CLAVE_REP, rv.TIPO_VALIDACION, rv.DESCRIPCION,
             rv.DOCUMENTADO, rv.PROGRAMADO, rv.CERTIFICADO, rv.ESTATUS, rv.CLAVE_PLATAFORMA,
             COALESCE(rv.VERSION_CARGA, iv.VERSION_CARGA) AS VERSION_CARGA
      FROM REPORTE_VALIDACION rv
      LEFT JOIN INVENTARIO_VALIDACIONES iv ON iv.CLAVE_VALIDACION = rv.CLAVE_VALIDACION
      WHERE rv.CLAVE_REP IN (${inList}) ${wherePlat}
      ORDER BY rv.CLAVE_REP, rv.CLAVE_VALIDACION
    `);
    res.json({ ok: true, data: rows });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── PUT /estatus-validacion-bulk
// Descripción: actualiza hitos de múltiples validaciones en paralelo (bulk).
// Parámetros body:
//   - claves: array de CLAVE_VALIDACION (requerido).
//   - clave_rep: CLAVE_REP base.
//   - clave_plataforma: CLAVE_PLATAFORMA (común para todas).
//   - etapa: 'DOCUMENTADO'|'PROGRAMADO'|'CERTIFICADO'|'IDENTIFICADO'.
//   - desmarcar: true para desmarcar.
//   - version: VERSION_CARGA (opcional, filtro para validación).
//   - fecha: fecha personalizada (default: GETDATE()).
// Tablas: REPORTE_VALIDACION (UPDATE o INSERT); AUDIT_LOG.
// Lógica: loop por cada validación, UPDATE si existe, INSERT si no (y no es IDENTIFICADO+desmarcar).
// Bitácora: registra acción MARCAR_BULK|DESMARCAR_BULK con total y cantidad actualizada.
router.put('/estatus-validacion-bulk', requireAuth, async (req, res) => {
  try {
    const { claves, clave_rep, clave_plataforma, etapa, fecha, desmarcar, version } = req.body;
    if (!claves?.length) return res.json({ ok: false, message: 'No hay validaciones seleccionadas' });
    const usuario   = req.session.user?.username || 'sistema';
    const fechaVal  = fecha ? esc(fecha) : 'GETDATE()';
    const versionFilter = version ? ` AND VERSION_CARGA=${esc(version)}` : '';

    let docVal, progVal, certVal, nuevoEstatus;
    if (etapa === 'IDENTIFICADO') {
      docVal = "'N'"; progVal = "'N'"; certVal = "'N'";
      nuevoEstatus = 'NO DOCUMENTADO';
    } else if (desmarcar) {
      docVal       = etapa === 'DOCUMENTADO' ? "'N'" : "'S'";
      progVal      = (etapa === 'DOCUMENTADO' || etapa === 'PROGRAMADO') ? "'N'" : "'S'";
      certVal      = "'N'";
      nuevoEstatus = etapa === 'CERTIFICADO' ? 'PROGRAMADO'
                   : etapa === 'PROGRAMADO'  ? 'DOCUMENTADO' : 'NO DOCUMENTADO';
    } else {
      docVal       = "'S'";
      progVal      = (etapa === 'PROGRAMADO' || etapa === 'CERTIFICADO') ? "'S'" : "'N'";
      certVal      = etapa === 'CERTIFICADO' ? "'S'" : "'N'";
      nuevoEstatus = etapa;
    }
    const docFecha  = etapa === 'DOCUMENTADO' ? `, DOC_FECHA_REAL=${desmarcar ? 'NULL' : fechaVal}, USER_DOC=${esc(usuario)}` : '';
    const progFecha = etapa === 'PROGRAMADO'  ? `, PROG_FECHA_REAL=${desmarcar ? 'NULL' : fechaVal}, USER_PROG=${esc(usuario)}` : '';
    const certFecha = etapa === 'CERTIFICADO' ? `, CERT_FECHA_REAL=${desmarcar ? 'NULL' : fechaVal}, USER_CERT=${esc(usuario)}` : '';

    let updated = 0;
    for (const clave_validacion of claves) {
      const existe = await query(`
        SELECT 1 FROM REPORTE_VALIDACION
        WHERE CLAVE_VALIDACION=${esc(clave_validacion)} AND CLAVE_PLATAFORMA=${esc(clave_plataforma)}${versionFilter}
      `);
      if (existe.length) {
        await query(`
          UPDATE REPORTE_VALIDACION SET
            DOCUMENTADO=${docVal}, PROGRAMADO=${progVal}, CERTIFICADO=${certVal},
            ESTATUS=${esc(nuevoEstatus)} ${docFecha}${progFecha}${certFecha}
          WHERE CLAVE_VALIDACION=${esc(clave_validacion)} AND CLAVE_PLATAFORMA=${esc(clave_plataforma)}${versionFilter}
        `);
        updated++;
      } else if (etapa !== 'IDENTIFICADO' && !desmarcar) {
        await query(`
          INSERT INTO REPORTE_VALIDACION
            (CLAVE_VALIDACION, CLAVE_REP, CLAVE_PLATAFORMA, DOCUMENTADO, PROGRAMADO, CERTIFICADO, ESTATUS
             ${etapa==='DOCUMENTADO' ? ',DOC_FECHA_REAL,USER_DOC' : etapa==='PROGRAMADO' ? ',PROG_FECHA_REAL,USER_PROG' : ',CERT_FECHA_REAL,USER_CERT'})
          VALUES (${esc(clave_validacion)}, ${esc(clave_rep)}, ${esc(clave_plataforma)},
                  ${docVal}, ${progVal}, ${certVal}, ${esc(nuevoEstatus)}, ${fechaVal}, ${esc(usuario)})
        `);
        updated++;
      }
    }
    await auditLog(usuario, 'estatus-validacion', desmarcar ? 'DESMARCAR_BULK' : 'MARCAR_BULK',
      { clave_rep, clave_plataforma, etapa, total: claves.length, updated });
    res.json({ ok: true, updated });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── GET /buscar-validacion
// Descripción: autocompletar validaciones por CLAVE_VALIDACION o DESCRIPCION.
// Parámetros query: q (texto de búsqueda, mín 2 caracteres).
// Tablas: REPORTE_VALIDACION.
// Límite: TOP 10 resultados.
// Sin bitácora (consulta de solo lectura).
router.get('/buscar-validacion', requireAuth, async (req, res) => {
  const q = (req.query.q || '').trim().replace(/'/g, "''");
  if (q.length < 2) return res.json({ ok: true, data: [] });
  try {
    const rows = await query(`
      SELECT DISTINCT TOP 10 CLAVE_VALIDACION, CLAVE_REP, CLAVE_PLATAFORMA, DESCRIPCION
      FROM REPORTE_VALIDACION
      WHERE CLAVE_VALIDACION LIKE '%${q}%' OR DESCRIPCION LIKE '%${q}%'
      ORDER BY CLAVE_VALIDACION
    `);
    res.json({ ok: true, data: rows });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── POST /inventario-reportes/check
// Descripción: valida qué reportes/versiones de un Excel ya existen en BD,
// para preparar la carga y avisar al usuario sobre duplicados.
// Parámetros body:
//   - pares: array de {clave_rep, version} a verificar.
//   - claves_entidad: array de CLAVE_ENTIDADREGULADA a validar contra catálogo.
// Tablas: INVENTARIO_REPORTES_HIST, CAT_ENTIDAD_REGULADA.
// Respuesta: version_existe (bool), version_count, entidades_invalidas (array).
// Sin bitácora (consulta de solo lectura).
router.post('/inventario-reportes/check', requireAuth, async (req, res) => {
  try {
    const { pares = [], claves_entidad = [] } = req.body;
    // Contar exactamente los pares (CLAVE_REP, VERSION_CARGA) que ya existen en hist
    let version_count = 0;
    if (pares.length) {
      for (const p of pares) {
        const existe = await query(`SELECT 1 FROM INVENTARIO_REPORTES_HIST WHERE CLAVE_REP=${esc(p.clave_rep)} AND VERSION_CARGA=${esc(p.version)}`);
        if (existe.length) version_count++;
      }
    }
    let invalidas = [];
    if (claves_entidad.length) {
      const vals = claves_entidad.map(c => `(${esc(c)})`).join(',');
      const rows = await query(`SELECT t.c FROM (VALUES ${vals}) AS t(c) WHERE NOT EXISTS (SELECT 1 FROM CAT_ENTIDAD_REGULADA WHERE CLAVE_ENTIDADREGULADA = t.c)`);
      invalidas = rows.map(r => r.c);
    }
    res.json({ ok: true, version_existe: version_count > 0, version_count, entidades_invalidas: invalidas });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── POST /inventario-reportes/upload
// Descripción: carga masiva de reportes desde Excel con lógica robusta:
//   1. Auto-respaldo de seguridad previo a cualquier cambio.
//   2. Insert/Update en INVENTARIO_REPORTES (comparación campo por campo).
//   3. Insert en INVENTARIO_REPORTES_HIST (solo nuevas combinaciones CLAVE_REP|VERSION_CARGA).
//   4. Insert en INVENTARIO_VERSIONES (registro de qué versión existe).
//   5. Bitácora detallada con diff de cambios (campo por campo, hasta 100 entradas).
// Parámetros form:
//   - archivo: file (Excel con hojas: CLAVE_REP, CLAVE_PAIS, ..., VERSION_CARGA, etc.)
//   - version: versión global si no viene en fila (default '1.0.0').
//   - regulacion, tipo_version, descripcion: metadata global.
//   - versiones, tipos, descripciones: JSON maps para override por clave|plataforma.
//   - force: 'true' para recargar versiones existentes.
// Tablas:
//   - INVENTARIO_REPORTES (INSERT/UPDATE), INVENTARIO_REPORTES_HIST (INSERT).
//   - INVENTARIO_VERSIONES (INSERT), CAT_* (auto-insert de catálogos).
//   - AUDIT_LOG (bitácora con cambios).
// Validaciones:
//   - Respaldo automático previo (aborta si falla, excepto si tabla no existe).
//   - Auto-inserción en catálogos si no existen las claves.
//   - Diff campo por campo (solo UPDATE si cambió algo).
// Bitácora: archivo, insertados, actualizados, errores, respaldo_previo, cambios (array).
// Respuesta: insertados, actualizados, errores, reportes, combos.
router.post('/inventario-reportes/upload', requireAuth, upload.single('archivo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, message: 'No se recibió archivo' });
  try {
    const usuario     = req.session.user?.username || 'sistema';
    const versionGlobal = (req.body.version     || '1.0.0').trim();
    const regulacion  = (req.body.regulacion  || '').trim();
    const tipo_version= (req.body.tipo_version|| 'BASE').trim();
    const descripcion = (req.body.descripcion || '').trim();
    const force       = req.body.force === 'true';
    const versionesMap    = req.body.versiones    ? JSON.parse(req.body.versiones)    : null;
    const tiposMap        = req.body.tipos        ? JSON.parse(req.body.tipos)        : null;
    const descripcionesMap = req.body.descripciones ? JSON.parse(req.body.descripciones) : null;

    const wb   = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws   = wb.Sheets[wb.SheetNames[0]];
    // Auto-detectar la fila de encabezados (soporta templates con títulos arriba)
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '', range: _detectHeaderRow(ws) });

    // ── Paso 0: Respaldo de seguridad (antes de cualquier cambio) ──
    // Aprovecha el servicio respaldos.respaldarAntesDeCarga() para snapshot de las
    // tablas *_RESPALDO con las claves que vienen en el Excel (rápido, no copia todo).
    // Lógica:
    //   - Si tabla RESPALDO no existe: avisa con warn, pero continúa (tolerante).
    //   - Si otro error: ABORTA la carga (seguro: mejor no subir que quebrar datos).
    const clavesExcel = [...new Set(rows.map(r => String(r.CLAVE_REP || '').trim()).filter(Boolean))];
    let respaldo_previo = false;
    try {
      await respaldos.respaldarAntesDeCarga(usuario, req.file.originalname, clavesExcel);
      respaldo_previo = true;
    } catch (eBak) {
      if (/no existe la tabla|invalid object name/i.test(eBak.message)) {
        console.warn('[upload-rep] sin respaldo previo:', eBak.message);
      } else {
        return res.status(500).json({ ok: false,
          message: 'No se pudo crear el respaldo previo — la carga se canceló y NO se subió nada. ' + eBak.message });
      }
    }

    let insertados = 0, actualizados = 0, errores = 0;
    const combos = []; // array de {CLAVE_REP, CLAVE_REP_GENERAL, PLATAFORMA, VERSION} procesadas (para bitácora).
    const cambiosDetalle = []; // array de diff {clave_rep, cambios: [{campo, antes, despues}]} (para bitácora).

    // ── Paso 1: procesar cada fila del Excel ──
    for (const r of rows) {
      const clave = String(r.CLAVE_REP || '').trim();
      if (!clave) continue;  // Saltar filas sin CLAVE_REP.
      const plataformaRow = String(r.PLATAFORMA || r.CLAVE_PLATAFORMA || '').trim();

      // ── Resolución de versión (cascada de prioridades) ──
      // El usuario puede especificar versión a nivel: (1) combinación exacta clave|plat|versión,
      // (2) combinación clave|plataforma, (3) clave sola, (4) versión en la fila, (5) global.
      // Esto permite que dos filas del mismo reporte con versión/plataforma distinta
      // NO se colapsen (regresión: antes se sobrescribía VERSION_CARGA).
      const versionRowExcel = String(r.VERSION_CARGA || '').trim();
      const comboKey = `${clave}|${plataformaRow}`;
      const comboKeyFull = `${comboKey}|${versionRowExcel}`;
      const version = (versionesMap && (versionesMap[comboKeyFull] || versionesMap[comboKey] || versionesMap[clave]))
        || versionRowExcel || versionGlobal;
      const tipo_ver_row = (tiposMap && (tiposMap[comboKeyFull] || tiposMap[comboKey] || tiposMap[clave])) || tipo_version;
      const descripcion_row = (descripcionesMap && (descripcionesMap[comboKeyFull] || descripcionesMap[comboKey] || descripcionesMap[clave])) || descripcion;
      try {
        // Buscar reporte existente en inventario.
        const existeInv = await query(`
          SELECT CLAVE_PAIS, CLAVE_ENTIDADREGULADA, CLAVE_REG, CLAVE_SERIE, SUBSERIE,
                 CLAVE_GRUPO, REPORTE, CLAVE_SECCION_REP, CLAVE_VERSION_REPORTE, CLAVE_PERIODO,
                 DESCRIPCION_ESP, CLAVE_FECHA_ENT_REP, CARACTERISTICAS,
                 CLAVE_REGULACION_REP, CLAVE_REP_GENERAL, FECHA_REGULACION, VERSION_CARGA
          FROM INVENTARIO_REPORTES WHERE CLAVE_REP=${esc(clave)}`);

        // ── Helper: auto-insertar en catálogos si no existen ──
        // Previene errores FK al insertar reportes con claves de catálogos nuevas.
        const autoInsert = async (tabla, campoClave, campoNombre, valor) => {
          if (!valor) return;
          const existe = await query(`SELECT 1 FROM ${tabla} WHERE ${campoClave}=${esc(valor)}`);
          if (!existe.length) {
            if (campoNombre) {
              await query(`INSERT INTO ${tabla} (${campoClave}, ${campoNombre}) VALUES (${esc(valor)}, ${esc(valor)})`);
            } else {
              await query(`INSERT INTO ${tabla} (${campoClave}) VALUES (${esc(valor)})`);
            }
          }
        };
        await autoInsert('CAT_REPORTES_GENERALES', 'CLAVE_REP_GENERAL',    null,                    r.CLAVE_REP_GENERAL);
        await autoInsert('CAT_VERSION_REPORTE',    'CLAVE_VERSION_REPORTE', 'NOMBRE_VERSION_REP',    r.CLAVE_VERSION_REPORTE);
        await autoInsert('CAT_PAISES',             'CLAVE_PAIS',            'PAIS',                  r.CLAVE_PAIS);
        await autoInsert('CAT_ENTIDAD_REGULADA',   'CLAVE_ENTIDADREGULADA', null,                    r.CLAVE_ENTIDADREGULADA);
        await autoInsert('CAT_REGULADORES',        'CLAVE_REG',             'REGULADOR',             r.CLAVE_REG);
        await autoInsert('CAT_GRUPO',              'CLAVE_GRUPO',           'NOMBRE_GRUPO',          r.CLAVE_GRUPO);
        await autoInsert('CAT_PERIODICIDAD',       'CLAVE_PERIODO',         'PERIODO',               r.CLAVE_PERIODO);
        await autoInsert('CAT_REGULACION',         'CLAVE_REGULACION_REP',  'NOMBRE_REGULACION_REP', r.CLAVE_REGULACION_REP);

        if (!existeInv.length) {
          // Rama A: reporte nuevo → INSERT en INVENTARIO_REPORTES.
          await query(`
            INSERT INTO INVENTARIO_REPORTES (
              CLAVE_REP, CLAVE_PAIS, CLAVE_ENTIDADREGULADA, CLAVE_REG,
              CLAVE_SERIE, SUBSERIE, CLAVE_GRUPO, REPORTE,
              CLAVE_SECCION_REP, CLAVE_VERSION_REPORTE, CLAVE_PERIODO,
              DESCRIPCION_ESP, CLAVE_FECHA_ENT_REP, CARACTERISTICAS,
              CLAVE_REGULACION_REP, CLAVE_REP_GENERAL, FECHA_REGULACION,
              FECHA_ALTA, FECHA_ACTUALIZADA, VIGENTE, VERSION_CARGA
            ) VALUES (
              ${esc(clave)}, ${esc(r.CLAVE_PAIS)}, ${esc(r.CLAVE_ENTIDADREGULADA)}, ${esc(r.CLAVE_REG)},
              ${esc(r.CLAVE_SERIE)}, ${esc(r.SUBSERIE)}, ${esc(r.CLAVE_GRUPO)}, ${esc(r.REPORTE)},
              ${esc(r.CLAVE_SECCION_REP)}, ${esc(r.CLAVE_VERSION_REPORTE)}, ${esc(r.CLAVE_PERIODO)},
              ${esc(r.DESCRIPCION_ESP)}, ${esc(r.CLAVE_FECHA_ENT_REP)}, ${esc(r.CARACTERISTICAS)},
              ${esc(r.CLAVE_REGULACION_REP)}, ${esc(r.CLAVE_REP_GENERAL)},
              ${r.FECHA_REGULACION && !isNaN(new Date(r.FECHA_REGULACION)) ? esc(r.FECHA_REGULACION) : 'NULL'},
              GETDATE(), GETDATE(), 1, ${esc(version)}
            )
          `);
          insertados++;
        } else {
          // Rama B: reporte existente → comparar campos + UPDATE si cambió algo.
          const bd = existeInv[0];
          const str = v => (v == null ? '' : String(v).trim());  // normalizar para comparación.

          // ── Diff campo por campo (para bitácora detallada) ──
          // Comparar los campos principales de INVENTARIO_REPORTES.
          const camposComp = ['CLAVE_PAIS','CLAVE_ENTIDADREGULADA','CLAVE_REG','CLAVE_SERIE',
            'SUBSERIE','CLAVE_GRUPO','REPORTE','CLAVE_SECCION_REP','CLAVE_VERSION_REPORTE',
            'CLAVE_PERIODO','DESCRIPCION_ESP','CLAVE_FECHA_ENT_REP','CARACTERISTICAS',
            'CLAVE_REGULACION_REP','CLAVE_REP_GENERAL','FECHA_REGULACION'];
          const difs = camposComp
            .filter(c => str(bd[c]) !== str(r[c]))
            .map(c => ({ campo: c, antes: str(bd[c]), despues: str(r[c]) }));
          const cambio = difs.length > 0;

          // Verificar cambio de VERSION_CARGA (puede cambiar aunque otros campos no).
          const versionCambio = str(bd.VERSION_CARGA) !== str(version);
          if (versionCambio) difs.push({ campo: 'VERSION_CARGA', antes: str(bd.VERSION_CARGA), despues: str(version) });
          if (difs.length) cambiosDetalle.push({ clave_rep: clave, cambios: difs });

          // ── Actualizar solo si cambió algo ──
          if (cambio) {
            await query(`
              UPDATE INVENTARIO_REPORTES SET
                CLAVE_PAIS=${esc(r.CLAVE_PAIS)}, CLAVE_ENTIDADREGULADA=${esc(r.CLAVE_ENTIDADREGULADA)},
                CLAVE_REG=${esc(r.CLAVE_REG)}, CLAVE_SERIE=${esc(r.CLAVE_SERIE)},
                SUBSERIE=${esc(r.SUBSERIE)}, CLAVE_GRUPO=${esc(r.CLAVE_GRUPO)}, REPORTE=${esc(r.REPORTE)},
                CLAVE_SECCION_REP=${esc(r.CLAVE_SECCION_REP)}, CLAVE_VERSION_REPORTE=${esc(r.CLAVE_VERSION_REPORTE)},
                CLAVE_PERIODO=${esc(r.CLAVE_PERIODO)}, DESCRIPCION_ESP=${esc(r.DESCRIPCION_ESP)},
                CLAVE_FECHA_ENT_REP=${esc(r.CLAVE_FECHA_ENT_REP)}, CARACTERISTICAS=${esc(r.CARACTERISTICAS)},
                CLAVE_REGULACION_REP=${esc(r.CLAVE_REGULACION_REP)}, CLAVE_REP_GENERAL=${esc(r.CLAVE_REP_GENERAL)},
                FECHA_REGULACION=${r.FECHA_REGULACION && !isNaN(new Date(r.FECHA_REGULACION)) ? esc(r.FECHA_REGULACION) : 'NULL'},
                VERSION_CARGA=${esc(version)}, FECHA_ACTUALIZADA=GETDATE()
              WHERE CLAVE_REP=${esc(clave)}
            `);
            actualizados++;
          } else if (versionCambio) {
            // Rama B.2: solo cambió VERSION_CARGA (otros campos sin cambios).
            // Actualizar únicamente la versión para reflejar cambios menores.
            await query(`
              UPDATE INVENTARIO_REPORTES SET VERSION_CARGA=${esc(version)}, FECHA_ACTUALIZADA=GETDATE()
              WHERE CLAVE_REP=${esc(clave)}
            `);
            actualizados++;
          }
          // Rama B.3: sin cambios → no tocar inventario (evita timestamp innecesario).
        }
        // ── Paso 2: registrar en historial y versiones (solo si es nueva combo CLAVE_REP|VERSION_CARGA) ──
        // INVENTARIO_REPORTES_HIST: snapshot de cada versión del reporte (auditoría de cambios).
        // INVENTARIO_VERSIONES: registro de que existe esa versión (metadata general).
        try {
          const existeHist = await query(`SELECT 1 FROM INVENTARIO_REPORTES_HIST WHERE CLAVE_REP=${esc(clave)} AND VERSION_CARGA=${esc(version)}`);
          if (!existeHist.length) {  // Si es nueva combo, insertar en ambas tablas.
            await query(`
              INSERT INTO INVENTARIO_REPORTES_HIST
                (CLAVE_REP, VERSION_CARGA, CLAVE_PAIS, CLAVE_ENTIDADREGULADA, CLAVE_REG,
                 CLAVE_SERIE, SUBSERIE, CLAVE_GRUPO, REPORTE, CLAVE_SECCION_REP,
                 CLAVE_VERSION_REPORTE, CLAVE_PERIODO, DESCRIPCION_ESP, CLAVE_FECHA_ENT_REP,
                 CARACTERISTICAS, CLAVE_REGULACION_REP, CLAVE_REP_GENERAL, FECHA_REGULACION)
              VALUES
                (${esc(clave)}, ${esc(version)}, ${esc(r.CLAVE_PAIS)}, ${esc(r.CLAVE_ENTIDADREGULADA)}, ${esc(r.CLAVE_REG)},
                 ${esc(r.CLAVE_SERIE)}, ${esc(r.SUBSERIE)}, ${esc(r.CLAVE_GRUPO)}, ${esc(r.REPORTE)}, ${esc(r.CLAVE_SECCION_REP)},
                 ${esc(r.CLAVE_VERSION_REPORTE)}, ${esc(r.CLAVE_PERIODO)}, ${esc(r.DESCRIPCION_ESP)}, ${esc(r.CLAVE_FECHA_ENT_REP)},
                 ${esc(r.CARACTERISTICAS)}, ${esc(r.CLAVE_REGULACION_REP)}, ${esc(r.CLAVE_REP_GENERAL)},
                 ${r.FECHA_REGULACION ? esc(r.FECHA_REGULACION) : 'NULL'})
            `);
            await query(`
              INSERT INTO INVENTARIO_VERSIONES (TIPO_OBJETO, CLAVE_OBJ, VERSION, REGULACION, TIPO_VERSION, DESCRIPCION, ESTATUS, USUARIO)
              VALUES ('REPORTE', ${esc(clave)}, ${esc(version)}, ${esc(regulacion)}, ${esc(tipo_ver_row)}, ${esc(descripcion_row)}, 'IDENTIFICADO', ${esc(usuario)})
            `);
          }
        } catch(e3) { console.warn('[inv-rep-hist] error:', e3.message); }
        combos.push({
          CLAVE_REP: clave,
          CLAVE_REP_GENERAL: String(r.CLAVE_REP_GENERAL || '').trim(),
          PLATAFORMA: plataformaRow,
          VERSION: version
        });
      } catch(e2) { console.error('[upload-rep] fila error:', e2.message); errores++; }
    }
    await auditLog(usuario, 'inventario-reportes', 'UPLOAD', {
      archivo: req.file.originalname, insertados, actualizados, errores, respaldo_previo,
      cambios: cambiosDetalle.slice(0, 100),
      combos: combos.slice(0, 200).map(c => ({ clave_rep: c.CLAVE_REP, plataforma: c.PLATAFORMA || null, version: c.VERSION }))
    });
    res.json({ ok: true, insertados, actualizados, errores,
      reportes: rows.map(r => ({ CLAVE_REP: String(r.CLAVE_REP||'').trim(), CLAVE_REP_GENERAL: String(r.CLAVE_REP_GENERAL||'').trim() })).filter(r => r.CLAVE_REP),
      combos });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── POST /inventario-reportes/preview-combos
// Descripción: valida qué combinaciones reporte+plataforma+versión existen en ESTATUS_REPORTE
// sin hacer cambios (solo lectura, para preview antes de confirmar).
// Parámetros body: combos (array de {clave_rep, plataforma, version}).
// Tablas: ESTATUS_REPORTE, INVENTARIO_REPORTES.
// Respuesta: combos (array con existe: true/false), inventario (mapa de VERSION_CARGA actuales).
// Sin bitácora (consulta de solo lectura).
router.post('/inventario-reportes/preview-combos', requireAuth, async (req, res) => {
  try {
    const { combos = [] } = req.body;
    const resultado = [];
    for (const c of combos) {
      const clave_rep  = String(c.clave_rep || '').trim();
      const plataforma = String(c.plataforma || '').trim();
      const version    = String(c.version || '').trim();
      let existe = false;
      if (clave_rep && plataforma && version) {
        const r = await query(`
          SELECT 1 FROM ESTATUS_REPORTE
          WHERE CLAVE_REP=${esc(clave_rep)} AND CLAVE_PLATAFORMA=${esc(plataforma)}
            AND VERSION_CARGA=${esc(version)}
        `);
        existe = r.length > 0;
      }
      resultado.push({ clave_rep, plataforma, version, existe });
    }
    // Versión actual en INVENTARIO_REPORTES por clave (para mostrar el cambio)
    const claves = [...new Set(resultado.map(c => c.clave_rep).filter(Boolean))];
    const inventario = {};
    if (claves.length) {
      const vals = claves.map(c => `(${esc(c)})`).join(',');
      const rows = await query(`
        SELECT LTRIM(RTRIM(ir.CLAVE_REP)) AS CLAVE_REP, ir.VERSION_CARGA
        FROM INVENTARIO_REPORTES ir
        JOIN (VALUES ${vals}) AS t(c) ON LTRIM(RTRIM(ir.CLAVE_REP)) = LTRIM(RTRIM(t.c))
      `);
      rows.forEach(r => { inventario[r.CLAVE_REP] = r.VERSION_CARGA; });
    }
    res.json({ ok: true, combos: resultado, inventario });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── POST /inventario-reportes/asignar-plataformas
// Descripción: crea nuevas combinaciones reporte+plataforma+versión en ESTATUS_REPORTE
// (asignación masiva de plataformas a reportes después de carga de inventario).
// Parámetros body: asignaciones (array de {clave_rep, clave_rep_general, plataforma, version}).
// Tablas: ESTATUS_REPORTE (INSERT), CAT_REPORTES_GENERALES (auto-insert si no existe).
// Lógica: UPSERT por (CLAVE_REP, CLAVE_PLATAFORMA, VERSION_CARGA).
//         Omite si ya existe (omitidos++).
// Bitácora: registra creados, omitidos, combos asignadas.
router.post('/inventario-reportes/asignar-plataformas', requireAuth, async (req, res) => {
  try {
    const { asignaciones = [] } = req.body;
    let creados = 0, omitidos = 0;
    for (const a of asignaciones) {
      const { clave_rep, clave_rep_general, plataforma, version = '1.0.0' } = a;
      // Checar por (CLAVE_REP, CLAVE_PLATAFORMA, VERSION_CARGA) exacto
      const existe = await query(`
        SELECT 1 FROM ESTATUS_REPORTE
        WHERE CLAVE_REP=${esc(clave_rep)} AND CLAVE_PLATAFORMA=${esc(plataforma)}
          AND VERSION_CARGA=${esc(version)}
      `);
      if (existe.length) { omitidos++; continue; }
      const repGeneral = clave_rep_general || clave_rep;
      // Asegurar que CLAVE_REP_GENERAL existe en CAT_REPORTES_GENERALES
      if (repGeneral) {
        const existeGen = await query(`SELECT 1 FROM CAT_REPORTES_GENERALES WHERE CLAVE_REP_GENERAL=${esc(repGeneral)}`);
        if (!existeGen.length) await query(`INSERT INTO CAT_REPORTES_GENERALES (CLAVE_REP_GENERAL) VALUES (${esc(repGeneral)})`);
      }
      // Usar VERSION_CARGA como VERSION para que el PK sea único por versión
      await query(`
        INSERT INTO ESTATUS_REPORTE
          (CLAVE_REP, CLAVE_REP_GENERAL, CLAVE_PLATAFORMA, VERSION, VERSION_CARGA,
           DOCUMENTADO, PROGRAMADO, CERTIFICADO, ESTATUS)
        VALUES
          (${esc(clave_rep)}, ${esc(repGeneral)}, ${esc(plataforma)}, ${esc(version)}, ${esc(version)},
           'NO', 'NO', 'NO', 'NO DOCUMENTADO')
      `);
      creados++;
    }
    const usuario = req.session.user?.username || 'sistema';
    await auditLog(usuario, 'estatus-reporte', 'CREAR_COMBINACIONES', {
      creados, omitidos,
      combos: asignaciones.slice(0, 200).map(a => ({ clave_rep: a.clave_rep, plataforma: a.plataforma, version: a.version || '1.0.0' }))
    });
    res.json({ ok: true, creados, omitidos });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── POST /inventario-validaciones/check
// Descripción: valida qué validaciones/versiones de un Excel ya existen en BD.
// Parámetros body:
//   - version: VERSION_CARGA a verificar (requerida).
//   - claves_rep: array de CLAVE_REP a validar (opcional).
//   - claves_validacion: array de CLAVE_VALIDACION a verificar (opcional).
// Tablas: INVENTARIO_VERSIONES, INVENTARIO_REPORTES.
// Respuesta: version_existe, version_count, claves_rep_invalidas.
// Sin bitácora (consulta de solo lectura).
router.post('/inventario-validaciones/check', requireAuth, async (req, res) => {
  try {
    const { version, claves_rep = [], claves_validacion = [] } = req.body;
    let version_count = 0;
    if (claves_validacion.length) {
      // Contar exactamente las CLAVE_VALIDACION del Excel que ya tienen esa versión
      const valsVal = claves_validacion.map(c => `(${esc(c)})`).join(',');
      const vCheck = await query(`
        SELECT COUNT(*) AS cnt FROM INVENTARIO_VERSIONES
        WHERE TIPO_OBJETO='VALIDACION'
          AND VERSION=${esc(version)}
          AND CLAVE_OBJ IN (SELECT c FROM (VALUES ${valsVal}) AS t(c))
      `);
      version_count = vCheck[0].cnt;
    }
    let invalidas = [];
    if (claves_rep.length) {
      const vals = claves_rep.map(c => `(${esc(c)})`).join(',');
      const rows = await query(`SELECT t.c FROM (VALUES ${vals}) AS t(c) WHERE NOT EXISTS (SELECT 1 FROM INVENTARIO_REPORTES WHERE LTRIM(RTRIM(CLAVE_REP)) = LTRIM(RTRIM(t.c)))`);
      invalidas = rows.map(r => r.c);
    }
    res.json({ ok: true, version_existe: version_count > 0, version_count, claves_rep_invalidas: invalidas });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── POST /inventario-validaciones/upload
// Descripción: carga masiva de validaciones desde Excel con lógica robusta:
//   1. Lectura de filas y normalización.
//   2. Batch INSERT en INVENTARIO_VALIDACIONES (nuevas claves).
//   3. Batch UPDATE en INVENTARIO_VALIDACIONES (claves existentes).
//   4. Batch INSERT en INVENTARIO_VALIDACIONES_HIST (nuevas combos).
//   5. Batch INSERT en INVENTARIO_VERSIONES (si force=true, DELETE primero).
// Parámetros form:
//   - archivo: file (Excel con CLAVE_VALIDACION, CLAVE_REP, ...).
//   - version: VERSION_CARGA (default '1.0.0').
//   - regulacion, tipo_version, descripcion: metadata.
//   - force: 'true' para recargar versiones (DELETE + INSERT en INVENTARIO_VERSIONES).
// Tablas:
//   - INVENTARIO_VALIDACIONES (INSERT/UPDATE batch).
//   - INVENTARIO_VALIDACIONES_HIST (INSERT batch).
//   - INVENTARIO_VERSIONES (INSERT batch, DELETE opcional).
// Chunk size: 200 filas por batch (balance entre tamaño SQL y cantidad de queries).
// Bitácora: insertados, actualizados, errores, validaciones.
// Respuesta: insertados, actualizados, errores, validaciones procesadas.
router.post('/inventario-validaciones/upload', requireAuth, upload.single('archivo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, message: 'No se recibió archivo' });
  try {
    const usuario      = req.session.user?.username || 'sistema';
    const version      = (req.body.version      || '1.0.0').trim();
    const regulacion   = (req.body.regulacion   || '').trim();
    const force        = req.body.force === 'true';
    const tipo_version = (req.body.tipo_version || 'BASE').trim();
    const descripcion  = (req.body.descripcion  || '').trim();

    const wb   = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws   = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

    // ── Paso 0: normalizar filas válidas (trim + filter) ──
    const validas = rows.map(r => ({
      clave:    String(r.CLAVE_VALIDACION || '').trim(),
      claveRep: String(r.CLAVE_REP || '').trim(),
      pais:     String(r.CLAVE_PAIS || '').trim(),
      entidad:  String(r.CLAVE_ENTIDADREGULADA || '').trim(),
      reg:      String(r.CLAVE_REG || '').trim(),
      idAnt:    String(r.ID_VALIDACION_ANT || '').trim(),
      desc:     String(r.DESCRIPCION_VALIDACION || '').trim(),
      tipo:     String(r.TIPO_VALIDACION || '').trim(),
      tipoCalc: String(r.TIPO_VALIDACION_CALC || '').trim(),
    })).filter(r => r.clave);

    // ── Paso 1: pre-cargar existentes (single query para performance) ──
    // Carga en SET para búsqueda O(1) al iterar filas del Excel.
    const existingRows = await query(`SELECT CLAVE_VALIDACION FROM INVENTARIO_VALIDACIONES`);
    const existingSet  = new Set(existingRows.map(r => r.CLAVE_VALIDACION));

    const existingHist = await query(`SELECT CLAVE_VALIDACION FROM INVENTARIO_VALIDACIONES_HIST WHERE VERSION_CARGA=${esc(version)}`);
    const existingHistSet = new Set(existingHist.map(r => r.CLAVE_VALIDACION));

    // Segmentar filas: INSERT si es nueva, UPDATE si existe, HIST si es nueva combo versión.
    const toInsert = validas.filter(r => !existingSet.has(r.clave));
    const toUpdate = validas.filter(r =>  existingSet.has(r.clave));
    const toHist   = validas.filter(r => !existingHistSet.has(r.clave));

    const CHUNK = 200;  // Tamaño de batch: 200 filas por query (balance SQL/network).
    let insertados = 0, actualizados = 0, errores = 0;

    // ── Paso 2: Batch INSERT en INVENTARIO_VALIDACIONES (nuevas validaciones) ──
    for (let i = 0; i < toInsert.length; i += CHUNK) {
      const chunk = toInsert.slice(i, i + CHUNK);
      const vals  = chunk.map(r =>
        `(${esc(r.clave)},${esc(r.pais)},${esc(r.entidad)},${esc(r.reg)},${esc(r.claveRep)},` +
        `${esc(r.idAnt)},${esc(r.desc)},${esc(r.tipo)},${esc(r.tipoCalc)},${esc(version)},GETDATE())`
      ).join(',');
      try {
        await query(`INSERT INTO INVENTARIO_VALIDACIONES
          (CLAVE_VALIDACION,CLAVE_PAIS,CLAVE_ENTIDADREGULADA,CLAVE_REG,CLAVE_REP,
           ID_VALIDACION_ANT,DESCRIPCION_VALIDACION,TIPO_VALIDACION,TIPO_VALIDACION_CALC,VERSION_CARGA,FECHA_ALTA)
          VALUES ${vals}`);
        insertados += chunk.length;
      } catch(e) { console.error('[upload-val] batch insert error:', e.message); errores += chunk.length; }
    }

    // ── Paso 3: Batch UPDATE en INVENTARIO_VALIDACIONES (actualizar existentes) ──
    // Usa JOIN con VALUES temporal para actualizar solo campos que cambiaron.
    for (let i = 0; i < toUpdate.length; i += CHUNK) {
      const chunk = toUpdate.slice(i, i + CHUNK);
      const vals  = chunk.map(r =>
        `(${esc(r.clave)},${esc(r.claveRep)},${esc(r.desc)},${esc(r.tipo)},${esc(r.tipoCalc)})`
      ).join(',');
      try {
        await query(`
          UPDATE t SET
            t.CLAVE_REP=s.cr, t.DESCRIPCION_VALIDACION=s.dv,
            t.TIPO_VALIDACION=s.tv, t.TIPO_VALIDACION_CALC=s.tvc,
            t.VERSION_CARGA=${esc(version)}, t.FECHA_ACTUALIZADA=GETDATE()
          FROM INVENTARIO_VALIDACIONES t
          JOIN (VALUES ${vals}) AS s(cv,cr,dv,tv,tvc)
            ON t.CLAVE_VALIDACION = s.cv`);
        actualizados += chunk.length;
      } catch(e) { console.error('[upload-val] batch update error:', e.message); errores += chunk.length; }
    }

    // ── Paso 4: Batch INSERT en INVENTARIO_VALIDACIONES_HIST (historial de versiones) ──
    // Snapshot de cada versión de validaciones para auditoría.
    for (let i = 0; i < toHist.length; i += CHUNK) {
      const chunk = toHist.slice(i, i + CHUNK);
      const vals  = chunk.map(r =>
        `(${esc(r.clave)},${esc(version)},${esc(r.pais)},${esc(r.entidad)},${esc(r.reg)},` +
        `${esc(r.claveRep)},${esc(r.desc)},${esc(r.tipo)},${esc(r.tipoCalc)})`
      ).join(',');
      try {
        await query(`INSERT INTO INVENTARIO_VALIDACIONES_HIST
          (CLAVE_VALIDACION,VERSION_CARGA,CLAVE_PAIS,CLAVE_ENTIDADREGULADA,CLAVE_REG,
           CLAVE_REP,DESCRIPCION_VALIDACION,TIPO_VALIDACION,TIPO_VALIDACION_CALC)
          VALUES ${vals}`);
      } catch(e) { console.warn('[inv-val-hist] batch error:', e.message); }
    }

    // ── Paso 5: Batch INSERT en INVENTARIO_VERSIONES (registro de versión existente) ──
    // Si force=true, limpia versión anterior (permite recargar si cambió metadata).
    if (force) {
      const clavesList = validas.map(r => esc(r.clave)).join(',');
      try { await query(`DELETE FROM INVENTARIO_VERSIONES WHERE TIPO_OBJETO='VALIDACION' AND VERSION=${esc(version)} AND CLAVE_OBJ IN (${clavesList})`); }
      catch(e) { console.warn('[inv-versiones] delete error:', e.message); }
    }
    for (let i = 0; i < validas.length; i += CHUNK) {
      const chunk = validas.slice(i, i + CHUNK);
      const vals  = chunk.map(r =>
        `('VALIDACION',${esc(r.clave)},${esc(version)},${esc(regulacion)},${esc(tipo_version)},${esc(descripcion)},'IDENTIFICADO',${esc(usuario)})`
      ).join(',');
      try {
        await query(`INSERT INTO INVENTARIO_VERSIONES
          (TIPO_OBJETO,CLAVE_OBJ,VERSION,REGULACION,TIPO_VERSION,DESCRIPCION,ESTATUS,USUARIO)
          VALUES ${vals}`);
      } catch(e) { console.warn('[inv-versiones] batch error:', e.message); }
    }

    const validacionesProcesadas = validas.map(r => ({
      CLAVE_VALIDACION: r.clave, CLAVE_REP: r.claveRep,
      DESCRIPCION_VALIDACION: r.desc, TIPO_VALIDACION: r.tipo
    }));
    res.json({ ok: true, insertados, actualizados, errores, validaciones: validacionesProcesadas });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── GET /cat-plataformas
// Descripción: lista de plataformas disponibles en el catálogo.
// Tablas: CAT_PLATAFORMA.
// Sin bitácora (consulta de solo lectura).
router.get('/cat-plataformas', requireAuth, async (req, res) => {
  try {
    const rows = await query(`SELECT CLAVE_PLATAFORMA FROM CAT_PLATAFORMA ORDER BY CLAVE_PLATAFORMA`);
    res.json({ ok: true, data: rows.map(r => r.CLAVE_PLATAFORMA) });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── GET /cat-estatus
// Descripción: lista de estatus disponibles para reportes y validaciones.
// Tablas: CAT_ESTATUS, CAT_ESTATUSINT_REPVAL (JOIN para filtrar solo los usados).
// Sin bitácora (consulta de solo lectura).
router.get('/cat-estatus', requireAuth, async (req, res) => {
  try {
    const rows = await query(`
      SELECT ce.CLAVE_ESTATUS FROM CAT_ESTATUS ce
      INNER JOIN CAT_ESTATUSINT_REPVAL cv ON cv.CLAVE_ESTATUS = ce.CLAVE_ESTATUS
      ORDER BY cv.ID_ESTATUS
    `);
    res.json({ ok: true, data: rows.map(r => r.CLAVE_ESTATUS) });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── PUT /estatus-reporte/:id/version-cliente
// Descripción: marca/desmarca una versión de reporte como "versión cliente"
// (es decir, validada/aprobada por el cliente para ese contrato).
// Lógica: mutualmente exclusiva dentro de un grupo (clave_rep_base+plataforma),
// es decir, solo una versión puede ser VERSION_CLIENTE=1 para un contrato.
// Parámetros path: id (ID_ESTATUS_REP).
// Parámetros body:
//   - version_cliente: 1 para marcar, 0 para desmarcar.
//   - clave_rep_base, clave_plataforma, clave_contrato (para context, clave_contrato requerida).
// Tablas: CONTRATOS_VERSION_CLIENTE (UPSERT); AUDIT_LOG.
// Validaciones:
//   - Si version_cliente=1: desactiva otras versiones del mismo grupo en ese contrato.
//   - Si version_cliente=0: desactiva solo esta versión.
// Bitácora: registra id, clave_contrato, clave_rep_base, clave_plataforma, acción (MARCAR/DESMARCAR).
router.put('/estatus-reporte/:id/version-cliente', requireAuth, async (req, res) => {
  try {
    const { version_cliente, clave_rep_base, clave_plataforma, clave_contrato } = req.body;
    if (!clave_contrato) return res.status(400).json({ ok: false, message: 'Falta clave_contrato' });
    const id = parseInt(req.params.id);

    if (version_cliente) {
      // Desmarcar todos los demás del mismo grupo para este contrato
      if (clave_rep_base && clave_plataforma) {
        await query(`
          UPDATE CONTRATOS_VERSION_CLIENTE SET VERSION_CLIENTE=0
          WHERE CLAVE_CONTRATO = ${esc(clave_contrato)}
            AND VERSION_CLIENTE = 1
            AND ID_ESTATUS_REP IN (
              SELECT er.ID_ESTATUS_REP FROM ESTATUS_REPORTE er
              WHERE er.CLAVE_REP_GENERAL = ${esc(clave_rep_base)}
                AND er.CLAVE_PLATAFORMA = ${esc(clave_plataforma)}
                AND er.ID_ESTATUS_REP != ${id}
            )
        `);
      }
      // UPSERT el nuevo marcado
      const existe = await query(`SELECT 1 FROM CONTRATOS_VERSION_CLIENTE WHERE CLAVE_CONTRATO=${esc(clave_contrato)} AND ID_ESTATUS_REP=${id}`);
      if (existe.length) {
        await query(`UPDATE CONTRATOS_VERSION_CLIENTE SET VERSION_CLIENTE=1 WHERE CLAVE_CONTRATO=${esc(clave_contrato)} AND ID_ESTATUS_REP=${id}`);
      } else {
        await query(`INSERT INTO CONTRATOS_VERSION_CLIENTE (CLAVE_CONTRATO, ID_ESTATUS_REP, VERSION_CLIENTE) VALUES (${esc(clave_contrato)}, ${id}, 1)`);
      }
    } else {
      // Desmarcar — solo poner VERSION_CLIENTE=0, mantener fila por si tiene ESTATUS_PROYECTO
      await query(`UPDATE CONTRATOS_VERSION_CLIENTE SET VERSION_CLIENTE=0 WHERE CLAVE_CONTRATO=${esc(clave_contrato)} AND ID_ESTATUS_REP=${id}`);
    }
    const usuario = req.session.user?.username || 'sistema';
    await auditLog(usuario, 'contratos', version_cliente ? 'VERSION_CLIENTE_MARCAR' : 'VERSION_CLIENTE_DESMARCAR',
      { id_estatus_rep: id, clave_contrato, clave_rep_base, clave_plataforma });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── PUT /estatus-reporte/estatus
// Descripción: actualiza el ESTATUS secuencial (texto libre, estado de progreso)
// de un reporte, sin afectar las banderas DOCUMENTADO/PROGRAMADO/CERTIFICADO.
// Similar a /estatus-validacion/estatus pero para reportes.
// Parámetros body:
//   - clave_rep, clave_plataforma: identifican el reporte.
//   - estatus: nuevo ESTATUS.
//   - version: VERSION_CARGA (opcional, para especificar exacta).
//   - id_estatus_rep: ID_ESTATUS_REP (si viene, actualiza directo por ID + candado 404).
// Tablas: ESTATUS_REPORTE (UPDATE); AUDIT_LOG.
// Validaciones:
//   - Si id_estatus_rep: foto "antes" de esa fila, UPDATE directo.
//   - Si sin id pero existe el par + versión: UPDATE esa(s) fila(s).
//   - Si sin id y sin versión pero varias versiones existen: 409 pidiendo confirmación.
//   - Si no existe: INSERT alta nueva (si viene versión, usa esa; si no, NULL).
// Bitácora: registra antes/después (para versiones), filas_afectadas, version, confirmación si aplica.
router.put('/estatus-reporte/estatus', requireAuth, async (req, res) => {
  try {
    const { clave_rep, clave_plataforma, estatus, version, id_estatus_rep } = req.body;
    const usuario = req.session.user?.username || 'sistema';

    // Si viene ID, actualizar directamente por ID
    if (id_estatus_rep) {
      const antesRows = await query(`
        SELECT ID_ESTATUS_REP, VERSION_CARGA, ESTATUS
        FROM ESTATUS_REPORTE WHERE ID_ESTATUS_REP=${parseInt(id_estatus_rep)}
      `);
      // Candado: si el ID ya no existe, avisar en lugar de regresar un falso éxito
      if (!antesRows.length) {
        return res.status(404).json({
          ok: false,
          message: `El registro (ID ${id_estatus_rep}) ya no existe. No se modificó nada. Recarga la lista e intenta de nuevo.`
        });
      }
      await query(`
        UPDATE ESTATUS_REPORTE SET
          ESTATUS=${esc(estatus)}, FECHA_ESTATUS=GETDATE(), USER_ESTATUS=${esc(usuario)}
        WHERE ID_ESTATUS_REP=${parseInt(id_estatus_rep)}
      `);
      await auditLog(usuario, 'estatus-reporte', 'ESTATUS',
        { id_estatus_rep, clave_rep, clave_plataforma,
          version: antesRows[0].VERSION_CARGA == null ? 'NULL' : String(antesRows[0].VERSION_CARGA).trim(),
          estatus,
          filas_afectadas: antesRows.length, antes: antesRows[0],
          despues: { ESTATUS: estatus } });
      return res.json({ ok: true });
    }

    const versionFilter = version ? ` AND VERSION_CARGA=${esc(version)}` : '';
    const existe = await query(`
      SELECT 1 FROM ESTATUS_REPORTE
      WHERE CLAVE_REP=${esc(clave_rep)} AND CLAVE_PLATAFORMA=${esc(clave_plataforma)}${versionFilter}
    `);

    if (existe.length) {
      // Foto "antes" de las filas que se van a tocar (para bitácora)
      const antesRows = await query(`
        SELECT ID_ESTATUS_REP, VERSION_CARGA, ESTATUS
        FROM ESTATUS_REPORTE
        WHERE CLAVE_REP=${esc(clave_rep)} AND CLAVE_PLATAFORMA=${esc(clave_plataforma)}${versionFilter}
      `);
      // Candado: sin versión y con varias versiones en el par → pedir confirmación
      // explícita antes de tocar todas (evita planchar estatus de versiones históricas).
      if (!versionFilter && antesRows.length > 1 && !req.body.confirmar_todas) {
        const versiones = antesRows.map(a => a.VERSION_CARGA == null ? 'NULL' : String(a.VERSION_CARGA).trim());
        return res.status(409).json({
          ok: false, requiere_confirmacion: true, filas: antesRows.length, versiones,
          message: `${clave_rep} en ${clave_plataforma} tiene ${antesRows.length} versiones (${versiones.join(', ')}). Especifica la versión, o confirma que quieres aplicar a TODAS. No se modificó nada.`
        });
      }
      await query(`
        UPDATE ESTATUS_REPORTE SET
          ESTATUS=${esc(estatus)}, FECHA_ESTATUS=GETDATE(), USER_ESTATUS=${esc(usuario)}
        WHERE CLAVE_REP=${esc(clave_rep)} AND CLAVE_PLATAFORMA=${esc(clave_plataforma)}${versionFilter}
      `);
      await auditLog(usuario, 'estatus-reporte', 'ESTATUS',
        { clave_rep, clave_plataforma, version: version || 'todas', estatus,
          confirmo_todas: !version && antesRows.length > 1 ? true : undefined,
          filas_afectadas: antesRows.length, antes: antesRows.slice(0, 20), despues: { ESTATUS: estatus } });
      return res.json({ ok: true });
    } else if (version) {
      // La plataforma tiene registros pero NO con esa versión: rechazar en lugar
      // de crear un registro fantasma con una versión que no le corresponde.
      const existeGeneral = await query(`
        SELECT 1 FROM ESTATUS_REPORTE
        WHERE CLAVE_REP=${esc(clave_rep)} AND CLAVE_PLATAFORMA=${esc(clave_plataforma)}
      `);
      if (existeGeneral.length) {
        return res.status(400).json({
          ok: false,
          message: `La versión ${version} no existe para ${clave_rep} en ${clave_plataforma}. No se modificó nada.`
        });
      }
      // No hay ningún registro para esa clave+plataforma: alta nueva legítima
      const invRowV = await query(`SELECT CLAVE_REP_GENERAL FROM INVENTARIO_REPORTES WHERE CLAVE_REP=${esc(clave_rep)}`);
      const claveRepGeneralV = invRowV.length ? invRowV[0].CLAVE_REP_GENERAL : clave_rep;
      const existeRepGenV = await query(`SELECT 1 FROM CAT_REPORTES_GENERALES WHERE CLAVE_REP_GENERAL=${esc(claveRepGeneralV)}`);
      if (!existeRepGenV.length) await query(`INSERT INTO CAT_REPORTES_GENERALES (CLAVE_REP_GENERAL) VALUES (${esc(claveRepGeneralV)})`);
      await query(`
        INSERT INTO ESTATUS_REPORTE
          (CLAVE_REP, CLAVE_REP_GENERAL, CLAVE_PLATAFORMA, VERSION, VERSION_CARGA,
           DOCUMENTADO, PROGRAMADO, CERTIFICADO, ESTATUS, FECHA_ESTATUS, USER_ESTATUS)
        VALUES
          (${esc(clave_rep)}, ${esc(claveRepGeneralV)}, ${esc(clave_plataforma)}, '00', ${esc(version)},
           'NO', 'NO', 'NO', ${esc(estatus)}, GETDATE(), ${esc(usuario)})
      `);
    } else {
      const invRow = await query(`SELECT CLAVE_REP_GENERAL FROM INVENTARIO_REPORTES WHERE CLAVE_REP=${esc(clave_rep)}`);
      const claveRepGeneral = invRow.length ? invRow[0].CLAVE_REP_GENERAL : clave_rep;
      const existeRepGen2 = await query(`SELECT 1 FROM CAT_REPORTES_GENERALES WHERE CLAVE_REP_GENERAL=${esc(claveRepGeneral)}`);
      if (!existeRepGen2.length) await query(`INSERT INTO CAT_REPORTES_GENERALES (CLAVE_REP_GENERAL) VALUES (${esc(claveRepGeneral)})`);
      await query(`
        INSERT INTO ESTATUS_REPORTE
          (CLAVE_REP, CLAVE_REP_GENERAL, CLAVE_PLATAFORMA, VERSION, VERSION_CARGA,
           DOCUMENTADO, PROGRAMADO, CERTIFICADO, ESTATUS, FECHA_ESTATUS, USER_ESTATUS)
        VALUES
          (${esc(clave_rep)}, ${esc(claveRepGeneral)}, ${esc(clave_plataforma)}, '00', ${esc(version || null)},
           'NO', 'NO', 'NO', ${esc(estatus)}, GETDATE(), ${esc(usuario)})
      `);
    }
    await auditLog(usuario, 'estatus-reporte', 'ESTATUS',
      { clave_rep, clave_plataforma, version: version || null, estatus,
        alta_nueva: true, filas_afectadas: 1, antes: null, despues: { ESTATUS: estatus } });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── POST /inventario-validaciones/plataformas-asignadas
// Descripción: obtiene qué plataformas ya tienen asignada cada validación.
// Parámetros body: claves (array de CLAVE_VALIDACION).
// Tablas: REPORTE_VALIDACION.
// Respuesta: mapa {CLAVE_VALIDACION: [CLAVE_PLATAFORMA, ...], ...}.
// Sin bitácora (consulta de solo lectura).
router.post('/inventario-validaciones/plataformas-asignadas', requireAuth, async (req, res) => {
  try {
    const { claves = [] } = req.body;
    if (!claves.length) return res.json({ ok: true, data: {} });
    const vals = claves.map(c => `(${esc(c)})`).join(',');
    const rows = await query(`
      SELECT CLAVE_VALIDACION, CLAVE_PLATAFORMA
      FROM REPORTE_VALIDACION
      WHERE CLAVE_VALIDACION IN (SELECT c FROM (VALUES ${vals}) AS t(c))
    `);
    const data = {};
    for (const r of rows) {
      if (!data[r.CLAVE_VALIDACION]) data[r.CLAVE_VALIDACION] = [];
      data[r.CLAVE_VALIDACION].push(r.CLAVE_PLATAFORMA);
    }
    res.json({ ok: true, data });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── POST /inventario-validaciones/asignar-plataformas
// Descripción: crea asignaciones de plataformas a validaciones (nuevas combinaciones
// en REPORTE_VALIDACION). Permite una validación en múltiples reportes de múltiples plataformas.
// Parámetros body:
//   - asignaciones: array de {clave_validacion, clave_rep, tipo_validacion, descripcion, plataforma}.
//   - version: VERSION_CARGA (default '1.0.0').
// Tablas: REPORTE_VALIDACION (INSERT); AUDIT_LOG.
// Lógica: UPSERT por (CLAVE_VALIDACION, CLAVE_PLATAFORMA, CLAVE_REP).
//         Omite si ya existe (omitidos++), en otro caso inserta.
//         Esto permite compartir una validación entre reportes (flexibilidad).
// Bitácora: registra creados, omitidos.
router.post('/inventario-validaciones/asignar-plataformas', requireAuth, async (req, res) => {
  try {
    const { asignaciones = [], version = '1.0.0' } = req.body;
    let creados = 0, omitidos = 0;
    for (const a of asignaciones) {
      const { clave_validacion, clave_rep, tipo_validacion, descripcion, plataforma } = a;
      const existe = await query(`
        SELECT 1 FROM REPORTE_VALIDACION
        WHERE CLAVE_VALIDACION=${esc(clave_validacion)} AND CLAVE_PLATAFORMA=${esc(plataforma)} AND CLAVE_REP=${esc(clave_rep)}
      `);
      if (existe.length) { omitidos++; continue; }
      await query(`
        INSERT INTO REPORTE_VALIDACION
          (CLAVE_VALIDACION, CLAVE_REP, CLAVE_PLATAFORMA, TIPO_VALIDACION, DESCRIPCION, DOCUMENTADO, PROGRAMADO, CERTIFICADO, ESTATUS, VERSION, VERSION_CARGA)
        VALUES
          (${esc(clave_validacion)}, ${esc(clave_rep)}, ${esc(plataforma)}, ${esc(tipo_validacion)}, ${esc(descripcion)},
           'N', 'N', 'N', 'NO DOCUMENTADO', '0', ${esc(version)})
      `);
      creados++;
    }
    res.json({ ok: true, creados, omitidos });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── GET /inventario-validaciones/entidades
// Descripción: lista de entidades reguladas únicas en inventario de validaciones.
// Tablas: INVENTARIO_VALIDACIONES.
// Sin bitácora (consulta de solo lectura).
router.get('/inventario-validaciones/entidades', requireAuth, async (req, res) => {
  try {
    const rows = await query(`SELECT DISTINCT CLAVE_ENTIDADREGULADA FROM INVENTARIO_VALIDACIONES WHERE CLAVE_ENTIDADREGULADA IS NOT NULL ORDER BY CLAVE_ENTIDADREGULADA`);
    res.json({ ok: true, data: rows.map(r => r.CLAVE_ENTIDADREGULADA) });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── GET /inventario-validaciones/reportes-por-entidad
// Descripción: lista de reportes en inventario filtrados por entidad regulada.
// Parámetros query: entidad (CLAVE_ENTIDADREGULADA, opcional).
// Tablas: INVENTARIO_VALIDACIONES.
// Sin bitácora (consulta de solo lectura).
router.get('/inventario-validaciones/reportes-por-entidad', requireAuth, async (req, res) => {
  try {
    const entidad = (req.query.entidad || '').trim();
    const w = entidad ? `WHERE CLAVE_ENTIDADREGULADA=${esc(entidad)} AND CLAVE_REP IS NOT NULL` : `WHERE CLAVE_REP IS NOT NULL`;
    const rows = await query(`SELECT DISTINCT CLAVE_REP FROM INVENTARIO_VALIDACIONES ${w} ORDER BY CLAVE_REP`);
    res.json({ ok: true, data: rows.map(r => r.CLAVE_REP) });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── GET /inventario-validaciones/filtros
// Descripción: devuelve listas de valores únicos para filtros dinámicos
// (países, reguladores, tipos de validaciones).
// Tablas: INVENTARIO_VALIDACIONES.
// Sin bitácora (consulta de solo lectura).
router.get('/inventario-validaciones/filtros', requireAuth, async (req, res) => {
  try {
    const [paises, regs, tipos] = await Promise.all([
      query(`SELECT DISTINCT CLAVE_PAIS FROM INVENTARIO_VALIDACIONES WHERE CLAVE_PAIS IS NOT NULL ORDER BY CLAVE_PAIS`),
      query(`SELECT DISTINCT CLAVE_REG FROM INVENTARIO_VALIDACIONES WHERE CLAVE_REG IS NOT NULL ORDER BY CLAVE_REG`),
      query(`SELECT DISTINCT TIPO_VALIDACION FROM INVENTARIO_VALIDACIONES WHERE TIPO_VALIDACION IS NOT NULL ORDER BY TIPO_VALIDACION`)
    ]);
    res.json({ ok: true, data: {
      paises: paises.map(r => r.CLAVE_PAIS),
      regs:   regs.map(r => r.CLAVE_REG),
      tipos:  tipos.map(r => r.TIPO_VALIDACION)
    } });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── GET /inventario-validaciones/resumen
// Descripción: resumen del inventario: conteo de validaciones por reporte.
// Parámetros query:
//   - entidad, pais, reg, tipo: filtros opcionales.
//   - q: búsqueda de texto en CLAVE_VALIDACION, DESCRIPCION, CLAVE_REP.
// Tablas: INVENTARIO_VALIDACIONES, INVENTARIO_REPORTES (LEFT JOIN).
// Lógica: si hay búsqueda o tipo, solo reportes con validaciones que coincidan;
//         si no, todos los reportes (con COUNT = 0 si no tienen validaciones).
// Respuesta: array de {CLAVE_REP, VERSION_CARGA, TOTAL}.
// Sin bitácora (consulta de solo lectura).
router.get('/inventario-validaciones/resumen', requireAuth, async (req, res) => {
  try {
    const entidad = (req.query.entidad || '').trim();
    const pais    = (req.query.pais || '').trim();
    const reg     = (req.query.reg || '').trim();
    const tipo    = (req.query.tipo || '').trim();
    const q       = (req.query.q || '').trim();
    const pat     = q ? esc(`%${q}%`) : '';
    let rows;
    if (q || tipo) {
      // Rama A: con búsqueda de texto o tipo: filtrar validaciones, luego agrupar por reporte.
      const w = [
        entidad ? `CLAVE_ENTIDADREGULADA=${esc(entidad)}` : '',
        pais    ? `CLAVE_PAIS=${esc(pais)}` : '',
        reg     ? `CLAVE_REG=${esc(reg)}` : '',
        tipo    ? `TIPO_VALIDACION=${esc(tipo)}` : '',
        q       ? `(CLAVE_VALIDACION LIKE ${pat} OR DESCRIPCION_VALIDACION LIKE ${pat} OR CLAVE_REP LIKE ${pat})` : ''
      ].filter(Boolean).join(' AND ');
      rows = await query(`
        SELECT CLAVE_REP, VERSION_CARGA, COUNT(*) AS TOTAL
        FROM INVENTARIO_VALIDACIONES
        WHERE ${w}
        GROUP BY CLAVE_REP, VERSION_CARGA
        ORDER BY CLAVE_REP
      `);
    } else {
      // Rama B: sin búsqueda: todos los reportes (incluye reportes sin validaciones, COUNT=0).
      const conds = [
        entidad ? `CLAVE_ENTIDADREGULADA=${esc(entidad)}` : '',
        pais    ? `CLAVE_PAIS=${esc(pais)}` : '',
        reg     ? `CLAVE_REG=${esc(reg)}` : ''
      ].filter(Boolean).join(' AND ');
      const wBase = conds ? `WHERE ${conds}` : '';
      rows = await query(`
        SELECT base.CLAVE_REP, iv.VERSION_CARGA, COUNT(iv.CLAVE_VALIDACION) AS TOTAL
        FROM (
          SELECT CLAVE_REP FROM INVENTARIO_REPORTES ${wBase}
          UNION
          SELECT CLAVE_REP FROM INVENTARIO_VALIDACIONES ${wBase}
        ) base
        LEFT JOIN INVENTARIO_VALIDACIONES iv ON iv.CLAVE_REP = base.CLAVE_REP
        GROUP BY base.CLAVE_REP, iv.VERSION_CARGA
        ORDER BY base.CLAVE_REP
      `);
    }
    res.json({ ok: true, data: rows });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── GET /inventario-validaciones/estatus-minimo
// Descripción: para cada reporte, retorna el estatus MÁS ATRASADO de sus validaciones.
// Útil para ver el "cuello de botella" de un reporte (si una validación falta documentar,
// el reporte está atrasado).
// Parámetros query: entidad, pais, reg, tipo, q (filtros opcionales).
// Tablas: INVENTARIO_VALIDACIONES, REPORTE_VALIDACION (LEFT JOIN).
// Mapa de estatus: IDENTIFICADO=1, EN DOCUMENTACION=2, ..., CERTIFICADO=9, sin estatus=0.
// MIN_RANK: valor numérico del estatus más atrasado (menor = más atrasado).
// Sin bitácora (consulta de solo lectura).
router.get('/inventario-validaciones/estatus-minimo', requireAuth, async (req, res) => {
  try {
    const entidad = (req.query.entidad || '').trim();
    const pais    = (req.query.pais || '').trim();
    const reg     = (req.query.reg || '').trim();
    const tipo    = (req.query.tipo || '').trim();
    const q       = (req.query.q || '').trim();
    const pat     = q ? esc(`%${q}%`) : '';
    const w = [
      entidad ? `iv.CLAVE_ENTIDADREGULADA=${esc(entidad)}` : '',
      pais    ? `iv.CLAVE_PAIS=${esc(pais)}` : '',
      reg     ? `iv.CLAVE_REG=${esc(reg)}` : '',
      tipo    ? `iv.TIPO_VALIDACION=${esc(tipo)}` : '',
      q       ? `(iv.CLAVE_VALIDACION LIKE ${pat} OR iv.DESCRIPCION_VALIDACION LIKE ${pat} OR iv.CLAVE_REP LIKE ${pat})` : ''
    ].filter(Boolean).join(' AND ');
    const rows = await query(`
      SELECT iv.CLAVE_REP,
        MIN(CASE UPPER(LTRIM(RTRIM(rv.ESTATUS)))
          WHEN 'IDENTIFICADO'     THEN 1
          WHEN 'EN DOCUMENTACION' THEN 2
          WHEN 'DOCUMENTADO'      THEN 3
          WHEN 'EN ANALISIS PROG' THEN 4
          WHEN 'ANALIZADO'        THEN 5
          WHEN 'EN PROGRAMACION'  THEN 6
          WHEN 'PROGRAMADO'       THEN 7
          WHEN 'EN CERTIFICACION' THEN 8
          WHEN 'CERTIFICADO'      THEN 9
          ELSE 0 END) AS MIN_RANK
      FROM INVENTARIO_VALIDACIONES iv
      LEFT JOIN REPORTE_VALIDACION rv ON rv.CLAVE_VALIDACION = iv.CLAVE_VALIDACION
      ${w ? 'WHERE ' + w : ''}
      GROUP BY iv.CLAVE_REP
    `);
    res.json({ ok: true, data: rows });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── GET /inventario-validaciones/lista
// Descripción: lista de validaciones del inventario con filtros opcionales.
// Parámetros query: entidad, rep (CLAVE_REP), pais, reg, tipo.
// Tablas: INVENTARIO_VALIDACIONES, REPORTE_VALIDACION (LEFT JOIN).
// Respuesta: array con campos de inventario + estatus de proyecto (si existe).
// Sin bitácora (consulta de solo lectura).
router.get('/inventario-validaciones/lista', requireAuth, async (req, res) => {
  try {
    const entidad = (req.query.entidad || '').trim();
    const rep     = (req.query.rep || '').trim();
    const pais    = (req.query.pais || '').trim();
    const reg     = (req.query.reg || '').trim();
    const tipo    = (req.query.tipo || '').trim();
    const w = [
      entidad ? `iv.CLAVE_ENTIDADREGULADA=${esc(entidad)}` : '',
      rep     ? `iv.CLAVE_REP=${esc(rep)}` : '',
      pais    ? `iv.CLAVE_PAIS=${esc(pais)}` : '',
      reg     ? `iv.CLAVE_REG=${esc(reg)}` : '',
      tipo    ? `iv.TIPO_VALIDACION=${esc(tipo)}` : ''
    ].filter(Boolean).join(' AND ');
    const rows = await query(`
      SELECT
        iv.CLAVE_VALIDACION, iv.CLAVE_REP, iv.CLAVE_ENTIDADREGULADA,
        iv.CLAVE_REG, iv.DESCRIPCION_VALIDACION, iv.TIPO_VALIDACION,
        iv.TIPO_VALIDACION_CALC, iv.VERSION_CARGA,
        rv.CLAVE_PLATAFORMA, rv.ESTATUS, rv.DOCUMENTADO, rv.PROGRAMADO, rv.CERTIFICADO
      FROM INVENTARIO_VALIDACIONES iv
      LEFT JOIN REPORTE_VALIDACION rv ON rv.CLAVE_VALIDACION = iv.CLAVE_VALIDACION
      ${w ? 'WHERE ' + w : ''}
      ORDER BY iv.CLAVE_VALIDACION, rv.CLAVE_PLATAFORMA
    `);
    res.json({ ok: true, data: rows });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── Helper: detectar fila de headers en Excel ──
// Propósito: encontrar la fila que contiene encabezados (CLAVE_CONTRATO o CLAVE_REP).
// Busca en las primeras 5 filas. Soporta templates con títulos descriptivos arriba.
function _detectHeaderRow(ws) {
  const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
  for (let i = 0; i < Math.min(raw.length, 5); i++) {
    const h = (raw[i] || []).map(v => (v || '').toString().toUpperCase().trim());
    if (h.includes('CLAVE_CONTRATO') || h.includes('CLAVE_REP')) return i;
  }
  return 0;
}

// ── Helper: parseContratosExcel(buffer) ──
// Propósito: parsear Excel de contratos con dos hojas:
//   1. "CONTRATO": CLAVE_CONTRATO, NOMBRE_CONTRATO, CLAVE_CLIENTE, CLAVE_PLATAFORMA, CLAVE_PAIS, NOMBRE_CLIENTE, NOTAS.
//   2. "REPORTES": CLAVE_CONTRATO, CLAVE_REP.
// Retorna: {contratos: [...], reportes: [...]}.
function parseContratosExcel(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const wsC = wb.Sheets['CONTRATO'] || wb.Sheets[wb.SheetNames[0]];
  const wsR = wb.Sheets['REPORTES'] || wb.Sheets[wb.SheetNames[1]];
  const rawC = XLSX.utils.sheet_to_json(wsC, { defval: '', range: _detectHeaderRow(wsC) });
  const rawR = wsR ? XLSX.utils.sheet_to_json(wsR, { defval: '', range: _detectHeaderRow(wsR) }) : [];
  const contratos = rawC.map(r => ({
    clave:     String(r.CLAVE_CONTRATO   || '').trim(),
    nombre:    String(r.NOMBRE_CONTRATO  || '').trim(),
    pais:      String(r.CLAVE_PAIS       || 'MX').trim(),
    cliente:   String(r.CLAVE_CLIENTE    || '').trim(),
    nomCli:    String(r.NOMBRE_CLIENTE   || '').trim(),
    plataforma:String(r.CLAVE_PLATAFORMA || '').trim(),
    notas:     String(r.NOTAS || '').trim(),
  })).filter(r => r.clave && r.cliente && r.plataforma);
  const reportes = rawR.map(r => ({
    contrato: String(r.CLAVE_CONTRATO || '').trim(),
    rep:      String(r.CLAVE_REP      || '').trim(),
  })).filter(r => r.contrato && r.rep);
  return { contratos, reportes };
}

// ── POST /contratos/preview
// Descripción: preview de carga de Excel de contratos (solo lectura, sin guardar cambios).
// Permite al usuario ver qué se va a insertar/actualizar/desactivar antes de confirmar.
// Parámetros form: archivo (Excel con hojas CONTRATO y REPORTES).
// Tablas: CLIENTE, CONTRATOS, CONTRATOS_REPORTES, ESTATUS_REPORTE (solo lecturas).
// Respuesta: preview (array con análisis por contrato):
//   - clienteNuevo, contratoNuevo, totalReportes.
//   - repsNuevos, repsDesactivar, repsActualizar, repsInvalidos.
// Sin bitácora (consulta de solo lectura).
router.post('/contratos/preview', requireAuth, upload.single('archivo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, message: 'No se recibió archivo' });
  try {
    const { contratos, reportes } = parseContratosExcel(req.file.buffer);

    // Verificar existencia de clientes y contratos
    const preview = [];
    for (const c of contratos) {
      const [cliRow]  = await query(`SELECT NOMBRE_CLIENTE FROM CLIENTE WHERE CLAVE_CLIENTE=${esc(c.cliente)}`);
      const [contRow] = await query(`SELECT NOMBRE_CONTRATO FROM CONTRATOS WHERE CLAVE_CONTRATO=${esc(c.clave)}`);
      const repsContrato = reportes.filter(r => r.contrato === c.clave);

      // Reportes actuales en BD para este contrato
      const repsBD = await query(`SELECT CLAVE_REP FROM CONTRATOS_REPORTES WHERE CLAVE_CONTRATO=${esc(c.clave)} AND ACTIVO=1`);
      const repsBDSet = new Set(repsBD.map(r => r.CLAVE_REP));
      const repsExcelSet = new Set(repsContrato.map(r => r.rep));

      // Validar cuáles reportes existen en inventario para la plataforma
      const repsValidos = [], repsInvalidos = [];
      for (const r of repsContrato) {
        const existe = await query(`SELECT 1 FROM ESTATUS_REPORTE WHERE CLAVE_REP_GENERAL=${esc(r.rep)} AND CLAVE_PLATAFORMA=${esc(c.plataforma)}`);
        if (existe.length) repsValidos.push(r.rep);
        else repsInvalidos.push(r.rep);
      }

      preview.push({
        clave:        c.clave,
        nombre:       c.nombre,
        cliente:      c.cliente,
        nomCli:       cliRow ? cliRow.NOMBRE_CLIENTE : (c.nomCli || c.cliente),
        clienteNuevo: !cliRow,
        plataforma:   c.plataforma,
        contratoNuevo:!contRow,
        totalReportes: repsContrato.length,
        repsNuevos:     repsValidos.filter(r => !repsBDSet.has(r)),
        repsDesactivar: [...repsBDSet].filter(r => !repsExcelSet.has(r)),
        repsActualizar: repsValidos.filter(r => repsBDSet.has(r)),
        repsInvalidos,
      });
    }
    res.json({ ok: true, preview });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── POST /contratos/upload
// Descripción: carga real de Excel de contratos con INSERT/UPDATE de clientes y contratos,
// e INSERT/UPDATE/DESACTIVACIÓN de reportes asignados.
// Parámetros form: archivo (Excel con hojas CONTRATO y REPORTES).
// Tablas:
//   - CLIENTE (INSERT si no existe).
//   - CONTRATOS (INSERT o UPDATE).
//   - CONTRATOS_REPORTES (INSERT o UPDATE ACTIVO, y UPDATE ACTIVO=0 para no mencionados).
//   - AUDIT_LOG (bitácora por contrato).
// Lógica:
//   1. Por cada contrato: verificar/crear cliente, crear/actualizar contrato.
//   2. Insertar reportes nuevos (validar que existan en ESTATUS_REPORTE para la plataforma).
//   3. Actualizar reportes existentes (ACTIVO=1).
//   4. Desactivar reportes no mencionados en el Excel (ACTIVO=0).
// Validaciones:
//   - Reporte debe existir en ESTATUS_REPORTE para la plataforma (en otro caso, error + omitir).
// Bitácora: por contrato, registra clientes creados, contratos nuevos/actualizados, reportes (nuevos/desactivados).
// Respuesta: clientes/contratos/reportes con {insertados, actualizados, desactivados}, errores, errMsg.
router.post('/contratos/upload', requireAuth, upload.single('archivo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, message: 'No se recibió archivo' });
  try {
    const usuario = req.session.user?.username || 'sistema';
    const { contratos, reportes } = parseContratosExcel(req.file.buffer);

    let cliInsert = 0, contInsert = 0, contUpdate = 0;
    let repInsert = 0, repUpdate = 0, repDesactivar = 0, errores = 0, errMsg = null;

    for (const c of contratos) {
      try {
        // 1. CLIENTE — insertar si no existe
        const [cliRow] = await query(`SELECT 1 FROM CLIENTE WHERE CLAVE_CLIENTE=${esc(c.cliente)}`);
        if (!cliRow) {
          await query(`INSERT INTO CLIENTE (CLAVE_CLIENTE, NOMBRE_CLIENTE, CLAVE_PAIS, ACTIVO, FECHA_ALTA, FECHA_MODIFICA) VALUES (${esc(c.cliente)}, ${esc(c.nomCli || c.cliente)}, ${esc(c.pais)}, 1, GETDATE(), GETDATE())`);
          cliInsert++;
        }

        // 2. CONTRATO — insert o update
        const [contRow] = await query(`SELECT 1 FROM CONTRATOS WHERE CLAVE_CONTRATO=${esc(c.clave)}`);
        if (!contRow) {
          await query(`INSERT INTO CONTRATOS (CLAVE_CONTRATO, NOMBRE_CONTRATO, CLAVE_CLIENTE, CLAVE_PLATAFORMA, FECHA_ALTA, FECHA_MODIFICA)
            VALUES (${esc(c.clave)}, ${esc(c.nombre)}, ${esc(c.cliente)}, ${esc(c.plataforma)}, GETDATE(), GETDATE())`);
          contInsert++;
        } else {
          await query(`UPDATE CONTRATOS SET NOMBRE_CONTRATO=${esc(c.nombre)}, CLAVE_PLATAFORMA=${esc(c.plataforma)}, FECHA_MODIFICA=GETDATE()
            WHERE CLAVE_CONTRATO=${esc(c.clave)}`);
          contUpdate++;
        }

        // 3. CONTRATOS_REPORTES
        const repsContrato = reportes.filter(r => r.contrato === c.clave);
        const repsBD = await query(`SELECT CLAVE_REP FROM CONTRATOS_REPORTES WHERE CLAVE_CONTRATO=${esc(c.clave)}`);
        const repsBDSet = new Set(repsBD.map(r => r.CLAVE_REP));
        const repsExcelSet = new Set(repsContrato.map(r => r.rep));

        for (const r of repsContrato) {
          if (!repsBDSet.has(r.rep)) {
            // Validar que el reporte existe en el inventario para esta plataforma
            const existeER = await query(`SELECT 1 FROM ESTATUS_REPORTE WHERE CLAVE_REP_GENERAL=${esc(r.rep)} AND CLAVE_PLATAFORMA=${esc(c.plataforma)}`);
            if (!existeER.length) {
              errMsg = (errMsg ? errMsg + ', ' : '') + `${r.rep} no existe en inventario para ${c.plataforma}`;
              errores++;
              continue;
            }
            await query(`INSERT INTO CONTRATOS_REPORTES (CLAVE_CONTRATO, CLAVE_REP, ACTIVO)
              VALUES (${esc(c.clave)}, ${esc(r.rep)}, 1)`);
            repInsert++;
          } else {
            await query(`UPDATE CONTRATOS_REPORTES SET ACTIVO=1
              WHERE CLAVE_CONTRATO=${esc(c.clave)} AND CLAVE_REP=${esc(r.rep)}`);
            repUpdate++;
          }
        }

        // Desactivar reportes que ya no están en el Excel
        for (const rep of [...repsBDSet].filter(r => !repsExcelSet.has(r))) {
          await query(`UPDATE CONTRATOS_REPORTES SET ACTIVO=0 WHERE CLAVE_CONTRATO=${esc(c.clave)} AND CLAVE_REP=${esc(rep)}`);
          repDesactivar++;
        }

        await auditLog(usuario, 'upload-contratos', 'UPLOAD', {
          contrato: c.clave, cliente: c.cliente, plataforma: c.plataforma,
          reportes_nuevos: repInsert, reportes_desactivados: repDesactivar
        });
      } catch(e2) { console.error('[upload-contratos]', e2.message); errores++; errMsg = e2.message; }
    }

    res.json({ ok: true, clientes: { insertados: cliInsert }, contratos: { insertados: contInsert, actualizados: contUpdate },
      reportes: { insertados: repInsert, actualizados: repUpdate, desactivados: repDesactivar }, errores, errMsg: errMsg || null });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── GET /inventario-reportes/export
// Descripción: exporta inventario de reportes a Excel (descarga archivo .xlsx).
// Tablas: INVENTARIO_REPORTES.
// Headers: CLAVE_REP, CLAVE_PAIS, CLAVE_ENTIDADREGULADA, ..., VERSION_CARGA.
// Respuesta: archivo binario (application/vnd.openxmlformats-officedocument.spreadsheetml.sheet).
// Sin bitácora (exportación de solo lectura).
router.get('/inventario-reportes/export', requireAuth, async (req, res) => {
  try {
    const rows = await query(`
      SELECT CLAVE_REP, CLAVE_PAIS, CLAVE_ENTIDADREGULADA, CLAVE_REG,
             CLAVE_SERIE, SUBSERIE, CLAVE_GRUPO, REPORTE,
             CLAVE_SECCION_REP, CLAVE_VERSION_REPORTE, CLAVE_PERIODO,
             DESCRIPCION_ESP, CLAVE_FECHA_ENT_REP, CARACTERISTICAS,
             CLAVE_REGULACION_REP, CLAVE_REP_GENERAL, FECHA_REGULACION, VIGENTE,
             VERSION_CARGA
      FROM INVENTARIO_REPORTES
      ORDER BY CLAVE_REP
    `);
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, 'INVENTARIO_REPORTES');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename="inventario_reportes.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── GET /inventario/reportes
// Descripción: búsqueda rápida de reportes por CLAVE_REP o DESCRIPCION_ESP.
// Parámetros query: q (texto de búsqueda).
// Tablas: INVENTARIO_REPORTES.
// Límite: TOP 20 resultados.
// Sin bitácora (consulta de solo lectura).
router.get('/inventario/reportes', requireAuth, async (req, res) => {
  try {
    const q = req.query.q || '';
    const rows = await query(`
      SELECT TOP 20 CLAVE_REP, DESCRIPCION_ESP, CLAVE_ENTIDADREGULADA
      FROM INVENTARIO_REPORTES
      WHERE CLAVE_REP LIKE '%${q.replace(/'/g,"''")}%'
        OR DESCRIPCION_ESP LIKE '%${q.replace(/'/g,"''")}%'
      ORDER BY CLAVE_REP
    `);
    res.json({ ok: true, data: rows });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── GET /contratos/:clave/resumen
// Descripción: resumen de estatus de reportes para un contrato (para dashboard).
// Devuelve conteo de reportes por hito alcanzado.
// Parámetros path: clave (CLAVE_CONTRATO).
// Tablas: CONTRATOS_REPORTES, ESTATUS_REPORTE (LEFT JOIN).
// Respuesta: {documentados, programados, certificados, total}.
// Sin bitácora (consulta de solo lectura).
router.get('/contratos/:clave/resumen', requireAuth, async (req, res) => {
  try {
    const rows = await query(`
      SELECT
        SUM(CASE WHEN er.DOCUMENTADO='S' THEN 1 ELSE 0 END) AS documentados,
        SUM(CASE WHEN er.PROGRAMADO='S'  THEN 1 ELSE 0 END) AS programados,
        SUM(CASE WHEN er.CERTIFICADO='S' THEN 1 ELSE 0 END) AS certificados,
        COUNT(cr.CLAVE_REP) AS total
      FROM CONTRATOS_REPORTES cr
      LEFT JOIN ESTATUS_REPORTE er ON er.CLAVE_REP = cr.CLAVE_REP
      WHERE cr.CLAVE_CONTRATO=${esc(req.params.clave)}
    `);
    res.json({ ok: true, data: rows[0] });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

module.exports = router;
module.exports.warmCache = getRVClaves;
