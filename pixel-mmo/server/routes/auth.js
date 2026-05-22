import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/database.js';
import { signToken, requireAuth } from '../middleware/auth.js';
import { deriveStats, VALID_RACES, VALID_CLASSES, RACE_STATS, CLASS_STATS } from '../engine/raceStats.js';

const router = Router();
const SALT_ROUNDS = 10;

// Register
router.post('/register', async (req, res) => {
  const { username, password, email } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'username and password required.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

  const db = getDb();
  if (db.prepare('SELECT id FROM accounts WHERE username = ?').get(username)) {
    return res.status(409).json({ error: 'Username already taken.' });
  }

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

// List characters
router.get('/characters', requireAuth, (req, res) => {
  const chars = getDb().prepare(
    'SELECT id, name, race, class, level, current_room_id, last_active FROM characters WHERE account_id = ?'
  ).all(req.account.id);
  res.json(chars);
});

// Create character — stats derived from race+class
router.post('/characters', requireAuth, (req, res) => {
  const race = VALID_RACES.includes(req.body.race)   ? req.body.race   : 'human';
  const cls  = VALID_CLASSES.includes(req.body.class) ? req.body.class  : 'adventurer';
  const name = (req.body.name || '').trim();

  if (!name)        return res.status(400).json({ error: 'name required.' });
  if (name.length < 2 || name.length > 30) return res.status(400).json({ error: 'Name must be 2-30 characters.' });

  const db = getDb();
  if (db.prepare('SELECT id FROM characters WHERE name = ?').get(name)) {
    return res.status(409).json({ error: 'Character name already taken.' });
  }

  const stats    = deriveStats(race, cls);
  const startRoom = db.prepare("SELECT id FROM rooms WHERE name = 'The Void' LIMIT 1").get();
  const id       = uuidv4();
  const now      = Date.now();

  db.prepare(`
    INSERT INTO characters
      (id, account_id, name, race, class, level, experience,
       health, max_health, mana, max_mana, endurance, max_endurance,
       current_room_id, gold, created_at, last_active)
    VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  `).run(
    id, req.account.id, name, race, cls,
    stats.health, stats.max_health,
    stats.mana,   stats.max_mana,
    stats.endurance, stats.max_endurance,
    startRoom?.id ?? null,
    now, now,
  );

  res.status(201).json(db.prepare('SELECT * FROM characters WHERE id = ?').get(id));
});

// Race/class reference data
router.get('/races', (_, res) => {
  res.json(Object.entries(RACE_STATS).map(([id, s]) => ({ id, ...s })));
});
router.get('/classes', (_, res) => {
  res.json(Object.entries(CLASS_STATS).map(([id, s]) => ({ id, ...s })));
});

export default router;
