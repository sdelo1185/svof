/**
 * Combat + equipment socket handler.
 *
 * Combat events:
 *   attack { npc_id }         → attack a combatant NPC in the current room
 *   flee                      → attempt to escape combat (50% chance, moves to random exit)
 *
 * Equipment events:
 *   equip   { item_id }       → equip item from inventory into its slot
 *   unequip { slot }          → move item from slot back to bag
 *   equipment                 → request current equipment summary
 */

import { getSession }   from '../../engine/playerManager.js';
import { getExitsForRoom } from '../../engine/roomManager.js';
import { attackNpc, getNpcCurrentHp } from '../../engine/combatManager.js';
import { GM, send, err, msg } from '../gmcp.js';
import { getDb } from '../../db/database.js';

// Equipment slots and the item types that fit them
const SLOT_RULES = {
  mainhand: ['weapon'],
  offhand:  ['weapon', 'armor'],    // shields often typed armor
  head:     ['armor', 'clothing'],
  chest:    ['armor', 'clothing'],
  legs:     ['armor', 'clothing'],
  hands:    ['armor', 'clothing'],
  feet:     ['armor', 'clothing'],
  ring:     ['misc', 'clothing'],
  neck:     ['misc', 'clothing'],
};

export function registerCombatHandlers(io, socket) {
  socket.on('attack',    (d) => handleAttack(io, socket, d));
  socket.on('flee',      ()  => handleFlee(io, socket));
  socket.on('equip',     (d) => handleEquip(socket, d));
  socket.on('unequip',   (d) => handleUnequip(socket, d));
  socket.on('equipment', ()  => handleEquipment(socket));
}

// ─── attack ───────────────────────────────────────────────────────────────────

function handleAttack(io, socket, data) {
  const session = getSession(socket.id);
  if (!session?.roomId) return;

  const { npc_id } = data || {};
  if (!npc_id) return err(socket, 'Attack what? Usage: attack <npc_id>');

  const result = attackNpc(io, socket, session, npc_id);
  if (!result.ok) err(socket, result.reason);
}

// ─── flee ─────────────────────────────────────────────────────────────────────

function handleFlee(io, socket) {
  const session = getSession(socket.id);
  if (!session?.roomId) return;

  if (Math.random() < 0.50) {
    err(socket, 'You fail to escape!');
    return;
  }

  const exits = getExitsForRoom(session.roomId).filter(x => !x.is_locked);
  if (!exits.length) { err(socket, 'There is nowhere to flee!'); return; }

  const exit = exits[Math.floor(Math.random() * exits.length)];
  socket.emit('move', { direction: exit.direction });   // re-use movement handler
}

// ─── equip ────────────────────────────────────────────────────────────────────

function handleEquip(socket, data) {
  const session = getSession(socket.id);
  if (!session) return;

  const { item_id } = data || {};
  if (!item_id) return err(socket, 'Equip what?');

  const db  = getDb();
  const row = db.prepare(`
    SELECT ci.*, it.type, it.name, it.attributes
    FROM character_items ci
    JOIN item_templates it ON it.id = ci.template_id
    WHERE ci.id = ? AND ci.character_id = ?
  `).get(item_id, session.characterId);

  if (!row)             return err(socket, 'Item not in your inventory.');
  if (row.equipped_slot) return err(socket, `${row.name} is already equipped in ${row.equipped_slot}.`);

  // Determine slot from attributes or item type
  const attrs = JSON.parse(row.attributes);
  const slot  = attrs.slot ?? _defaultSlot(row.type, attrs);
  if (!slot) return err(socket, `${row.name} cannot be equipped.`);

  // Unequip anything already in that slot
  const current = db.prepare(`
    SELECT ci.id, it.name FROM character_items ci
    JOIN item_templates it ON it.id = ci.template_id
    WHERE ci.character_id = ? AND ci.equipped_slot = ?
  `).get(session.characterId, slot);
  if (current) {
    db.prepare('UPDATE character_items SET equipped_slot = NULL WHERE id = ?').run(current.id);
    msg(socket, `You unequip ${current.name}.`);
  }

  db.prepare('UPDATE character_items SET equipped_slot = ? WHERE id = ?').run(slot, item_id);
  msg(socket, `You equip ${row.name} [${slot}].`);
  _sendEquipment(socket, session.characterId, db);
  _sendUpdatedInventory(socket, session.characterId, db);
}

// ─── unequip ──────────────────────────────────────────────────────────────────

function handleUnequip(socket, data) {
  const session = getSession(socket.id);
  if (!session) return;

  const { slot } = data || {};
  if (!slot) return err(socket, 'Unequip which slot?');

  const db  = getDb();
  const row = db.prepare(`
    SELECT ci.id, it.name FROM character_items ci
    JOIN item_templates it ON it.id = ci.template_id
    WHERE ci.character_id = ? AND ci.equipped_slot = ?
  `).get(session.characterId, slot);

  if (!row) return err(socket, `Nothing equipped in ${slot}.`);
  db.prepare('UPDATE character_items SET equipped_slot = NULL WHERE id = ?').run(row.id);
  msg(socket, `You unequip ${row.name}.`);
  _sendEquipment(socket, session.characterId, db);
  _sendUpdatedInventory(socket, session.characterId, db);
}

// ─── equipment list ───────────────────────────────────────────────────────────

function handleEquipment(socket) {
  const session = getSession(socket.id);
  if (!session) return;
  const db = getDb();
  _sendEquipment(socket, session.characterId, db);
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function _sendEquipment(socket, characterId, db) {
  const rows = db.prepare(`
    SELECT ci.equipped_slot as slot, it.id as template_id, ci.id as item_id,
           it.name, it.type, it.attributes
    FROM character_items ci
    JOIN item_templates it ON it.id = ci.template_id
    WHERE ci.character_id = ? AND ci.equipped_slot IS NOT NULL
    ORDER BY ci.equipped_slot
  `).all(characterId);

  send(socket, 'Char.Equipment', {
    slots: rows.map(r => ({
      slot: r.slot, item_id: r.item_id, name: r.name, type: r.type,
      attributes: JSON.parse(r.attributes),
    })),
  });
}

function _sendUpdatedInventory(socket, characterId, db) {
  const items = db.prepare(`
    SELECT ci.id, ci.equipped_slot, ci.stack_count, ci.acquired_at,
           it.name, it.type, it.description, it.attributes
    FROM character_items ci
    JOIN item_templates it ON it.id = ci.template_id
    WHERE ci.character_id = ?
    ORDER BY ci.acquired_at DESC
  `).all(characterId);

  send(socket, GM.CHAR_ITEMS_INV, {
    items: items.map(i => ({
      id: i.id, name: i.name, type: i.type, description: i.description,
      stackCount: i.stack_count, equippedSlot: i.equipped_slot,
      attributes: JSON.parse(i.attributes),
    })),
  });
}

function _defaultSlot(type, attrs) {
  if (attrs.slot) return attrs.slot;
  if (type === 'weapon') return 'mainhand';
  if (type === 'armor')  return 'chest';
  if (type === 'clothing') return 'chest';
  return null;
}
