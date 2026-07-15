const express   = require('express');
const router    = express.Router();
const userStore = require('../db/userStore');

const ROLES_VALIDOS = ['lector', 'admin', 'owner'];

// ── Solo owner ────────────────────────────────────────────
function requireOwner(req, res, next) {
  if (!req.session.user) return res.status(401).json({ ok: false, message: 'No autenticado' });
  if (req.session.user.rol !== 'owner') return res.status(403).json({ ok: false, message: 'Se requiere rol owner' });
  next();
}

// ── Admin o Owner ─────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ ok: false, message: 'No autenticado' });
  if (!['admin', 'owner'].includes(req.session.user.rol)) return res.status(403).json({ ok: false, message: 'Se requiere rol admin u owner' });
  next();
}

// ── GET /api/usuarios ─────────────────────────────────────
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
// Body: { username, nombre, rol, password }
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
// Body: { password }
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
// Body: { nombre, rol }
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
// Activa o desactiva un usuario
router.post('/:id/toggle', requireOwner, (req, res) => {
  // No permitir desactivarse a sí mismo
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
