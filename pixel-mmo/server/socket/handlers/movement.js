/**
 * Movement handler.
 *
 * enterRoom() in roomManager owns the complete transition:
 *   playerManager → Socket.io → item cache → GMCP packets
 * So this handler only needs to validate the exit, write to DB, then call enterRoom.
 * announceLeave broadcasts departure from the old room before the transition.
 *
 * Rate: MAX_MOVES_PER_SEC per character.
 */

import { getDb } from '../../db/database.js';
import { enterRoom, announceLeave, getRoomById, sendRoomInfo } from '../../engine/roomManager.js';
import { getSession } from '../../engine/playerManager.js';
import { GM, send, err } from '../gmcp.js';

const MAX_MOVES_PER_SEC = 3;
const MOVE_WINDOW_MS = 1000 / MAX_MOVES_PER_SEC;
const lastMoveTime = new Map(); // socketId → ms timestamp

export function registerMovementHandlers(io, socket) {
  socket.on('move', (data) => handleMove(io, socket, data));
  socket.on('admin:teleport', (data) => handleTeleport(io, socket, data));
}

function handleMove(io, socket, data) {
  const { direction } = data || {};
  if (!direction) return;

  // Rate limit
  const now = Date.now();
  if (now - (lastMoveTime.get(socket.id) ?? 0) < MOVE_WINDOW_MS) {
    send(socket, GM.MOVE_FAIL, { direction, reason: 'Moving too fast.' });
    return;
  }
  lastMoveTime.set(socket.id, now);

  const session = getSession(socket.id);
  if (!session?.roomId) {
    send(socket, GM.MOVE_FAIL, { direction, reason: 'You are not in a room.' });
    return;
  }

  const exit = getDb().prepare(
    'SELECT * FROM room_exits WHERE from_room_id = ? AND direction = ?'
  ).get(session.roomId, direction);

  if (!exit) {
    send(socket, GM.MOVE_FAIL, { direction, reason: 'There is no exit in that direction.' });
    return;
  }

  if (exit.is_locked) {
    send(socket, GM.MOVE_FAIL, { direction, reason: `The ${exit.door_name || 'door'} is locked.` });
    return;
  }

  const fromRoomId = session.roomId;
  const toRoomId = exit.to_room_id;

  // Announce departure to the old room BEFORE the transition
  announceLeave(io, socket, session, fromRoomId);

  // Write to DB
  getDb().prepare('UPDATE characters SET current_room_id = ?, last_active = ? WHERE id = ?')
    .run(toRoomId, Date.now(), session.characterId);

  // Full transition: playerManager + Socket.io + item cache + GMCP
  send(socket, GM.MOVE_SUCCESS, { direction, room_id: toRoomId });
  enterRoom(io, socket, session, toRoomId);
}

function handleTeleport(io, socket, data) {
  const session = getSession(socket.id);
  if (!session || !['admin','developer'].includes(session.role)) {
    err(socket, 'Unauthorized.');
    return;
  }

  const { room_id } = data || {};
  if (!room_id) { err(socket, 'room_id required.'); return; }

  const targetRoom = getRoomById(room_id);
  if (!targetRoom) { err(socket, `Room ${room_id} not found.`); return; }

  if (session.roomId) {
    announceLeave(io, socket, session, session.roomId, 'teleported away');
  }

  getDb().prepare('UPDATE characters SET current_room_id = ?, last_active = ? WHERE id = ?')
    .run(room_id, Date.now(), session.characterId);

  enterRoom(io, socket, session, room_id);
}
