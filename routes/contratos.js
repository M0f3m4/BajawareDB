const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const XLSX    = require('xlsx');
const path    = require('path');
const { query } = require('../db/connection');

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ ok: false, message: 'No autenticado' });
  next();
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const esc = v => (v === null || v === undefined || v === '') ? 'NULL' : `'${String(v).trim().replace(/'/g,"''")}'`;

// ── GET historial de versiones ────────────────────────────
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

// ── POST migración masiva 1.0.0 ───────────────────────────
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

// Cache del DISTINCT CLAVE_REP de REPORTE_VALIDACION (scan lento de 431k filas — se hace UNA vez)
let _rvClavesCache = null;
let _rvCacheTime   = 0;
const RV_TTL = 10 * 60 * 1000; // 10 minutos

async function getRVClaves() {
  if (_rvClavesCache && Date.now() - _rvCacheTime < RV_TTL) return _rvClavesCache;
  console.log('[cache] refrescando DISTINCT CLAVE_REP de REPORTE_VALIDACION...');
  const rows = await query(`SELECT DISTINCT CLAVE_REP FROM REPORTE_VALIDACION`);
  _rvClavesCache = rows.map(r => r.CLAVE_REP);
  _rvCacheTime   = Date.now();
  console.log(`[cache] listo: ${_rvClavesCache.length} claves distintas`);
  return _rvClavesCache;
}

