/**
 * Admin socket command handlers.
 *
 * All handlers check session.role before executing.
 * Events registered here:
 *   admin:look          – detailed room overlay
 *   admin:dig           – create new room in direction + auto-link
 *   admin:link          – link current room to existing room by id
 *   admin:unlink        – remove an exit
 *   admin:setroom       – update current room properties
 *   admin:setcap        – update item cap for current room
 *   admin:placeitem     – place item template in current room
 *   admin:removeitem    – remove item by id from current room
 *   admin:listrooms     – paginated room list with filters
 *   admin:ai:generate   – AI draft generation
 *   admin:ai:commit     – commit pending draft
 *   admin:ai:discard    – discard pending draft
 */

import { getDb } from '../../db/database.js';
import { getSession } from '../../engine/playerManager.js';
import {
  getAdminRoomOverlay,
  digRoom,
  linkRooms,
  unlinkExit,
  updateRoom,
  broadcastItemAdded,
  broadcastItemRemoved,
} from '../../engine/roomManager.js';
import { placeItem, removeItem, getItemsInRoom, getRoomCap, getItemCount } from '../../engine/itemManager.js';
import { generateRoomDraft, storeDraft, getDraft, clearDraft, commitDraft } from '../../engine/worldBuilder.js';
import { runWorldAgent, expandArea, generateNpcPortrait } from '../../services/worldAgent.js';
import { generatePixelArtImage } from '../../services/imageGen.js';
import { updateRoomImage } from '../../engine/roomManager.js';
import { GM, send, msg, err } from '../gmcp.js';

export function registerAdminHandlers(io, socket) {
  const guard = (fn) => async (data) => {
    const session = getSession(socket.id);
    if (!session || !['admin','developer'].includes(session.role)) {
      return err(socket, 'Admin access required.');
    }
    try {
      await fn(session, data || {});
    } catch (e) {
      console.error(`[admin] ${socket.id}:`, e.message);
      err(socket, e.message);
    }
  };

  socket.on('admin:look',         guard(handleLook));
  socket.on('admin:dig',          guard(handleDig));
  socket.on('admin:link',         guard(handleLink));
  socket.on('admin:unlink',       guard(handleUnlink));
  socket.on('admin:setroom',      guard(handleSetRoom));
  socket.on('admin:setcap',       guard(handleSetCap));
  socket.on('admin:placeitem',    guard(handlePlaceItem));
  socket.on('admin:removeitem',   guard(handleRemoveItem));
  socket.on('admin:listrooms',    guard(handleListRooms));
  socket.on('admin:ai:generate',  guard(handleAIGenerate));
  socket.on('admin:ai:commit',    guard(handleAICommit));
  socket.on('admin:ai:discard',   guard(handleAIDiscard));
  socket.on('admin:agent:run',     guard(handleAgentRun));
  socket.on('admin:agent:expand',  guard(handleAgentExpand));
  socket.on('admin:room:genimage', guard(handleGenRoomImage));
  socket.on('admin:npc:genimage',  guard(handleGenNpcImage));
}

// ─── handlers ────────────────────────────────────────────────────────────────

async function handleLook(session) {
  const overlay = getAdminRoomOverlay(session.roomId);
  if (!overlay) return err(null, 'Not in a valid room.');
  send(
    _getSocket(session.socketId),
    GM.ADMIN_ROOM,
    overlay,
  );
}

async function handleDig(session, { direction, name, short_desc, terrain_type, indoor, safe_zone, light_level, item_cap }) {
  if (!direction) throw new Error('direction required.');
  if (!name) throw new Error('name required.');
  if (!short_desc) throw new Error('short_desc required.');

  const { newRoom, exits } = digRoom(
    session.roomId,
    direction,
    { name, short_desc, terrain_type, indoor, safe_zone, light_level, item_cap },
    session.accountId,
  );

  msg(_getSocket(session.socketId),
    `Dug ${direction}: "${newRoom.name}" [${newRoom.id.slice(0,8)}]. Return exit linked automatically.`);

  // Refresh overlay for admin
  send(_getSocket(session.socketId), GM.ADMIN_ROOM, getAdminRoomOverlay(session.roomId));
}

async function handleLink(session, { direction, target_room_id, bidirectional = true, is_door = false, is_locked = false, door_name }) {
  if (!direction || !target_room_id) throw new Error('direction and target_room_id required.');

  linkRooms(session.roomId, direction, target_room_id, {
    bidirectional, isDoor: is_door, isLocked: is_locked, doorName: door_name
  }, session.accountId);

  msg(_getSocket(session.socketId), `Linked ${direction} → ${target_room_id.slice(0,8)}${bidirectional ? ' (bidirectional)' : ''}.`);
  send(_getSocket(session.socketId), GM.ADMIN_ROOM, getAdminRoomOverlay(session.roomId));
}

