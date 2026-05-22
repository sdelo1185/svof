/**
 * Socket.io server setup.
 *
 * Connection lifecycle:
 *   1. Auth middleware verifies JWT (socket.data.account)
 *   2. On 'play' event: client sends characterId → validated, session created
 *   3. Character enters their saved room (or Void if none)
 *   4. Gameplay events (move, look, admin:*) are routed to handlers
 *   5. On disconnect: session cleaned, room departure broadcast
 */

import { Server } from 'socket.io';
import { getDb } from '../db/database.js';
import { socketAuth } from '../middleware/auth.js';
import { trackJoin, trackLeave, getSession } from '../engine/playerManager.js';
import { enterRoom, leaveRoom } from '../engine/roomManager.js';
import { tickExpiredItems } from '../engine/itemManager.js';
import { registerMovementHandlers } from './handlers/movement.js';
import { registerAdminHandlers, setIO } from './handlers/admin.js';
import { broadcast, GM, send, msg, err } from './gmcp.js';

export function createSocketServer(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    pingTimeout: 20000,
    pingInterval: 10000,
  });

  setIO(io);

  // Auth middleware on every connection
  io.use(socketAuth);

  io.on('connection', (socket) => {
    const account = socket.data.account;
    console.log(`[socket] connect ${socket.id} acct=${account.id} role=${account.role}`);

    // ── play: enter world with a character ──────────────────────────────────
    socket.on('play', (data) => {
      const { character_id } = data || {};
      if (!character_id) return err(socket, 'character_id required.');

      const db = getDb();
      const character = db.prepare(
        'SELECT * FROM characters WHERE id = ? AND account_id = ?'
      ).get(character_id, account.id);

      if (!character) return err(socket, 'Character not found or not yours.');

      const session = trackJoin(socket.id, character, account);

      // Determine starting room
      let roomId = character.current_room_id;
      if (!roomId) {
        const voidRoom = db.prepare("SELECT id FROM rooms WHERE name = 'The Void' LIMIT 1").get();
        roomId = voidRoom?.id ?? null;
      }

      if (!roomId) {
        err(socket, 'No rooms exist in the world yet. An admin must create the starting room.');
        return;
      }

      // Update session roomId so enterRoom broadcasts correctly
      session.roomId = roomId;

      // Send character status
      send(socket, GM.CHAR_STATUS, {
        id: character.id,
        name: character.name,
        race: character.race,
        class: character.class,
        level: character.level,
        role: account.role,
      });
      send(socket, GM.CHAR_VITALS, {
        hp: character.health, maxhp: character.max_health,
        mp: character.mana, maxmp: character.max_mana,
        ep: character.endurance, maxep: character.max_endurance,
      });

      enterRoom(io, socket, session, roomId);
      console.log(`[socket] ${character.name} entered ${roomId}`);
    });

    // ── look: re-send full room info (player triggered) ─────────────────
    socket.on('look', () => {
      const session = getSession(socket.id);
      if (!session?.roomId) return;
      enterRoom(io, socket, session, session.roomId);
    });

    // ── Movement ─────────────────────────────────────────────────────────
    registerMovementHandlers(io, socket);

    // ── Admin commands ────────────────────────────────────────────────────
    if (['admin', 'developer'].includes(account.role)) {
      registerAdminHandlers(io, socket);
    }

    // ── disconnect ────────────────────────────────────────────────────────
    socket.on('disconnect', (reason) => {
      const session = trackLeave(socket.id);
      if (session?.roomId) {
        leaveRoom(io, socket, session, session.roomId, 'disconnected');
        getDb().prepare('UPDATE characters SET last_active = ? WHERE id = ?')
          .run(Date.now(), session.characterId);
      }
      console.log(`[socket] disconnect ${socket.id} reason=${reason}`);
    });
  });

  // ── Item expiry ticker (every 30s) ────────────────────────────────────────
  setInterval(() => {
    const expired = tickExpiredItems();
    if (expired.length === 0) return;

    // Group by room and broadcast removals
    const byRoom = new Map();
    for (const { roomId, itemId } of expired) {
      if (!byRoom.has(roomId)) byRoom.set(roomId, []);
      byRoom.get(roomId).push(itemId);
    }
    for (const [roomId, itemIds] of byRoom) {
      broadcast(io, roomId, GM.ROOM_ITEMS, { removed: itemIds });
    }
    console.log(`[items] Despawned ${expired.length} temporary item(s).`);
  }, 30_000);

  return io;
}
