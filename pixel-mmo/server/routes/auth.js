import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/database.js';
import { signToken, requireAuth } from '../middleware/auth.js';

const router = Router();
const SALT_ROUNDS = 10;

// Register a new account
router.post('/register', async (req, res) => {
  const { username, password, email } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'username and password required.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

  const db = getDb();
  const existing = db.prepare('SELECT id FROM accounts WHERE username = ?').get(username);
  if (existing) return res.status(409).json({ error: 'Username already taken.' });

  const hash = await bcrypt.hash(password, SALT_ROUNDS);
  const id = uuidv4();
  db.prepare(
    'INSERT INTO accounts (id, username, password_hash, email, role, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, username, hash, email || null, 'player', Date.now());

  const token = signToken({ id, username, role: 'player' });
  res.status(201).json({ token, account: { id, username, role: 'player' } });
});

// Login
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'username and password required.' });

  const db = getDb();
  const account = db.prepare('SELECT * FROM accounts WHERE username = ?').get(username);
  if (!account) return res.status(401).json({ error: 'Invalid credentials.' });

  const ok = await bcrypt.compare(password, account.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials.' });

  db.prepare('UPDATE accounts SET last_login = ? WHERE id = ?').run(Date.now(), account.id);

  const token = signToken({ id: account.id, username: account.username, role: account.role });
  res.json({ token, account: { id: account.id, username: account.username, role: account.role } });
});

// List characters for logged-in account
router.get('/characters', requireAuth, (req, res) => {
  const chars = getDb().prepare(
    'SELECT id, name, race, class, level, current_room_id, last_active FROM characters WHERE account_id = ?'
  ).all(req.account.id);
  res.json(chars);
});

// Create a character
router.post('/characters', requireAuth, (req, res) => {
  const { name, race = 'human', class: cls = 'adventurer' } = req.body;
  if (!name) return res.status(400).json({ error: 'name required.' });

  const db = getDb();
  const exists = db.prepare('SELECT id FROM characters WHERE name = ?').get(name);
  if (exists) return res.status(409).json({ error: 'Character name already taken.' });

  const startRoom = db.prepare("SELECT id FROM rooms WHERE name = 'The Void' LIMIT 1").get();
  const id = uuidv4();
  db.prepare(`
    INSERT INTO characters (id, account_id, name, race, class, current_room_id, created_at, last_active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.account.id, name, race, cls, startRoom?.id ?? null, Date.now(), Date.now());

  res.status(201).json(db.prepare('SELECT * FROM characters WHERE id = ?').get(id));
});

export default router;
