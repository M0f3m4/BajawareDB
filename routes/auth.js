const express   = require('express');
const router    = express.Router();
const userStore = require('../db/userStore');

/**
 * POST /auth/login
 * Body: { username, password }
 */
router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !username.trim()) {
    return res.status(400).json({ ok: false, message: 'Usuario requerido' });
  }
  if (!password) {
    return res.status(400).json({ ok: false, message: 'Contraseña requerida' });
  }

  try {
    const found = userStore.findByUsername(username);

    if (!found) {
      return res.status(401).json({ ok: false, message: 'Usuario o contraseña incorrectos' });
    }
    if (!found.activo) {
      return res.status(401).json({ ok: false, message: 'Usuario desactivado' });
    }

    const valid = await userStore.verifyPassword(found, password);
    if (!valid) {
      return res.status(401).json({ ok: false, message: 'Usuario o contraseña incorrectos' });
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
 * POST /auth/cambiar-password
 * Body: { username, passwordActual, passwordNueva }
 */
router.post('/cambiar-password', async (req, res) => {
  const { username, passwordActual, passwordNueva } = req.body;
  if (!username || !passwordActual || !passwordNueva) {
    return res.status(400).json({ ok: false, message: 'Todos los campos son requeridos' });
  }
  if (passwordNueva.length < 6) {
    return res.status(400).json({ ok: false, message: 'La nueva contraseña debe tener al menos 6 caracteres' });
  }
  try {
    const found = userStore.findByUsername(username);
    if (!found) return res.status(401).json({ ok: false, message: 'Usuario no encontrado' });
    if (!found.activo) return res.status(401).json({ ok: false, message: 'Usuario desactivado' });
    const valid = await userStore.verifyPassword(found, passwordActual);
    if (!valid) return res.status(401).json({ ok: false, message: 'Contraseña actual incorrecta' });
    await userStore.setPassword(found.id, passwordNueva);
    return res.json({ ok: true, message: 'Contraseña actualizada correctamente' });
  } catch (err) {
    console.error('Error cambiando contraseña:', err.message);
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
 */
router.get('/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ ok: false });
  res.json({ ok: true, user: req.session.user });
});

module.exports = router;
