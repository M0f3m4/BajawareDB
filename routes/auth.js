// ════════════════════════════════════════════════════════════════════════════════
// MÓDULO: Autenticación y Gestión de Sesiones
// ════════════════════════════════════════════════════════════════════════════════
// Propósito: Endpoints para login, logout, cambio de contraseña y consulta de sesión
// Datos de usuarios: almacenados en db/users.json vía userStore
// Las sesiones se mantienen server-side en memoria/cookie (express-session)

const express   = require('express');
const router    = express.Router();
const userStore = require('../db/userStore');

// ── POST /auth/login ──────────────────────────────────────
// Autentica un usuario y crea sesión
// Body requerido: { username: string, password: string }
// Validaciones:
//   - username no vacío
//   - password no vacío
//   - usuario existe en db/users.json
//   - usuario está activo
//   - contraseña es correcta
// Retorna: { ok: true, user: { id, nombre, username, rol } }
// Almacena usuario en req.session.user (sesión server-side)
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

    // Crear sesión con datos básicos del usuario
    const user = { id: found.id, nombre: found.nombre, username: found.username, rol: found.rol };
    req.session.user = user;
    return res.json({ ok: true, user });

  } catch (err) {
    console.error('Error en login:', err.message);
    return res.status(500).json({ ok: false, message: 'Error interno' });
  }
});

// ── POST /auth/cambiar-password ───────────────────────────
// Cambia la contraseña de un usuario autenticándose primero
// Body requerido: { username, passwordActual, passwordNueva }
// Validaciones:
//   - todos los campos presentes
//   - passwordNueva >= 6 caracteres
//   - usuario existe y está activo
//   - passwordActual es correcto
// Retorna: { ok: true, message: "..." }
// Almacena nueva contraseña en db/users.json (hash)
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

// ── POST /auth/logout ─────────────────────────────────────
// Cierra la sesión actual del usuario
// Retorna: { ok: true }
// Efecto: destruye req.session.user
router.post('/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

// ── GET /auth/me ──────────────────────────────────────────
// Consulta el usuario de la sesión actual (si existe)
// Retorna: { ok: true, user: { id, nombre, username, rol } } o 401 si no autenticado
// Útil para validar sesión en frontend después de recargar página
router.get('/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ ok: false });
  res.json({ ok: true, user: req.session.user });
});

module.exports = router;
