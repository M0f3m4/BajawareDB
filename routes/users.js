// ════════════════════════════════════════════════════════════════════════════════
// MÓDULO: Administración de Usuarios
// ════════════════════════════════════════════════════════════════════════════════
// Propósito: APIs CRUD para gestionar usuarios (creación, edición, toggle activo)
// Almacenamiento: db/users.json vía userStore
// Permisos:
//   - GET /: requiere role admin u owner
//   - POST / (crear): requiere role owner
//   - POST /:id/password (resetear): requiere role owner
//   - PUT /:id (editar): requiere role owner
//   - POST /:id/toggle (activar/desactivar): requiere role owner

const express   = require('express');
const router    = express.Router();
const userStore = require('../db/userStore');

const ROLES_VALIDOS = ['lector', 'admin', 'owner'];

// ── Middleware: Requiere role owner ──────────────────────
// Acceso MÁXIMO: solo el propietario de la aplicación (rol='owner')
// Verifica: autenticación + rol exacto 'owner'
// Responde 401 si no autenticado, 403 si rol insuficiente
function requireOwner(req, res, next) {
  if (!req.session.user) return res.status(401).json({ ok: false, message: 'No autenticado' });
  if (req.session.user.rol !== 'owner') return res.status(403).json({ ok: false, message: 'Se requiere rol owner' });
  next();
}

// ── Middleware: Requiere role admin o owner ──────────────
// Acceso AMPLIO: administrador o propietario (rol en ['admin', 'owner'])
// Verifica: autenticación + rol de admin+ (no permite 'lector')
// Responde 401 si no autenticado, 403 si rol insuficiente
function requireAdmin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ ok: false, message: 'No autenticado' });
  if (!['admin', 'owner'].includes(req.session.user.rol)) return res.status(403).json({ ok: false, message: 'Se requiere rol admin u owner' });
  next();
}

