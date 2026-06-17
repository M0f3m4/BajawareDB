const express   = require('express');
const router    = express.Router();
const userStore = require('../db/userStore');

// ── Solo admins ───────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ ok: false, message: 'No autenticado' });
  if (req.session.user.rol !== 'admin') return res.status(403).json({ ok: false, message: 'Se requiere rol admin' });
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
// Body: { username, nombre, rol }
router.post('/', requireAdmin, (req, res) => {
  const { username, nombre, rol = 'lector' } = req.body;
  if (!username || !nombre) return res.status(400).json({ ok: false, message: 'username y nombre son requeridos' });
  if (!['admin', 'lector'].includes(rol)) return res.status(400).json({ ok: false, message: 'Rol inválido' });
  try {
    const user = userStore.create({ username, nombre, rol });
    res.json({ ok: true, data: user });
  } catch (e) {
    res.status(400).json({ ok: false, message: e.message });
  }
});

// ── PUT /api/usuarios/:id ─────────────────────────────────
// Body: { nombre, rol }
router.put('/:id', requireAdmin, (req, res) => {
  const { nombre, rol } = req.body;
  if (rol && !['admin', 'lector'].includes(rol)) return res.status(400).json({ ok: false, message: 'Rol inválido' });
  try {
    const user = userStore.update(req.params.id, { ...(nombre && { nombre }), ...(rol && { rol }) });
    res.json({ ok: true, data: user });
  } catch (e) {
    res.status(400).json({ ok: false, message: e.message });
  }
});

// ── POST /api/usuarios/:id/toggle ─────────────────────────
// Activa o desactiva un usuario
router.post('/:id/toggle', requireAdmin, (req, res) => {
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
