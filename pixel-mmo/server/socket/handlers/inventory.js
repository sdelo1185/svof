/**
 * Inventory handler — get, drop, examine, inv.
 *
 * Items in rooms:    room_items table  ↔ itemManager cache
 * Items on players:  character_items table
 *
 * Rules:
 *   - Persistent room items cannot be picked up (admin must set is_persistent=0)
 *   - Dropping respects the room's item cap
 *   - Stackable items merge on drop/get
 */

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../../db/database.js';
import { getSession } from '../../engine/playerManager.js';
import { removeItem, placeItem } from '../../engine/itemManager.js';
import { broadcastItemAdded, broadcastItemRemoved } from '../../engine/roomManager.js';
import { GM, send, broadcast } from '../gmcp.js';

let _io;
export function setIO(io) { _io = io; }

export function registerInventoryHandlers(io, socket) {
  socket.on('item:get',     (d) => handleGet(socket, d));
  socket.on('item:drop',    (d) => handleDrop(socket, d));
  socket.on('item:examine', (d) => handleExamine(socket, d));
  socket.on('inv',          ()  => sendInventory(socket));
}

// ─── handlers ────────────────────────────────────────────────────────────────

function handleGet(socket, data) {
  const session = getSession(socket.id);
  if (!session?.roomId) return;

  const { item_id } = data || {};
  if (!item_id) return send(socket, GM.SERVER_ERR, { text: 'Specify an item.' });

  const db = getDb();

  // Load room item
  const roomItem = db.prepare(`
    SELECT ri.*, it.name, it.type, it.description, it.attributes, it.is_stackable, it.max_stack
    FROM room_items ri
    JOIN item_templates it ON it.id = ri.template_id
    WHERE ri.id = ? AND ri.room_id = ?
  `).get(item_id, session.roomId);

  if (!roomItem) return send(socket, GM.SERVER_ERR, { text: 'That is not here.' });
  if (roomItem.is_persistent) return send(socket, GM.SERVER_ERR, { text: `${roomItem.name} is fixed in place.` });

  const getTx = db.transaction(() => {
    // Remove from room
    removeItem(item_id, session.roomId);

    // Check for existing stack in inventory
    if (roomItem.is_stackable) {
      const existing = db.prepare(`
        SELECT * FROM character_items WHERE character_id = ? AND template_id = ? AND equipped_slot IS NULL
      `).get(session.characterId, roomItem.template_id);

      if (existing) {
        const newCount = existing.stack_count + roomItem.stack_count;
        db.prepare('UPDATE character_items SET stack_count = ? WHERE id = ?').run(newCount, existing.id);
        return existing.id;
      }
    }

    // Insert new inventory entry
    const id = uuidv4();
    db.prepare(`
      INSERT INTO character_items (id, template_id, character_id, stack_count, acquired_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, roomItem.template_id, session.characterId, roomItem.stack_count, Date.now());
    return id;
  });

  getTx();

  // Broadcast item removal to room
  broadcastItemRemoved(_io, session.roomId, item_id);
  send(socket, GM.SERVER_MSG, { text: `You pick up ${roomItem.name}.` });

  sendInventory(socket);
}

function handleDrop(socket, data) {
  const session = getSession(socket.id);
  if (!session?.roomId) return;

  const { item_id, count: rawCount } = data || {};
  if (!item_id) return send(socket, GM.SERVER_ERR, { text: 'Specify an item.' });

  const db = getDb();
  const invItem = db.prepare(`
    SELECT ci.*, it.name, it.type, it.description, it.attributes, it.is_stackable
    FROM character_items ci
    JOIN item_templates it ON it.id = ci.template_id
    WHERE ci.id = ? AND ci.character_id = ?
  `).get(item_id, session.characterId);

  if (!invItem) return send(socket, GM.SERVER_ERR, { text: 'You do not have that.' });
  if (invItem.equipped_slot) return send(socket, GM.SERVER_ERR, { text: `Remove ${invItem.name} first.` });

  const dropCount = Math.min(Math.max(1, rawCount || invItem.stack_count), invItem.stack_count);

  const result = placeItem(session.roomId, invItem.template_id, {
    isPersistent: false,
    stackCount: dropCount,
    placedBy: null,
  });

  if (!result.ok) return send(socket, GM.SERVER_ERR, { text: result.error });

  const dropTx = db.transaction(() => {
    const remaining = invItem.stack_count - dropCount;
    if (remaining <= 0) {
      db.prepare('DELETE FROM character_items WHERE id = ?').run(item_id);
    } else {
      db.prepare('UPDATE character_items SET stack_count = ? WHERE id = ?').run(remaining, item_id);
    }
  });
  dropTx();

  broadcastItemAdded(_io, session.roomId, result.item);
  send(socket, GM.SERVER_MSG, { text: `You drop ${invItem.name}.` });
  sendInventory(socket);
}

function handleExamine(socket, data) {
  const session = getSession(socket.id);
  if (!session?.roomId) return;

  const { item_id } = data || {};
  if (!item_id) return;

  const db = getDb();

  // Check room first, then inventory
  let item = db.prepare(`
    SELECT it.name, it.type, it.description, it.attributes
    FROM room_items ri JOIN item_templates it ON it.id = ri.template_id
    WHERE ri.id = ? AND ri.room_id = ?
  `).get(item_id, session.roomId);

  if (!item) {
    item = db.prepare(`
      SELECT it.name, it.type, it.description, it.attributes
      FROM character_items ci JOIN item_templates it ON it.id = ci.template_id
      WHERE ci.id = ? AND ci.character_id = ?
    `).get(item_id, session.characterId);
  }

  if (!item) return send(socket, GM.SERVER_ERR, { text: 'You cannot examine that.' });

  send(socket, GM.SERVER_MSG, {
    text: `[${item.type.toUpperCase()}] ${item.name}\n${item.description || ''}\n${JSON.stringify(JSON.parse(item.attributes), null, 2)}`,
    type: 'examine',
    item: { name: item.name, type: item.type, description: item.description, attributes: JSON.parse(item.attributes) },
  });
}

// ─── inventory packet ─────────────────────────────────────────────────────────

export function sendInventory(socket) {
  const session = getSession(socket.id);
  if (!session) return;

  const items = getDb().prepare(`
    SELECT ci.id, ci.stack_count, ci.equipped_slot, ci.acquired_at,
           it.name, it.type, it.description, it.attributes
    FROM character_items ci
    JOIN item_templates it ON it.id = ci.template_id
    WHERE ci.character_id = ?
    ORDER BY ci.acquired_at
  `).all(session.characterId);

  send(socket, GM.CHAR_ITEMS_INV, {
    items: items.map(i => ({
      id: i.id,
      name: i.name,
      type: i.type,
      description: i.description,
      attributes: JSON.parse(i.attributes),
      stackCount: i.stack_count,
      equippedSlot: i.equipped_slot,
    })),
  });
}
