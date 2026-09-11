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

// ── Validación de argumentos ───────────────────────────────────────────
// Requiere ruta a Excel SOFIPO como argumento de línea de comandos
const archivo = process.argv[2];
if (!archivo) {
  console.error('❌ Indica la ruta del Excel: node db/importar-sofipo.js <archivo.xlsx>');
  process.exit(1);
}

// ── Helpers de escape SQL ──────────────────────────────────────────────
/**
 * esc(): Escapar valor para SQL (string o NULL)
 *
 * Transforma:
 *  - null, undefined, '' (vacío) → NULL (sin comillas)
 *  - 'texto' → 'texto' (con comillas, comillas internas escapadas)
 *
 * Ej: esc('O\'Brien') → 'O''Brien' (comilla doble escapa a SQL)
 *
 * Previene: inyección SQL mediante valores con comillas
 */
const esc = v => (v === null || v === undefined || v === '') ? 'NULL' : `'${String(v).trim().replace(/'/g, "''")}'`;

/**
 * escInt(): Escapar valor para SQL (entero o NULL)
 *
 * Transforma:
 *  - '42' → 42
 *  - '' o 'abc' (no numérico) → NULL
 *
 * Previene: errores tipo INT si celda tiene basura
 */
const escInt = v => {
  const n = parseInt(v);
  return isNaN(n) ? 'NULL' : String(n);
};

/**
 * importar()
 * Lee Excel SOFIPO (archivo oficial con 3 hojas) y carga tablas SQL Server.
 * Borra datos existentes y recarga (FULL UPSERT, no incremental).
 *
 * HOJAS PROCESADAS:
 *  1. "LAYOUT_DESC SOFIPO" → SOFIPO_LAYOUT_DESC
 *     Metadata: empresa, país, clave_layout, orden, llave, nombre_campo,
 *     tipo_dato, formato, obligatorio, validacion, catalogo, descripcion, etc.
 *
 *  2. "LAYOUT SOFIPO" → SOFIPO_LAYOUT_USO
 *     Vinculación: campo ↔ reporte (qué columna usa cada campo en cada reporte)
 *
 *  3. "ESTRUCTURA DE REPORTES SOFIPO" → SOFIPO_REPORTES
 *     Estructura de reportes: ID_REPORTE, orden, nombre_campo, tipo_dato, longitud, decimales, etc.
 *
 * FLUJO:
 *  1. Abre archivo Excel (XLSX.readFile)
 *  2. Para cada hoja: DELETE FROM tabla (limpia) → INSERT nuevos registros
 *  3. Reporta OK/ERR por cada hoja (muestra solo primeros 3 errores para no saturar consola)
 *  4. Exit 0 si éxito, exit 1 si error fatal
 *
 * NOTA: No valida duplicados ni estructura Excel (asume Excel oficial correcto)
 */
async function importar() {
  console.log(`📂 Leyendo: ${archivo}`);
  const wb = XLSX.readFile(path.resolve(archivo));

  // ── Hoja 1: LAYOUT_DESC ──────────────────────────────────
  // Metadata de campos SOFIPO: tipos, formatos, validaciones, catálogos permitidos.
  // Se borra y recarga (FULL UPSERT).
  // Filas: saltar fila 0 (encabezados), columnas: 0=EMPRESA, 1=PAIS, 2=CLAVE_LAYOUT, ...
  // Validación mínima: requiere CLAVE_LAYOUT (col 2) y NOMBRE_CAMPO (col 5) no vacíos
  console.log('\n📋 Importando SOFIPO_LAYOUT_DESC...');
  await query('DELETE FROM SOFIPO_LAYOUT_DESC');

  const ws1   = wb.Sheets['LAYOUT_DESC SOFIPO'];
  const rows1 = XLSX.utils.sheet_to_json(ws1, { header: 1, defval: '' });
  let ok1 = 0, err1 = 0;

  for (let i = 1; i < rows1.length; i++) {
    const r = rows1[i];
    const layout = String(r[2] || '').trim();      // Columna 2: CLAVE_LAYOUT
    const campo  = String(r[5] || '').trim();      // Columna 5: NOMBRE_CAMPO

    // Saltar filas vacías (layout o campo faltante)
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
      // Mostrar solo primeros 3 errores (evita llenar consola con miles de errores)
      if (err1 <= 3) console.error(`  ❌ Fila ${i + 1}:`, e.message);
    }
  }
  console.log(`  ✅ ${ok1} registros insertados, ${err1} errores`);

  // ── Hoja 2: LAYOUT_USO ───────────────────────────────────
  // Vinculación: qué campos SOFIPO se usan en qué reportes (y en qué columna/posición).
  // Permite detectar: "campo cambió de posición", "campo se eliminó de reporte".
  // Se borra y recarga (FULL UPSERT).
  // Validación mínima: requiere CLAVE_LAYOUT (col 2) y NOMBRE_CAMPO (col 3) no vacíos
  console.log('\n🔗 Importando SOFIPO_LAYOUT_USO...');
  await query('DELETE FROM SOFIPO_LAYOUT_USO');

  const ws2   = wb.Sheets['LAYOUT SOFIPO'];
  const rows2 = XLSX.utils.sheet_to_json(ws2, { header: 1, defval: '' });
  let ok2 = 0, err2 = 0;

  for (let i = 1; i < rows2.length; i++) {
    const r = rows2[i];
    const layout = String(r[2] || '').trim();      // Columna 2: CLAVE_LAYOUT
    const campo  = String(r[3] || '').trim();      // Columna 3: NOMBRE_CAMPO

    // Saltar filas vacías (layout o campo faltante)
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
  // Estructura de reportes SOFIPO: columnas, tipos, longitudes, decimales, catálogos permitidos.
  // Define la "firma" de cada reporte (qué columnas, qué tipos, qué restricciones).
  // Se borra y recarga (FULL UPSERT).
  // Validación mínima: requiere ID_REPORTE (col 0) no vacío
  console.log('\n📊 Importando SOFIPO_REPORTES...');
  await query('DELETE FROM SOFIPO_REPORTES');

  const ws3   = wb.Sheets['ESTRUCTURA DE REPORTES SOFIPO'];
  const rows3 = XLSX.utils.sheet_to_json(ws3, { header: 1, defval: '' });
  let ok3 = 0, err3 = 0;

  for (let i = 1; i < rows3.length; i++) {
    const r = rows3[i];
    const idReporte = String(r[0] || '').trim();  // Columna 0: ID_REPORTE (requerido)

    // Saltar filas sin ID de reporte
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

  // Fin exitoso de importación
  console.log('\n🎉 Importación completada.');
}

// ── Ejecución ──────────────────────────────────────────────────────────
// Llamar importar() y salir con código apropiado (0=éxito, 1=error fatal)
// Permite uso en scripts de CI/CD (bash if/while basados en $?)
importar()
  .then(() => process.exit(0))                      // Exit 0 si éxito
  .catch(e => { console.error('❌ Error fatal:', e.message); process.exit(1); });  // Exit 1 si error
