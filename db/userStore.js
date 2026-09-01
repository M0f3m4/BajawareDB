/*
 * db/userStore.js
 * Almacén de usuarios en archivo JSON (users.json).
 * CRUD de usuarios con autenticación bcrypt.
 * Nota: users.json es el archivo de sesiones y autenticación local (NOT SQL Server).
 */

const fs     = require('fs');
const path   = require('path');
const bcrypt = require('bcrypt');

// Ruta al archivo de usuarios persistente
const FILE        = path.join(__dirname, 'users.json');
// Rondas de hashing bcrypt (más alto = más seguro pero lento)
const SALT_ROUNDS = 10;

// Lee array de usuarios desde archivo JSON, retorna [] si falla
function readAll() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return [];
  }
}

// Persiste array de usuarios en archivo JSON con formato legible
function writeAll(users) {
  fs.writeFileSync(FILE, JSON.stringify(users, null, 2), 'utf8');
}

// Retorna todos los usuarios
function getAll() {
  return readAll();
}

// Busca usuario por username (case-insensitive)
function findByUsername(username) {
  return readAll().find(u => u.username.toLowerCase() === username.toLowerCase().trim());
}

// Busca usuario por ID numérico
function findById(id) {
  return readAll().find(u => u.id === parseInt(id));
}

// Verifica contraseña contra hash bcrypt del usuario
async function verifyPassword(user, password) {
  if (!user.passwordHash) return false;
  return bcrypt.compare(password, user.passwordHash);
}

// Crear nuevo usuario con ID auto-incremental y contraseña hasheada
async function create({ username, nombre, rol = 'lector', password }) {
  const users = readAll();

  // Validar que username no exista ya
  if (users.find(u => u.username.toLowerCase() === username.toLowerCase())) {
    throw new Error('El usuario ya existe');
  }

  // Hash contraseña si se proporciona
  const passwordHash = password ? await bcrypt.hash(password, SALT_ROUNDS) : null;

  // Crear nuevo usuario con ID auto-incremental
  const newUser = {
    id:           (Math.max(0, ...users.map(u => u.id)) + 1),
    username:     username.trim(),
    nombre:       nombre.trim(),
    rol,
    activo:       true,
    passwordHash,
    createdAt:    new Date().toISOString()
  };

  users.push(newUser);
  writeAll(users);
  return newUser;
}

// Resetea contraseña de un usuario (rehash)
async function setPassword(id, password) {
  const users = readAll();
  const idx   = users.findIndex(u => u.id === parseInt(id));
  if (idx === -1) throw new Error('Usuario no encontrado');

  // Hash nueva contraseña y persistir
  users[idx].passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  writeAll(users);
  return users[idx];
}

// Actualiza campos específicos de un usuario (merge)
function update(id, fields) {
  const users = readAll();
  const idx   = users.findIndex(u => u.id === parseInt(id));
  if (idx === -1) throw new Error('Usuario no encontrado');

  // Merge propiedades existentes con nuevas
  users[idx] = { ...users[idx], ...fields };
  writeAll(users);
  return users[idx];
}

// Activa/desactiva un usuario (invierte flag activo)
function toggleActivo(id) {
  const users = readAll();
  const idx   = users.findIndex(u => u.id === parseInt(id));
  if (idx === -1) throw new Error('Usuario no encontrado');

  // Invertir estado
  users[idx].activo = !users[idx].activo;
  writeAll(users);
  return users[idx];
}

// Exportar todas las operaciones CRUD de usuarios
module.exports = { getAll, findByUsername, findById, create, update, toggleActivo, verifyPassword, setPassword };
