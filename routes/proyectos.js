// ============================================================================
// routes/proyectos.js — Módulo PROYECTOS (Tablero tipo "PROYECTOS ACTIVOS 2026")
// ----------------------------------------------------------------------------
// Modelo en cascada: CLIENTE → CONTRATOS → PROYECTOS.
// Un contrato puede tener varios proyectos; cada proyecto vive en la tabla
// PROYECTOS (ID_PROYECTO identity) y cuelga de su CLAVE_CONTRATO. El alta se
// hace eligiendo cliente → contrato → nombre del proyecto.
//
// Cada proyecto trae: RAG manual (Green/Amber/Red con bitácora), líderes
// funcional/técnico, avance, tipo de actividad y estatus de pagos. Los RAG de
// reportes y validaciones se calculan al vuelo desde las fechas del CONTRATO
// padre (ahí viven CONTRATOS_REPORTES y CONTRATOS_VALIDACION_ESTATUS).
//
// Reglas de semáforo por producto (reporte o validación), calculadas al vuelo:
//   VERDE : ya se entregó (FECHA_INSTALADO_PROD / FECHA_REAL con valor), o la
//           fecha estimada llega con holgura (> UMBRAL_AMBAR días) antes de la
//           fecha de necesidad del cliente.
//   AMBAR : la estimada llega justa (<= UMBRAL_AMBAR días de holgura).
//   ROJO  : la estimada supera la necesidad, o la estimada ya venció sin
//           entrega, o hay fecha de necesidad pero no hay estimada.
//   GRIS  : sin fechas capturadas (no castiga; simplemente no hay dato).
// El RAG agregado (reportes o validaciones) es "el peor manda":
//   ROJO > AMBAR > VERDE; si todo es GRIS, queda NULL (sin datos).
//
// Tablas: PROYECTOS, CONTRATOS, CLIENTE, CONTRATOS_REPORTES,
//         CONTRATOS_VALIDACION_ESTATUS, AUDIT_LOG (bitácora).
// ============================================================================

const express = require('express');
const router  = express.Router();
const { query } = require('../db/connection');

// Días de holgura mínimos para considerar VERDE una fecha estimada.
const UMBRAL_AMBAR = 15;

// Middleware: valida sesión autenticada (mismo criterio que routes/contratos.js).
function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ ok: false, message: 'No autenticado' });
  next();
}

// Helper: escapa valores SQL (mismo helper que routes/contratos.js).
const esc = v => (v === null || v === undefined || v === '') ? 'NULL' : `'${String(v).trim().replace(/'/g,"''")}'`;

// Helper: valida que el id del proyecto sea un entero (evita inyección en la URL).
function idNum(raw) {
  const n = parseInt(raw, 10);
  return (Number.isInteger(n) && n > 0) ? n : null;
}

// Helper: bitácora en AUDIT_LOG. Si falla, no bloquea el flujo principal.
async function auditLog(usuario, seccion, accion, detalle) {
  try {
    const det = typeof detalle === 'object' ? JSON.stringify(detalle) : String(detalle);
    await query(`
      INSERT INTO AUDIT_LOG (USUARIO, SECCION, ACCION, DETALLE)
      VALUES (${esc(usuario)}, ${esc(seccion)}, ${esc(accion)}, ${esc(det)})
    `);
  } catch(e) { /* no bloquear si audit falla */ }
}

// Fragmento SQL reutilizable: semáforo de un reporte de CONTRATOS_REPORTES.
const SEMAFORO_REPORTE = `
  CASE
    WHEN cr.FECHA_INSTALADO_PROD IS NOT NULL THEN 'VERDE'
    WHEN cr.FECHA_ESTIMADA_PROD IS NULL AND cr.FECHA_NECESIDAD IS NULL THEN 'GRIS'
    WHEN cr.FECHA_ESTIMADA_PROD IS NULL THEN 'ROJO'
    WHEN cr.FECHA_NECESIDAD IS NOT NULL AND cr.FECHA_ESTIMADA_PROD > cr.FECHA_NECESIDAD THEN 'ROJO'
    WHEN cr.FECHA_ESTIMADA_PROD < CAST(GETDATE() AS date) THEN 'ROJO'
    WHEN cr.FECHA_NECESIDAD IS NOT NULL AND DATEDIFF(day, cr.FECHA_ESTIMADA_PROD, cr.FECHA_NECESIDAD) <= ${UMBRAL_AMBAR} THEN 'AMBAR'
    ELSE 'VERDE'
  END`;

// Fragmento SQL reutilizable: semáforo de una validación de CONTRATOS_VALIDACION_ESTATUS.
const SEMAFORO_VALIDACION = `
  CASE
    WHEN cv.FECHA_REAL IS NOT NULL THEN 'VERDE'
    WHEN cv.FECHA_ESTIMADA IS NULL AND cv.FECHA_NECESIDAD IS NULL THEN 'GRIS'
    WHEN cv.FECHA_ESTIMADA IS NULL THEN 'ROJO'
    WHEN cv.FECHA_NECESIDAD IS NOT NULL AND cv.FECHA_ESTIMADA > cv.FECHA_NECESIDAD THEN 'ROJO'
    WHEN cv.FECHA_ESTIMADA < CAST(GETDATE() AS date) THEN 'ROJO'
    WHEN cv.FECHA_NECESIDAD IS NOT NULL AND DATEDIFF(day, cv.FECHA_ESTIMADA, cv.FECHA_NECESIDAD) <= ${UMBRAL_AMBAR} THEN 'AMBAR'
    ELSE 'VERDE'
  END`;

