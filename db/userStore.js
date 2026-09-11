/*
 * db/userStore.js
 * Almacén de usuarios en archivo JSON (users.json).
 * CRUD de usuarios con autenticación bcrypt.
 * Nota: users.json es el archivo de sesiones y autenticación local (NOT SQL Server).
 */

const fs     = require('fs');
const path   = require('path');
const bcrypt = require('bcrypt');

// ── Configuración ──────────────────────────────────────────────────────
// Ruta al archivo de usuarios persistente (users.json, NO en SQL Server)
// Nota: userStore.js es almacén local de autenticación; usuarios ≠ tablas CLIENTE/PROYECTOS de SQL
const FILE        = path.join(__dirname, 'users.json');
// Rondas de hashing bcrypt (10 = ~100ms en máquina típica; más alto = más seguro pero lento)
// Cambiar solo si performance lo requiere (ej: >10 = más seguro pero timeouts en login)
const SALT_ROUNDS = 10;

/**
 * readAll(): Lee array de usuarios desde users.json
 *
 * Retorna: Array de objetos usuario (si existe y es válido JSON)
 *          [] (array vacío) si archivo no existe o JSON corrupto (no tira error)
 *
 * Estructura usuario:
 *  { id, username, nombre, rol, activo, passwordHash, createdAt }
 */
function readAll() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    // Silenciosamente retorna [] si archivo falta o JSON inválido (init graceful)
    return [];
  }
}

/**
 * writeAll(): Persiste array de usuarios en users.json (sobrescribe)
 *
 * @param {array} users - Array de objetos usuario a guardar
 * Formato: JSON con identación 2 espacios (legible para admin)
 */
function writeAll(users) {
  fs.writeFileSync(FILE, JSON.stringify(users, null, 2), 'utf8');
}

/**
 * getAll(): Retorna todos los usuarios registrados
 *
 * Retorna: Array de objetos usuario (vacío si no hay usuarios)
 */
function getAll() {
  return readAll();
}

/**
 * findByUsername(): Busca usuario por username (case-insensitive)
 *
 * @param {string} username - Username a buscar (ej: "admin", "ADMIN")
 * Retorna: Objeto usuario si encontrado, undefined si no existe
 *
 * Búsqueda case-insensitive + trim de espacios (ej: " admin " == "ADMIN")
 */
function findByUsername(username) {
  return readAll().find(u => u.username.toLowerCase() === username.toLowerCase().trim());
}

/**
 * findById(): Busca usuario por ID numérico
 *
 * @param {number|string} id - ID a buscar (auto-incremental en users.json)
 * Retorna: Objeto usuario si encontrado, undefined si no existe
 */
function findById(id) {
  return readAll().find(u => u.id === parseInt(id));
}

/**
 * verifyPassword(): Verifica contraseña contra hash bcrypt
 *
 * @param {object} user     - Objeto usuario (con passwordHash)
 * @param {string} password - Contraseña en plano a verificar
 * Retorna: true si password es correcto, false si no
 *
 * Proceso: bcrypt.compare descifra hash y compara constantemente (previene timing attacks)
 * Nota: Si user.passwordHash no existe, retorna false (usuario sin password = no puede login)
 */
async function verifyPassword(user, password) {
  if (!user.passwordHash) return false;
  return bcrypt.compare(password, user.passwordHash);
}

/**
 * create(): Crear nuevo usuario con ID auto-incremental y contraseña hasheada
 *
 * @param {object} params - { username, nombre, rol='lector', password }
 *   - username: identificador único (case-insensitive check, trimmed)
 *   - nombre: nombre completo (trimmed)
 *   - rol: 'lector' | 'editor' | 'admin' (default 'lector')
 *   - password: contraseña en plano (hasheada con bcrypt antes de guardar)
 *
 * Retorna: Objeto usuario nuevo (con ID asignado, createdAt timestamp)
 *
 * Throws: Error si username ya existe (case-insensitive)
 *
 * Campos generados automáticamente:
 *  - id: Math.max(usuarios existentes) + 1 (auto-incremental)
 *  - activo: true (todos nuevos usuarios activos por defecto)
 *  - passwordHash: bcrypt.hash(password, SALT_ROUNDS) si password se proporciona, null si no
 *  - createdAt: ISO timestamp del momento de creación
 */
async function create({ username, nombre, rol = 'lector', password }) {
  const users = readAll();

  // Validar: username no existe ya (case-insensitive)
  if (users.find(u => u.username.toLowerCase() === username.toLowerCase())) {
    throw new Error('El usuario ya existe');
  }

  // Hash contraseña si se proporciona (null si no)
  const passwordHash = password ? await bcrypt.hash(password, SALT_ROUNDS) : null;

  // Crear nuevo usuario con ID auto-incremental
  const newUser = {
    id:           (Math.max(0, ...users.map(u => u.id)) + 1),  // ID = max_existente + 1
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

/**
 * setPassword(): Resetea/cambia contraseña de un usuario (rehash bcrypt)
 *
 * @param {number|string} id - ID del usuario
 * @param {string} password  - Nueva contraseña en plano (será hasheada)
 *
 * Retorna: Objeto usuario modificado
 * Throws: Error si usuario no encontrado
 *
 * Uso: admin reset contraseña olvidada, cambio de password en perfil
 */
async function setPassword(id, password) {
  const users = readAll();
  const idx   = users.findIndex(u => u.id === parseInt(id));
  if (idx === -1) throw new Error('Usuario no encontrado');

  // Hash nueva contraseña (rehash) y persistir
  users[idx].passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  writeAll(users);
  return users[idx];
}

/**
 * update(): Actualiza campos específicos de un usuario (merge parcial)
 *
 * @param {number|string} id - ID del usuario
 * @param {object} fields    - Mapa de campos a actualizar
 *                             (ej: { nombre: 'Nuevo Nombre', rol: 'admin' })
 *
 * Retorna: Objeto usuario modificado (merge: campos viejos + nuevos)
 * Throws: Error si usuario no encontrado
 *
 * Nota: Si quieres cambiar contraseña, usa setPassword() (hashea bcrypt)
 *       update() no modifica passwordHash de manera segura
 */
function update(id, fields) {
  const users = readAll();
  const idx   = users.findIndex(u => u.id === parseInt(id));
  if (idx === -1) throw new Error('Usuario no encontrado');

  // Merge: conserva propiedades viejas, sobrescribe con las nuevas
  users[idx] = { ...users[idx], ...fields };
  writeAll(users);
  return users[idx];
}

/**
 * toggleActivo(): Activa/desactiva un usuario (invierte flag)
 *
 * @param {number|string} id - ID del usuario
 *
 * Retorna: Objeto usuario modificado (activo flip)
 * Throws: Error si usuario no encontrado
 *
 * Efecto: activo: true → false (o vice versa)
 * Usuario inactivo no puede hacer login ni ver datos
 */
function toggleActivo(id) {
  const users = readAll();
  const idx   = users.findIndex(u => u.id === parseInt(id));
  if (idx === -1) throw new Error('Usuario no encontrado');

  // Invertir estado activo
  users[idx].activo = !users[idx].activo;
  writeAll(users);
  return users[idx];
}

// ── Exportar ───────────────────────────────────────────────────────────
// CRUD de usuarios: getters (getAll, findByUsername, findById),
//                   setters (create, update, setPassword, toggleActivo),
//                   verificación (verifyPassword)
module.exports = { getAll, findByUsername, findById, create, update, toggleActivo, verifyPassword, setPassword };
