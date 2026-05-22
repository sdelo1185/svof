import { Server } from 'socket.io';
import { getDb } from '../db/database.js';
import { socketAuth } from '../middleware/auth.js';
import { trackJoin, getSession } from '../engine/playerManager.js';
import { enterRoom, handleDisconnect, sendRoomInfo } from '../engine/roomManager.js';
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

  // Wire io into admin handler before any connections arrive
  setIO(io);

  io.use(socketAuth);

  io.on('connection', (socket) => {
    const account = socket.data.account;
    console.log(`[socket] connect ${socket.id} acct=${account.id} role=${account.role}`);

    // ── play: select character and enter world ────────────────────────────
    socket.on('play', (data) => {
      const { character_id } = data || {};
      if (!character_id) return err(socket, 'character_id required.');

      const db = getDb();
      const character = db.prepare(
        'SELECT * FROM characters WHERE id = ? AND account_id = ?'
      ).get(character_id, account.id);

      if (!character) return err(socket, 'Character not found or not yours.');

      // Resolve starting room
      let roomId = character.current_room_id;
      if (!roomId) {
        const voidRoom = db.prepare("SELECT id FROM rooms WHERE name = 'The Void' LIMIT 1").get();
        roomId = voidRoom?.id ?? null;
      }
      if (!roomId) {
        return err(socket, 'No rooms exist yet. An admin must build the world first.');
      }

      // Create in-memory session (roomId=null — enterRoom will set it via trackMove)
      const session = trackJoin(socket.id, character, account);

      send(socket, GM.CHAR_STATUS, {
        id: character.id,
        name: character.name,
        race: character.race,
        class: character.class,
        level: character.level,
        role: account.role,
      });
      send(socket, GM.CHAR_VITALS, {
        hp: character.health,    maxhp: character.max_health,
        mp: character.mana,      maxmp: character.max_mana,
        ep: character.endurance, maxep: character.max_endurance,
      });

      // Full transition into starting room
      enterRoom(io, socket, session, roomId);

      console.log(`[world] ${character.name} entered room ${roomId}`);
    });

    // ── look: re-send current room state to this socket only ─────────────
    socket.on('look', () => {
      const session = getSession(socket.id);
      if (session?.roomId) sendRoomInfo(socket, session.roomId);
    });

    // ── movement ──────────────────────────────────────────────────────────
    registerMovementHandlers(io, socket);

    // ── admin commands ────────────────────────────────────────────────────
    if (['admin', 'developer'].includes(account.role)) {
      registerAdminHandlers(io, socket);
    }

    // ── disconnect ────────────────────────────────────────────────────────
    socket.on('disconnect', (reason) => {
      handleDisconnect(io, socket.id);
      console.log(`[socket] disconnect ${socket.id} reason=${reason}`);
    });
  });

  // ── Temporary item expiry tick ────────────────────────────────────────────
  setInterval(() => {
    const expired = tickExpiredItems();
    if (!expired.length) return;

    const byRoom = new Map();
    for (const { roomId, itemId } of expired) {
      if (!byRoom.has(roomId)) byRoom.set(roomId, []);
      byRoom.get(roomId).push(itemId);
    }
    for (const [roomId, itemIds] of byRoom) {
      broadcast(io, roomId, GM.ROOM_ITEMS, { removed: itemIds });
    }
    console.log(`[items] Despawned ${expired.length} temp item(s).`);
  }, 30_000);

  return io;
}
