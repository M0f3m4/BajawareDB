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
    const rows = await query(`
      SELECT
        cr.CLAVE_REP,
        cr.ETAPA,
        cr.EN_USO,
        cr.FECHA_ESTIMADA_QA,
        cr.FECHA_INSTALADO_QA,
        cr.FECHA_ESTIMADA_CERT,
        cr.FECHA_CERTIFICADO,
        cr.FECHA_ESTIMADA_PROD,
        cr.FECHA_INSTALADO_PROD,
        ir.DESCRIPCION_ESP,
        ir.CLAVE_ENTIDADREGULADA,
        COALESCE(ir.REPORTE, cr.CLAVE_REP) AS REPORTE,
        er.DOCUMENTADO,
        er.DOC_FECHA_REAL,
        er.PROGRAMADO,
        er.PROG_FECHA_REAL,
        er.CERTIFICADO,
        er.CERT_FECHA_REAL,
        er.ESTATUS,
        COALESCE(er.CLAVE_PLATAFORMA, c.CLAVE_PLATAFORMA) AS CLAVE_PLATAFORMA,
        er.VERSION,
        ir.VERSION_CARGA
      FROM CONTRATOS_REPORTES cr
      LEFT JOIN CONTRATOS c            ON c.CLAVE_CONTRATO = cr.CLAVE_CONTRATO
      LEFT JOIN INVENTARIO_REPORTES ir ON ir.CLAVE_REP_GENERAL = cr.CLAVE_REP
      LEFT JOIN ESTATUS_REPORTE er     ON er.CLAVE_REP_GENERAL = cr.CLAVE_REP
                                      AND er.CLAVE_PLATAFORMA = c.CLAVE_PLATAFORMA
      WHERE cr.CLAVE_CONTRATO=${esc(req.params.clave)}
      ORDER BY cr.CLAVE_REP
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
    const repFiltro    = req.query.rep || null; // CLAVE_REP base opcional
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
               rv.DOCUMENTADO, rv.DOC_FECHA_REAL, rv.PROGRAMADO, rv.PROG_FECHA_REAL,
               rv.CERTIFICADO, rv.CERT_FECHA_REAL, rv.ESTATUS, rv.CLAVE_PLATAFORMA, rv.VERSION, rv.VERSION_CARGA
        FROM REPORTE_VALIDACION rv
        WHERE rv.CLAVE_REP IN (${inList})
        ${platFilter}
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
               rv.DOCUMENTADO, rv.DOC_FECHA_REAL, rv.PROGRAMADO, rv.PROG_FECHA_REAL,
               rv.CERTIFICADO, rv.CERT_FECHA_REAL, rv.ESTATUS, rv.CLAVE_PLATAFORMA, rv.VERSION, rv.VERSION_CARGA
        FROM REPORTE_VALIDACION rv
        WHERE rv.CLAVE_REP IN (${inList})
        ${platFilter}
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
      SELECT TOP 20 DISTINCT cr.CLAVE_REP, ir.DESCRIPCION_ESP
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
    const { clave_rep, clave_plataforma, etapa, fecha, desmarcar } = req.body;
    const usuario  = req.session.user?.username || 'sistema';
    const fechaVal = fecha ? esc(fecha) : 'GETDATE()';

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

    const existe = await query(`
      SELECT 1 FROM ESTATUS_REPORTE
      WHERE CLAVE_REP_GENERAL=${esc(clave_rep)} AND CLAVE_PLATAFORMA=${esc(clave_plataforma)}
    `);

    if (existe.length) {
      await query(`
        UPDATE ESTATUS_REPORTE SET
          DOCUMENTADO=${docVal}, PROGRAMADO=${progVal}, CERTIFICADO=${certVal},
          ESTATUS=${esc(nuevoEstatus)}
        WHERE CLAVE_REP_GENERAL=${esc(clave_rep)} AND CLAVE_PLATAFORMA=${esc(clave_plataforma)}
      `);
    } else {
      await query(`
        INSERT INTO ESTATUS_REPORTE
          (CLAVE_REP, CLAVE_REP_GENERAL, CLAVE_PLATAFORMA, VERSION,
           DOCUMENTADO, PROGRAMADO, CERTIFICADO, ESTATUS)
        VALUES
          (${esc(clave_rep)}, ${esc(clave_rep)}, ${esc(clave_plataforma)}, '00',
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
      SELECT CLAVE_VALIDACION, CLAVE_REP, TIPO_VALIDACION, DESCRIPCION,
             DOCUMENTADO, PROGRAMADO, CERTIFICADO, ESTATUS, CLAVE_PLATAFORMA
      FROM REPORTE_VALIDACION
      WHERE CLAVE_REP IN (${inList}) ${wherePlat}
      ORDER BY CLAVE_REP, CLAVE_VALIDACION
    `);
    res.json({ ok: true, data: rows });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── PUT bulk update de validaciones ──────────────────────────────────────
router.put('/estatus-validacion-bulk', requireAuth, async (req, res) => {
  try {
    const { claves, clave_rep, clave_plataforma, etapa, fecha, desmarcar } = req.body;
    if (!claves?.length) return res.json({ ok: false, message: 'No hay validaciones seleccionadas' });
    const usuario  = req.session.user?.username || 'sistema';
    const fechaVal = fecha ? esc(fecha) : 'GETDATE()';

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
        WHERE CLAVE_VALIDACION=${esc(clave_validacion)} AND CLAVE_PLATAFORMA=${esc(clave_plataforma)}
      `);
      if (existe.length) {
        await query(`
          UPDATE REPORTE_VALIDACION SET
            DOCUMENTADO=${docVal}, PROGRAMADO=${progVal}, CERTIFICADO=${certVal},
            ESTATUS=${esc(nuevoEstatus)} ${docFecha}${progFecha}${certFecha}
          WHERE CLAVE_VALIDACION=${esc(clave_validacion)} AND CLAVE_PLATAFORMA=${esc(clave_plataforma)}
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
    const { version, claves_entidad = [], claves_rep = [] } = req.body;
    let version_count = 0;
    if (claves_rep.length) {
      const vals = claves_rep.map(c => `(${esc(c)})`).join(',');
      const vCheck = await query(`SELECT COUNT(*) AS cnt FROM INVENTARIO_VERSIONES WHERE TIPO_OBJETO='REPORTE' AND VERSION=${esc(version)} AND CLAVE_OBJ IN (SELECT c FROM (VALUES ${vals}) AS t(c))`);
      version_count = vCheck[0].cnt;
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
    const version     = (req.body.version     || '1.0.0').trim();
    const regulacion  = (req.body.regulacion  || '').trim();
    const tipo_version= (req.body.tipo_version|| 'BASE').trim();
    const descripcion = (req.body.descripcion || '').trim();
    const force       = req.body.force === 'true';

    const wb   = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws   = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
    let insertados = 0, actualizados = 0, errores = 0;
    for (const r of rows) {
      const clave = String(r.CLAVE_REP || '').trim();
      if (!clave) continue;
      try {
        const existe = await query(`SELECT 1 FROM INVENTARIO_REPORTES WHERE CLAVE_REP=${esc(clave)}`);
        if (!existe.length) {
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
              ${r.FECHA_REGULACION ? esc(r.FECHA_REGULACION) : 'NULL'},
              GETDATE(), GETDATE(), 1, ${esc(version)}
            )
          `);
          insertados++;
        } else {
          await query(`
            UPDATE INVENTARIO_REPORTES SET
              CLAVE_PAIS=${esc(r.CLAVE_PAIS)}, CLAVE_ENTIDADREGULADA=${esc(r.CLAVE_ENTIDADREGULADA)},
              CLAVE_REG=${esc(r.CLAVE_REG)}, CLAVE_SERIE=${esc(r.CLAVE_SERIE)},
              CLAVE_GRUPO=${esc(r.CLAVE_GRUPO)}, REPORTE=${esc(r.REPORTE)},
              CLAVE_SECCION_REP=${esc(r.CLAVE_SECCION_REP)}, CLAVE_VERSION_REPORTE=${esc(r.CLAVE_VERSION_REPORTE)},
              CLAVE_PERIODO=${esc(r.CLAVE_PERIODO)}, DESCRIPCION_ESP=${esc(r.DESCRIPCION_ESP)},
              CLAVE_REGULACION_REP=${esc(r.CLAVE_REGULACION_REP)}, CLAVE_REP_GENERAL=${esc(r.CLAVE_REP_GENERAL)},
              VERSION_CARGA=${esc(version)}, FECHA_ACTUALIZADA=GETDATE()
            WHERE CLAVE_REP=${esc(clave)}
          `);
          actualizados++;
        }
        // Registrar versión en INVENTARIO_VERSIONES
        try {
          if (force) {
            await query(`DELETE FROM INVENTARIO_VERSIONES WHERE TIPO_OBJETO='REPORTE' AND CLAVE_OBJ=${esc(clave)} AND VERSION=${esc(version)}`);
          }
          await query(`
            INSERT INTO INVENTARIO_VERSIONES (TIPO_OBJETO, CLAVE_OBJ, VERSION, REGULACION, TIPO_VERSION, DESCRIPCION, ESTATUS, USUARIO)
            VALUES ('REPORTE', ${esc(clave)}, ${esc(version)}, ${esc(regulacion)}, ${esc(tipo_version)}, ${esc(descripcion)}, 'IDENTIFICADO', ${esc(usuario)})
          `);
        } catch(e3) { console.warn('[inv-versiones-rep] error:', e3.message); }
      } catch(e2) { console.error('[upload-rep] fila error:', e2.message); errores++; }
    }
    res.json({ ok: true, insertados, actualizados, errores });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── POST check inventario validaciones ────────────────────
