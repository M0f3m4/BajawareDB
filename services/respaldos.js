// ── services/respaldos.js ─────────────────────────────────
// Respaldo automático de tablas críticas.
//  1. Diario: una foto por día de cada tabla (retención 30 días).
//  2. Pre-carga: foto completa justo antes de cada carga de Excel
//     de inventario de reportes (se conservan indefinidamente).
//
// Requiere que existan las tablas <TABLA>_RESPALDO — ver
// respaldos_recuperacion/crear_tablas_respaldo.sql (correr una vez
// con un usuario con permisos DDL). Si no existen, el respaldo
// diario solo avisa en consola y no truena nada.

const { query } = require('../db/connection');

const TABLAS = ['ESTATUS_REPORTE', 'INVENTARIO_REPORTES'];
const META_COLS = ['FECHA_RESPALDO', 'MOTIVO', 'USUARIO_RESPALDO'];
const DIAS_RETENCION_DIARIO = 30;
const INTERVALO_MS = 6 * 60 * 60 * 1000; // revisa cada 6 h (por si el server se reinicia)

const escStr = v => `'${String(v == null ? '' : v).replace(/'/g, "''")}'`;

async function _columnas(tabla) {
  const rows = await query(`
    SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME = ${escStr(tabla)}
    ORDER BY ORDINAL_POSITION`);
  return rows.map(r => r.COLUMN_NAME);
}

/**
 * Copia filas de `tabla` a `tabla`_RESPALDO con fecha/motivo/usuario.
 * Si se pasa `claves` (array de CLAVE_REP) solo respalda esas filas;
 * si no, respalda la tabla completa (foto diaria).
 * Las columnas se resuelven dinámicamente (intersección origen∩destino), así
 * que si algún día se agrega una columna nueva no truena — solo hay que
 * agregarla también a la tabla de respaldo para que se incluya.
 */
async function respaldarTabla(tabla, motivo, usuario, claves = null) {
  const destino = `${tabla}_RESPALDO`;
  const colsDestino = await _columnas(destino);
  if (!colsDestino.length) {
    throw new Error(`No existe la tabla ${destino} — correr crear_tablas_respaldo.sql`);
  }
  const colsOrigen = await _columnas(tabla);
  const cols = colsOrigen.filter(c => colsDestino.includes(c) && !META_COLS.includes(c));
  const lista = cols.map(c => `[${c}]`).join(', ');
  let where = '';
  if (Array.isArray(claves) && claves.length) {
    const listaClaves = claves.map(c => escStr(String(c).trim())).join(',');
    where = `WHERE LTRIM(RTRIM(CLAVE_REP)) IN (${listaClaves})`;
  }
  await query(`
    INSERT INTO [${destino}] (${lista}, FECHA_RESPALDO, MOTIVO, USUARIO_RESPALDO)
    SELECT ${lista}, GETDATE(), ${escStr(String(motivo).slice(0, 200))}, ${escStr(usuario)}
    FROM [${tabla}] ${where}`);
}

/**
 * Respaldo previo a una carga de Excel (llamar desde el endpoint de upload).
 * Solo respalda las filas de las claves que vienen en el archivo — las únicas
 * que la carga puede tocar — para que sea rápido y no infle la tabla.
 */
async function respaldarAntesDeCarga(usuario, archivo, claves) {
  if (!Array.isArray(claves) || !claves.length) return;
  for (const t of TABLAS) {
    await respaldarTabla(t, `PRE_CARGA: ${archivo}`, usuario, claves);
  }
}

async function _yaHayRespaldoHoy(tabla) {
  const r = await query(`
    SELECT TOP 1 1 AS x FROM [${tabla}_RESPALDO]
    WHERE MOTIVO = 'DIARIO'
      AND CAST(FECHA_RESPALDO AS DATE) = CAST(GETDATE() AS DATE)`);
  return r.length > 0;
}

/** Toma la foto diaria (si no existe ya la de hoy) y purga las viejas. */
async function respaldoDiario() {
  for (const t of TABLAS) {
    try {
      if (await _yaHayRespaldoHoy(t)) continue;
      await respaldarTabla(t, 'DIARIO', 'sistema');
      await query(`
        DELETE FROM [${t}_RESPALDO]
        WHERE MOTIVO = 'DIARIO'
          AND FECHA_RESPALDO < DATEADD(DAY, -${DIAS_RETENCION_DIARIO}, GETDATE())`);
      console.log(`✔ Respaldo diario de ${t} listo`);
    } catch (e) {
      console.warn(`⚠ Respaldo diario de ${t}:`, e.message);
    }
  }
}

function iniciar() {
  respaldoDiario();
  setInterval(respaldoDiario, INTERVALO_MS);
}

module.exports = { iniciar, respaldoDiario, respaldarAntesDeCarga };
