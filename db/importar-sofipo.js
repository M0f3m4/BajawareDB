/**
 * db/importar-sofipo.js
 * Importa las 3 hojas del Excel SOFIPO a SQL Server.
 * Uso: node db/importar-sofipo.js <ruta-del-excel>
 * Ejemplo: node db/importar-sofipo.js "./ejemplo base layouts SOFIPO v2.1 (1).xlsx"
 */

require('dotenv').config();
const XLSX  = require('xlsx');
const path  = require('path');
const { query } = require('./connection');

const archivo = process.argv[2];
if (!archivo) {
  console.error('❌ Indica la ruta del Excel: node db/importar-sofipo.js <archivo.xlsx>');
  process.exit(1);
}

const esc = v => (v === null || v === undefined || v === '') ? 'NULL' : `'${String(v).trim().replace(/'/g, "''")}'`;
const escInt = v => {
  const n = parseInt(v);
  return isNaN(n) ? 'NULL' : String(n);
};

async function importar() {
  console.log(`📂 Leyendo: ${archivo}`);
  const wb = XLSX.readFile(path.resolve(archivo));

  // ── Hoja 1: LAYOUT_DESC ──────────────────────────────────
  console.log('\n📋 Importando SOFIPO_LAYOUT_DESC...');
  await query('DELETE FROM SOFIPO_LAYOUT_DESC');

  const ws1   = wb.Sheets['LAYOUT_DESC SOFIPO'];
  const rows1 = XLSX.utils.sheet_to_json(ws1, { header: 1, defval: '' });
  let ok1 = 0, err1 = 0;

  for (let i = 1; i < rows1.length; i++) {
    const r = rows1[i];
    const layout = String(r[2] || '').trim();
    const campo  = String(r[5] || '').trim();
    if (!layout || !campo) continue;

    try {
      await query(`
        INSERT INTO SOFIPO_LAYOUT_DESC
          (EMPRESA, PAIS, CLAVE_LAYOUT, ORDEN, LLAVE, NOMBRE_CAMPO,
           TIPO_DATO, FORMATO, OBLIGATORIO, VALIDACION, CATALOGO,
           DESCRIPCION, DESCRIPCION_EN, OBSERVACIONES, VALIDEZ_INFO, FUENTE)
        VALUES (
          ${esc(r[0])}, ${esc(r[1])}, ${esc(layout)}, ${escInt(r[3])}, ${esc(r[4])}, ${esc(campo)},
          ${esc(r[6])}, ${esc(r[7])}, ${esc(r[8])}, ${esc(r[9])}, ${esc(r[10])},
          ${esc(r[11])}, ${esc(r[12])}, ${esc(r[13])}, ${esc(r[14])}, ${esc(r[15])}
        )
      `);
      ok1++;
    } catch (e) {
      err1++;
      if (err1 <= 3) console.error(`  ❌ Fila ${i + 1}:`, e.message);
    }
  }
  console.log(`  ✅ ${ok1} registros insertados, ${err1} errores`);

  // ── Hoja 2: LAYOUT_USO ───────────────────────────────────
  console.log('\n🔗 Importando SOFIPO_LAYOUT_USO...');
  await query('DELETE FROM SOFIPO_LAYOUT_USO');

  const ws2   = wb.Sheets['LAYOUT SOFIPO'];
  const rows2 = XLSX.utils.sheet_to_json(ws2, { header: 1, defval: '' });
  let ok2 = 0, err2 = 0;

  for (let i = 1; i < rows2.length; i++) {
    const r = rows2[i];
    const layout = String(r[2] || '').trim();
    const campo  = String(r[3] || '').trim();
    if (!layout || !campo) continue;

    try {
      await query(`
        INSERT INTO SOFIPO_LAYOUT_USO
          (EMPRESA, PAIS, CLAVE_LAYOUT, NOMBRE_CAMPO, ID_REPORTE, COLUMNA_REPORTE)
        VALUES (
          ${esc(r[0])}, ${esc(r[1])}, ${esc(layout)}, ${esc(campo)},
          ${esc(r[4])}, ${escInt(r[5])}
        )
      `);
      ok2++;
    } catch (e) {
      err2++;
      if (err2 <= 3) console.error(`  ❌ Fila ${i + 1}:`, e.message);
    }
  }
  console.log(`  ✅ ${ok2} registros insertados, ${err2} errores`);

  // ── Hoja 3: REPORTES ─────────────────────────────────────
  console.log('\n📊 Importando SOFIPO_REPORTES...');
  await query('DELETE FROM SOFIPO_REPORTES');

  const ws3   = wb.Sheets['ESTRUCTURA DE REPORTES SOFIPO'];
  const rows3 = XLSX.utils.sheet_to_json(ws3, { header: 1, defval: '' });
  let ok3 = 0, err3 = 0;

  for (let i = 1; i < rows3.length; i++) {
    const r = rows3[i];
    const idReporte = String(r[0] || '').trim();
    if (!idReporte) continue;

    try {
      await query(`
        INSERT INTO SOFIPO_REPORTES
          (ID_REPORTE, ORDEN, NOMBRE_CAMPO, TIPO_DATO, LONGITUD, DECIMALES, FORMATO_CAPTURA, CATALOGO)
        VALUES (
          ${esc(idReporte)}, ${escInt(r[1])}, ${esc(r[2])}, ${esc(r[3])},
          ${escInt(r[4])}, ${escInt(r[5])}, ${esc(r[6])}, ${esc(r[7])}
        )
      `);
      ok3++;
    } catch (e) {
      err3++;
      if (err3 <= 3) console.error(`  ❌ Fila ${i + 1}:`, e.message);
    }
  }
  console.log(`  ✅ ${ok3} registros insertados, ${err3} errores`);

  console.log('\n🎉 Importación completada.');
}

importar()
  .then(() => process.exit(0))
  .catch(e => { console.error('❌ Error fatal:', e.message); process.exit(1); });