router.post('/inventario-validaciones/check', requireAuth, async (req, res) => {
  try {
    const { version, claves_rep = [], claves_validacion = [] } = req.body;
    let version_count = 0;
    if (claves_validacion.length) {
      const vals = claves_validacion.map(c => `(${esc(c)})`).join(',');
      const vCheck = await query(`SELECT COUNT(*) AS cnt FROM INVENTARIO_VERSIONES WHERE TIPO_OBJETO='VALIDACION' AND VERSION=${esc(version)} AND CLAVE_OBJ IN (SELECT c FROM (VALUES ${vals}) AS t(c))`);
      version_count = vCheck[0].cnt;
    }
    let invalidas = [];
    if (claves_rep.length) {
      const vals = claves_rep.map(c => `(${esc(c)})`).join(',');
      const rows = await query(`SELECT t.c FROM (VALUES ${vals}) AS t(c) WHERE NOT EXISTS (SELECT 1 FROM INVENTARIO_REPORTES WHERE CLAVE_REP = t.c)`);
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
    let insertados = 0, actualizados = 0, errores = 0;
    const validacionesProcesadas = [];

    for (const r of rows) {
      const clave    = String(r.CLAVE_VALIDACION || '').trim();
      const claveRep = String(r.CLAVE_REP || '').trim();
      if (!clave) continue;
      try {
        // Upsert en INVENTARIO_VALIDACIONES
        const existeInv = await query(`SELECT 1 FROM INVENTARIO_VALIDACIONES WHERE CLAVE_VALIDACION=${esc(clave)}`);
        if (!existeInv.length) {
          await query(`
            INSERT INTO INVENTARIO_VALIDACIONES
              (CLAVE_VALIDACION, CLAVE_PAIS, CLAVE_ENTIDADREGULADA, CLAVE_REG, CLAVE_REP,
               ID_VALIDACION_ANT, DESCRIPCION_VALIDACION, TIPO_VALIDACION, TIPO_VALIDACION_CALC, VERSION_CARGA, FECHA_ALTA)
            VALUES
              (${esc(clave)}, ${esc(r.CLAVE_PAIS)}, ${esc(r.CLAVE_ENTIDADREGULADA)}, ${esc(r.CLAVE_REG)}, ${esc(claveRep)},
               ${esc(r.ID_VALIDACION_ANT)}, ${esc(r.DESCRIPCION_VALIDACION)}, ${esc(r.TIPO_VALIDACION)}, ${esc(r.TIPO_VALIDACION_CALC)}, ${esc(version)}, GETDATE())
          `);
          insertados++;
        } else {
          await query(`
            UPDATE INVENTARIO_VALIDACIONES SET
              CLAVE_REP=${esc(claveRep)}, DESCRIPCION_VALIDACION=${esc(r.DESCRIPCION_VALIDACION)},
              TIPO_VALIDACION=${esc(r.TIPO_VALIDACION)}, VERSION_CARGA=${esc(version)}, FECHA_ACTUALIZADA=GETDATE()
            WHERE CLAVE_VALIDACION=${esc(clave)}
          `);
          actualizados++;
        }
        validacionesProcesadas.push({
          CLAVE_VALIDACION: clave,
          CLAVE_REP: claveRep,
          DESCRIPCION_VALIDACION: String(r.DESCRIPCION_VALIDACION || '').trim(),
          TIPO_VALIDACION: String(r.TIPO_VALIDACION || '').trim()
        });
        // Registrar en INVENTARIO_VERSIONES
        try {
          if (force) {
            await query(`DELETE FROM INVENTARIO_VERSIONES WHERE TIPO_OBJETO='VALIDACION' AND CLAVE_OBJ=${esc(clave)} AND VERSION=${esc(version)}`);
          }
          await query(`
            INSERT INTO INVENTARIO_VERSIONES (TIPO_OBJETO, CLAVE_OBJ, VERSION, REGULACION, TIPO_VERSION, DESCRIPCION, ESTATUS, USUARIO)
            VALUES ('VALIDACION', ${esc(clave)}, ${esc(version)}, ${esc(regulacion)}, ${esc(tipo_version)}, ${esc(descripcion)}, 'IDENTIFICADO', ${esc(usuario)})
          `);
        } catch(e3) { console.warn('[inv-versiones] error:', e3.message); }
      } catch(e2) { console.error('[upload-val] fila error:', e2.message); errores++; }
    }
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
router.post('/inventario-validaciones/asignar-plataformas', requireAuth, async (req, res) => {
  try {
    const { asignaciones = [], version = '1.0.0' } = req.body;
    // asignaciones: [{ clave_validacion, clave_rep, tipo_validacion, descripcion, plataforma }]
    let creados = 0, omitidos = 0;
    for (const a of asignaciones) {
      const { clave_validacion, clave_rep, tipo_validacion, descripcion, plataforma } = a;
      const existe = await query(`SELECT 1 FROM REPORTE_VALIDACION WHERE CLAVE_VALIDACION=${esc(clave_validacion)} AND CLAVE_PLATAFORMA=${esc(plataforma)}`);
      if (!existe.length) {
        await query(`
          INSERT INTO REPORTE_VALIDACION
            (CLAVE_VALIDACION, CLAVE_REP, CLAVE_PLATAFORMA, TIPO_VALIDACION, DESCRIPCION, DOCUMENTADO, PROGRAMADO, CERTIFICADO, ESTATUS, VERSION, VERSION_CARGA)
          VALUES
            (${esc(clave_validacion)}, ${esc(clave_rep)}, ${esc(plataforma)}, ${esc(tipo_validacion)}, ${esc(descripcion)},
             'N', 'N', 'N', 'NO DOCUMENTADO', '0', ${esc(version)})
        `);
        creados++;
      } else {
        omitidos++;
      }
    }
    res.json({ ok: true, creados, omitidos });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── POST carga Excel contratos (2 hojas) ──────────────────
router.post('/contratos/upload', requireAuth, upload.single('archivo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, message: 'No se recibió archivo' });
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });

    // Hoja CONTRATO
    const wsC  = wb.Sheets['CONTRATO'] || wb.Sheets[wb.SheetNames[0]];
    const cont = XLSX.utils.sheet_to_json(wsC, { defval: '' });
    let contInsert = 0, contErr = 0;
    for (const r of cont) {
      const clave = String(r.CLAVE_CONTRATO || '').trim();
      if (!clave) continue;
      try {
        const existe = await query(`SELECT 1 FROM CONTRATOS WHERE CLAVE_CONTRATO=${esc(clave)}`);
        if (!existe.length) {
          await query(`
            INSERT INTO CONTRATOS (CLAVE_CONTRATO, NOMBRE_CONTRATO, CLAVE_CLIENTE, CLAVE_PLATAFORMA, FECHA_ALTA, FECHA_MODIFICA)
            VALUES (${esc(clave)}, ${esc(r.NOMBRE_CONTRATO)}, ${esc(r.CLAVE_CLIENTE)}, ${esc(r.CLAVE_PLATAFORMA)}, GETDATE(), GETDATE())
          `);
          contInsert++;
        }
      } catch(e2) { contErr++; }
    }

    // Hoja REPORTES
    const wsR  = wb.Sheets['REPORTES'] || wb.Sheets[wb.SheetNames[1]];
    let repInsert = 0, repErr = 0;
    if (wsR) {
      const reps = XLSX.utils.sheet_to_json(wsR, { defval: '' });
      for (const r of reps) {
        const claveC = String(r.CLAVE_CONTRATO || '').trim();
        const claveR = String(r.CLAVE_REP || '').trim();
        if (!claveC || !claveR) continue;
        try {
          const existe = await query(`SELECT 1 FROM CONTRATOS_REPORTES WHERE CLAVE_CONTRATO=${esc(claveC)} AND CLAVE_REP=${esc(claveR)}`);
          if (!existe.length) {
            await query(`
              INSERT INTO CONTRATOS_REPORTES (CLAVE_CONTRATO, CLAVE_REP, FECHA_ESTIMADA_QA, FECHA_ESTIMADA_CERT, FECHA_ESTIMADA_PROD)
              VALUES (
                ${esc(claveC)}, ${esc(claveR)},
                ${r.FECHA_ESTIMADA_QA  ? esc(r.FECHA_ESTIMADA_QA)  : 'NULL'},
                ${r.FECHA_ESTIMADA_CERT ? esc(r.FECHA_ESTIMADA_CERT) : 'NULL'},
                ${r.FECHA_ESTIMADA_PROD ? esc(r.FECHA_ESTIMADA_PROD) : 'NULL'}
              )
            `);
            repInsert++;
          }
        } catch(e2) { repErr++; }
      }
    }

    res.json({ ok: true, contratos: { insertados: contInsert, errores: contErr }, reportes: { insertados: repInsert, errores: repErr } });
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
             CLAVE_REGULACION_REP, CLAVE_REP_GENERAL, FECHA_REGULACION, VIGENTE
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
