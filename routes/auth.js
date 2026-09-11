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
// Autentica un usuario y crea sesión server-side
// Body requerido: { username: string, password: string }
// Validaciones:
//   - username no vacío
//   - password no vacío
//   - usuario existe en db/users.json (vía userStore.findByUsername)
//   - usuario está activo (campo activo = true)
//   - contraseña es correcta (verificada con bcrypt vía userStore.verifyPassword)
// Retorna: { ok: true, user: { id, nombre, username, rol } }
// Almacena usuario en req.session.user (sesión server-side express-session)
// Permisos: ninguno (endpoint público para login inicial)
// Tablas: db/users.json (userStore es un repositorio in-memory/file-based)
router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  // Validación 1: username no vacío
  if (!username || !username.trim()) {
    return res.status(400).json({ ok: false, message: 'Usuario requerido' });
  }
  // Validación 2: password no vacío
  if (!password) {
    return res.status(400).json({ ok: false, message: 'Contraseña requerida' });
  }

  try {
    // Búsqueda de usuario por username en userStore
    const found = userStore.findByUsername(username);

    if (!found) {
      return res.status(401).json({ ok: false, message: 'Usuario o contraseña incorrectos' });
    }
    // Verificación: usuario activo
    if (!found.activo) {
      return res.status(401).json({ ok: false, message: 'Usuario desactivado' });
    }

    // Verificación: contraseña correcta (comparación con hash bcrypt)
    const valid = await userStore.verifyPassword(found, password);
    if (!valid) {
      return res.status(401).json({ ok: false, message: 'Usuario o contraseña incorrectos' });
    }

    // Crear sesión con datos básicos del usuario (id, nombre, username, rol)
    // Estos datos se almacenan en express-session y se persisten en cookie
    const user = { id: found.id, nombre: found.nombre, username: found.username, rol: found.rol };
    req.session.user = user;
    return res.json({ ok: true, user });

  } catch (err) {
    console.error('Error en login:', err.message);
    return res.status(500).json({ ok: false, message: 'Error interno' });
  }
});

// ── POST /auth/cambiar-password ───────────────────────────
// Cambia la contraseña de un usuario validando la contraseña actual
// Body requerido: { username, passwordActual, passwordNueva }
// Validaciones:
//   - todos los campos presentes
//   - passwordNueva >= 6 caracteres
//   - usuario existe en db/users.json
//   - usuario está activo
//   - passwordActual es correcto (verificado con bcrypt)
// Retorna: { ok: true, message: "..." }
// Efecto: genera nuevo hash con bcrypt y almacena en db/users.json vía userStore.setPassword
// Permisos: ninguno (endpoint público, requiere validación de contraseña actual)
// Tablas: db/users.json (userStore)
router.post('/cambiar-password', async (req, res) => {
  const { username, passwordActual, passwordNueva } = req.body;
  // Validación 1: todos los campos presentes
  if (!username || !passwordActual || !passwordNueva) {
    return res.status(400).json({ ok: false, message: 'Todos los campos son requeridos' });
  }
  // Validación 2: contraseña nueva tiene mínimo 6 caracteres
  if (passwordNueva.length < 6) {
    return res.status(400).json({ ok: false, message: 'La nueva contraseña debe tener al menos 6 caracteres' });
  }
  try {
    const found = userStore.findByUsername(username);
    if (!found) return res.status(401).json({ ok: false, message: 'Usuario no encontrado' });
    // Verificación: usuario activo
    if (!found.activo) return res.status(401).json({ ok: false, message: 'Usuario desactivado' });
    // Verificación: contraseña actual es correcta
    const valid = await userStore.verifyPassword(found, passwordActual);
    if (!valid) return res.status(401).json({ ok: false, message: 'Contraseña actual incorrecta' });
    // Actualización: genera hash bcrypt y almacena
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
// Efecto: destruye la sesión completa (req.session.destroy), que elimina la cookie
// Permisos: ninguno (endpoint público)
router.post('/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

// ── GET /auth/me ──────────────────────────────────────────
// Consulta el usuario de la sesión actual (si existe)
// Retorna: { ok: true, user: { id, nombre, username, rol } } si autenticado
//         o 401 si no hay sesión activa
// Caso de uso: validar sesión en frontend después de recargar página, establecer
//              usuario autenticado en el store de la aplicación
// Permisos: ninguno (endpoint público, lee datos de sesión existente)
router.get('/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ ok: false });
  res.json({ ok: true, user: req.session.user });
});

module.exports = router;
