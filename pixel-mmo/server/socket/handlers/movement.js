/**
 * Movement handler — player and admin navigation.
 *
 * Rate-limited to MAX_MOVES_PER_SEC per character.
 * Validates exit exists, door unlocked, then updates DB + in-memory state.
 */

import { getDb } from '../../db/database.js';
import { enterRoom, leaveRoom, getRoomById, getExitsForRoom } from '../../engine/roomManager.js';
import { trackMove, getSession } from '../../engine/playerManager.js';
import { GM, send, msg, err } from '../gmcp.js';

const MAX_MOVES_PER_SEC = 3;
const MOVE_WINDOW_MS = 1000 / MAX_MOVES_PER_SEC;
const lastMoveTime = new Map(); // socketId → timestamp

export function registerMovementHandlers(io, socket) {
  socket.on('move', (data) => handleMove(io, socket, data));
  socket.on('admin:teleport', (data) => handleTeleport(io, socket, data));
}

async function handleMove(io, socket, data) {
  const { direction } = data || {};
  if (!direction) return;

  // Rate limit
  const now = Date.now();
  const last = lastMoveTime.get(socket.id) || 0;
  if (now - last < MOVE_WINDOW_MS) {
    send(socket, GM.MOVE_FAIL, { direction, reason: 'Moving too fast.' });
    return;
  }
  lastMoveTime.set(socket.id, now);

  const session = getSession(socket.id);
  if (!session) return;

  const db = getDb();
  const fromRoomId = session.roomId;

  if (!fromRoomId) {
    send(socket, GM.MOVE_FAIL, { direction, reason: 'You are nowhere.' });
    return;
  }

  const exit = db.prepare(
    'SELECT * FROM room_exits WHERE from_room_id = ? AND direction = ?'
  ).get(fromRoomId, direction);

  if (!exit) {
    send(socket, GM.MOVE_FAIL, { direction, reason: 'There is no exit in that direction.' });
    return;
  }

  if (exit.is_locked) {
    send(socket, GM.MOVE_FAIL, { direction, reason: `The ${exit.door_name || 'door'} is locked.` });
    return;
  }

  const toRoomId = exit.to_room_id;

  // Update memory state (before DB to ensure broadcast uses new room)
  leaveRoom(io, socket, session, fromRoomId);
  trackMove(socket.id, fromRoomId, toRoomId);

  // Update DB
  db.prepare('UPDATE characters SET current_room_id = ?, last_active = ? WHERE id = ?')
    .run(toRoomId, Date.now(), session.characterId);

  send(socket, GM.MOVE_SUCCESS, { direction, room_id: toRoomId });
  enterRoom(io, socket, session, toRoomId);
}

async function handleTeleport(io, socket, data) {
  const session = getSession(socket.id);
  if (!session || !['admin','developer'].includes(session.role)) {
    err(socket, 'Unauthorized.');
    return;
  }

  const { room_id } = data || {};
  if (!room_id) { err(socket, 'room_id required.'); return; }

  const targetRoom = getRoomById(room_id);
  if (!targetRoom) { err(socket, `Room ${room_id} not found.`); return; }

  const fromRoomId = session.roomId;
  if (fromRoomId) {
    leaveRoom(io, socket, session, fromRoomId, 'teleported away');
  }
  trackMove(socket.id, fromRoomId, room_id);

  getDb().prepare('UPDATE characters SET current_room_id = ?, last_active = ? WHERE id = ?')
    .run(room_id, Date.now(), session.characterId);

  msg(socket, `Teleported to ${targetRoom.name}.`);
  enterRoom(io, socket, session, room_id);
}
