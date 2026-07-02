require('dotenv').config();
const { query } = require('./db/connection');

async function run() {
  await query(`
    UPDATE INVENTARIO_REPORTES SET
      REPORTE               = 'CC1',
      CLAVE_SERIE           = 'CC1',
      CLAVE_GRUPO           = 'CARTERA',
      CLAVE_REG             = 'SUPER',
      CLAVE_SECCION_REP     = '00',
      CLAVE_VERSION_REPORTE = '22',
      DESCRIPCION_ESP       = 'CC1 INFORMACIÓN DE CRÉDITOS NUEVOS',
      CLAVE_REP_GENERAL     = 'GT_BM_CC1_CC1_00'
    WHERE CLAVE_REP = 'GT_BM_CC1_CC1_00_22'
  `);
  console.log('Restaurado completamente.');

  const check = await query(`
    SELECT REPORTE, CLAVE_SERIE, CLAVE_GRUPO, CLAVE_REG, CLAVE_PERIODO,
           DESCRIPCION_ESP, CLAVE_REP_GENERAL, CLAVE_REGULACION_REP
    FROM INVENTARIO_REPORTES WHERE CLAVE_REP='GT_BM_CC1_CC1_00_22'
  `);
  console.log(JSON.stringify(check, null, 2));
}

run().catch(e => console.error(e.message));