async function handleUnlink(session, { direction }) {
  if (!direction) throw new Error('direction required.');
  unlinkExit(session.roomId, direction, session.accountId);
  msg(_getSocket(session.socketId), `Removed exit: ${direction}.`);
  send(_getSocket(session.socketId), GM.ADMIN_ROOM, getAdminRoomOverlay(session.roomId));
}

async function handleSetRoom(session, fields) {
  updateRoom(session.roomId, fields, session.accountId);
  msg(_getSocket(session.socketId), 'Room updated.');
  send(_getSocket(session.socketId), GM.ADMIN_ROOM, getAdminRoomOverlay(session.roomId));
}

async function handleSetCap(session, { item_cap }) {
  if (item_cap == null || isNaN(item_cap)) throw new Error('item_cap (integer) required.');
  const cap = Math.max(0, Math.min(500, Math.floor(Number(item_cap))));
  updateRoom(session.roomId, { item_cap: cap }, session.accountId);
  msg(_getSocket(session.socketId), `Item cap set to ${cap}.`);
}

async function handlePlaceItem(session, { template_id, is_persistent = false, duration_seconds, stack_count = 1, overrides }) {
  if (!template_id) throw new Error('template_id required.');

  const result = placeItem(session.roomId, template_id, {
    isPersistent: !!is_persistent,
    durationSeconds: duration_seconds ?? null,
    stackCount: Math.max(1, stack_count),
    overrides: overrides ?? null,
    placedBy: session.accountId,
  });

  if (!result.ok) throw new Error(result.error);

  broadcastItemAdded(_io, session.roomId, result.item);

  const socket = _getSocket(session.socketId);
  const cap = getRoomCap(session.roomId);
  const count = getItemCount(session.roomId);
  msg(socket, `Placed "${result.item.name}" [${result.item.id.slice(0,8)}]. Room: ${count}/${cap} items.`);
}

async function handleRemoveItem(session, { item_id }) {
  if (!item_id) throw new Error('item_id required.');
  const removed = removeItem(item_id, session.roomId);
  if (!removed) throw new Error('Item not found in this room.');

  broadcastItemRemoved(_io, session.roomId, item_id);
  msg(_getSocket(session.socketId), `Removed item ${item_id.slice(0,8)}.`);
}

async function handleListRooms(session, { region_id, terrain_type, limit = 20, offset = 0 }) {
  const db = getDb();
  let query = 'SELECT id, name, short_desc, terrain_type, item_cap FROM rooms WHERE 1=1';
  const params = [];
  if (region_id) { query += ' AND region_id = ?'; params.push(region_id); }
  if (terrain_type) { query += ' AND terrain_type = ?'; params.push(terrain_type); }
  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(Number(limit), Number(offset));
  const rooms = db.prepare(query).all(...params);
  send(_getSocket(session.socketId), GM.ADMIN_ROOM, { type: 'room_list', rooms });
}

async function handleAIGenerate(session, { prompt, direction, count = 3 }) {
  if (!prompt) throw new Error('prompt required.');
  if (!direction) throw new Error('direction required (where to extend from current room).');

  const socket = _getSocket(session.socketId);
  msg(socket, `Generating ${count} room(s) to the ${direction}... (this may take a moment)`);

  const draft = await generateRoomDraft(prompt, session.roomId, direction, count);
  storeDraft(session.socketId, draft);

  send(socket, GM.ADMIN_DRAFT, {
    status: 'preview',
    draft_id: draft.id,
    theme_note: draft.theme_note,
    rooms: draft.rooms,
    exits: draft.exits,
    instructions: 'Review above. Send admin:ai:commit to accept or admin:ai:discard to cancel.',
  });
}

async function handleAICommit(session) {
  const socket = _getSocket(session.socketId);
  const created = commitDraft(session.socketId, session.accountId);
  msg(socket, `Committed ${created.length} room(s): ${created.map(r => `"${r.name}"`).join(', ')}.`);
  send(socket, GM.ADMIN_DRAFT, { status: 'committed', rooms: created.map(r => ({ id: r.id, name: r.name })) });
  send(socket, GM.ADMIN_ROOM, getAdminRoomOverlay(session.roomId));
}

