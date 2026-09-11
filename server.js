/*
 * server.js
 * Punto de entrada principal de Bajaware.
 * App Node.js/Express que gestiona reportes regulatorios y auditoría.
 * Conecta a SQL Server (192.168.94.43 en producción), inicia monitoreo y respaldos.
 */

// Cargar variables de entorno (.env con DB_SERVER, DB_DATABASE, SESSION_SECRET, etc.)
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');

// Rutas modulares por dominio (auth, API, Jira, usuarios, layouts, reportes, contratos, proyectos)
const authRoutes    = require('./routes/auth');
const apiRoutes     = require('./routes/api');
const jiraRoutes    = require('./routes/jira');
const usersRoutes   = require('./routes/users');
const layoutsRoutes   = require('./routes/layouts');
const reportesRoutes  = require('./routes/reportes');
const contratosRoutes = require('./routes/contratos');
const proyectosRoutes = require('./routes/proyectos');
// Servicios de background: monitoreo de cambios y respaldos automáticos
const monitor        = require('./services/monitor');
const respaldos      = require('./services/respaldos');
// Inicializador de tablas SQL Server (crea si no existen, idempotente)
const { setup }     = require('./db/setup');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────
// Parseo de payloads JSON/form-urlencoded con límite 10MB (para carga de Excel/reportes)
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Middleware de sesiones: identificar usuario, timeout tras 8 horas de inactividad.
// Utiliza secret de .env para firmar cookies de sesión (previene manipulación cliente).
app.use(session({
  secret: process.env.SESSION_SECRET || 'bajaware-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 } // 8 horas de validez máxima
}));

// ── Archivos estáticos (frontend) ─────────────────────────
// Servir SPA (Single Page App) desde carpeta public/: index.html, CSS, JS, assets
app.use(express.static(path.join(__dirname, 'public')));

// ── Rutas ─────────────────────────────────────────────────
// Registro de endpoints modulares por dominio (cada uno en su archivo bajo routes/)
app.use('/auth',           authRoutes);           // Login/logout, validación credenciales
app.use('/api',            apiRoutes);            // Endpoints genéricos de API
app.use('/api/jira',       jiraRoutes);           // Integración con Jira (tickets QD/CDL)
app.use('/api/usuarios',   usersRoutes);          // CRUD usuarios (admin)
app.use('/api/layouts',    layoutsRoutes);        // Gestión de layouts SOFIPO
app.use('/api/reportes',   reportesRoutes);       // Carga, validación, cambios de estado de reportes
app.use('/api/contratos',  contratosRoutes);      // Contratos, clientes, reportes por contrato
app.use('/api/inventario', contratosRoutes);      // Alias: inventario = contratos
app.use('/api/proyectos',  proyectosRoutes);      // Proyectos, RAG, semáforos, alertas

// ── Fallback → SPA ────────────────────────────────────────
// Ruta comodín catch-all: redirige todas las demás rutas a index.html (SPA router manejará)
// Permite navegación directa y refresco en subrutas del frontend sin errores 404
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Arranque ──────────────────────────────────────────────
// Iniciar servidor HTTP en puerto especificado (3000 por defecto) e inicializar servicios críticos
app.listen(PORT, async () => {
  console.log(`Bajaware corriendo en http://localhost:${PORT}`);

  // setupDB(): Crear tablas SQL Server si no existen (idempotente, safe para múltiples arranques)
  // Crea: LAYOUT_VERSIONES, QA_ALERTAS, SOFIPO_LAYOUT_*, AUDIT_LOG, INVENTARIO_VERSIONES,
  //       PROYECTOS, PROYECTOS_REPORTES, PROY_RAG_ALERTAS, PROYECTOS_RESPALDO, etc.
  // Agrega columnas faltantes con ALTER TABLE si ya existen (para prod con versiones previas).
  try { await setup(); } catch (e) { console.warn('⚠ Setup DB:', e.message); }

  // monitor.iniciar(): Inicia monitoreo de cambios en background
  // Detecta y registra cambios en ESTATUS_REPORTE y otras tablas críticas en AUDIT_LOG
  monitor.iniciar();

  // respaldos.iniciar(): Inicia servicio de respaldos automáticos diarios
  // Captura snapshots de tablas críticas (PROYECTOS, CONTRATOS_REPORTES, etc.)
  // Permite comparar semana vs semana y recuperación ante corrupción
  respaldos.iniciar();

  // contratosRoutes.warmCache(): Pre-calienta cache de validaciones en background (no bloqueante)
  // Carga en memoria listas de campos, validaciones y catálogos para respuesta rápida
  contratosRoutes.warmCache()
    .then(() => console.log('✔ Cache validaciones listo'))
    .catch(e  => console.warn('⚠ Cache validaciones:', e.message));
});
