/**
 * GMCP (Generic MUD Communication Protocol) inspired packet system.
 * Each packet is { module: string, data: object }.
 *
 * Module registry mirrors Achaea's GMCP namespacing:
 *   Room.Info        – full room state sent on entry
 *   Room.Players     – delta: {entered, left} player info
 *   Room.Items       – delta: {added[], removed[]}
 *   Char.Status      – static character info (name, race, class, level)
 *   Char.Vitals      – numeric bars (hp, mp, ep and maxes)
 *   Char.Items       – inventory changes
 *   Move.Success     – {direction, room_id}
 *   Move.Fail        – {direction, reason}
 *   Admin.RoomInfo   – extended room data visible only to admins
 *   Admin.AIDraft    – AI-generated room draft pending commit
 *   Server.Message   – system messages (string)
 *   Server.Error     – error messages (string)
 */

export const GM = {
  ROOM_INFO:       'Room.Info',
  ROOM_PLAYERS:    'Room.Players',
  ROOM_ITEMS:      'Room.Items',
  CHAR_STATUS:     'Char.Status',
  CHAR_VITALS:     'Char.Vitals',
  CHAR_ITEMS_INV:  'Char.Items.Inv',
  MOVE_SUCCESS:    'Move.Success',
  MOVE_FAIL:       'Move.Fail',
  COMM_SAY:        'Comm.Say',
  COMM_TELL:       'Comm.Tell',
  COMM_YELL:       'Comm.Yell',
  COMM_EMOTE:      'Comm.Emote',
  ADMIN_ROOM:      'Admin.RoomInfo',
  ADMIN_DRAFT:     'Admin.AIDraft',
  SERVER_MSG:      'Server.Message',
  SERVER_ERR:      'Server.Error',
};

/**
 * Send a GMCP packet to a single socket.
 */
export function send(socket, module, data) {
  socket.emit('gmcp', { module, data });
}

/**
 * Send a GMCP packet to all sockets in a Socket.io room (= game room).
 * io.to(roomSocketKey) broadcasts to all connected clients in that room.
 */
export function broadcast(io, gameRoomId, module, data) {
  io.to(roomKey(gameRoomId)).emit('gmcp', { module, data });
}

/**
 * Broadcast to a room EXCEPT one socket (e.g., the moving player).
 */
export function broadcastExcept(io, gameRoomId, excludeSocketId, module, data) {
  io.to(roomKey(gameRoomId)).except(excludeSocketId).emit('gmcp', { module, data });
}

/** Canonical Socket.io room name for a game room id. */
export function roomKey(gameRoomId) {
  return `room:${gameRoomId}`;
}

/** Convenience: server message to single socket. */
export function msg(socket, text) {
  send(socket, GM.SERVER_MSG, { text });
}

/** Convenience: error to single socket. */
export function err(socket, text) {
  send(socket, GM.SERVER_ERR, { text });
}
