/**
 * roomManager — authoritative world geography and room broadcasting.
 *
 * Responsibilities:
 *   - CRUD for rooms and exits (DB-backed)
 *   - Building Room.Info packets for players entering rooms
 *   - Broadcasting room events via GMCP
 *   - Managing player socket.io room membership
 */

import { getDb } from '../db/database.js';
import { v4 as uuidv4 } from 'uuid';
import { loadRoomItems, unloadRoomItems, getItemsInRoom } from './itemManager.js';
import { getPlayersInRoom, getRoomPlayerCount } from './playerManager.js';
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

// ─── player enter / leave (socket room membership + GMCP events) ──────────────

/**
 * Move a socket into a game room:
 * 1. Join Socket.io room
 * 2. Load item cache if needed
 * 3. Send Room.Info to the entering player
 * 4. Broadcast Room.Players.entered to others
 */
export function enterRoom(io, socket, session, toRoomId) {
  socket.join(roomKey(toRoomId));

  loadRoomItems(toRoomId);

  const room = getRoomById(toRoomId);
  const exits = getExitsForRoom(toRoomId);
  const players = getPlayersInRoom(toRoomId);
  const items = getItemsInRoom(toRoomId);

  // Full state to entering player
  send(socket, GM.ROOM_INFO, {
    id: room.id,
    name: room.name,
    short_desc: room.short_desc,
    long_desc: room.long_desc,
    terrain: room.terrain_type,
    indoor: !!room.indoor,
    safe_zone: !!room.safe_zone,
    light_level: room.light_level,
    exits: exits.map(x => ({ dir: x.direction, name: x.to_room_name, door: !!x.is_door, locked: !!x.is_locked })),
    players,
    items: items.map(itemPacket),
  });

  // Notify others in the room
  broadcastExcept(io, toRoomId, socket.id, GM.ROOM_PLAYERS, {
    entered: { name: session.name, race: session.race, class: session.class, level: session.level },
  });
}

/**
 * Remove a socket from a game room and optionally broadcast departure.
 */
export function leaveRoom(io, socket, session, fromRoomId, reason = 'left') {
  socket.leave(roomKey(fromRoomId));

  // Unload item cache if no players remain
  if (getRoomPlayerCount(fromRoomId) === 0) {
    unloadRoomItems(fromRoomId);
  }

  if (reason !== 'silent') {
    broadcastExcept(io, fromRoomId, socket.id, GM.ROOM_PLAYERS, {
      left: { name: session.name, reason },
    });
  }
}

// ─── room creation / modification ─────────────────────────────────────────────

export function createRoom(fields, createdBy) {
  const id = uuidv4();
  const now = Date.now();
  const db = getDb();
  db.prepare(`
    INSERT INTO rooms (id, name, short_desc, long_desc, terrain_type, indoor, safe_zone, light_level, item_cap, region_id, asset_id, created_by, created_at, updated_at)
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

// ─── exit management ──────────────────────────────────────────────────────────

/**
 * Dig: create a new room in `direction` from `fromRoomId`, link both ways.
 * Returns { newRoom, exits[] }.
 */
export function digRoom(fromRoomId, direction, roomFields, createdBy) {
  const db = getDb();
  const newRoom = createRoom(roomFields, createdBy);
  const now = Date.now();
  const exitId = uuidv4();
  const returnId = uuidv4();
  const opp = OPPOSITE_DIR[direction];

  db.prepare(`
    INSERT INTO room_exits (id, from_room_id, direction, to_room_id, is_door, is_locked, created_by, created_at)
    VALUES (?, ?, ?, ?, 0, 0, ?, ?)
  `).run(exitId, fromRoomId, direction, newRoom.id, createdBy, now);

  db.prepare(`
    INSERT INTO room_exits (id, from_room_id, direction, to_room_id, is_door, is_locked, created_by, created_at)
    VALUES (?, ?, ?, ?, 0, 0, ?, ?)
  `).run(returnId, newRoom.id, opp, fromRoomId, createdBy, now);

  _logAdminAction(createdBy, 'dig', 'room', newRoom.id, { fromRoomId, direction });
  return { newRoom, exits: getExitsForRoom(fromRoomId) };
}

/**
 * Link two existing rooms with a directed exit.
 * `bidirectional` adds a return exit as well.
 */
export function linkRooms(fromRoomId, direction, toRoomId, options, createdBy) {
  const { bidirectional = true, isDoor = false, isLocked = false, doorName = null } = options;
  const db = getDb();
  const now = Date.now();

  // Upsert — replace if direction already exists
  db.prepare(`
    INSERT OR REPLACE INTO room_exits (id, from_room_id, direction, to_room_id, is_door, is_locked, door_name, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(uuidv4(), fromRoomId, direction, toRoomId, isDoor ? 1 : 0, isLocked ? 1 : 0, doorName, createdBy, now);

  if (bidirectional) {
    const opp = OPPOSITE_DIR[direction];
    if (opp) {
      db.prepare(`
        INSERT OR REPLACE INTO room_exits (id, from_room_id, direction, to_room_id, is_door, is_locked, door_name, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(uuidv4(), toRoomId, opp, fromRoomId, isDoor ? 1 : 0, isLocked ? 1 : 0, doorName, createdBy, now);
    }
  }

  _logAdminAction(createdBy, 'link', 'exit', `${fromRoomId}:${direction}`, { toRoomId, bidirectional });
}

export function unlinkExit(fromRoomId, direction, createdBy) {
  getDb().prepare('DELETE FROM room_exits WHERE from_room_id = ? AND direction = ?').run(fromRoomId, direction);
  _logAdminAction(createdBy, 'unlink', 'exit', `${fromRoomId}:${direction}`, {});
}

// ─── Admin Room.Info overlay ──────────────────────────────────────────────────

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

// ─── Room broadcast helpers ───────────────────────────────────────────────────

export function broadcastItemAdded(io, roomId, item) {
  broadcast(io, roomId, GM.ROOM_ITEMS, { added: [itemPacket(item)] });
}

export function broadcastItemRemoved(io, roomId, itemId) {
  broadcast(io, roomId, GM.ROOM_ITEMS, { removed: [itemId] });
}

// ─── helpers ─────────────────────────────────────────────────────────────────

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

// ─── Startup: seed void room if world is empty ────────────────────────────────

export function ensureVoidRoom() {
  const db = getDb();
  const count = db.prepare('SELECT COUNT(*) as n FROM rooms').get().n;
  if (count > 0) return null;

  const id = uuidv4();
  const now = Date.now();
  db.prepare(`
    INSERT INTO rooms (id, name, short_desc, long_desc, terrain_type, indoor, safe_zone, light_level, item_cap, created_by, created_at, updated_at)
    VALUES (?, 'The Void', 'An infinite grey expanse stretches in all directions.', 'The primordial void from which all creation emerged. Nothing exists here yet — only potential.', 'void', 0, 1, 'dim', 0, 'system', ?, ?)
  `).run(id, now, now);

  console.log(`[world] Created starting Void room: ${id}`);
  return id;
}
