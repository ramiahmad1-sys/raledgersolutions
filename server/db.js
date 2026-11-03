'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
fs.mkdirSync(path.join(DATA_DIR, 'files'), { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'portal.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS clients (id TEXT PRIMARY KEY, name TEXT NOT NULL, contact TEXT NOT NULL DEFAULT '', created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, role TEXT NOT NULL CHECK (role IN ('staff','client')),
  client_id TEXT REFERENCES clients(id) ON DELETE CASCADE, pw TEXT NOT NULL, created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK (kind IN ('doc','report')),
  name TEXT NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL, period TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
  by TEXT NOT NULL, date TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE, title TEXT NOT NULL,
  due TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')), created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE, sender TEXT NOT NULL CHECK (sender IN ('staff','client')),
  text TEXT NOT NULL, date TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_files_client ON files(client_id);
CREATE INDEX IF NOT EXISTS idx_req_client ON requests(client_id);
CREATE INDEX IF NOT EXISTS idx_msg_client ON messages(client_id);
`);

// migration: per-client email opt-out (1 = send notification emails to this client)
if (!db.prepare('PRAGMA table_info(clients)').all().some(c => c.name === 'notify'))
  db.exec('ALTER TABLE clients ADD COLUMN notify INTEGER NOT NULL DEFAULT 1');

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return salt.toString('hex') + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
function checkPassword(pw, stored) {
  const [salt, hash] = stored.split(':');
  const a = Buffer.from(hash, 'hex'), b = crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function createUser({ email, password, role, clientId = null }) {
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO users (id,email,role,client_id,pw,created) VALUES (?,?,?,?,?,?)')
    .run(id, email.trim().toLowerCase(), role, clientId, hashPassword(password), new Date().toISOString());
  return id;
}
module.exports = { db, DATA_DIR, hashPassword, checkPassword, createUser };
