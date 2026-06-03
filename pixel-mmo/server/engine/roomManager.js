/**
 * roomManager — world geography, room state, and player transitions.
 *
 * enterRoom owns the complete transition:
 *   playerManager update → Socket.io membership → item cache → GMCP packets
 * This keeps movement.js, play handler, and disconnect handler simple.
 *
 * sendRoomInfo re-sends Room.Info to a single socket without side-effects
 * (used by the 'look' handler).
 */

import { getDb } from '../db/database.js';
import { v4 as uuidv4 } from 'uuid';
import { loadRoomItems, unloadRoomItems, getItemsInRoom } from './itemManager.js';
import { trackMove, trackLeave, getPlayersInRoom, getRoomPlayerCount } from './playerManager.js';
import { getNpcsInRoom } from './npcManager.js';
import { GM, send, broadcast, broadcastExcept, roomKey } from '../socket/gmcp.js';

export const OPPOSITE_DIR = {
  n: 's', s: 'n',
  e: 'w', w: 'e',
  ne: 'sw', sw: 'ne',
  nw: 'se', se: 'nw',
  u: 'd', d: 'u',
  in: 'out', out: 'in',
};

// ─── room queries ─────────────────────────────────────────────────────────────

export function getRoomById(roomId) {
  return getDb().prepare('SELECT * FROM rooms WHERE id = ?').get(roomId) ?? null;
}

export function getExitsForRoom(roomId) {
  return getDb().prepare(`
    SELECT re.*, r.name as to_room_name
    FROM room_exits re
    JOIN rooms r ON r.id = re.to_room_id
    WHERE re.from_room_id = ?
    ORDER BY re.direction
  `).all(roomId);
}

export function getRoomWithExits(roomId) {
  const room = getRoomById(roomId);
  if (!room) return null;
  room.exits = getExitsForRoom(roomId);
  return room;
}

// ─── player transitions ───────────────────────────────────────────────────────

/**
 * Fully transition a socket into toRoomId from wherever session says they are.
 * Handles: playerManager index, Socket.io rooms, item cache, GMCP packets.
 */
export function enterRoom(io, socket, session, toRoomId) {
  const fromRoomId = session.roomId ?? null;

  // 1. Update playerManager (session.roomId + roomIndex)
  trackMove(socket.id, fromRoomId, toRoomId);

  // 2. Update Socket.io membership
  if (fromRoomId) socket.leave(roomKey(fromRoomId));
  socket.join(roomKey(toRoomId));

  // 3. Clean up old room item cache if it's now empty
  if (fromRoomId && getRoomPlayerCount(fromRoomId) === 0) {
    unloadRoomItems(fromRoomId);
  }

  // 4. Load new room items
  loadRoomItems(toRoomId);

  // 5. Send full room state to the entering socket
  sendRoomInfo(socket, toRoomId);

  // 6. Tell everyone else in the destination
  broadcastExcept(io, toRoomId, socket.id, GM.ROOM_PLAYERS, {
    entered: { name: session.name, race: session.displayRace ?? session.race, class: session.class, level: session.level },
  });
}

/**
 * Announce departure from a room. Does NOT update playerManager or Socket.io
 * membership — callers handle that before/after.
 */
export function announceLeave(io, socket, session, fromRoomId, reason = 'left') {
  if (reason === 'silent') return;
  io.to(roomKey(fromRoomId)).emit('gmcp', {
    module: GM.ROOM_PLAYERS,
    data: { left: { name: session.name, reason } },
  });
}

/**
 * Handle disconnect: clean up playerManager, unload items if room now empty,
 * broadcast departure. Returns the session (or null).
 */
export function handleDisconnect(io, socketId) {
  const session = trackLeave(socketId);
  if (!session) return null;

  if (session.roomId) {
    // Broadcast departure — socket is disconnecting so use io.to instead of broadcastExcept
    io.to(roomKey(session.roomId)).emit('gmcp', {
      module: GM.ROOM_PLAYERS,
      data: { left: { name: session.name, reason: 'disconnected' } },
    });
    if (getRoomPlayerCount(session.roomId) === 0) {
      unloadRoomItems(session.roomId);
    }
  }

  getDb().prepare('UPDATE characters SET last_active = ? WHERE id = ?')
    .run(Date.now(), session.characterId);

  return session;
}

