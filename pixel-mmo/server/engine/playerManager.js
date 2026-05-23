/**
 * playerManager — tracks all online characters in memory.
 *
 * onlineSessions: Map<socketId, SessionRecord>
 * roomIndex:      Map<roomId, Set<socketId>>   (fast "who's here" lookup)
 *
 * A SessionRecord holds everything needed for broadcasting without hitting DB:
 *   { socketId, characterId, accountId, name, race, class, level, role,
 *     roomId, connectedAt, lastActivity }
 */

/** @type {Map<string, object>} */
const onlineSessions = new Map();

/** @type {Map<string, Set<string>>} */
const roomIndex = new Map();

export function trackJoin(socketId, character, account) {
  const isImmortal = ['admin','developer'].includes(account.role);
  const session = {
    socketId,
    characterId: character.id,
    accountId: account.id,
    name: character.name,
    race: character.race,
    displayRace: isImmortal ? 'immortal' : character.race,
    class: character.class,
    level: character.level,
    role: account.role,
    roomId: null,   // enterRoom calls trackMove to set this correctly
    connectedAt: Date.now(),
    lastActivity: Date.now(),
  };
  onlineSessions.set(socketId, session);
  return session;
}

export function trackLeave(socketId) {
  const session = onlineSessions.get(socketId);
  if (!session) return null;
  if (session.roomId) _removeFromRoom(socketId, session.roomId);
  onlineSessions.delete(socketId);
  return session;
}

/** Called by movement handler BEFORE the DB update. */
export function trackMove(socketId, fromRoomId, toRoomId) {
  const session = onlineSessions.get(socketId);
  if (!session) return;
  if (fromRoomId) _removeFromRoom(socketId, fromRoomId);
  _addToRoom(socketId, toRoomId);
  session.roomId = toRoomId;
  session.lastActivity = Date.now();
}

export function touch(socketId) {
  const s = onlineSessions.get(socketId);
  if (s) s.lastActivity = Date.now();
}

export function getSession(socketId) {
  return onlineSessions.get(socketId) ?? null;
}

export function getSessionByCharacterId(characterId) {
  for (const s of onlineSessions.values()) {
    if (s.characterId === characterId) return s;
  }
  return null;
}

/** Returns lightweight player objects for Room.Info / Room.Players packets. */
export function getPlayersInRoom(roomId) {
  const ids = roomIndex.get(roomId);
  if (!ids || ids.size === 0) return [];
  return [...ids].map(sid => {
    const s = onlineSessions.get(sid);
    return s ? { name: s.name, race: s.displayRace ?? s.race, class: s.class, level: s.level } : null;
  }).filter(Boolean);
}

export function getRoomPlayerCount(roomId) {
  return roomIndex.get(roomId)?.size ?? 0;
}

export function getTotalOnline() {
  return onlineSessions.size;
}

export function getAllOnline() {
  return [...onlineSessions.values()];
}

// ─── internal helpers ─────────────────────────────────────────────────────────

function _addToRoom(socketId, roomId) {
  if (!roomIndex.has(roomId)) roomIndex.set(roomId, new Set());
  roomIndex.get(roomId).add(socketId);
}

function _removeFromRoom(socketId, roomId) {
  const set = roomIndex.get(roomId);
  if (!set) return;
  set.delete(socketId);
  if (set.size === 0) roomIndex.delete(roomId);
}
