require('dotenv').config();
const { query } = require('./db/connection');

async function run() {
  // Ver otros reportes BM de GT para inferir el patrón
  const rows = await query(`
    SELECT TOP 5 CLAVE_REP, REPORTE, CLAVE_SERIE, CLAVE_GRUPO, CLAVE_REG
    FROM INVENTARIO_REPORTES
    WHERE CLAVE_PAIS='GT' AND CLAVE_ENTIDADREGULADA='BM'
      AND CLAVE_REP != 'GT_BM_CC1_CC1_00_22'
      AND REPORTE IS NOT NULL
  `);
  console.log(JSON.stringify(rows, null, 2));
}

run().catch(e => console.error(e.message));
