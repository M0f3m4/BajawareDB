require('dotenv').config();
const { query } = require('./db/connection');

async function run() {
  // Limpiar INVENTARIO_VERSIONES del upload accidental
  await query(`
    DELETE FROM INVENTARIO_VERSIONES
    WHERE TIPO_OBJETO='REPORTE'
      AND CLAVE_OBJ='GT_BM_CC1_CC1_00_22'
      AND FECHA_CARGA > DATEADD(minute,-30,GETDATE())
  `);
  console.log('INVENTARIO_VERSIONES limpio');

  // Ver estado de INVENTARIO_REPORTES
  const rows = await query(`
    SELECT CLAVE_REP, CLAVE_PAIS, CLAVE_ENTIDADREGULADA, REPORTE, CLAVE_SERIE
    FROM INVENTARIO_REPORTES
    WHERE CLAVE_REP='GT_BM_CC1_CC1_00_22'
  `);
  console.log('INVENTARIO_REPORTES:', JSON.stringify(rows));
}

run().catch(e => console.error(e.message));
