import 'dotenv/config';
import http from 'http';
import express from 'express';
import cors from 'cors';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';

import { getDb } from './db/database.js';
import { createSocketServer } from './socket/index.js';
import { ensureVoidRoom } from './engine/roomManager.js';

import worldbuildingRouter from './routes/worldbuilding.js';
import adminRouter from './routes/admin.js';
import authRouter from './routes/auth.js';
import worldRouter from './routes/world.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Static files
app.use('/assets', express.static(join(__dir, '../client/assets')));
app.use('/phaser', express.static(join(__dir, 'node_modules/phaser/dist')));
app.use(express.static(join(__dir, '../client')));

// REST routes
app.use('/api/auth',    authRouter);
app.use('/api/world',   worldRouter);
app.use('/api/wb',      worldbuildingRouter);   // worldbuilding pipeline
app.use('/api/wbadmin', adminRouter);           // submission review (legacy token auth)

app.get('/game', (_, res) => res.sendFile('game.html', { root: join(__dir, '../client') }));

app.get('/health', (_, res) => res.json({
  ok: true,
  time: new Date().toISOString(),
  env: process.env.NODE_ENV || 'development',
}));

// ── HTTP + Socket.io ──────────────────────────────────────────────────────────
const httpServer = http.createServer(app);
const io = createSocketServer(httpServer);

// ── World bootstrap ───────────────────────────────────────────────────────────
async function bootstrap() {
  const db = getDb();

  // Seed admin account if missing
  const adminUsername = process.env.ADMIN_USERNAME || 'admin';
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin1234';
  const existing = db.prepare('SELECT id FROM accounts WHERE username = ?').get(adminUsername);
  if (!existing) {
    const hash = await bcrypt.hash(adminPassword, 10);
    const id = uuidv4();
    db.prepare(
      'INSERT INTO accounts (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(id, adminUsername, hash, 'admin', Date.now());
    console.log(`[boot] Admin account created: ${adminUsername}`);
  }

  // Seed void room if world is empty
  ensureVoidRoom();

  httpServer.listen(PORT, () => {
    console.log(`\nPixel MMO server running on http://localhost:${PORT}`);
    console.log(`  Worldbuilder UI:  http://localhost:${PORT}/worldbuilder/`);
    console.log(`  Admin panel:      http://localhost:${PORT}/admin/`);
    console.log(`  Socket.io:        ws://localhost:${PORT}`);
    console.log(`  REST API:         http://localhost:${PORT}/api/\n`);
  });
}

bootstrap().catch(err => {
  console.error('[boot] Fatal error:', err);
  process.exit(1);
});
