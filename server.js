/*
 * server.js
 * Punto de entrada principal de Bajaware.
 * App Node.js/Express que gestiona reportes regulatorios y auditoría.
 * Conecta a SQL Server (192.168.94.43 en producción), inicia monitoreo y respaldos.
 */

require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');

const authRoutes    = require('./routes/auth');
const apiRoutes     = require('./routes/api');
const jiraRoutes    = require('./routes/jira');
const usersRoutes   = require('./routes/users');
const layoutsRoutes   = require('./routes/layouts');
const reportesRoutes  = require('./routes/reportes');
const contratosRoutes = require('./routes/contratos');
const monitor        = require('./services/monitor');
const respaldos      = require('./services/respaldos');
const { setup }     = require('./db/setup');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────
// Configurar parseo JSON/URL con límite 10MB para subidas de Excel
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Configurar sesiones con expiración de 8 horas
app.use(session({
  secret: process.env.SESSION_SECRET || 'bajaware-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 } // 8 horas
}));

// ── Archivos estáticos (frontend) ─────────────────────────
// Servir SPA desde carpeta public/
app.use(express.static(path.join(__dirname, 'public')));

// ── Rutas ─────────────────────────────────────────────────
// Registro de endpoints modulares
app.use('/auth',           authRoutes);
app.use('/api',            apiRoutes);
app.use('/api/jira',       jiraRoutes);
app.use('/api/usuarios',   usersRoutes);
app.use('/api/layouts',    layoutsRoutes);
app.use('/api/reportes',   reportesRoutes);
app.use('/api/contratos',  contratosRoutes);
app.use('/api/inventario', contratosRoutes);

// ── Fallback → SPA ────────────────────────────────────────
// Ruta comodín: redirige todas las demás rutas a index.html (Single Page App)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Arranque ──────────────────────────────────────────────
// Iniciar servidor HTTP en puerto especificado e inicializar servicios
app.listen(PORT, async () => {
  console.log(`Bajaware corriendo en http://localhost:${PORT}`);

  // Crear tablas necesarias en SQL Server si no existen
  try { await setup(); } catch (e) { console.warn('⚠ Setup DB:', e.message); }

  // Iniciar monitoreo de cambios (auditoría en ESTATUS_REPORTE, AUDIT_LOG)
  monitor.iniciar();

  // Iniciar servicio de respaldos automáticos diarios de tablas críticas
  respaldos.iniciar(); // respaldo diario automático de tablas críticas

  // Pre-calentar cache de validaciones en background (no bloquea el arranque)
  contratosRoutes.warmCache()
    .then(() => console.log('✔ Cache validaciones listo'))
    .catch(e  => console.warn('⚠ Cache validaciones:', e.message));
});
