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

// Tablas críticas que requieren respaldo automático
// - ESTATUS_REPORTE: tabla sensible que sufrió un planchamiento histórico (bug de Excel)
// - INVENTARIO_REPORTES: catálogo de reportes disponibles
const TABLAS = ['ESTATUS_REPORTE', 'INVENTARIO_REPORTES'];
// Columnas de metadatos agregadas a cada fila respaldada (no se copian del origen)
const META_COLS = ['FECHA_RESPALDO', 'MOTIVO', 'USUARIO_RESPALDO'];
// Retención de snapshots diarios: se purgan automáticamente después de N días
const DIAS_RETENCION_DIARIO = 30;
// Intervalo de revisión: cada 6 horas por si el server se reinicia en mitad del día
const INTERVALO_MS = 6 * 60 * 60 * 1000; // revisa cada 6 h (por si el server se reinicia)

// Helper para escapar strings SQL: reemplaza comillas simples por pares (SQL standard)
const escStr = v => `'${String(v == null ? '' : v).replace(/'/g, "''")}'`;

// Obtiene lista de columnas de una tabla (en orden de definición).
// Útil para inspeccionar esquema de tablas en tiempo de ejecución.
async function _columnas(tabla) {
  const rows = await query(`
    SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME = ${escStr(tabla)}
    ORDER BY ORDINAL_POSITION`);
  return rows.map(r => r.COLUMN_NAME);
}

/**
 * MOTOR DE RESPALDO: Copia filas de `tabla` a `tabla`_RESPALDO con metadatos.
 *
 * PARÁMETROS:
 *   tabla    — Nombre de tabla origen (ej: ESTATUS_REPORTE)
 *   motivo   — Razón del respaldo (ej: DIARIO, PRE_CARGA). Se trunca a 200 chars.
 *   usuario  — Usuario que solicitó el respaldo (ej: 'sistema', 'admin@domain')
 *   claves   — (Opcional) Array de CLAVE_REP para respaldar solo filas específicas.
 *              Si es null/vacío, respalda la tabla completa (foto diaria).
 *
 * LÓGICA DE MAPEO DINÁMICO:
 *   - Lee columnas de ambas tablas (origen y destino)
 *   - Realiza intersección: solo copia columnas que existen en ambas
 *   - Excluye columnas de metadatos (FECHA_RESPALDO, MOTIVO, USUARIO_RESPALDO)
 *   - Esto hace el sistema RESISTENTE a cambios de schema:
 *     si se agrega columna nueva, se incluye automáticamente al respaldo.
 *
 * CONTEXTO DE SEGURIDAD:
 *   Esta tabla es parte del blindaje del sistema. Históricamente, un bug en el
 *   cargador de Excel planchó VERSION_CARGA en ESTATUS_REPORTE, requiriendo ~5
 *   días de recuperación manual. Los respaldos PRE_CARGA previenen esto: si la
 *   carga falla o genera cambios inesperados, podemos restaurar el snapshot.
 */
async function respaldarTabla(tabla, motivo, usuario, claves = null) {
  const destino = `${tabla}_RESPALDO`;
  // Validar que existe la tabla de respaldo; si no, avisar y no fallar
  const colsDestino = await _columnas(destino);
  if (!colsDestino.length) {
    throw new Error(`No existe la tabla ${destino} — correr crear_tablas_respaldo.sql`);
  }
  // Obtener columnas de ambas tablas e interseccionar
  const colsOrigen = await _columnas(tabla);
  const cols = colsOrigen.filter(c => colsDestino.includes(c) && !META_COLS.includes(c));
  const lista = cols.map(c => `[${c}]`).join(', ');
  // Opcionalmente filtrar por clave de reportes
  let where = '';
  if (Array.isArray(claves) && claves.length) {
    const listaClaves = claves.map(c => escStr(String(c).trim())).join(',');
    where = `WHERE LTRIM(RTRIM(CLAVE_REP)) IN (${listaClaves})`;
  }
  // Insertar filas con metadatos de respaldo
  await query(`
    INSERT INTO [${destino}] (${lista}, FECHA_RESPALDO, MOTIVO, USUARIO_RESPALDO)
    SELECT ${lista}, GETDATE(), ${escStr(String(motivo).slice(0, 200))}, ${escStr(usuario)}
    FROM [${tabla}] ${where}`);
}

