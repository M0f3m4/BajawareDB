const express   = require('express');
const router    = express.Router();
const userStore = require('../db/userStore');

/**
 * POST /auth/login
 * Body: { username }
 * Valida que el usuario exista en la BD (sin contraseña por ahora).
 * Si la BD no está disponible, permite cualquier usuario (modo dev).
 */
router.post('/login', async (req, res) => {
  const { username } = req.body;

  if (!username || !username.trim()) {
    return res.status(400).json({ ok: false, message: 'Usuario requerido' });
  }

  try {
    const found = userStore.findByUsername(username);

    if (!found) {
      return res.status(401).json({ ok: false, message: 'Usuario no encontrado' });
    }
    if (!found.activo) {
      return res.status(401).json({ ok: false, message: 'Usuario desactivado' });
    }

    const user = { id: found.id, nombre: found.nombre, username: found.username, rol: found.rol };
    req.session.user = user;
    return res.json({ ok: true, user });

  } catch (err) {
    console.error('Error en login:', err.message);
    return res.status(500).json({ ok: false, message: 'Error interno' });
  }
});

/**
 * POST /auth/logout
 */
router.post('/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

/**
 * GET /auth/me
 * Devuelve el usuario en sesión actual.
 */
router.get('/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ ok: false });
  res.json({ ok: true, user: req.session.user });
});

module.exports = router;
