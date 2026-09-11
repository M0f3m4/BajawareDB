/*
 * db/connection.js
 * Gestión de conexión a SQL Server.
 * En producción: 192.168.94.43, BD: BajawaredB
 * Pool singleton, métodos para queries parametrizadas (previene inyección SQL).
 */

const sql = require('mssql');

// ── Configuración de conexión ─────────────────────────────────────
// Lee credenciales de .env: DB_SERVER (prod: 192.168.94.43), DB_DATABASE, DB_USER, DB_PASSWORD
// Fallback a localhost para desarrollo si no están definidas.
const config = {
  server:   process.env.DB_SERVER   || 'localhost',      // Servidor SQL Server (FQDN o IP)
  port:     parseInt(process.env.DB_PORT || '1433'),     // Puerto estándar SQL Server
  database: process.env.DB_DATABASE || 'BajawaredB',    // BD principal
  user:     process.env.DB_USER     || 'sa',             // Usuario SQL (ej. 'sa' en dev)
  password: process.env.DB_PASSWORD || '',               // Contraseña SQL
  options: {
    // Encriptación de conexión (false en dev por cert autofirmado, true en prod con cert real)
    encrypt:                  process.env.DB_ENCRYPT === 'true',
    // Aceptar cualquier certificado (necesario con certs autofirmados)
    trustServerCertificate:   true,
    // Abortar queries que usen aritmética con NULL (standard SQL)
    enableArithAbort:         true,
    // Versión TLS mínima (LAN interna, no requiere TLS 1.3)
    cryptoCredentialsDetails: { minVersion: 'TLSv1' }
  },
  // Timeout de 2 minutos por query (default mssql era 15s; algunos imports SOFIPO necesitan más)
  requestTimeout: 120000,
  // Pool de conexiones reutilizables: máx 10 simultáneas, 0 mín, timeout idle 30s
  // Evita crear conexión nueva en cada query (mejor performance)
  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000
  }
};

// ── Pool singleton de conexiones ──────────────────────────────────
// Se crea una sola vez al primer uso y se reutiliza (evita overhead de conexiones nuevas).
// Toda query pide una conexión del pool (si está libre) o espera (si todas están en uso).
let pool = null;

/**
 * getPool(): Obtiene o crea el pool singleton de conexiones a SQL Server
 *
 * Si ya existe, retorna directamente.
 * Si no existe, establece conexión con SQL Server usando config de .env.
 * Log: muestra "✔ SQL Server conectado: [BD]" al conectar por primera vez.
 *
 * Throws: Error si no puede conectar a BD (ej. servidor caído, credenciales inválidas)
 */
async function getPool() {
  if (pool) return pool;
  try {
    pool = await sql.connect(config);
    console.log('✔ SQL Server conectado:', process.env.DB_DATABASE);
    return pool;
  } catch (err) {
    console.error('✖ Error conectando a SQL Server:', err.message);
    throw err;
  }
}

/**
 * query(): Ejecuta una query T-SQL con parámetros (safe contra inyección SQL)
 *
 * @param {string} queryStr - T-SQL a ejecutar (ej: 'SELECT * FROM PROYECTOS WHERE ID_PROYECTO = @id')
 * @param {object} params   - Mapa { nombre: valor } para parámetros (ej: { id: 42 })
 *                             Parámetros se escapan automáticamente (safe contra inyección)
 *
 * Retorna: Array de registros (recordset). Vacío si no hay filas.
 *          Ej: [{ ID_PROYECTO: 1, NOMBRE_PROYECTO: 'ABC' }, ...]
 *
 * Proceso:
 *  1. Obtiene pool singleton (conexión a SQL Server)
 *  2. Crea request dentro del pool
 *  3. Añade cada parámetro (@key = value) a la request
 *  4. Ejecuta query T-SQL (parámetros escape automático = safe)
 *  5. Retorna result.recordset (array de filas)
 *
 * Throws: Error si query inválida, timeouts (120s), o problema de conexión
 *
 * Uso:
 *  const rows = await query('SELECT * FROM CLIENTE WHERE ID_CLIENTE = @id', { id: 5 });
 *  const inserted = await query('INSERT INTO AUDIT_LOG (...) VALUES (@usuario, @accion)', {...});
 */
async function query(queryStr, params = {}) {
  const db = await getPool();
  const request = db.request();

  // Parametrizar cada valor en la request: @key = value
  // El driver escapa automáticamente (previene inyección SQL)
  for (const [key, value] of Object.entries(params)) {
    request.input(key, value);
  }

  // Ejecutar query T-SQL y retornar array de registros
  const result = await request.query(queryStr);
  return result.recordset;
}

// ── Exportar funciones y módulo mssql ──────────────────────────────
// getPool: obtener pool singleton (solo para inicialización)
// query: ejecutar queries parametrizadas (safe SQL injection)
// sql: módulo mssql bruto (para operaciones avanzadas)
module.exports = { getPool, query, sql };
