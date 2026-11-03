'use strict';
// Usage: npm run create-user -- staff you@example.com 'a long passphrase'
const { createUser } = require('./db');
const [role, email, password] = process.argv.slice(2);
if (role !== 'staff' || !email || !password || password.length < 10) {
  console.error('Usage: create-user staff <email> <password (10+ chars)>\n(client accounts are created from the staff screen)');
  process.exit(1);
}
try { createUser({ email, password, role }); console.log('Created staff user', email.toLowerCase()); }
catch (e) { console.error(e.message.includes('UNIQUE') ? 'That email already exists.' : e.message); process.exit(1); }
