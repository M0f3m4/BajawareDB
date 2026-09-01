/*
 * db/connection.js
 * Gestión de conexión a SQL Server.
 * En producción: 192.168.94.43, BD: BajawaredB
 * Pool singleton, métodos para queries parametrizadas (previene inyección SQL).
 */

const sql = require('mssql');

// Configuración de conexión con SQL Server desde variables de entorno
const config = {
  server:   process.env.DB_SERVER   || 'localhost',
  port:     parseInt(process.env.DB_PORT || '1433'),
  database: process.env.DB_DATABASE || 'BajawaredB',
  user:     process.env.DB_USER     || 'sa',
  password: process.env.DB_PASSWORD || '',
  options: {
    encrypt:                  process.env.DB_ENCRYPT === 'true',
    trustServerCertificate:   true,
    enableArithAbort:         true,
    cryptoCredentialsDetails: { minVersion: 'TLSv1' }
  },
  requestTimeout: 120000,   // 2 min por query (default era 15s)
  // Pool de conexiones reutilizables: hasta 10 conexiones simultáneas
  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000
  }
};

// Singleton pool: se crea una sola vez y se reutiliza en toda la app
let pool = null;

/**
 * Devuelve el pool de conexiones (singleton).
 * Si no existe, lo crea.
 */
// Obtener o crear el pool singleton de conexiones a SQL Server
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
 * Ejecuta una query y devuelve los registros.
 * @param {string} query  - T-SQL a ejecutar
 * @param {object} params - { nombre: valor } para parametrizar
 */
// Ejecutar query T-SQL con parámetros (safe contra inyección SQL)
async function query(queryStr, params = {}) {
  const db = await getPool();
  const request = db.request();

  // Parametrizar valores en la request (previene inyección SQL)
  for (const [key, value] of Object.entries(params)) {
    request.input(key, value);
  }

  // Ejecutar query y retornar registros
  const result = await request.query(queryStr);
  return result.recordset;
}

// Exportar funciones y módulo mssql para uso en otros módulos
module.exports = { getPool, query, sql };