// ── CLIENTES ──────────────────────────────────────────────
router.get('/clientes', requireAuth, async (req, res) => {
  try {
    const rows = await query(`SELECT ID_CLIENTE, CLAVE_CLIENTE, NOMBRE_CLIENTE, CLAVE_PAIS, ACTIVO FROM CLIENTE WHERE ACTIVO=1 ORDER BY NOMBRE_CLIENTE`);
    res.json({ ok: true, data: rows });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── CLIENTES que tienen contratos ─────────────────────────
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

// ── GET lista de contratos con estatus ────────────────────
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

// ── PUT actualizar estatus y etapa de un contrato ─────────
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

// ── GET personalizaciones por estatus_reporte + contrato ──
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

// ── POST crear personalización ─────────────────────────────
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

// ── PUT editar personalización ─────────────────────────────
router.put('/personalizaciones/:id', requireAuth, async (req, res) => {
  try {
    const { subversion, estatus } = req.body;
    const usuario = req.session.user?.username || 'sistema';
    await query(`UPDATE PERSONALIZACIONES SET SUBVERSION=${esc(subversion)}, ESTATUS=${esc(estatus)} WHERE ID=${parseInt(req.params.id)}`);
    await auditLog(usuario, 'contratos', 'PERSONALIZACION_EDITAR', { id: req.params.id, subversion, estatus });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── DELETE personalización ─────────────────────────────────
router.delete('/personalizaciones/:id', requireAuth, async (req, res) => {
  try {
    const usuario = req.session.user?.username || 'sistema';
    await query(`DELETE FROM PERSONALIZACIONES WHERE ID=${parseInt(req.params.id)}`);
    await auditLog(usuario, 'contratos', 'PERSONALIZACION_BORRAR', { id: req.params.id });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── PUT actualizar estatus de reporte en contrato ─────────
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

// ── GET/PUT estatus proyecto de validaciones por contrato ──
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

// ── GET versión de validaciones del cliente por contrato+rep
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

// ── PUT marcar versión de validaciones del cliente ─────────
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

// ── CONTRATOS por cliente ─────────────────────────────────
router.get('/clientes/:clave/contratos', requireAuth, async (req, res) => {
  try {
    const rows = await query(`
      SELECT ID_CONTRATO, CLAVE_CONTRATO, NOMBRE_CONTRATO, CLAVE_PLATAFORMA, FECHA_ALTA
      FROM CONTRATOS WHERE CLAVE_CLIENTE=${esc(req.params.clave)} ORDER BY NOMBRE_CONTRATO
    `);
    res.json({ ok: true, data: rows });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── REPORTES por contrato + estatus ──────────────────────
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

// ── VALIDACIONES por contrato ─────────────────────────────
router.get('/contratos/:clave/validaciones', requireAuth, async (req, res) => {
  try {
    // Paso 1: CLAVE_REP base del contrato
    const claves = await query(`
      SELECT DISTINCT CLAVE_REP FROM CONTRATOS_REPORTES
      WHERE CLAVE_CONTRATO=${esc(req.params.clave)}
    `);
    if (!claves.length) return res.json({ ok: true, data: [] });

    // Paso 2: todos los CLAVE_REP distintos de REPORTE_VALIDACION (usa cache en memoria)
    const todosRV = await getRVClaves();

    // Paso 3: filtrar en JS cuáles versiones corresponden a las bases del contrato
    const baseSet = new Set(claves.map(r => r.CLAVE_REP));
    const matched = todosRV.filter(c => {
        if (baseSet.has(c)) return true;          // coincidencia exacta
        const i = c.lastIndexOf('_');
        return i > 0 && baseSet.has(c.slice(0, i)); // quitar sufijo _AÑO
      });

    if (!matched.length) return res.json({ ok: true, data: [] });

    // Paso 4: IN con los claves exactos → rápido aunque no haya índice
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

// ── VALIDACIONES por cliente (opcional: filtro por CLAVE_CLIENTE) ────────────
// ── REPORTES (CLAVE_REP base) por cliente ────────────────
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

// ── VALIDACIONES por cliente, filtradas por reporte ───────
// ?rep=CLAVE_REP_BASE → solo ese reporte (recomendado, rápido)
// sin ?rep            → todos los reportes del cliente (lento si hay muchos)
router.get('/clientes/:clave/validaciones', requireAuth, async (req, res) => {
  try {
    const claveCliente = req.params.clave;
    const repFiltro       = req.query.rep || null; // CLAVE_REP base opcional
    const versionCargaFiltro = req.query.version_carga || null; // filtrar por VERSION_CARGA
    const esTodos = claveCliente === 'todos';

    // -- Nombre del cliente + plataformas contratadas
    let nombreCliente = '';
    let platFilter = ''; // AND rv.CLAVE_PLATAFORMA IN (...)
    if (!esTodos) {
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

    // -- Si viene filtro por reporte, úsalo directo (evita cache + IN grande)
    let rows;
    if (repFiltro) {
      const base = repFiltro.replace(/'/g, "''");
      const todosRV = await getRVClaves();
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
      // -- Sin filtro: todos los reportes del cliente (puede ser lento)
      const clavesBQ = esTodos
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

    // -- Agregar CLAVE_UNICA solo cuando hay cliente seleccionado
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

// ── GET versiones de carga para un reporte (para dropdown) ─
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

// ── GET búsqueda por serie en ESTATUS_REPORTE ──────────────
// Devuelve todas las combinaciones reporte+plataforma+versión que coincidan
// con la serie/texto (ej. "ACLME") para agregarlas en bulk a la lista de marcado
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

// ── GET versiones de carga para validaciones de un reporte ─
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

// ── GET estatus de un reporte ─────────────────────────────
router.get('/estatus-reporte/:clave', requireAuth, async (req, res) => {
  try {
    const rows = await query(`
      SELECT * FROM ESTATUS_REPORTE WHERE CLAVE_REP=${esc(req.params.clave)}
    `);
    res.json({ ok: true, data: rows });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── Helper: insertar en AUDIT_LOG ────────────────────────
async function auditLog(usuario, seccion, accion, detalle) {
  try {
    const det = typeof detalle === 'object' ? JSON.stringify(detalle) : String(detalle);
    await query(`
      INSERT INTO AUDIT_LOG (USUARIO, SECCION, ACCION, DETALLE)
      VALUES (${esc(usuario)}, ${esc(seccion)}, ${esc(accion)}, ${esc(det)})
    `);
  } catch(e) { /* no bloquear el flujo principal si audit falla */ }
}

// ── CLIENTES que tienen un reporte contratado ─────────────
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

// ── Autocomplete de CLAVE_REP en CONTRATOS_REPORTES ──────
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

// ── GET bitácora de movimientos ───────────────────────────
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

// ── PUT actualizar estatus de reporte ─────────────────────
// Body: { clave_rep, clave_plataforma, etapa, fecha }
// etapa: 'DOCUMENTADO' | 'PROGRAMADO' | 'CERTIFICADO'
router.put('/estatus-reporte', requireAuth, async (req, res) => {
  try {
    const { clave_rep, clave_plataforma, etapa, fecha, desmarcar, version, id_estatus_rep } = req.body;
    const usuario       = req.session.user?.username || 'sistema';
    const fechaVal      = fecha ? esc(fecha) : 'GETDATE()';
    const versionFilter = version ? ` AND VERSION_CARGA=${esc(version)}` : '';

    // Cascada MARCAR:    CERT→doc+prog+cert | PROG→doc+prog | DOC→doc
    // Cascada DESMARCAR: DOC→los3           | PROG→prog+cert | CERT→cert
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

    // Si viene ID, actualizar directamente por ID (evita crear duplicados)
    if (id_estatus_rep) {
      await query(`
        UPDATE ESTATUS_REPORTE SET
          DOCUMENTADO=${docVal}, PROGRAMADO=${progVal}, CERTIFICADO=${certVal},
          ESTATUS=${esc(nuevoEstatus)}
        WHERE ID_ESTATUS_REP=${parseInt(id_estatus_rep)}
      `);
      await auditLog(usuario, 'estatus-reporte', desmarcar ? 'DESMARCAR' : 'MARCAR',
        { id_estatus_rep, clave_rep, clave_plataforma, etapa, resultado: nuevoEstatus });
      return res.json({ ok: true });
    }

    const existeExacto = await query(`
      SELECT 1 FROM ESTATUS_REPORTE
      WHERE CLAVE_REP=${esc(clave_rep)} AND CLAVE_PLATAFORMA=${esc(clave_plataforma)}${versionFilter}
    `);
    const existeGeneral = await query(`
      SELECT 1 FROM ESTATUS_REPORTE
      WHERE CLAVE_REP=${esc(clave_rep)} AND CLAVE_PLATAFORMA=${esc(clave_plataforma)}
    `);

    if (existeExacto.length || (!versionFilter && existeGeneral.length)) {
      await query(`
        UPDATE ESTATUS_REPORTE SET
          DOCUMENTADO=${docVal}, PROGRAMADO=${progVal}, CERTIFICADO=${certVal},
          ESTATUS=${esc(nuevoEstatus)}
          ${version ? `, VERSION_CARGA=${esc(version)}` : ''}
        WHERE CLAVE_REP=${esc(clave_rep)} AND CLAVE_PLATAFORMA=${esc(clave_plataforma)}${versionFilter}
      `);
    } else if (existeGeneral.length) {
      // La versión indicada NO existe para esa plataforma.
      // Antes aquí se reasignaba VERSION_CARGA a todos los registros de la
      // clave+plataforma (planchaba versiones de otras plataformas). Ahora se rechaza.
      return res.status(400).json({
        ok: false,
        message: `La versión ${version} no existe para ${clave_rep} en ${clave_plataforma}. No se modificó nada.`
      });
    } else {
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
      { clave_rep, clave_plataforma, etapa, resultado: nuevoEstatus });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── PUT actualizar estatus de validación ──────────────────
// Cascada MARCAR:    DOC→doc | PROG→doc+prog | CERT→doc+prog+cert
// Cascada DESMARCAR: DOC→los 3 | PROG→prog+cert | CERT→cert
// ── PUT actualizar estatus secuencial de validación ───────
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

router.put('/estatus-validacion', requireAuth, async (req, res) => {
  try {
    const { clave_validacion, clave_rep, clave_plataforma, etapa, fecha, desmarcar } = req.body;
    const usuario  = req.session.user?.username || 'sistema';
    const fechaVal = fecha ? esc(fecha) : 'GETDATE()';

    let docVal, progVal, certVal, nuevoEstatus;
    if (etapa === 'IDENTIFICADO') {
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

// ── GET validaciones de un reporte (para bulk update) ────────────────────
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

// ── PUT bulk update de validaciones ──────────────────────────────────────
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

// ── GET búsqueda de validaciones (para autocompletar en el form) ──────────
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

// ── POST check inventario reportes ────────────────────────
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

// ── POST carga Excel inventario reportes ──────────────────
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
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
    let insertados = 0, actualizados = 0, errores = 0;
    for (const r of rows) {
      const clave = String(r.CLAVE_REP || '').trim();
      if (!clave) continue;
      const version        = versionesMap    ? (versionesMap[clave]    || versionGlobal) : versionGlobal;
      const tipo_ver_row   = tiposMap        ? (tiposMap[clave]        || tipo_version)  : tipo_version;
      const descripcion_row = descripcionesMap ? (descripcionesMap[clave] || descripcion) : descripcion;
      try {
        const existeInv = await query(`
          SELECT CLAVE_PAIS, CLAVE_ENTIDADREGULADA, CLAVE_REG, CLAVE_SERIE, SUBSERIE,
                 CLAVE_GRUPO, REPORTE, CLAVE_SECCION_REP, CLAVE_VERSION_REPORTE, CLAVE_PERIODO,
                 DESCRIPCION_ESP, CLAVE_FECHA_ENT_REP, CARACTERISTICAS,
                 CLAVE_REGULACION_REP, CLAVE_REP_GENERAL, FECHA_REGULACION, VERSION_CARGA
          FROM INVENTARIO_REPORTES WHERE CLAVE_REP=${esc(clave)}`);
        // Auto-insertar en catálogos si la clave no existe (aplica a INSERT y UPDATE)
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
          // Reporte nuevo — INSERT
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
          // Comparar campos fila por fila — solo UPDATE si algo cambió
          const bd = existeInv[0];
          const str = v => (v == null ? '' : String(v).trim());
          const cambio =
            str(bd.CLAVE_PAIS)              !== str(r.CLAVE_PAIS)              ||
            str(bd.CLAVE_ENTIDADREGULADA)   !== str(r.CLAVE_ENTIDADREGULADA)   ||
            str(bd.CLAVE_REG)               !== str(r.CLAVE_REG)               ||
            str(bd.CLAVE_SERIE)             !== str(r.CLAVE_SERIE)             ||
            str(bd.SUBSERIE)                !== str(r.SUBSERIE)                ||
            str(bd.CLAVE_GRUPO)             !== str(r.CLAVE_GRUPO)             ||
            str(bd.REPORTE)                 !== str(r.REPORTE)                 ||
            str(bd.CLAVE_SECCION_REP)       !== str(r.CLAVE_SECCION_REP)       ||
            str(bd.CLAVE_VERSION_REPORTE)   !== str(r.CLAVE_VERSION_REPORTE)   ||
            str(bd.CLAVE_PERIODO)           !== str(r.CLAVE_PERIODO)           ||
            str(bd.DESCRIPCION_ESP)         !== str(r.DESCRIPCION_ESP)         ||
            str(bd.CLAVE_FECHA_ENT_REP)     !== str(r.CLAVE_FECHA_ENT_REP)     ||
            str(bd.CARACTERISTICAS)         !== str(r.CARACTERISTICAS)         ||
            str(bd.CLAVE_REGULACION_REP)    !== str(r.CLAVE_REGULACION_REP)    ||
            str(bd.CLAVE_REP_GENERAL)       !== str(r.CLAVE_REP_GENERAL)       ||
            str(bd.FECHA_REGULACION)        !== str(r.FECHA_REGULACION);

          const versionCambio = str(bd.VERSION_CARGA) !== str(version);
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
            // Solo cambió la versión — actualizar únicamente VERSION_CARGA
            await query(`
              UPDATE INVENTARIO_REPORTES SET VERSION_CARGA=${esc(version)}, FECHA_ACTUALIZADA=GETDATE()
              WHERE CLAVE_REP=${esc(clave)}
            `);
            actualizados++;
          }
          // Sin cambios — no toca inventario
        }
        // Registrar en hist y versiones solo si es nueva combinación CLAVE_REP + VERSION_CARGA
        try {
          const existeHist = await query(`SELECT 1 FROM INVENTARIO_REPORTES_HIST WHERE CLAVE_REP=${esc(clave)} AND VERSION_CARGA=${esc(version)}`);
          if (!existeHist.length) {
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
      } catch(e2) { console.error('[upload-rep] fila error:', e2.message); errores++; }
    }
    res.json({ ok: true, insertados, actualizados, errores, reportes: rows.map(r => ({ CLAVE_REP: String(r.CLAVE_REP||'').trim(), CLAVE_REP_GENERAL: String(r.CLAVE_REP_GENERAL||'').trim() })).filter(r => r.CLAVE_REP) });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── POST asignar plataformas a reportes ───────────────────
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
    res.json({ ok: true, creados, omitidos });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── POST check inventario validaciones ────────────────────
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

// ── POST carga Excel inventario validaciones ───────────────
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

    // Normalizar filas válidas
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

    // ── 1. Pre-cargar existentes en una sola query ──────────
    const existingRows = await query(`SELECT CLAVE_VALIDACION FROM INVENTARIO_VALIDACIONES`);
    const existingSet  = new Set(existingRows.map(r => r.CLAVE_VALIDACION));

    const existingHist = await query(`SELECT CLAVE_VALIDACION FROM INVENTARIO_VALIDACIONES_HIST WHERE VERSION_CARGA=${esc(version)}`);
    const existingHistSet = new Set(existingHist.map(r => r.CLAVE_VALIDACION));

    const toInsert = validas.filter(r => !existingSet.has(r.clave));
    const toUpdate = validas.filter(r =>  existingSet.has(r.clave));
    const toHist   = validas.filter(r => !existingHistSet.has(r.clave));

    const CHUNK = 200;
    let insertados = 0, actualizados = 0, errores = 0;

    // ── 2. Batch INSERT INVENTARIO_VALIDACIONES ─────────────
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

    // ── 3. Batch UPDATE usando MERGE ────────────────────────
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

    // ── 4. Batch INSERT INVENTARIO_VALIDACIONES_HIST ────────
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

    // ── 5. Batch INSERT INVENTARIO_VERSIONES ────────────────
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

// ── POST carga Excel contratos (2 hojas) ──────────────────
// Hoja "CONTRATO": CLAVE_CONTRATO, NOMBRE_CONTRATO, CLAVE_CLIENTE, CLAVE_PLATAFORMA
// Hoja "REPORTES": CLAVE_CONTRATO, CLAVE_REP, FECHA_ESTIMADA_QA, FECHA_ESTIMADA_CERT, FECHA_ESTIMADA_PROD
// ── GET catálogo de plataformas ───────────────────────────
router.get('/cat-plataformas', requireAuth, async (req, res) => {
  try {
    const rows = await query(`SELECT CLAVE_PLATAFORMA FROM CAT_PLATAFORMA ORDER BY CLAVE_PLATAFORMA`);
    res.json({ ok: true, data: rows.map(r => r.CLAVE_PLATAFORMA) });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── GET catálogo de estatus ───────────────────────────────
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

// ── PUT actualizar VERSION_CLIENTE en ESTATUS_REPORTE ────
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

// ── PUT actualizar estatus secuencial de reporte ──────────
router.put('/estatus-reporte/estatus', requireAuth, async (req, res) => {
  try {
    const { clave_rep, clave_plataforma, estatus, version, id_estatus_rep } = req.body;
    const usuario = req.session.user?.username || 'sistema';

    // Si viene ID, actualizar directamente por ID
    if (id_estatus_rep) {
      await query(`
        UPDATE ESTATUS_REPORTE SET
          ESTATUS=${esc(estatus)}, FECHA_ESTATUS=GETDATE(), USER_ESTATUS=${esc(usuario)}
        WHERE ID_ESTATUS_REP=${parseInt(id_estatus_rep)}
      `);
      await auditLog(usuario, 'estatus-reporte', 'ESTATUS', { id_estatus_rep, clave_rep, clave_plataforma, estatus });
      return res.json({ ok: true });
    }

    const versionFilter = version ? ` AND VERSION_CARGA=${esc(version)}` : '';
    const existe = await query(`
      SELECT 1 FROM ESTATUS_REPORTE
      WHERE CLAVE_REP=${esc(clave_rep)} AND CLAVE_PLATAFORMA=${esc(clave_plataforma)}${versionFilter}
    `);

    if (existe.length) {
      await query(`
        UPDATE ESTATUS_REPORTE SET
          ESTATUS=${esc(estatus)}, FECHA_ESTATUS=GETDATE(), USER_ESTATUS=${esc(usuario)}
        WHERE CLAVE_REP=${esc(clave_rep)} AND CLAVE_PLATAFORMA=${esc(clave_plataforma)}${versionFilter}
      `);
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
      { clave_rep, clave_plataforma, version: version || 'todas', estatus });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── POST plataformas ya asignadas a lista de validaciones ─
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

// ── POST asignar plataformas a validaciones ────────────────
// Lógica: (CLAVE_VALIDACION, CLAVE_PLATAFORMA, CLAVE_REP) exacto existe → omitir
//         no existe esa combinación exacta → insertar (permite compartir validaciones entre reportes)
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

// ── GET entidades del inventario de validaciones ──────────
router.get('/inventario-validaciones/entidades', requireAuth, async (req, res) => {
  try {
    const rows = await query(`SELECT DISTINCT CLAVE_ENTIDADREGULADA FROM INVENTARIO_VALIDACIONES WHERE CLAVE_ENTIDADREGULADA IS NOT NULL ORDER BY CLAVE_ENTIDADREGULADA`);
    res.json({ ok: true, data: rows.map(r => r.CLAVE_ENTIDADREGULADA) });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── GET reportes del inventario filtrados por entidad ─────
router.get('/inventario-validaciones/reportes-por-entidad', requireAuth, async (req, res) => {
  try {
    const entidad = (req.query.entidad || '').trim();
    const w = entidad ? `WHERE CLAVE_ENTIDADREGULADA=${esc(entidad)} AND CLAVE_REP IS NOT NULL` : `WHERE CLAVE_REP IS NOT NULL`;
    const rows = await query(`SELECT DISTINCT CLAVE_REP FROM INVENTARIO_VALIDACIONES ${w} ORDER BY CLAVE_REP`);
    res.json({ ok: true, data: rows.map(r => r.CLAVE_REP) });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── GET filtros del inventario de validaciones ─────────────
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

// ── GET resumen del inventario: conteo de validaciones por reporte ─
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
      // Con búsqueda de texto o tipo: solo reportes con validaciones que coincidan
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
      // Sin búsqueda: todos los reportes del inventario, con conteo 0 si no tienen validaciones
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

// ── GET estatus mínimo de validación por reporte ──────────
// Regresa por CLAVE_REP el estatus más atrasado de sus validaciones
// (orden: IDENTIFICADO=1 ... CERTIFICADO=9; sin estatus=0)
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

// ── GET validaciones del inventario por entidad + reporte ─
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

// ── helper: detectar fila de headers ─────────────────────
function _detectHeaderRow(ws) {
  const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
  for (let i = 0; i < Math.min(raw.length, 5); i++) {
    const h = (raw[i] || []).map(v => (v || '').toString().toUpperCase().trim());
    if (h.includes('CLAVE_CONTRATO') || h.includes('CLAVE_REP')) return i;
  }
  return 0;
}

// ── helpers para parsear Excel de contratos ───────────────
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

// ── POST /contratos/preview — analiza sin guardar ─────────
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

// ── POST /contratos/upload — carga real ───────────────────
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

// ── GET exportar inventario reportes a Excel ──────────────
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

// ── GET búsqueda inventario reportes ─────────────────────
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

// ── GET resumen de estatus por contrato (para dashboard) ──
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
