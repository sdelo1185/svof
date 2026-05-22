/**
 * NPC interaction handler.
 *
 * Events:
 *   npc:talk    { npc_id, message }   → keyword-matched dialogue response
 *   npc:examine { npc_id }            → full NPC description
 *
 * Admin events (admin role only):
 *   admin:npc:place  { name, title, description, race, role, dialogue[] }
 *   admin:npc:remove { npc_id }
 *   admin:npc:dialogue { npc_id, dialogue[] }
 */

import { getSession } from '../../engine/playerManager.js';
import { getNpcById, getNpcsInRoom, placeNpc, removeNpc, processTalk, updateNpcDialogue } from '../../engine/npcManager.js';
import { GM, send, broadcast, msg, err } from '../gmcp.js';

let _io;
export function setIO(io) { _io = io; }

export function registerNpcHandlers(io, socket) {
  socket.on('npc:talk',    (d) => handleTalk(socket, d));
  socket.on('npc:examine', (d) => handleExamine(socket, d));

  if (['admin','developer'].includes(socket.data.account.role)) {
    socket.on('admin:npc:place',    (d) => handleAdminPlace(socket, d));
    socket.on('admin:npc:remove',   (d) => handleAdminRemove(socket, d));
    socket.on('admin:npc:dialogue', (d) => handleAdminDialogue(socket, d));
  }
}

// ─── handlers ────────────────────────────────────────────────────────────────

function handleTalk(socket, data) {
  const session = getSession(socket.id);
  if (!session?.roomId) return;

  const { npc_id, message = 'hello' } = data || {};
  if (!npc_id) return err(socket, 'Specify an NPC.');

  const result = processTalk(npc_id, session.roomId, message);
  if (!result) return err(socket, 'That NPC is not here.');

  // Broadcast the exchange to the room
  broadcast(_io, session.roomId, GM.COMM_SAY, {
    sender: result.npc,
    message: result.response,
    npc: true,
  });
}

function handleExamine(socket, data) {
  const session = getSession(socket.id);
  if (!session?.roomId) return;

  const { npc_id } = data || {};
  const npc = npc_id ? getNpcsInRoom(session.roomId).find(n => n.id === npc_id) : null;
  if (!npc) return err(socket, 'That NPC is not here.');

  send(socket, GM.SERVER_MSG, {
    text: `${npc.name}${npc.title ? `, ${npc.title}` : ''}\n${npc.description || 'An unremarkable figure.'}`,
    type: 'examine_npc',
    npc: { id: npc.id, name: npc.name, title: npc.title, race: npc.race, role: npc.role, description: npc.description },
  });
}

function handleAdminPlace(socket, data) {
  const session = getSession(socket.id);
  if (!session?.roomId) return;

  const {
    name, title, description, race='human', role='citizen', dialogue=[],
    is_combatant=false, max_health=100, attack_power=10, armor=0,
    experience_reward=25, respawn_seconds=300, gold_reward=0,
  } = data || {};
  if (!name) return err(socket, 'name required.');

  const npc = placeNpc(session.roomId, {
    name, title, description, race, role, dialogue,
    is_combatant, max_health, attack_power, armor,
    experience_reward, respawn_seconds, gold_reward,
  }, session.characterId);

  broadcast(_io, session.roomId, 'Room.Npcs', {
    added: [{ id: npc.id, name: npc.name, title: npc.title, race: npc.race, role: npc.role, is_combatant: npc.is_combatant }],
  });
  msg(socket, `Placed NPC "${npc.name}" [${npc.id.slice(0,8)}].`);
}

function handleAdminRemove(socket, data) {
  const session = getSession(socket.id);
  if (!session?.roomId) return;

  const { npc_id } = data || {};
  if (!npc_id) return err(socket, 'npc_id required.');

  const removed = removeNpc(npc_id, session.roomId);
  if (!removed) return err(socket, 'NPC not found in this room.');

  broadcast(_io, session.roomId, 'Room.Npcs', { removed: [npc_id] });
  msg(socket, `Removed NPC "${removed.name}".`);
}

function handleAdminDialogue(socket, data) {
  const { npc_id, dialogue } = data || {};
  if (!npc_id || !Array.isArray(dialogue)) return err(socket, 'npc_id and dialogue[] required.');

  const session = getSession(socket.id);
  updateNpcDialogue(npc_id, dialogue, session?.characterId);
  msg(socket, `Dialogue updated for NPC ${npc_id.slice(0,8)}.`);
}