// Helper JS: agrega el "peor color manda" a partir de los conteos.
function ragAgregado(rojos, ambar, verdes) {
  if ((rojos|0) > 0)  return 'Red';
  if ((ambar|0) > 0)  return 'Amber';
  if ((verdes|0) > 0) return 'Green';
  return null; // todo gris = sin datos
}

// ── GET /tablero
// Descripción: tablero principal — un renglón por PROYECTO con datos de su
// contrato y cliente, RAG manual, avance, líderes y los RAG calculados de
// reportes y validaciones del contrato padre (con conteos para tooltips).
// Parámetros query opcionales: tipo_actividad, cliente, rag, texto.
// Sin bitácora (solo lectura).
router.get('/tablero', requireAuth, async (req, res) => {
  try {
    const { tipo_actividad, cliente, rag, texto } = req.query;
    let where = 'WHERE p.ACTIVO = 1';
    if (tipo_actividad) where += ` AND p.TIPO_ACTIVIDAD = ${esc(tipo_actividad)}`;
    if (cliente)        where += ` AND c.CLAVE_CLIENTE = ${esc(cliente)}`;
    if (rag)            where += ` AND p.RAG_PROYECTO = ${esc(rag)}`;
    if (texto)          where += ` AND (p.NOMBRE_PROYECTO LIKE ${esc('%'+texto+'%')} OR cl.NOMBRE_CLIENTE LIKE ${esc('%'+texto+'%')} OR c.CLAVE_CONTRATO LIKE ${esc('%'+texto+'%')})`;

    const rows = await query(`
      SELECT
        p.ID_PROYECTO, p.NOMBRE_PROYECTO, p.TIPO_ACTIVIDAD, p.ESTATUS_PAGO,
        p.RAG_PROYECTO, p.RAG_COMENTARIO, p.RAG_FECHA, p.RAG_USUARIO,
        p.RAG_REPORTES_MANUAL, p.RAG_VALIDACIONES_MANUAL,
        p.AVANCE_ESTIMADO, p.FECHA_NECESIDAD, p.FECHA_ESTIMADA_CONCLUIR,
        p.FUNCIONAL_NOMBRE, p.TECNICO_NOMBRE, p.RAG_PRODUCTO_ULTIMO,
        c.CLAVE_CONTRATO, c.NOMBRE_CONTRATO, c.CLAVE_CLIENTE, c.CLAVE_PLATAFORMA,
        cl.NOMBRE_CLIENTE,
        ISNULL(p.TIPO_INSTITUCION, cl.TIPO_INSTITUCION) AS TIPO_INSTITUCION,
        ISNULL(r.TOT,0) AS REP_TOTAL, ISNULL(r.VERDES,0) AS REP_VERDES,
        ISNULL(r.AMBAR,0) AS REP_AMBAR, ISNULL(r.ROJOS,0) AS REP_ROJOS, ISNULL(r.GRISES,0) AS REP_GRISES,
        ISNULL(v.TOT,0) AS VAL_TOTAL, ISNULL(v.VERDES,0) AS VAL_VERDES,
        ISNULL(v.AMBAR,0) AS VAL_AMBAR, ISNULL(v.ROJOS,0) AS VAL_ROJOS, ISNULL(v.GRISES,0) AS VAL_GRISES,
        CASE WHEN prodp.ID_PROYECTO IS NOT NULL THEN prodp.TOT ELSE ISNULL(prod.TOT,0) END AS PROD_TOTAL,
        CASE WHEN prodp.ID_PROYECTO IS NOT NULL THEN prodp.CERTIFICADOS ELSE ISNULL(prod.CERTIFICADOS,0) END AS PROD_CERTIFICADOS,
        CASE WHEN prodp.ID_PROYECTO IS NOT NULL THEN 1 ELSE 0 END AS PROD_LIGADOS
      FROM PROYECTOS p
      INNER JOIN CONTRATOS c ON c.CLAVE_CONTRATO = p.CLAVE_CONTRATO
      LEFT JOIN CLIENTE cl ON cl.CLAVE_CLIENTE = c.CLAVE_CLIENTE
      LEFT JOIN (
        SELECT cr.CLAVE_CONTRATO,
               COUNT(*) AS TOT,
               SUM(CASE WHEN ${SEMAFORO_REPORTE} = 'VERDE' THEN 1 ELSE 0 END) AS VERDES,
               SUM(CASE WHEN ${SEMAFORO_REPORTE} = 'AMBAR' THEN 1 ELSE 0 END) AS AMBAR,
               SUM(CASE WHEN ${SEMAFORO_REPORTE} = 'ROJO'  THEN 1 ELSE 0 END) AS ROJOS,
               SUM(CASE WHEN ${SEMAFORO_REPORTE} = 'GRIS'  THEN 1 ELSE 0 END) AS GRISES
        FROM CONTRATOS_REPORTES cr
        WHERE cr.ACTIVO = 1
        GROUP BY cr.CLAVE_CONTRATO
      ) r ON r.CLAVE_CONTRATO = c.CLAVE_CONTRATO
      LEFT JOIN (
        SELECT cv.CLAVE_CONTRATO,
               COUNT(*) AS TOT,
               SUM(CASE WHEN ${SEMAFORO_VALIDACION} = 'VERDE' THEN 1 ELSE 0 END) AS VERDES,
               SUM(CASE WHEN ${SEMAFORO_VALIDACION} = 'AMBAR' THEN 1 ELSE 0 END) AS AMBAR,
               SUM(CASE WHEN ${SEMAFORO_VALIDACION} = 'ROJO'  THEN 1 ELSE 0 END) AS ROJOS,
               SUM(CASE WHEN ${SEMAFORO_VALIDACION} = 'GRIS'  THEN 1 ELSE 0 END) AS GRISES
        FROM CONTRATOS_VALIDACION_ESTATUS cv
        GROUP BY cv.CLAVE_CONTRATO
      ) v ON v.CLAVE_CONTRATO = c.CLAVE_CONTRATO
      LEFT JOIN (
        -- RAG de producto: cuenta los renglones de la pantalla "Estatus por
        -- Contrato" (mismo join: CLAVE_REP_GENERAL + plataforma del contrato)
        -- y cuántos tienen ESTATUS = CERTIFICADO. %: <80 Rojo, 80-99 Ámbar, 100 Verde.
        SELECT cr.CLAVE_CONTRATO,
               COUNT(er.ID_ESTATUS_REP) AS TOT,
               SUM(CASE WHEN er.ESTATUS = 'CERTIFICADO' THEN 1 ELSE 0 END) AS CERTIFICADOS
        FROM CONTRATOS_REPORTES cr
        INNER JOIN CONTRATOS cc ON cc.CLAVE_CONTRATO = cr.CLAVE_CONTRATO
        LEFT JOIN ESTATUS_REPORTE er ON er.CLAVE_REP_GENERAL = cr.CLAVE_REP
                                    AND er.CLAVE_PLATAFORMA  = cc.CLAVE_PLATAFORMA
        WHERE cr.ACTIVO = 1
        GROUP BY cr.CLAVE_CONTRATO
      ) prod ON prod.CLAVE_CONTRATO = c.CLAVE_CONTRATO
      LEFT JOIN (
        -- RAG de producto POR PROYECTO: si el proyecto tiene reportes ligados
        -- en PROYECTOS_REPORTES, el % se calcula solo sobre esos reportes
        -- (mismo join de estatus). Si no tiene liga, manda el cálculo por
        -- contrato completo (prod, arriba) como fallback.
        SELECT pr.ID_PROYECTO,
               COUNT(er.ID_ESTATUS_REP) AS TOT,
               SUM(CASE WHEN er.ESTATUS = 'CERTIFICADO' THEN 1 ELSE 0 END) AS CERTIFICADOS
        FROM PROYECTOS_REPORTES pr
        INNER JOIN PROYECTOS pp ON pp.ID_PROYECTO = pr.ID_PROYECTO
        INNER JOIN CONTRATOS cc ON cc.CLAVE_CONTRATO = pp.CLAVE_CONTRATO
        LEFT JOIN ESTATUS_REPORTE er ON er.CLAVE_REP_GENERAL = pr.CLAVE_REP
                                    AND er.CLAVE_PLATAFORMA  = cc.CLAVE_PLATAFORMA
        GROUP BY pr.ID_PROYECTO
      ) prodp ON prodp.ID_PROYECTO = p.ID_PROYECTO
      ${where}
      ORDER BY cl.NOMBRE_CLIENTE, p.NOMBRE_PROYECTO
    `);

    // Se calculan en JS los RAG agregados (peor color manda) para cada renglón.
    // Si hay override manual (RAG_*_MANUAL) ese color manda sobre el calculado.
    const data = rows.map(row => {
      // RAG de producto por % de reportes CERTIFICADOS: <80 Rojo, 80-99 Ámbar,
      // 100 Verde. Sin reportes ligados = null (sin dato, gris en la UI).
      const pct = row.PROD_TOTAL > 0 ? (row.PROD_CERTIFICADOS / row.PROD_TOTAL) * 100 : null;
      return {
        ...row,
        RAG_REPORTES:     ragAgregado(row.REP_ROJOS, row.REP_AMBAR, row.REP_VERDES),
        RAG_VALIDACIONES: ragAgregado(row.VAL_ROJOS, row.VAL_AMBAR, row.VAL_VERDES),
        PROD_PCT:         pct === null ? null : Math.round(pct * 10) / 10,
        RAG_PRODUCTO:     pct === null ? null : (pct >= 100 ? 'Green' : (pct >= 80 ? 'Amber' : 'Red')),
      };
    });
    // Detección de cambios de semáforo en RAG producto → alertas.
    // Compara el color calculado contra el último observado (RAG_PRODUCTO_ULTIMO):
    //  - color → color distinto: genera alerta y actualiza el testigo.
    //  - null → color (primera vez con datos) o color → null: solo actualiza el
    //    testigo en silencio (no es un cambio de semáforo real).
    // En try aparte: si la tabla de alertas aún no existe, el tablero no truena.
    try {
      for (const row of data) {
        const previo = row.RAG_PRODUCTO_ULTIMO || null;
        const actual = row.RAG_PRODUCTO || null;
        if (actual === previo) continue;
        if (previo !== null && actual !== null) {
          await query(`
            INSERT INTO PROY_RAG_ALERTAS (ID_PROYECTO, RAG_ANTERIOR, RAG_NUEVO, PCT_NUEVO)
            VALUES (${row.ID_PROYECTO}, ${esc(previo)}, ${esc(actual)}, ${row.PROD_PCT === null ? 'NULL' : Number(row.PROD_PCT)})
          `);
        }
        await query(`UPDATE PROYECTOS SET RAG_PRODUCTO_ULTIMO = ${esc(actual)} WHERE ID_PROYECTO = ${row.ID_PROYECTO}`);
      }
    } catch (eAlertas) {
      console.warn('⚠ Alertas RAG producto:', eAlertas.message);
    }

    res.json({ ok: true, umbral_ambar: UMBRAL_AMBAR, data });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── GET /alertas
// Descripción: alertas de cambio de semáforo en RAG producto. Devuelve las 50
// más recientes con nombre de proyecto/cliente, y dos conteos: sin_leer y
// semana (alertas de lunes a viernes de la semana en curso; el lunes se
// calcula en JS para no depender del DATEFIRST del servidor SQL).
// Sin bitácora (consulta de solo lectura).
router.get('/alertas', requireAuth, async (req, res) => {
  try {
    // Lunes de la semana en curso (si hoy es sáb/dom, el lunes ya pasado)
    const hoy = new Date();
    const lun = new Date(hoy);
    lun.setDate(hoy.getDate() - ((hoy.getDay() + 6) % 7));
    const lunStr = `${lun.getFullYear()}-${String(lun.getMonth()+1).padStart(2,'0')}-${String(lun.getDate()).padStart(2,'0')}`;

    const alertas = await query(`
      SELECT TOP 50 a.ID_ALERTA, a.ID_PROYECTO, a.RAG_ANTERIOR, a.RAG_NUEVO,
             a.PCT_NUEVO, a.FECHA_ALERTA, a.LEIDA,
             p.NOMBRE_PROYECTO, p.CLAVE_CONTRATO, cl.NOMBRE_CLIENTE
      FROM PROY_RAG_ALERTAS a
      INNER JOIN PROYECTOS p ON p.ID_PROYECTO = a.ID_PROYECTO
      LEFT JOIN CONTRATOS c  ON c.CLAVE_CONTRATO = p.CLAVE_CONTRATO
      LEFT JOIN CLIENTE  cl  ON cl.CLAVE_CLIENTE = c.CLAVE_CLIENTE
      ORDER BY a.FECHA_ALERTA DESC
    `);
    const [conteo] = await query(`
      SELECT SUM(CASE WHEN LEIDA = 0 THEN 1 ELSE 0 END) AS sin_leer,
             SUM(CASE WHEN FECHA_ALERTA >= '${lunStr}'
                       AND FECHA_ALERTA <  DATEADD(DAY, 5, CAST('${lunStr}' AS DATE))
                      THEN 1 ELSE 0 END) AS semana
      FROM PROY_RAG_ALERTAS
    `);
    res.json({ ok: true, data: { alertas, sin_leer: conteo?.sin_leer || 0, semana: conteo?.semana || 0 } });
  } catch(e) { res.json({ ok: true, data: { alertas: [], sin_leer: 0, semana: 0 } }); }
});

// ── PUT /alertas/leidas
// Descripción: marca todas las alertas pendientes como leídas (quién y cuándo
// queda en la misma fila: FECHA_LEIDA / USUARIO_LEIDA).
router.put('/alertas/leidas', requireAuth, async (req, res) => {
  try {
    const usuario = req.session.user.username;
    await query(`
      UPDATE PROY_RAG_ALERTAS
      SET LEIDA = 1, FECHA_LEIDA = GETDATE(), USUARIO_LEIDA = ${esc(usuario)}
      WHERE LEIDA = 0
    `);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── GET /catalogo-alta
// Descripción: catálogo para el alta en cascada — todos los clientes con sus
// contratos. El front agrupa: eliges cliente y se filtran sus contratos.
// Sin bitácora (solo lectura).
router.get('/catalogo-alta', requireAuth, async (req, res) => {
  try {
    const rows = await query(`
      SELECT cl.CLAVE_CLIENTE, cl.NOMBRE_CLIENTE, cl.TIPO_INSTITUCION,
             c.CLAVE_CONTRATO, c.NOMBRE_CONTRATO
      FROM CLIENTE cl
      INNER JOIN CONTRATOS c ON c.CLAVE_CLIENTE = cl.CLAVE_CLIENTE
      ORDER BY cl.NOMBRE_CLIENTE, c.NOMBRE_CONTRATO
    `);
    res.json({ ok: true, data: rows });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── GET /snapshot/ultimo
// Descripción: fecha del último snapshot semanal de PROYECTOS (viernes 20:00
// hora Pacífico, ver services/respaldos.js). Para la leyenda del tablero.
// Respuesta: {ultimo: datetime|null}. Si la tabla PROYECTOS_RESPALDO todavía
// no existe (server sin reiniciar), regresa null sin tronar.
// Sin bitácora (consulta de solo lectura).
router.get('/snapshot/ultimo', requireAuth, async (req, res) => {
  try {
    const rows = await query(`
      SELECT MAX(FECHA_RESPALDO) AS ultimo
      FROM PROYECTOS_RESPALDO
      WHERE MOTIVO IN ('SEMANAL', 'MANUAL')
    `);
    res.json({ ok: true, data: { ultimo: rows.length ? rows[0].ultimo : null } });
  } catch(e) { res.json({ ok: true, data: { ultimo: null } }); }
});

// ── GET /snapshot/lista
// Descripción: snapshots disponibles de PROYECTOS_RESPALDO para el comparativo.
// Cada snapshot se identifica por su fecha exacta como string (formato 121,
// yyyy-mm-dd hh:mi:ss.mmm) para evitar líos de zona horaria al reconsultar.
// Respuesta: [{CLAVE_SNAP, FECHA_RESPALDO, MOTIVO, FILAS}]. Sin bitácora.
router.get('/snapshot/lista', requireAuth, async (req, res) => {
  try {
    const rows = await query(`
      SELECT CONVERT(VARCHAR(23), FECHA_RESPALDO, 121) AS CLAVE_SNAP,
             FECHA_RESPALDO, MOTIVO, COUNT(*) AS FILAS
      FROM PROYECTOS_RESPALDO
      WHERE MOTIVO IN ('SEMANAL', 'MANUAL')
      GROUP BY CONVERT(VARCHAR(23), FECHA_RESPALDO, 121), FECHA_RESPALDO, MOTIVO
      ORDER BY FECHA_RESPALDO DESC
    `);
    res.json({ ok: true, data: rows });
  } catch(e) { res.json({ ok: true, data: [] }); }
});

// ── GET /snapshot/detalle?clave=yyyy-mm-dd hh:mi:ss.mmm
// Descripción: filas completas de un snapshot (para comparar contra el tablero
// actual en el frontend). La clave es el CLAVE_SNAP de /snapshot/lista.
// Sin bitácora (consulta de solo lectura).
router.get('/snapshot/detalle', requireAuth, async (req, res) => {
  try {
    const clave = String(req.query.clave || '').trim();
    if (!clave) return res.status(400).json({ ok: false, message: 'Falta clave del snapshot' });
    const rows = await query(`
      SELECT * FROM PROYECTOS_RESPALDO
      WHERE CONVERT(VARCHAR(23), FECHA_RESPALDO, 121) = ${esc(clave)}
    `);
    res.json({ ok: true, data: rows });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── POST /
// Descripción: alta de proyecto en cascada. Body: clave_contrato (obligatorio),
// nombre_proyecto (obligatorio) y opcionales tipo_actividad, estatus_pago,
// funcional_nombre, tecnico_nombre, rag, avance_estimado,
// fecha_estimada_concluir. Valida que el contrato exista. Bitácora ALTA.
router.post('/', requireAuth, async (req, res) => {
  try {
    const usuario = req.session.user.username;
    const { clave_contrato, nombre_proyecto, tipo_actividad, estatus_pago,
            funcional_nombre, tecnico_nombre, rag, avance_estimado,
            fecha_estimada_concluir } = req.body;

    if (!clave_contrato || !nombre_proyecto)
      return res.status(400).json({ ok: false, message: 'clave_contrato y nombre_proyecto son obligatorios' });
    if (rag && !['Green','Amber','Red'].includes(rag))
      return res.status(400).json({ ok: false, message: 'RAG inválido (Green/Amber/Red)' });

    let avance = 'NULL';
    if (avance_estimado !== undefined && avance_estimado !== null && avance_estimado !== '') {
      const n = parseFloat(avance_estimado);
      if (isNaN(n) || n < 0 || n > 100)
        return res.status(400).json({ ok: false, message: 'avance_estimado debe ser 0-100' });
      avance = n;
    }

    const [contrato] = await query(`SELECT CLAVE_CONTRATO, CLAVE_CLIENTE FROM CONTRATOS WHERE CLAVE_CONTRATO = ${esc(clave_contrato)}`);
    if (!contrato) return res.status(404).json({ ok: false, message: 'El contrato no existe' });

    const [nuevo] = await query(`
      INSERT INTO PROYECTOS (CLAVE_CONTRATO, NOMBRE_PROYECTO, TIPO_ACTIVIDAD, ESTATUS_PAGO,
                             FUNCIONAL_NOMBRE, TECNICO_NOMBRE, RAG_PROYECTO, RAG_USUARIO, RAG_FECHA,
                             AVANCE_ESTIMADO, FECHA_ESTIMADA_CONCLUIR, USUARIO_ALTA, FECHA_MODIFICA)
      OUTPUT INSERTED.ID_PROYECTO
      VALUES (${esc(clave_contrato)}, ${esc(nombre_proyecto)}, ${esc(tipo_actividad)}, ${esc(estatus_pago)},
              ${esc(funcional_nombre)}, ${esc(tecnico_nombre)}, ${esc(rag)},
              ${rag ? esc(usuario) : 'NULL'}, ${rag ? 'GETDATE()' : 'NULL'},
              ${avance}, ${esc(fecha_estimada_concluir)}, ${esc(usuario)}, GETDATE())
    `);

    await auditLog(usuario, 'proyectos', 'ALTA_PROYECTO', {
      id_proyecto: nuevo ? nuevo.ID_PROYECTO : null,
      clave_contrato, clave_cliente: contrato.CLAVE_CLIENTE, nombre_proyecto,
      tipo_actividad, estatus_pago, rag
    });
    res.json({ ok: true, id_proyecto: nuevo ? nuevo.ID_PROYECTO : null });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── GET /:id/reportes-ligados
// Descripción: claves de reportes (CLAVE_REP base) ligadas específicamente
// a este proyecto en PROYECTOS_REPORTES.
// Sin bitácora (solo lectura).
router.get('/:id/reportes-ligados', requireAuth, async (req, res) => {
  try {
    const id = idNum(req.params.id);
    if (!id) return res.status(400).json({ ok: false, message: 'id inválido' });
    const rows = await query(`
      SELECT CLAVE_REP FROM PROYECTOS_REPORTES
      WHERE ID_PROYECTO = ${id} ORDER BY CLAVE_REP
    `);
    res.json({ ok: true, data: rows.map(r => r.CLAVE_REP) });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── PUT /:id/reportes-ligados
// Descripción: reemplaza el conjunto de reportes ligados al proyecto.
// Body: { reportes: ['CLAVE_REP', ...] } — solo se aceptan claves que
// pertenezcan al contrato padre del proyecto (CONTRATOS_REPORTES).
// Bitácora: proyectos / REPORTES_LIGADOS.
router.put('/:id/reportes-ligados', requireAuth, async (req, res) => {
  try {
    const usuario = req.session.user.username;
    const id = idNum(req.params.id);
    if (!id) return res.status(400).json({ ok: false, message: 'id inválido' });
    const { reportes } = req.body || {};
    if (!Array.isArray(reportes)) return res.status(400).json({ ok: false, message: 'reportes debe ser un arreglo' });

    const [proy] = await query(`SELECT CLAVE_CONTRATO FROM PROYECTOS WHERE ID_PROYECTO = ${id}`);
    if (!proy) return res.status(404).json({ ok: false, message: 'Proyecto no encontrado' });

    const validas = await query(`
      SELECT CLAVE_REP FROM CONTRATOS_REPORTES WHERE CLAVE_CONTRATO = ${esc(proy.CLAVE_CONTRATO)}
    `);
    const setValidas = new Set(validas.map(r => r.CLAVE_REP));
    const limpias = [...new Set(reportes.map(c => String(c).trim()).filter(Boolean))]
      .filter(c => setValidas.has(c));

    await query(`DELETE FROM PROYECTOS_REPORTES WHERE ID_PROYECTO = ${id}`);
    for (const c of limpias) {
      await query(`
        INSERT INTO PROYECTOS_REPORTES (ID_PROYECTO, CLAVE_REP, USUARIO_ALTA)
        VALUES (${id}, ${esc(c)}, ${esc(usuario)})
      `);
    }
    await auditLog(usuario, 'proyectos', 'REPORTES_LIGADOS', {
      id_proyecto: id, clave_contrato: proy.CLAVE_CONTRATO,
      total: limpias.length, reportes: limpias
    });
    res.json({ ok: true, total: limpias.length });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── GET /:id/detalle
// Descripción: detalle de un proyecto — los reportes y validaciones del
// CONTRATO padre, con fechas y semáforo por renglón. Es el "expandir".
// Sin bitácora (solo lectura).
router.get('/:id/detalle', requireAuth, async (req, res) => {
  try {
    const id = idNum(req.params.id);
    if (!id) return res.status(400).json({ ok: false, message: 'id inválido' });

    const [proy] = await query(`SELECT CLAVE_CONTRATO FROM PROYECTOS WHERE ID_PROYECTO = ${id}`);
    if (!proy) return res.status(404).json({ ok: false, message: 'Proyecto no encontrado' });
    const clave = proy.CLAVE_CONTRATO;

    const reportes = await query(`
      SELECT cr.CLAVE_REP, cr.ETAPA, cr.EN_USO,
             cr.FECHA_NECESIDAD, cr.FECHA_ESTIMADA_QA, cr.FECHA_INSTALADO_QA,
             cr.FECHA_ESTIMADA_CERT, cr.FECHA_CERTIFICADO,
             cr.FECHA_ESTIMADA_PROD, cr.FECHA_INSTALADO_PROD,
             ${SEMAFORO_REPORTE} AS SEMAFORO
      FROM CONTRATOS_REPORTES cr
      WHERE cr.CLAVE_CONTRATO = ${esc(clave)} AND cr.ACTIVO = 1
      ORDER BY cr.CLAVE_REP
    `);
    const validaciones = await query(`
      SELECT cv.CLAVE_VALIDACION, cv.CLAVE_PLATAFORMA, cv.VERSION_CARGA, cv.ESTATUS_PROYECTO,
             cv.FECHA_NECESIDAD, cv.FECHA_ESTIMADA, cv.FECHA_REAL,
             ${SEMAFORO_VALIDACION} AS SEMAFORO
      FROM CONTRATOS_VALIDACION_ESTATUS cv
      WHERE cv.CLAVE_CONTRATO = ${esc(clave)}
      ORDER BY cv.CLAVE_VALIDACION
    `);
    res.json({ ok: true, data: { clave_contrato: clave, reportes, validaciones } });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── PUT /:id/rag
// Descripción: actualiza el RAG manual del proyecto (Green/Amber/Red) con
// comentario opcional. Guarda quién y cuándo, y deja bitácora antes/después.
router.put('/:id/rag', requireAuth, async (req, res) => {
  try {
    const usuario = req.session.user.username;
    const id = idNum(req.params.id);
    if (!id) return res.status(400).json({ ok: false, message: 'id inválido' });
    const { rag, comentario } = req.body;
    if (!['Green','Amber','Red', null, ''].includes(rag))
      return res.status(400).json({ ok: false, message: 'RAG inválido (Green/Amber/Red)' });

    const [antes] = await query(`SELECT RAG_PROYECTO, RAG_COMENTARIO FROM PROYECTOS WHERE ID_PROYECTO = ${id}`);
    if (!antes) return res.status(404).json({ ok: false, message: 'Proyecto no encontrado' });

    await query(`
      UPDATE PROYECTOS SET
        RAG_PROYECTO   = ${esc(rag)},
        RAG_COMENTARIO = ${esc(comentario)},
        RAG_FECHA      = GETDATE(),
        RAG_USUARIO    = ${esc(usuario)},
        FECHA_MODIFICA = GETDATE()
      WHERE ID_PROYECTO = ${id}
    `);
    await auditLog(usuario, 'proyectos', 'RAG_MANUAL', { id_proyecto: id, antes, despues: { rag, comentario } });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── PUT /:id/info
// Descripción: actualiza los campos del proyecto. Solo toca los campos que
// vienen en el body (los ausentes no se modifican). Bitácora antes/después.
router.put('/:id/info', requireAuth, async (req, res) => {
  try {
    const usuario = req.session.user.username;
    const id = idNum(req.params.id);
    if (!id) return res.status(400).json({ ok: false, message: 'id inválido' });
    const permitidos = {
      nombre_proyecto:         'NOMBRE_PROYECTO',
      tipo_actividad:          'TIPO_ACTIVIDAD',
      estatus_pago:            'ESTATUS_PAGO',
      avance_estimado:         'AVANCE_ESTIMADO',
      fecha_necesidad:         'FECHA_NECESIDAD',
      fecha_estimada_concluir: 'FECHA_ESTIMADA_CONCLUIR',
      funcional_nombre:        'FUNCIONAL_NOMBRE',
      tecnico_nombre:          'TECNICO_NOMBRE',
      tipo_institucion:        'TIPO_INSTITUCION',
      rag_reportes_manual:     'RAG_REPORTES_MANUAL',
      rag_validaciones_manual: 'RAG_VALIDACIONES_MANUAL',
    };
    // Los overrides de semáforo solo aceptan Green/Amber/Red o null (= automático).
    const RAGS_VALIDOS = [null, '', 'Green', 'Amber', 'Red'];
    for (const campoRag of ['rag_reportes_manual', 'rag_validaciones_manual']) {
      if (campoRag in req.body && !RAGS_VALIDOS.includes(req.body[campoRag]))
        return res.status(400).json({ ok: false, message: `${campoRag} debe ser Green, Amber, Red o vacío` });
    }
    const sets = [];
    const cambios = {};
    for (const [campo, col] of Object.entries(permitidos)) {
      if (campo in req.body) {
        // AVANCE_ESTIMADO es numérico; el resto van escapados como texto/fecha.
        if (campo === 'avance_estimado') {
          const n = req.body[campo] === null || req.body[campo] === '' ? null : parseFloat(req.body[campo]);
          if (n !== null && (isNaN(n) || n < 0 || n > 100))
            return res.status(400).json({ ok: false, message: 'avance_estimado debe ser 0-100' });
          sets.push(`${col} = ${n === null ? 'NULL' : n}`);
        } else if (campo === 'nombre_proyecto' && !req.body[campo]) {
          return res.status(400).json({ ok: false, message: 'nombre_proyecto no puede quedar vacío' });
        } else {
          sets.push(`${col} = ${esc(req.body[campo])}`);
        }
        cambios[campo] = req.body[campo];
      }
    }
    if (!sets.length) return res.status(400).json({ ok: false, message: 'Sin campos para actualizar' });

    const [antes] = await query(`
      SELECT NOMBRE_PROYECTO, TIPO_ACTIVIDAD, TIPO_INSTITUCION, ESTATUS_PAGO, AVANCE_ESTIMADO, FECHA_NECESIDAD, FECHA_ESTIMADA_CONCLUIR, FUNCIONAL_NOMBRE, TECNICO_NOMBRE, RAG_REPORTES_MANUAL, RAG_VALIDACIONES_MANUAL
      FROM PROYECTOS WHERE ID_PROYECTO = ${id}`);
    if (!antes) return res.status(404).json({ ok: false, message: 'Proyecto no encontrado' });

    await query(`UPDATE PROYECTOS SET ${sets.join(', ')}, FECHA_MODIFICA = GETDATE() WHERE ID_PROYECTO = ${id}`);
    await auditLog(usuario, 'proyectos', 'INFO_PROYECTO', { id_proyecto: id, antes, despues: cambios });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── PUT /:id/reporte-fechas
// Descripción: captura la fecha de necesidad del cliente (y opcionalmente la
// estimada de producción) para un reporte del CONTRATO padre del proyecto.
// Bitácora antes/después.
router.put('/:id/reporte-fechas', requireAuth, async (req, res) => {
  try {
    const usuario = req.session.user.username;
    const id = idNum(req.params.id);
    if (!id) return res.status(400).json({ ok: false, message: 'id inválido' });
    const { clave_rep, fecha_necesidad, fecha_estimada_prod } = req.body;
    if (!clave_rep) return res.status(400).json({ ok: false, message: 'clave_rep requerido' });

    const [proy] = await query(`SELECT CLAVE_CONTRATO FROM PROYECTOS WHERE ID_PROYECTO = ${id}`);
    if (!proy) return res.status(404).json({ ok: false, message: 'Proyecto no encontrado' });
    const clave = proy.CLAVE_CONTRATO;

    const [antes] = await query(`
      SELECT FECHA_NECESIDAD, FECHA_ESTIMADA_PROD FROM CONTRATOS_REPORTES
      WHERE CLAVE_CONTRATO = ${esc(clave)} AND CLAVE_REP = ${esc(clave_rep)}`);
    if (!antes) return res.status(404).json({ ok: false, message: 'Reporte no ligado al contrato de este proyecto' });

    const sets = [];
    if ('fecha_necesidad' in req.body)     sets.push(`FECHA_NECESIDAD = ${esc(fecha_necesidad)}`);
    if ('fecha_estimada_prod' in req.body) sets.push(`FECHA_ESTIMADA_PROD = ${esc(fecha_estimada_prod)}`);
    if (!sets.length) return res.status(400).json({ ok: false, message: 'Sin fechas para actualizar' });

    await query(`
      UPDATE CONTRATOS_REPORTES SET ${sets.join(', ')}
      WHERE CLAVE_CONTRATO = ${esc(clave)} AND CLAVE_REP = ${esc(clave_rep)}`);
    await auditLog(usuario, 'proyectos', 'FECHAS_REPORTE', { id_proyecto: id, clave_contrato: clave, clave_rep, antes, despues: { fecha_necesidad, fecha_estimada_prod } });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── DELETE /:id
// Descripción: baja lógica del proyecto (ACTIVO = 0). No borra el renglón,
// solo lo saca del tablero. Bitácora con los datos del proyecto dado de baja.
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const usuario = req.session.user.username;
    const id = idNum(req.params.id);
    if (!id) return res.status(400).json({ ok: false, message: 'id inválido' });

    const [antes] = await query(`SELECT NOMBRE_PROYECTO, CLAVE_CONTRATO FROM PROYECTOS WHERE ID_PROYECTO = ${id} AND ACTIVO = 1`);
    if (!antes) return res.status(404).json({ ok: false, message: 'Proyecto no encontrado' });

    await query(`UPDATE PROYECTOS SET ACTIVO = 0, FECHA_MODIFICA = GETDATE() WHERE ID_PROYECTO = ${id}`);
    await auditLog(usuario, 'proyectos', 'BAJA_PROYECTO', { id_proyecto: id, ...antes });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── GET /archivados
// Descripción: proyectos dados de baja (ACTIVO = 0), para la ventana de
// archivado del tablero. Ordenados por fecha de baja (FECHA_MODIFICA) desc.
// Sin bitácora (consulta de solo lectura).
router.get('/archivados', requireAuth, async (req, res) => {
  try {
    const rows = await query(`
      SELECT p.ID_PROYECTO, p.NOMBRE_PROYECTO, p.TIPO_ACTIVIDAD, p.CLAVE_CONTRATO,
             c.NOMBRE_CONTRATO, cl.NOMBRE_CLIENTE, p.FECHA_MODIFICA
      FROM PROYECTOS p
      INNER JOIN CONTRATOS c ON c.CLAVE_CONTRATO = p.CLAVE_CONTRATO
      INNER JOIN CLIENTE  cl ON cl.CLAVE_CLIENTE = c.CLAVE_CLIENTE
      WHERE p.ACTIVO = 0
      ORDER BY p.FECHA_MODIFICA DESC
    `);
    res.json({ ok: true, data: rows });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── PUT /:id/restaurar
// Descripción: recupera un proyecto dado de baja por accidente (ACTIVO = 1).
// Vuelve a aparecer en el tablero con todos sus datos intactos (la baja es
// lógica, nada se pierde). Bitácora RESTAURA_PROYECTO.
router.put('/:id/restaurar', requireAuth, async (req, res) => {
  try {
    const usuario = req.session.user.username;
    const id = idNum(req.params.id);
    if (!id) return res.status(400).json({ ok: false, message: 'id inválido' });

    const [antes] = await query(`SELECT NOMBRE_PROYECTO, CLAVE_CONTRATO FROM PROYECTOS WHERE ID_PROYECTO = ${id} AND ACTIVO = 0`);
    if (!antes) return res.status(404).json({ ok: false, message: 'Proyecto archivado no encontrado' });

    await query(`UPDATE PROYECTOS SET ACTIVO = 1, FECHA_MODIFICA = GETDATE() WHERE ID_PROYECTO = ${id}`);
    await auditLog(usuario, 'proyectos', 'RESTAURA_PROYECTO', { id_proyecto: id, ...antes });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── PUT /cliente/:clave/tipo-institucion
// Descripción: asigna el tipo de institución del cliente (Banca Múltiple,
// SOFIPO, FINTECH, etc.). Bitácora antes/después.
router.put('/cliente/:clave/tipo-institucion', requireAuth, async (req, res) => {
  try {
    const usuario = req.session.user.username;
    const { tipo_institucion } = req.body;
    const [antes] = await query(`SELECT TIPO_INSTITUCION FROM CLIENTE WHERE CLAVE_CLIENTE = ${esc(req.params.clave)}`);
    if (!antes) return res.status(404).json({ ok: false, message: 'Cliente no encontrado' });
    await query(`
      UPDATE CLIENTE SET TIPO_INSTITUCION = ${esc(tipo_institucion)}, FECHA_MODIFICA = GETDATE()
      WHERE CLAVE_CLIENTE = ${esc(req.params.clave)}`);
    await auditLog(usuario, 'proyectos', 'TIPO_INSTITUCION', { clave_cliente: req.params.clave, antes, despues: { tipo_institucion } });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

module.exports = router;
