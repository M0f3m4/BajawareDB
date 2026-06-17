require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');

const authRoutes  = require('./routes/auth');
const apiRoutes   = require('./routes/api');
const jiraRoutes  = require('./routes/jira');
const usersRoutes = require('./routes/users');
const monitor     = require('./services/monitor');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'bajaware-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 } // 8 horas
}));

// ── Archivos estáticos (frontend) ─────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── Rutas ─────────────────────────────────────────────────
app.use('/auth',         authRoutes);
app.use('/api',          apiRoutes);
app.use('/api/jira',     jiraRoutes);
app.use('/api/usuarios', usersRoutes);

// ── Fallback → SPA ────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Arranque ──────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Bajaware corriendo en http://localhost:${PORT}`);
  monitor.iniciar();
});
