require('dotenv').config();
const { query } = require('./db/connection');

async function run() {
  // Ver todos los campos de un reporte similar para inferir los valores
  const ref = await query(`
    SELECT TOP 1 CLAVE_REP, REPORTE, CLAVE_SERIE, CLAVE_GRUPO, CLAVE_REG,
      CLAVE_SECCION_REP, CLAVE_VERSION_REPORTE, CLAVE_PERIODO,
      DESCRIPCION_ESP, CLAVE_REGULACION_REP, CLAVE_REP_GENERAL
    FROM INVENTARIO_REPORTES
    WHERE CLAVE_PAIS='GT' AND CLAVE_ENTIDADREGULADA='BM' AND REPORTE IS NOT NULL
      AND CLAVE_REP != 'GT_BM_CC1_CC1_00_22'
  `);
  console.log('Reporte de referencia:', JSON.stringify(ref, null, 2));

  // Ver también si hay otro reporte CC1 de otra versión para referencia exacta
  const cc1ref = await query(`
    SELECT TOP 3 CLAVE_REP, REPORTE, CLAVE_SERIE, CLAVE_GRUPO, CLAVE_REG,
      CLAVE_SECCION_REP, CLAVE_VERSION_REPORTE, CLAVE_PERIODO,
      DESCRIPCION_ESP, CLAVE_REGULACION_REP, CLAVE_REP_GENERAL
    FROM INVENTARIO_REPORTES
    WHERE CLAVE_REP LIKE '%CC1%'
  `);
  console.log('Reportes CC1:', JSON.stringify(cc1ref, null, 2));
}

run().catch(e => console.error(e.message));
