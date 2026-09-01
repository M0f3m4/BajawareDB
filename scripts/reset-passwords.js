/*
 * scripts/reset-passwords.js
 * Utilidad para reiniciar contraseñas de todos los usuarios a un valor por defecto.
 * Uso: node scripts/reset-passwords.js
 * Advertencia: solo usar en desarrollo o setup inicial.
 */

const bcrypt = require('bcrypt');
const fs = require('fs');
const path = require('path');

// Ruta al archivo de usuarios
const FILE = path.join(__dirname, '../db/users.json');
// Contraseña por defecto para todos los usuarios tras reset
const DEFAULT_PASSWORD = '123456789';
// Rondas de bcrypt para hashing
const SALT_ROUNDS = 10;

/**
 * main()
 * Lee archivo users.json, rehashea todas las contraseñas con la contraseña por defecto,
 * y persiste. Útil para reset de desarrollo o setup inicial.
 */
async function main() {
  const users = JSON.parse(fs.readFileSync(FILE, 'utf8'));

  // Rehashear contraseña de cada usuario
  for (const u of users) {
    u.passwordHash = await bcrypt.hash(DEFAULT_PASSWORD, SALT_ROUNDS);
    console.log('Reset:', u.username);
  }

  // Guardar cambios
  fs.writeFileSync(FILE, JSON.stringify(users, null, 2));
  console.log('Listo —', users.length, 'usuarios con contraseña 123456789');
}

// Ejecutar script
main().catch(console.error);
