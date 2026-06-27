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
        er.DOCUMENTADO,
        er.DOC_FECHA_REAL,
        er.PROGRAMADO,
        er.PROG_FECHA_REAL,
        er.CERTIFICADO,
        er.CERT_FECHA_REAL,
        er.ESTATUS,
        er.CLAVE_PLATAFORMA,
        er.VERSION
      FROM CONTRATOS_REPORTES cr
      LEFT JOIN INVENTARIO_REPORTES ir ON ir.CLAVE_REP = cr.CLAVE_REP
      LEFT JOIN ESTATUS_REPORTE er     ON er.CLAVE_REP = cr.CLAVE_REP
      WHERE cr.CLAVE_CONTRATO=${esc(req.params.clave)}
      ORDER BY cr.CLAVE_REP
    `);
    res.json({ ok: true, data: rows });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── VALIDACIONES por contrato ─────────────────────────────
router.get('/contratos/:clave/validaciones', requireAuth, async (req, res) => {
  try {
    const rows = await query(`
      SELECT
        rv.CLAVE_VALIDACION,
        rv.CLAVE_REP,
        rv.TIPO_VALIDACION,
        rv.DESCRIPCION,
        rv.DOCUMENTADO,
        rv.DOC_FECHA_REAL,
        rv.PROGRAMADO,
        rv.PROG_FECHA_REAL,
        rv.CERTIFICADO,
        rv.CERT_FECHA_REAL,
        rv.ESTATUS,
        rv.CLAVE_PLATAFORMA,
        rv.VERSION
      FROM REPORTE_VALIDACION rv
      INNER JOIN CONTRATOS_REPORTES cr ON cr.CLAVE_REP = rv.CLAVE_REP
      WHERE cr.CLAVE_CONTRATO=${esc(req.params.clave)}
      ORDER BY rv.CLAVE_REP, rv.CLAVE_VALIDACION
    `);
    res.json({ ok: true, data: rows });
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

// ── PUT actualizar estatus de reporte ─────────────────────
// Body: { clave_rep, clave_plataforma, etapa, fecha }
// etapa: 'DOCUMENTADO' | 'PROGRAMADO' | 'CERTIFICADO'
router.put('/estatus-reporte', requireAuth, async (req, res) => {
  try {
    const { clave_rep, clave_plataforma, etapa, fecha } = req.body;
    const usuario = req.session.user?.usuario || 'sistema';
    const fechaVal = fecha ? esc(fecha) : 'GETDATE()';

    const campoFecha  = etapa === 'DOCUMENTADO' ? 'DOC_FECHA_REAL'
                      : etapa === 'PROGRAMADO'  ? 'PROG_FECHA_REAL'
                      : 'CERT_FECHA_REAL';
    const campoUser   = etapa === 'DOCUMENTADO' ? 'USER_DOC'
                      : etapa === 'PROGRAMADO'  ? 'USER_PROG'
                      : 'USER_CERT';

    // Verificar si existe registro
    const existe = await query(`SELECT 1 FROM ESTATUS_REPORTE WHERE CLAVE_REP=${esc(clave_rep)} AND CLAVE_PLATAFORMA=${esc(clave_plataforma)}`);

    if (existe.length) {
      await query(`
        UPDATE ESTATUS_REPORTE SET
          ${etapa}='S',
          ${campoFecha}=${fechaVal},
          ${campoUser}=${esc(usuario)},
          ESTATUS=${esc(etapa)}
        WHERE CLAVE_REP=${esc(clave_rep)} AND CLAVE_PLATAFORMA=${esc(clave_plataforma)}
      `);
    } else {
      await query(`
        INSERT INTO ESTATUS_REPORTE (CLAVE_REP, CLAVE_PLATAFORMA, ${etapa}, ${campoFecha}, ${campoUser}, ESTATUS)
        VALUES (${esc(clave_rep)}, ${esc(clave_plataforma)}, 'S', ${fechaVal}, ${esc(usuario)}, ${esc(etapa)})
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
    let ok = 0, err = 0;
    for (const r of rows) {
      const clave = r.CLAVE_REP || r['CLAVE REP'] || '';
      if (!clave) continue;
      try {
        const existe = await query(`SELECT 1 FROM INVENTARIO_REPORTES WHERE CLAVE_REP=${esc(clave)}`);
        if (!existe.length) {
          await query(`
            INSERT INTO INVENTARIO_REPORTES (CLAVE_REP, CLAVE_PAIS, CLAVE_ENTIDADREGULADA, CLAVE_REG, REPORTE, DESCRIPCION_ESP, FECHA_ALTA, VIGENTE)
            VALUES (${esc(clave)}, ${esc(r.CLAVE_PAIS||r.PAIS)}, ${esc(r.CLAVE_ENTIDADREGULADA||r.ENTIDAD)}, ${esc(r.CLAVE_REG||r.REGULACION)}, ${esc(r.REPORTE||clave)}, ${esc(r.DESCRIPCION_ESP||r.DESCRIPCION)}, GETDATE(), 1)
          `);
          ok++;
        }
      } catch(e2) { err++; }
    }
    res.json({ ok: true, insertados: ok, errores: err });
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
