import { Server } from 'socket.io';
import { getDb } from '../db/database.js';
import { socketAuth } from '../middleware/auth.js';
import { trackJoin, getSession } from '../engine/playerManager.js';
import { enterRoom, handleDisconnect, sendRoomInfo } from '../engine/roomManager.js';
import { tickExpiredItems } from '../engine/itemManager.js';
import { registerMovementHandlers } from './handlers/movement.js';
import { registerAdminHandlers, setIO as adminSetIO } from './handlers/admin.js';
import { registerCommunicationHandlers } from './handlers/communication.js';
import { registerInventoryHandlers, sendInventory, setIO as invSetIO } from './handlers/inventory.js';
import { registerNpcHandlers, setIO as npcSetIO } from './handlers/npc.js';
import { registerCombatHandlers } from './handlers/combat.js';
import { registerSkillHandlers }  from './handlers/skills.js';
import { setIO as combatSetIO } from '../engine/combatManager.js';
import { broadcast, GM, send, err } from './gmcp.js';
import { RACE_STATS, CLASS_STATS } from '../engine/raceStats.js';

export function createSocketServer(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    pingTimeout: 20000,
    pingInterval: 10000,
  });

  adminSetIO(io);
  invSetIO(io);
  npcSetIO(io);
  combatSetIO(io);

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

      let roomId = character.current_room_id;
      if (!roomId) {
        const voidRoom = db.prepare("SELECT id FROM rooms WHERE name = 'The Void' LIMIT 1").get();
        roomId = voidRoom?.id ?? null;
      }
      if (!roomId) {
        return err(socket, 'No rooms exist yet. An admin must build the world first.');
      }

      const session = trackJoin(socket.id, character, account);

      const raceData  = RACE_STATS[character.race]  ?? RACE_STATS.human;
      const classData = CLASS_STATS[character.class] ?? CLASS_STATS.adventurer;
      const isImmortal = ['admin','developer'].includes(account.role);
      send(socket, GM.CHAR_STATUS, {
        id:    character.id,
        name:  character.name,
        race:  isImmortal ? 'immortal' : character.race,
        class: character.class,
        level: character.level,
        role:  account.role,
        gold:  character.gold,
        stats: {
          str: 10 + raceData.str,
          dex: 10 + raceData.dex,
          con: 10 + raceData.con,
          int: 10 + raceData.int,
          wis: 10 + raceData.wis,
        },
        lore: { race: raceData.lore, class: classData.lore },
      });
      send(socket, GM.CHAR_VITALS, {
        hp: character.health,    maxhp: character.max_health,
        mp: character.mana,      maxmp: character.max_mana,
        ep: character.endurance, maxep: character.max_endurance,
      });

      enterRoom(io, socket, session, roomId);
      sendInventory(socket);

      console.log(`[world] ${character.name} entered room ${roomId}`);
    });

    // ── look ──────────────────────────────────────────────────────────────
    socket.on('look', () => {
      const session = getSession(socket.id);
      if (session?.roomId) sendRoomInfo(socket, session.roomId);
    });

    // ── subsystems ────────────────────────────────────────────────────────
    registerMovementHandlers(io, socket);
    registerCommunicationHandlers(io, socket);
    registerInventoryHandlers(io, socket);
    registerNpcHandlers(io, socket);
    registerCombatHandlers(io, socket);
    registerSkillHandlers(io, socket);

    if (['admin', 'developer'].includes(account.role)) {
      registerAdminHandlers(io, socket);
    }

    // ── rest: restore endurance over time ────────────────────────────────
    const restInterval = setInterval(() => {
      const sess = getSession(socket.id);
      if (!sess?.characterId) return;
      const db   = getDb();
      const char = db.prepare('SELECT health,max_health,mana,max_mana,endurance,max_endurance FROM characters WHERE id = ?').get(sess.characterId);
      if (!char) return;
      const newHp  = Math.min(char.max_health,    char.health    + Math.ceil(char.max_health    * 0.02));
      const newMp  = Math.min(char.max_mana,      char.mana      + Math.ceil(char.max_mana      * 0.03));
      const newEp  = Math.min(char.max_endurance, char.endurance + Math.ceil(char.max_endurance * 0.05));
      if (newHp !== char.health || newMp !== char.mana || newEp !== char.endurance) {
        db.prepare('UPDATE characters SET health=?,mana=?,endurance=? WHERE id=?').run(newHp, newMp, newEp, sess.characterId);
        send(socket, GM.CHAR_VITALS, { hp:newHp, maxhp:char.max_health, mp:newMp, maxmp:char.max_mana, ep:newEp, maxep:char.max_endurance });
      }
    }, 10_000);

    // ── disconnect ────────────────────────────────────────────────────────
    socket.on('disconnect', (reason) => {
      clearInterval(restInterval);
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