/**
 * RESPALDO PRE-CARGA: Fotograf√≠a defensiva antes de procesar un archivo Excel.
 *
 * CÓMO USARLA: Llamar desde el endpoint de upload de Excel, pasando:
 *   - usuario: quién inició la carga (usuario del sistema)
 *   - archivo: nombre/ruta del archivo Excel (para auditoría)
 *   - claves: array de CLAVE_REP que la carga va a tocar
 *
 * PROPÓSITO: Proteger contra cambios inesperados o destructivos del cargador.
 * Solo respalda las filas que la carga puede afectar (las claves del archivo),
 * no la tabla completa, para que sea rápido y no genere overhead de almacenamiento.
 *
 * IMPORTANCIA: Si la carga falla o corrompe datos, estos snapshots permiten
 * restauración quirúrgica (por CLAVE_REP) sin afectar al resto de la BD.
 * Se conservan indefinidamente con motivo PRE_CARGA.
 */
async function respaldarAntesDeCarga(usuario, archivo, claves) {
  if (!Array.isArray(claves) || !claves.length) return;
  for (const t of TABLAS) {
    await respaldarTabla(t, `PRE_CARGA: ${archivo}`, usuario, claves);
  }
}

// Verifica si ya existe un respaldo DIARIO para hoy en una tabla.
// Se usa para evitar duplicados si la función se ejecuta múltiples veces en el mismo día.
async function _yaHayRespaldoHoy(tabla) {
  const r = await query(`
    SELECT TOP 1 1 AS x FROM [${tabla}_RESPALDO]
    WHERE MOTIVO = 'DIARIO'
      AND CAST(FECHA_RESPALDO AS DATE) = CAST(GETDATE() AS DATE)`);
  return r.length > 0;
}

/**
 * FOTO DIARIA: Snapshot completo de todas las tablas críticas.
 *
 * FLUJO:
 *  1. Para cada tabla en TABLAS:
 *     a. Verifica si ya existe respaldo DIARIO de hoy (skip si sí)
 *     b. Si no existe, toma snapshot completo con motivo='DIARIO'
 *     c. Limpia snapshots diarios más antiguos de 30 días (purga automática)
 *
 * PROPÓSITO: Mantener una serie de fotos diarias completas (1 por día) como
 * punto de recuperación rápida en caso de corrupción generalizada de datos.
 *
 * ROBUSTEZ: Captura errores por tabla (si ESTATUS_REPORTE falla, sigue con
 * INVENTARIO_REPORTES). No detiene el ciclo si algún respaldo falla.
 */
async function respaldoDiario() {
  for (const t of TABLAS) {
    try {
      // Evitar duplicados: si ya hay snapshot de hoy, saltar
      if (await _yaHayRespaldoHoy(t)) continue;
      // Tomar foto completa de la tabla
      await respaldarTabla(t, 'DIARIO', 'sistema');
      // Purgar snapshots diarios más antiguos que el período de retención
      await query(`
        DELETE FROM [${t}_RESPALDO]
        WHERE MOTIVO = 'DIARIO'
          AND FECHA_RESPALDO < DATEADD(DAY, -${DIAS_RETENCION_DIARIO}, GETDATE())`);
      console.log(`✔ Respaldo diario de ${t} listo`);
    } catch (e) {
      // Avisar pero no fallar: permite que ciclo continúe con otras tablas
      console.warn(`⚠ Respaldo diario de ${t}:`, e.message);
    }
  }
}

// Inicializa el sistema de respaldos automáticos.
// Ejecuta respaldo diario al arrancar y programa verificaciones periódicas cada 6 horas.
// (Intervalo largo por si el servidor se reinicia; la función _yaHayRespaldoHoy
// evita duplicados en caso de múltiples ejecuciones el mismo día.)
function iniciar() {
  respaldoDiario();
  setInterval(respaldoDiario, INTERVALO_MS);
}

module.exports = { iniciar, respaldoDiario, respaldarAntesDeCarga };
