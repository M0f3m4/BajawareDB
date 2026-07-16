const fs     = require('fs');
const path   = require('path');
const bcrypt = require('bcrypt');

const FILE        = path.join(__dirname, 'users.json');
const SALT_ROUNDS = 10;

function readAll() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return [];
  }
}

function writeAll(users) {
  fs.writeFileSync(FILE, JSON.stringify(users, null, 2), 'utf8');
}

function getAll() {
  return readAll();
}

function findByUsername(username) {
  return readAll().find(u => u.username.toLowerCase() === username.toLowerCase().trim());
}

function findById(id) {
  return readAll().find(u => u.id === parseInt(id));
}

async function verifyPassword(user, password) {
  if (!user.passwordHash) return false;
  return bcrypt.compare(password, user.passwordHash);
}

async function create({ username, nombre, rol = 'lector', password }) {
  const users = readAll();
  if (users.find(u => u.username.toLowerCase() === username.toLowerCase())) {
    throw new Error('El usuario ya existe');
  }
  const passwordHash = password ? await bcrypt.hash(password, SALT_ROUNDS) : null;
  const newUser = {
    id:           (Math.max(0, ...users.map(u => u.id)) + 1),
    username:     username.trim(),
    nombre:       nombre.trim(),
    rol,
    activo:       true,
    passwordHash,
    createdAt:    new Date().toISOString()
  };
  users.push(newUser);
  writeAll(users);
  return newUser;
}

async function setPassword(id, password) {
  const users = readAll();
  const idx   = users.findIndex(u => u.id === parseInt(id));
  if (idx === -1) throw new Error('Usuario no encontrado');
  users[idx].passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  writeAll(users);
  return users[idx];
}

function update(id, fields) {
  const users = readAll();
  const idx   = users.findIndex(u => u.id === parseInt(id));
  if (idx === -1) throw new Error('Usuario no encontrado');
  users[idx] = { ...users[idx], ...fields };
  writeAll(users);
  return users[idx];
}

function toggleActivo(id) {
  const users = readAll();
  const idx   = users.findIndex(u => u.id === parseInt(id));
  if (idx === -1) throw new Error('Usuario no encontrado');
  users[idx].activo = !users[idx].activo;
  writeAll(users);
  return users[idx];
}

module.exports = { getAll, findByUsername, findById, create, update, toggleActivo, verifyPassword, setPassword };
