/**
 * itemManager — authoritative source for items in rooms.
 *
 * Design:
 *   - Active room item state lives in `roomItemCache`: Map<roomId, Map<itemId, ItemRecord>>
 *   - Cache is lazily populated when a room becomes occupied (via loadRoomItems)
 *   - DB (room_items) is the write-through store for persistence
 *   - Temporary items are cleaned up by a 30-second interval ticker
 *   - Room item cap is enforced synchronously before every placement
 */

import { getDb } from '../db/database.js';
import { v4 as uuidv4 } from 'uuid';

const DEFAULT_CAP = 50;

/** @type {Map<string, Map<string, object>>} roomId → (itemId → record) */
const roomItemCache = new Map();

/** Populated rooms set — cleared when no players remain */
const loadedRooms = new Set();

// ─── public API ──────────────────────────────────────────────────────────────

/**
 * Load all items for a room from DB into memory.
 * Called when the first player enters a room.
 */
export function loadRoomItems(roomId) {
  if (loadedRooms.has(roomId)) return;
  const db = getDb();
  const rows = db.prepare(`
    SELECT ri.*, it.name, it.type, it.description, it.attributes as template_attrs, it.is_stackable
    FROM room_items ri
    JOIN item_templates it ON it.id = ri.template_id
    WHERE ri.room_id = ? AND (ri.despawn_at IS NULL OR ri.despawn_at > ?)
  `).all(roomId, Date.now());

  const cache = new Map();
  for (const row of rows) {
    cache.set(row.id, _hydrateItem(row));
  }
  roomItemCache.set(roomId, cache);
  loadedRooms.add(roomId);
}

/**
 * Unload a room's item cache (called when room becomes empty of players).
 */
export function unloadRoomItems(roomId) {
  roomItemCache.delete(roomId);
  loadedRooms.delete(roomId);
}

/**
 * Place an item in a room.
 * Returns { ok, item, error }.
 */
export function placeItem(roomId, templateId, options = {}) {
  const {
    isPersistent = false,
    durationSeconds = null,   // null = no expiry for temp items (manual removal only)
    stackCount = 1,
    overrides = null,
    placedBy = null,
  } = options;

  const db = getDb();

  // Enforce cap
  const cap = getRoomCap(roomId);
  const currentCount = getItemCount(roomId);
  if (currentCount >= cap) {
    return { ok: false, error: `Room item cap reached (${cap}). Remove items first.` };
  }

  // Validate template
  const template = db.prepare('SELECT * FROM item_templates WHERE id = ?').get(templateId);
  if (!template) return { ok: false, error: 'Item template not found.' };

  const id = uuidv4();
  const now = Date.now();
  const despawnAt = (!isPersistent && durationSeconds)
    ? now + durationSeconds * 1000
    : null;

  db.prepare(`
    INSERT INTO room_items (id, template_id, room_id, is_persistent, spawned_at, despawn_at, stack_count, overrides, placed_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, templateId, roomId, isPersistent ? 1 : 0, now, despawnAt, stackCount, overrides ? JSON.stringify(overrides) : null, placedBy);

  const record = {
    id,
    templateId,
    roomId,
    name: template.name,
    type: template.type,
    description: template.description,
    attributes: { ...JSON.parse(template.attributes), ...(overrides || {}) },
    isPersistent,
    isStackable: !!template.is_stackable,
    stackCount,
    spawnedAt: now,
    despawnAt,
    placedBy,
  };

  // Write to cache if room is loaded
  if (loadedRooms.has(roomId)) {
    roomItemCache.get(roomId).set(id, record);
  }

  return { ok: true, item: record };
}

/**
 * Remove an item from a room. Returns the removed record or null.
 */
export function removeItem(itemId, roomId) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM room_items WHERE id = ? AND room_id = ?').get(itemId, roomId);
  if (!row) return null;

  db.prepare('DELETE FROM room_items WHERE id = ?').run(itemId);

  if (loadedRooms.has(roomId)) {
    roomItemCache.get(roomId).delete(itemId);
  }
  return row;
}

/**
 * Get all items currently in a room (from cache, or DB if not loaded).
 */
export function getItemsInRoom(roomId) {
  if (loadedRooms.has(roomId)) {
    return [...roomItemCache.get(roomId).values()];
  }
  // Fallback: query DB directly (for REST API calls when room has no players)
  const db = getDb();
  return db.prepare(`
    SELECT ri.*, it.name, it.type, it.description, it.attributes as template_attrs, it.is_stackable
    FROM room_items ri
    JOIN item_templates it ON it.id = ri.template_id
    WHERE ri.room_id = ? AND (ri.despawn_at IS NULL OR ri.despawn_at > ?)
  `).all(roomId, Date.now()).map(_hydrateItem);
}

export function getItemCount(roomId) {
  if (loadedRooms.has(roomId)) {
    return roomItemCache.get(roomId).size;
  }
  return getDb().prepare(
    'SELECT COUNT(*) as n FROM room_items WHERE room_id = ? AND (despawn_at IS NULL OR despawn_at > ?)'
  ).get(roomId, Date.now()).n;
}

export function getRoomCap(roomId) {
  const room = getDb().prepare('SELECT item_cap FROM rooms WHERE id = ?').get(roomId);
  return room?.item_cap ?? DEFAULT_CAP;
}

/**
 * Tick: remove expired temporary items from all loaded (and unloaded) rooms.
 * Called every 30s by the server timer.
 * Returns array of {roomId, itemId} for broadcasting.
 */
export function tickExpiredItems() {
  const now = Date.now();
  const db = getDb();
  const expired = db.prepare(
    'SELECT id, room_id FROM room_items WHERE despawn_at IS NOT NULL AND despawn_at <= ? AND is_persistent = 0'
  ).all(now);

  if (expired.length === 0) return [];

  const ids = expired.map(r => r.id);
  // SQLite can do batch delete with IN but with dynamic params we build it
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`DELETE FROM room_items WHERE id IN (${placeholders})`).run(...ids);

  // Evict from cache
  for (const { id, room_id } of expired) {
    if (loadedRooms.has(room_id)) {
      roomItemCache.get(room_id)?.delete(id);
    }
  }

  return expired.map(r => ({ roomId: r.room_id, itemId: r.id }));
}

// ─── internal helpers ─────────────────────────────────────────────────────────

function _hydrateItem(row) {
  const templateAttrs = JSON.parse(row.template_attrs || '{}');
  const overrides = row.overrides ? JSON.parse(row.overrides) : {};
  return {
    id: row.id,
    templateId: row.template_id,
    roomId: row.room_id,
    name: row.name,
    type: row.type,
    description: row.description,
    attributes: { ...templateAttrs, ...overrides },
    isPersistent: !!row.is_persistent,
    isStackable: !!row.is_stackable,
    stackCount: row.stack_count,
    spawnedAt: row.spawned_at,
    despawnAt: row.despawn_at,
    placedBy: row.placed_by,
  };
}