/**
 * Re-send Room.Info to a single socket — no side effects. Used by 'look'.
 */
export function sendRoomInfo(socket, roomId) {
  const room = getRoomById(roomId);
  if (!room) return;
  const exits = getExitsForRoom(roomId);
  const players = getPlayersInRoom(roomId);
  const items = getItemsInRoom(roomId);

  const npcs = getNpcsInRoom(roomId);

  send(socket, GM.ROOM_INFO, {
    id: room.id,
    name: room.name,
    short_desc: room.short_desc,
    long_desc: room.long_desc,
    terrain: room.terrain_type,
    indoor: !!room.indoor,
    safe_zone: !!room.safe_zone,
    light_level: room.light_level,
    image_url: room.image_url || null,
    exits: exits.map(x => ({
      dir: x.direction,
      name: x.to_room_name,
      door: !!x.is_door,
      locked: !!x.is_locked,
    })),
    players,
    npcs: npcs.map(n => ({ id: n.id, name: n.name, title: n.title, race: n.race, role: n.role, is_combatant: !!n.is_combatant, image_url: n.image_url || null })),
    items: items.map(itemPacket),
  });
}

// ─── room creation / modification ─────────────────────────────────────────────

export function createRoom(fields, createdBy) {
  const id = uuidv4();
  const now = Date.now();
  const db = getDb();
  db.prepare(`
    INSERT INTO rooms (id, name, short_desc, long_desc, terrain_type, indoor, safe_zone,
                       light_level, item_cap, region_id, asset_id, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    fields.name,
    fields.short_desc,
    fields.long_desc ?? null,
    fields.terrain_type ?? 'plains',
    fields.indoor ? 1 : 0,
    fields.safe_zone ? 1 : 0,
    fields.light_level ?? 'normal',
    fields.item_cap ?? 50,
    fields.region_id ?? null,
    fields.asset_id ?? null,
    createdBy,
    now, now,
  );
  return db.prepare('SELECT * FROM rooms WHERE id = ?').get(id);
}

export function updateRoom(roomId, fields, updatedBy) {
  const allowed = ['name','short_desc','long_desc','terrain_type','indoor','safe_zone','light_level','item_cap','region_id'];
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(fields)) {
    if (allowed.includes(k)) { sets.push(`${k} = ?`); vals.push(v); }
  }
  if (sets.length === 0) return null;
  sets.push('updated_at = ?');
  vals.push(Date.now(), roomId);
  getDb().prepare(`UPDATE rooms SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  _logAdminAction(updatedBy, 'update_room', 'room', roomId, fields);
  return getRoomById(roomId);
}

export function updateRoomImage(roomId, imageUrl) {
  getDb().prepare('UPDATE rooms SET image_url = ? WHERE id = ?').run(imageUrl, roomId);
}

// ─── exit management ──────────────────────────────────────────────────────────

export function digRoom(fromRoomId, direction, roomFields, createdBy) {
  const db = getDb();
  const newRoom = createRoom(roomFields, createdBy);
  const now = Date.now();
  const opp = OPPOSITE_DIR[direction];

  db.prepare(`
    INSERT INTO room_exits (id, from_room_id, direction, to_room_id, is_door, is_locked, created_by, created_at)
    VALUES (?, ?, ?, ?, 0, 0, ?, ?)
  `).run(uuidv4(), fromRoomId, direction, newRoom.id, createdBy, now);

  db.prepare(`
    INSERT INTO room_exits (id, from_room_id, direction, to_room_id, is_door, is_locked, created_by, created_at)
    VALUES (?, ?, ?, ?, 0, 0, ?, ?)
  `).run(uuidv4(), newRoom.id, opp, fromRoomId, createdBy, now);

  _logAdminAction(createdBy, 'dig', 'room', newRoom.id, { fromRoomId, direction });
  return { newRoom, exits: getExitsForRoom(fromRoomId) };
}

export function linkRooms(fromRoomId, direction, toRoomId, options, createdBy) {
  const { bidirectional = true, isDoor = false, isLocked = false, doorName = null } = options;
  const db = getDb();
  const now = Date.now();

  db.prepare(`
    INSERT OR REPLACE INTO room_exits (id, from_room_id, direction, to_room_id, is_door, is_locked, door_name, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(uuidv4(), fromRoomId, direction, toRoomId, isDoor?1:0, isLocked?1:0, doorName, createdBy, now);

  if (bidirectional) {
    const opp = OPPOSITE_DIR[direction];
    if (opp) {
      db.prepare(`
        INSERT OR REPLACE INTO room_exits (id, from_room_id, direction, to_room_id, is_door, is_locked, door_name, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(uuidv4(), toRoomId, opp, fromRoomId, isDoor?1:0, isLocked?1:0, doorName, createdBy, now);
    }
  }

  _logAdminAction(createdBy, 'link', 'exit', `${fromRoomId}:${direction}`, { toRoomId, bidirectional });
}

export function unlinkExit(fromRoomId, direction, createdBy) {
  getDb().prepare('DELETE FROM room_exits WHERE from_room_id = ? AND direction = ?').run(fromRoomId, direction);
  _logAdminAction(createdBy, 'unlink', 'exit', `${fromRoomId}:${direction}`, {});
}

// ─── Admin overlay ────────────────────────────────────────────────────────────

export function getAdminRoomOverlay(roomId) {
  const room = getRoomById(roomId);
  if (!room) return null;
  const exits = getExitsForRoom(roomId);
  const itemCount = getItemsInRoom(roomId).length;
  const playerCount = getRoomPlayerCount(roomId);

  return {
    ...room,
    exits_detail: exits.map(x => ({
      dir: x.direction,
      exit_id: x.id,
      to_room_id: x.to_room_id,
      to_room_name: x.to_room_name,
      door: !!x.is_door,
      locked: !!x.is_locked,
    })),
    item_count: itemCount,
    item_cap: room.item_cap,
    player_count: playerCount,
  };
}

export function broadcastItemAdded(io, roomId, item) {
  broadcast(io, roomId, GM.ROOM_ITEMS, { added: [itemPacket(item)] });
}

export function broadcastItemRemoved(io, roomId, itemId) {
  broadcast(io, roomId, GM.ROOM_ITEMS, { removed: [itemId] });
}

// ─── Startup ──────────────────────────────────────────────────────────────────

export function ensureVoidRoom() {
  const db = getDb();
  if (db.prepare('SELECT COUNT(*) as n FROM rooms').get().n > 0) return null;

  const id = uuidv4();
  const now = Date.now();
  db.prepare(`
    INSERT INTO rooms (id, name, short_desc, long_desc, terrain_type, indoor, safe_zone,
                       light_level, item_cap, created_by, created_at, updated_at)
    VALUES (?, 'The Void', 'An infinite grey expanse stretches in all directions.',
            'The primordial void from which all creation emerged. Nothing exists here yet — only potential.',
            'void', 0, 1, 'dim', 0, 'system', ?, ?)
  `).run(id, now, now);

  console.log(`[world] Created starting Void room: ${id}`);
  return id;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function itemPacket(item) {
  return {
    id: item.id,
    name: item.name,
    type: item.type,
    description: item.description,
    stackCount: item.stackCount,
    persistent: item.isPersistent,
  };
}

function _logAdminAction(adminId, actionType, targetType, targetId, data) {
  try {
    getDb().prepare(
      'INSERT INTO admin_actions (admin_id, action_type, target_type, target_id, data, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(adminId, actionType, targetType, targetId, JSON.stringify(data), Date.now());
  } catch { /* non-fatal */ }
}