// ── GET /api/usuarios ─────────────────────────────────────
// Lista todos los usuarios registrados (require requireAdmin)
// Retorna: { ok: true, data: [{ id, username, nombre, rol, activo, createdAt }, ...] }
// Almacenamiento: db/users.json (vía userStore.getAll)
// Permisos: admin, owner
// Tablas: db/users.json
router.get('/', requireAdmin, (req, res) => {
  try {
    // Recupera todos los usuarios desde userStore y extrae campos públicos
    const users = userStore.getAll().map(u => ({
      id:        u.id,
      username:  u.username,
      nombre:    u.nombre,
      rol:       u.rol,
      activo:    u.activo,
      createdAt: u.createdAt
    }));
    res.json({ ok: true, data: users });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ── POST /api/usuarios ────────────────────────────────────
// Crea un nuevo usuario en db/users.json (require requireOwner)
// Body requerido:
//   username: identificador único (clave del usuario)
//   nombre: nombre completo del usuario
//   rol: 'lector' | 'admin' | 'owner' (default: 'lector')
//   password: contraseña inicial (se genera hash con bcrypt via userStore.create)
// Validaciones:
//   - username y nombre no vacíos (trimmed)
//   - rol está en ROLES_VALIDOS = ['lector', 'admin', 'owner']
//   - username debe ser único (userStore valida duplicados)
// Retorna: { ok: true, data: { id, username, nombre, rol, activo, createdAt } }
// Efecto: inserta nuevo registro en db/users.json con activo=true, password hasheada
// Permisos: owner
// Tablas: db/users.json (vía userStore.create)
router.post('/', requireOwner, async (req, res) => {
  const { username, nombre, rol = 'lector', password } = req.body;
  // Validación 1: username y nombre requeridos
  if (!username || !nombre) return res.status(400).json({ ok: false, message: 'username y nombre son requeridos' });
  // Nota: contraseña temporalmente desactivada en validación (pero se acepta en body)
  // Validación 2: rol debe estar en lista de roles válidos
  if (!ROLES_VALIDOS.includes(rol)) return res.status(400).json({ ok: false, message: 'Rol inválido' });
  try {
    // userStore.create genera ID único, hashea password con bcrypt, y almacena en db/users.json
    const user = await userStore.create({ username, nombre, rol, password });
    res.json({ ok: true, data: user });
  } catch (e) {
    res.status(400).json({ ok: false, message: e.message });
  }
});

// ── POST /api/usuarios/:id/password ──────────────────────
// Resetea/cambia la contraseña de un usuario (require requireOwner)
// Params: :id = ID del usuario (desde db/users.json)
// Body requerido: { password: "nueva_contraseña" }
// Validaciones: password >= 4 caracteres (mínimo básico)
// Retorna: { ok: true }
// Efecto: genera nuevo hash bcrypt y actualiza en db/users.json vía userStore.setPassword
// Permisos: owner
// Tablas: db/users.json
router.post('/:id/password', requireOwner, async (req, res) => {
  const { password } = req.body;
  // Validación: password >= 4 caracteres
  if (!password || password.length < 4) return res.status(400).json({ ok: false, message: 'Contraseña muy corta (mínimo 4 caracteres)' });
  try {
    // userStore.setPassword genera nuevo hash y actualiza el usuario por ID
    await userStore.setPassword(req.params.id, password);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, message: e.message });
  }
});

// ── PUT /api/usuarios/:id ─────────────────────────────────
// Edita datos de un usuario (require requireOwner)
// Params: :id = ID del usuario
// Body (opcionales): { nombre, rol }
//   nombre: nuevo nombre completo (omitir para no cambiar)
//   rol: nuevo rol de ['lector', 'admin', 'owner'] (omitir para no cambiar)
// Validaciones: rol si se pasa debe estar en ROLES_VALIDOS
// Retorna: { ok: true, data: { id, username, nombre, rol, activo, createdAt } }
// Efecto: actualiza solo los campos presentes en el body, en db/users.json vía userStore.update
// Permisos: owner
// Tablas: db/users.json
// Nota: username no se puede cambiar (permanece como identificador único)
router.put('/:id', requireOwner, (req, res) => {
  const { nombre, rol } = req.body;
  // Validación: si rol se pasa, debe estar en lista válida
  if (rol && !ROLES_VALIDOS.includes(rol)) return res.status(400).json({ ok: false, message: 'Rol inválido' });
  try {
    // Usa operador spread para construir objeto de cambios (solo incluye campos presentes)
    const user = userStore.update(req.params.id, { ...(nombre && { nombre }), ...(rol && { rol }) });
    res.json({ ok: true, data: user });
  } catch (e) {
    res.status(400).json({ ok: false, message: e.message });
  }
});

// ── POST /api/usuarios/:id/toggle ─────────────────────────
// Activa/desactiva un usuario (toggle del campo activo: true ↔ false)
// Params: :id = ID del usuario
// Validación: no permite que el owner actual se desactive a sí mismo
// Retorna: { ok: true, data: { id, username, nombre, rol, activo, createdAt } }
// Efecto: invierte el valor de activo en db/users.json vía userStore.toggleActivo
// Permisos: owner
// Tablas: db/users.json
// Seguridad: previene que req.session.user se quede sin acceso (no puede desactivarse a sí mismo)
router.post('/:id/toggle', requireOwner, (req, res) => {
  // Prevención: no permitir que el usuario activo se desactive a sí mismo
  // Compara ID de params con ID de sesión actual
  if (parseInt(req.params.id) === req.session.user.id) {
    return res.status(400).json({ ok: false, message: 'No puedes desactivarte a ti mismo' });
  }
  try {
    // userStore.toggleActivo invierte activo (true→false, false→true)
    const user = userStore.toggleActivo(req.params.id);
    res.json({ ok: true, data: user });
  } catch (e) {
    res.status(400).json({ ok: false, message: e.message });
  }
});

module.exports = router;
