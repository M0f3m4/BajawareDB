const sql = require('mssql');

const config = {
  server:   process.env.DB_SERVER   || 'localhost',
  port:     parseInt(process.env.DB_PORT || '1433'),
  database: process.env.DB_DATABASE || 'BajawaredB',
  user:     process.env.DB_USER     || 'sa',
  password: process.env.DB_PASSWORD || '',
  options: {
    encrypt:              process.env.DB_ENCRYPT    === 'true',
    trustServerCertificate: process.env.DB_TRUST_CERT !== 'false',
    enableArithAbort:     true
  },
  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000
  }
};

let pool = null;

/**
 * Devuelve el pool de conexiones (singleton).
 * Si no existe, lo crea.
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
 * Ejecuta una query y devuelve los registros.
 * @param {string} query  - T-SQL a ejecutar
 * @param {object} params - { nombre: valor } para parametrizar
 */
async function query(queryStr, params = {}) {
  const db = await getPool();
  const request = db.request();
  for (const [key, value] of Object.entries(params)) {
    request.input(key, value);
  }
  const result = await request.query(queryStr);
  return result.recordset;
}

module.exports = { getPool, query, sql };
