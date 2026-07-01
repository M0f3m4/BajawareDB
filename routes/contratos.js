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
        er.VERSION
      FROM CONTRATOS_REPORTES cr
      LEFT JOIN CONTRATOS c            ON c.CLAVE_CONTRATO = cr.CLAVE_CONTRATO
      LEFT JOIN INVENTARIO_REPORTES ir ON ir.CLAVE_REP = cr.CLAVE_REP
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
        rv.CERTIFICADO, rv.CERT_FECHA_REAL, rv.ESTATUS, rv.CLAVE_PLATAFORMA, rv.VERSION
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

    // -- Nombre del cliente (si aplica)
    let nombreCliente = '';
    if (!esTodos) {
      const [cli] = await query(`SELECT NOMBRE_CLIENTE FROM CLIENTE WHERE CLAVE_CLIENTE=${esc(claveCliente)}`);
      if (!cli) return res.json({ ok: true, data: [], cliente: '' });
      nombreCliente = cli.NOMBRE_CLIENTE;
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
               rv.CERTIFICADO, rv.CERT_FECHA_REAL, rv.ESTATUS, rv.CLAVE_PLATAFORMA, rv.VERSION
        FROM REPORTE_VALIDACION rv
        WHERE rv.CLAVE_REP IN (${inList})
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
               rv.CERTIFICADO, rv.CERT_FECHA_REAL, rv.ESTATUS, rv.CLAVE_PLATAFORMA, rv.VERSION
        FROM REPORTE_VALIDACION rv
        WHERE rv.CLAVE_REP IN (${inList})
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

// ── PUT actualizar estatus de reporte ─────────────────────
// Body: { clave_rep, clave_plataforma, etapa, fecha }
// etapa: 'DOCUMENTADO' | 'PROGRAMADO' | 'CERTIFICADO'
router.put('/estatus-reporte', requireAuth, async (req, res) => {
  try {
    const { clave_rep, clave_plataforma, etapa, fecha, desmarcar } = req.body;
    const usuario  = req.session.user?.usuario || 'sistema';
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
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── PUT actualizar estatus de validación ──────────────────
router.put('/estatus-validacion', requireAuth, async (req, res) => {
  try {
    const { clave_validacion, clave_rep, clave_plataforma, etapa, fecha } = req.body;
    const usuario = req.session.user?.usuario || 'sistema';
    const fechaVal = fecha ? esc(fecha) : 'GETDATE()';

    const campoFecha = etapa === 'DOCUMENTADO' ? 'DOC_FECHA_REAL'
                     : etapa === 'PROGRAMADO'  ? 'PROG_FECHA_REAL'
                     : 'CERT_FECHA_REAL';
    const campoUser  = etapa === 'DOCUMENTADO' ? 'USER_DOC'
                     : etapa === 'PROGRAMADO'  ? 'USER_PROG'
                     : 'USER_CERT';

    const existe = await query(`SELECT 1 FROM REPORTE_VALIDACION WHERE CLAVE_VALIDACION=${esc(clave_validacion)} AND CLAVE_PLATAFORMA=${esc(clave_plataforma)}`);

    if (existe.length) {
      await query(`
        UPDATE REPORTE_VALIDACION SET
          ${etapa}='S',
          ${campoFecha}=${fechaVal},
          ${campoUser}=${esc(usuario)},
          ESTATUS=${esc(etapa)}
        WHERE CLAVE_VALIDACION=${esc(clave_validacion)} AND CLAVE_PLATAFORMA=${esc(clave_plataforma)}
      `);
    } else {
      await query(`
        INSERT INTO REPORTE_VALIDACION (CLAVE_VALIDACION, CLAVE_REP, CLAVE_PLATAFORMA, ${etapa}, ${campoFecha}, ${campoUser}, ESTATUS)
        VALUES (${esc(clave_validacion)}, ${esc(clave_rep)}, ${esc(clave_plataforma)}, 'S', ${fechaVal}, ${esc(usuario)}, ${esc(etapa)})
      `);
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── POST carga Excel inventario reportes ──────────────────
router.post('/inventario-reportes/upload', requireAuth, upload.single('archivo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, message: 'No se recibió archivo' });
  try {
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
              FECHA_ALTA, FECHA_ACTUALIZADA, VIGENTE
            ) VALUES (
              ${esc(clave)}, ${esc(r.CLAVE_PAIS)}, ${esc(r.CLAVE_ENTIDADREGULADA)}, ${esc(r.CLAVE_REG)},
              ${esc(r.CLAVE_SERIE)}, ${esc(r.SUBSERIE)}, ${esc(r.CLAVE_GRUPO)}, ${esc(r.REPORTE)},
              ${esc(r.CLAVE_SECCION_REP)}, ${esc(r.CLAVE_VERSION_REPORTE)}, ${esc(r.CLAVE_PERIODO)},
              ${esc(r.DESCRIPCION_ESP)}, ${esc(r.CLAVE_FECHA_ENT_REP)}, ${esc(r.CARACTERISTICAS)},
              ${esc(r.CLAVE_REGULACION_REP)}, ${esc(r.CLAVE_REP_GENERAL)},
              ${r.FECHA_REGULACION ? esc(r.FECHA_REGULACION) : 'NULL'},
              GETDATE(), GETDATE(), 1
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
              FECHA_ACTUALIZADA=GETDATE()
            WHERE CLAVE_REP=${esc(clave)}
          `);
          actualizados++;
        }
      } catch(e2) { errores++; }
    }
    res.json({ ok: true, insertados, actualizados, errores });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── POST carga Excel inventario validaciones ───────────────
router.post('/inventario-validaciones/upload', requireAuth, upload.single('archivo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, message: 'No se recibió archivo' });
  try {
    const wb   = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws   = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
    let insertados = 0, actualizados = 0, errores = 0;
    for (const r of rows) {
      const clave = String(r.CLAVE_VALIDACION || '').trim();
      if (!clave) continue;
      try {
        const existe = await query(`SELECT 1 FROM INVENTARIO_VALIDACIONES WHERE CLAVE_VALIDACION=${esc(clave)}`);
        if (!existe.length) {
          await query(`
            INSERT INTO INVENTARIO_VALIDACIONES (
              CLAVE_VALIDACION, CLAVE_PAIS, CLAVE_ENTIDADREGULADA, CLAVE_REG,
              CLAVE_REP, ID_VALIDACION_ANT, DESCRIPCION_VALIDACION,
              TIPO_VALIDACION, TIPO_VALIDACION_CALC, FECHA_ALTA
            ) VALUES (
              ${esc(clave)}, ${esc(r.CLAVE_PAIS)}, ${esc(r.CLAVE_ENTIDADREGULADA)}, ${esc(r.CLAVE_REG)},
              ${esc(r.CLAVE_REP)}, ${esc(r.ID_VALIDACION_ANT)}, ${esc(r.DESCRIPCION_VALIDACION)},
              ${esc(r.TIPO_VALIDACION)}, ${esc(r.TIPO_VALIDACION_CALC)}, GETDATE()
            )
          `);
          insertados++;
        } else {
          await query(`
            UPDATE INVENTARIO_VALIDACIONES SET
              CLAVE_REP=${esc(r.CLAVE_REP)},
              DESCRIPCION_VALIDACION=${esc(r.DESCRIPCION_VALIDACION)},
              TIPO_VALIDACION=${esc(r.TIPO_VALIDACION)},
              TIPO_VALIDACION_CALC=${esc(r.TIPO_VALIDACION_CALC)},
              FECHA_ACTUALIZADA=GETDATE()
            WHERE CLAVE_VALIDACION=${esc(clave)}
          `);
          actualizados++;
        }
      } catch(e2) { errores++; }
    }
    res.json({ ok: true, insertados, actualizados, errores });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── POST carga Excel contratos (2 hojas) ──────────────────
// Hoja "CONTRATO": CLAVE_CONTRATO, NOMBRE_CONTRATO, CLAVE_CLIENTE, CLAVE_PLATAFORMA
// Hoja "REPORTES": CLAVE_CONTRATO, CLAVE_REP, FECHA_ESTIMADA_QA, FECHA_ESTIMADA_CERT, FECHA_ESTIMADA_PROD
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
