const bcrypt = require('bcrypt');
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '../db/users.json');
const DEFAULT_PASSWORD = '123456789';
const SALT_ROUNDS = 10;

async function main() {
  const users = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  for (const u of users) {
    u.passwordHash = await bcrypt.hash(DEFAULT_PASSWORD, SALT_ROUNDS);
    console.log('Reset:', u.username);
  }
  fs.writeFileSync(FILE, JSON.stringify(users, null, 2));
  console.log('Listo —', users.length, 'usuarios con contraseña 123456789');
}
main().catch(console.error);