async function handleAIDiscard(session) {
  clearDraft(session.socketId);
  msg(_getSocket(session.socketId), 'AI draft discarded.');
  send(_getSocket(session.socketId), GM.ADMIN_DRAFT, { status: 'discarded' });
}

async function handleAgentRun(session, { prompt, direction = 'n', room_count = 5, include_npcs = true, include_items = true }) {
  if (!prompt) throw new Error('prompt required.');
  const socket = _getSocket(session.socketId);
  msg(socket, `World Agent starting: "${prompt}"`);

  let result;
  try {
    result = await runWorldAgent(
      {
        prompt,
        currentRoomId: session.roomId,
        exitDir:       direction,
        roomCount:     room_count,
        includeNpcs:   include_npcs,
        includeItems:  include_items,
      },
      (step, detail) => msg(socket, `[agent:${step}] ${detail}`),
    );
  } catch (e) {
    send(socket, GM.ADMIN_AGENT, { status: 'error', message: e.message });
    throw e;
  }

  const summary = `"${result.area_name}": ${result.rooms.length} rooms, ${result.npcs.length} NPCs, ${result.items.length} items.`;
  msg(socket, `✓ ${summary}`);
  send(socket, GM.ADMIN_AGENT, { status: 'complete', ...result });
  send(socket, GM.ADMIN_ROOM, getAdminRoomOverlay(session.roomId));
}

async function handleAgentExpand(session, { prompt, direction = 'n', room_count = 3, include_npcs = true, include_items = true }) {
  if (!prompt) throw new Error('prompt required.');
  const socket = _getSocket(session.socketId);
  msg(socket, `World Agent expanding area: "${prompt}"`);

  let result;
  try {
    result = await expandArea(
      { prompt, currentRoomId: session.roomId, exitDir: direction, roomCount: room_count, includeNpcs: include_npcs, includeItems: include_items },
      (step, detail) => msg(socket, `[agent:${step}] ${detail}`),
    );
  } catch (e) {
    send(socket, GM.ADMIN_AGENT, { status: 'error', message: e.message });
    throw e;
  }

  msg(socket, `✓ "${result.area_name}": ${result.rooms.length} rooms, ${result.npcs.length} NPCs, ${result.items.length} items.`);
  send(socket, GM.ADMIN_AGENT, { status: 'complete', ...result });
  send(socket, GM.ADMIN_ROOM, getAdminRoomOverlay(session.roomId));
}

async function handleGenNpcImage(session, { npc_id }) {
  if (!npc_id) throw new Error('npc_id required.');
  const socket = _getSocket(session.socketId);
  msg(socket, `Generating portrait for NPC ${npc_id.slice(0, 8)}…`);
  const url = await generateNpcPortrait(npc_id);
  if (url) {
    msg(socket, `Portrait saved: ${url}`);
    // Refresh room so portrait appears immediately
    const { sendRoomInfo } = await import('../../engine/roomManager.js');
    const { getSession } = await import('../../engine/playerManager.js');
    for (const [, s] of _io.sockets.sockets) {
      if (getSession(s.id)?.roomId === session.roomId) sendRoomInfo(s, session.roomId);
    }
  } else {
    throw new Error('Portrait generation unavailable — check OPENAI_API_KEY.');
  }
}

async function handleGenRoomImage(session) {
  const socket = _getSocket(session.socketId);
  const db = getDb();
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(session.roomId);
  if (!room) throw new Error('Not in a valid room.');

  msg(socket, `Generating pixel art for "${room.name}"…`);
  const prompt =
    `32-bit pixel art MMO scene: ${room.name}. ${room.short_desc || ''} ` +
    `${room.terrain_type} terrain, game environment, vibrant retro palette, top-down perspective.`;

  const { url, placeholder } = await generatePixelArtImage(prompt, room.id);
  if (placeholder || !url) {
    throw new Error('Image generation unavailable — check OPENAI_API_KEY in .env.');
  }
  updateRoomImage(room.id, url);
  msg(socket, `Image saved: ${url}`);

  // Push updated room info so image appears immediately
  const { sendRoomInfo } = await import('../../engine/roomManager.js');
  for (const [, s] of _io.sockets.sockets) {
    const { getSession } = await import('../../engine/playerManager.js');
    const sess = getSession(s.id);
    if (sess?.roomId === session.roomId) sendRoomInfo(s, session.roomId);
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

let _io;
export function setIO(ioInstance) { _io = ioInstance; }

function _getSocket(socketId) {
  return _io.sockets.sockets.get(socketId);
}
