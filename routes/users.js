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
// Acceso máximo: solo el propietario de la aplicación
function requireOwner(req, res, next) {
  if (!req.session.user) return res.status(401).json({ ok: false, message: 'No autenticado' });
  if (req.session.user.rol !== 'owner') return res.status(403).json({ ok: false, message: 'Se requiere rol owner' });
  next();
}

// ── Middleware: Requiere role admin o owner ──────────────
// Acceso amplio: administrador o propietario
function requireAdmin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ ok: false, message: 'No autenticado' });
  if (!['admin', 'owner'].includes(req.session.user.rol)) return res.status(403).json({ ok: false, message: 'Se requiere rol admin u owner' });
  next();
}

// ── GET /api/usuarios ─────────────────────────────────────
// Lista todos los usuarios registrados (require admin/owner)
// Retorna: { ok: true, data: [{ id, username, nombre, rol, activo, createdAt }, ...] }
// Almacenamiento: db/users.json (vía userStore)
router.get('/', requireAdmin, (req, res) => {
  try {
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
// Crea un nuevo usuario (require owner)
// Body requerido:
//   username: identificador único
//   nombre: nombre completo del usuario
//   rol: 'lector' | 'admin' | 'owner' (default: lector)
//   password: contraseña inicial (se hace hash con bcrypt)
// Validaciones:
//   - username y nombre no vacíos
//   - rol en ROLES_VALIDOS
// Retorna: { ok: true, data: { id, username, nombre, rol, activo, createdAt } }
// Almacena en: db/users.json (vía userStore.create)
router.post('/', requireOwner, async (req, res) => {
  const { username, nombre, rol = 'lector', password } = req.body;
  if (!username || !nombre) return res.status(400).json({ ok: false, message: 'username y nombre son requeridos' });
  // contraseña desactivada temporalmente
  if (!ROLES_VALIDOS.includes(rol)) return res.status(400).json({ ok: false, message: 'Rol inválido' });
  try {
    const user = await userStore.create({ username, nombre, rol, password });
    res.json({ ok: true, data: user });
  } catch (e) {
    res.status(400).json({ ok: false, message: e.message });
  }
});

// ── POST /api/usuarios/:id/password ──────────────────────
// Resetea/cambia la contraseña de un usuario (require owner)
// Params: :id = ID del usuario
// Body requerido: { password: "nueva_contraseña" }
// Validaciones: password >= 4 caracteres
// Retorna: { ok: true }
// Efecto: actualiza contraseña hasheada en db/users.json
router.post('/:id/password', requireOwner, async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 4) return res.status(400).json({ ok: false, message: 'Contraseña muy corta (mínimo 4 caracteres)' });
  try {
    await userStore.setPassword(req.params.id, password);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, message: e.message });
  }
});

// ── PUT /api/usuarios/:id ─────────────────────────────────
// Edita datos de un usuario (require owner)
// Params: :id = ID del usuario
// Body (opcionales): { nombre, rol }
// Validaciones: rol si se pasa debe ser válido
// Retorna: { ok: true, data: { id, username, nombre, rol, activo, createdAt } }
// Efecto: actualiza campos en db/users.json
router.put('/:id', requireOwner, (req, res) => {
  const { nombre, rol } = req.body;
  if (rol && !ROLES_VALIDOS.includes(rol)) return res.status(400).json({ ok: false, message: 'Rol inválido' });
  try {
    const user = userStore.update(req.params.id, { ...(nombre && { nombre }), ...(rol && { rol }) });
    res.json({ ok: true, data: user });
  } catch (e) {
    res.status(400).json({ ok: false, message: e.message });
  }
});

// ── POST /api/usuarios/:id/toggle ─────────────────────────
// Activa/desactiva un usuario (toggle del campo activo)
// Params: :id = ID del usuario
// Validación: no permite desactivarse a sí mismo
// Retorna: { ok: true, data: { id, username, nombre, rol, activo, createdAt } }
// Efecto: invierte flag activo en db/users.json
router.post('/:id/toggle', requireOwner, (req, res) => {
  // Prevención: no permitir desactivarse a sí mismo
  if (parseInt(req.params.id) === req.session.user.id) {
    return res.status(400).json({ ok: false, message: 'No puedes desactivarte a ti mismo' });
  }
  try {
    const user = userStore.toggleActivo(req.params.id);
    res.json({ ok: true, data: user });
  } catch (e) {
    res.status(400).json({ ok: false, message: e.message });
  }
});

module.exports = router;
