/**
 * Communication handler — say, tell, yell, emote.
 *
 * Rate limits: MAX_MSGS_PER_SEC per socket.
 * Messages are HTML-stripped (plain text only) and length-capped.
 */

import { getSession, getSessionByCharacterId, getAllOnline } from '../../engine/playerManager.js';
import { getExitsForRoom } from '../../engine/roomManager.js';
import { GM, send, broadcast, broadcastExcept, roomKey } from '../gmcp.js';

const MAX_MSG_LEN = 500;
const RATE_WINDOW_MS = 500;         // one message per 500ms
const lastMsgTime = new Map();

export function registerCommunicationHandlers(io, socket) {
  socket.on('say',   (d) => handleSay(io, socket, d));
  socket.on('tell',  (d) => handleTell(io, socket, d));
  socket.on('yell',  (d) => handleYell(io, socket, d));
  socket.on('emote', (d) => handleEmote(io, socket, d));
}

// ─── handlers ────────────────────────────────────────────────────────────────

function handleSay(io, socket, data) {
  const session = getSession(socket.id);
  if (!session?.roomId) return;
  const msg = sanitize(data?.message);
  if (!msg) return;
  if (!rateOk(socket.id)) return send(socket, GM.SERVER_ERR, { text: 'Slow down.' });

  broadcast(io, session.roomId, GM.COMM_SAY, {
    sender: session.name,
    message: msg,
  });
}

function handleTell(io, socket, data) {
  const session = getSession(socket.id);
  if (!session) return;
  const msg = sanitize(data?.message);
  const target = (data?.target || '').trim();
  if (!msg || !target) return;
  if (!rateOk(socket.id)) return send(socket, GM.SERVER_ERR, { text: 'Slow down.' });

  // Find target socket by character name (case-insensitive)
  const all = getAllOnline();
  const targetSession = all.find(s => s.name.toLowerCase() === target.toLowerCase());
  if (!targetSession) {
    return send(socket, GM.SERVER_ERR, { text: `${target} is not online.` });
  }

  const packet = { sender: session.name, to: targetSession.name, message: msg };
  // Send to both parties
  const targetSocket = io.sockets.sockets.get(targetSession.socketId);
  if (targetSocket) send(targetSocket, GM.COMM_TELL, packet);
  send(socket, GM.COMM_TELL, { ...packet, echo: true });
}

function handleYell(io, socket, data) {
  const session = getSession(socket.id);
  if (!session?.roomId) return;
  const msg = sanitize(data?.message);
  if (!msg) return;
  if (!rateOk(socket.id)) return send(socket, GM.SERVER_ERR, { text: 'Slow down.' });

  const packet = { sender: session.name, from_room: session.roomId, message: msg };

  // Broadcast to current room + all directly adjacent rooms
  const exits = getExitsForRoom(session.roomId);
  const roomsToNotify = new Set([session.roomId, ...exits.map(x => x.to_room_id)]);

  for (const roomId of roomsToNotify) {
    io.to(roomKey(roomId)).emit('gmcp', { module: GM.COMM_YELL, data: packet });
  }
}

function handleEmote(io, socket, data) {
  const session = getSession(socket.id);
  if (!session?.roomId) return;
  const msg = sanitize(data?.message);
  if (!msg) return;
  if (!rateOk(socket.id)) return send(socket, GM.SERVER_ERR, { text: 'Slow down.' });

  broadcast(io, session.roomId, GM.COMM_EMOTE, {
    sender: session.name,
    message: msg,
  });
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function sanitize(str) {
  if (typeof str !== 'string') return '';
  return str.trim().slice(0, MAX_MSG_LEN);
}

function rateOk(socketId) {
  const now = Date.now();
  if (now - (lastMsgTime.get(socketId) ?? 0) < RATE_WINDOW_MS) return false;
  lastMsgTime.set(socketId, now);
  return true;
}
