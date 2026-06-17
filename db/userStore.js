const fs   = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'users.json');

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

function create({ username, nombre, rol = 'lector' }) {
  const users = readAll();
  if (users.find(u => u.username.toLowerCase() === username.toLowerCase())) {
    throw new Error('El usuario ya existe');
  }
  const newUser = {
    id:        (Math.max(0, ...users.map(u => u.id)) + 1),
    username:  username.trim(),
    nombre:    nombre.trim(),
    rol,
    activo:    true,
    createdAt: new Date().toISOString()
  };
  users.push(newUser);
  writeAll(users);
  return newUser;
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

module.exports = { getAll, findByUsername, findById, create, update, toggleActivo };
