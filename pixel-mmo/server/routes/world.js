/**
 * REST API for world data — rooms, exits, item templates, and region management.
 * Read endpoints are public; write endpoints require admin role.
 */

import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/database.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import {
  getRoomById, getRoomWithExits, createRoom, updateRoom,
  linkRooms, unlinkExit, digRoom, getExitsForRoom,
} from '../engine/roomManager.js';
import { getItemsInRoom, placeItem, removeItem, getItemCount, getRoomCap } from '../engine/itemManager.js';

const router = Router();

// ─── Regions ────────────────────────────────────────────────────────────────

router.get('/regions', (req, res) => {
  res.json(getDb().prepare('SELECT * FROM regions ORDER BY name').all());
});

router.post('/regions', requireAdmin, (req, res) => {
  const { name, description, city_state, parent_region_id } = req.body;
  if (!name) return res.status(400).json({ error: 'name required.' });
  const id = uuidv4();
  getDb().prepare(
    'INSERT INTO regions (id, name, description, city_state, parent_region_id, created_by, created_at) VALUES (?,?,?,?,?,?,?)'
  ).run(id, name, description||null, city_state||null, parent_region_id||null, req.account.id, Date.now());
  res.status(201).json(getDb().prepare('SELECT * FROM regions WHERE id = ?').get(id));
});

// ─── Rooms ──────────────────────────────────────────────────────────────────

router.get('/rooms', (req, res) => {
  const { region_id, terrain_type, limit = 50, offset = 0 } = req.query;
  let q = 'SELECT r.*, re_count.exit_count FROM rooms r LEFT JOIN (SELECT from_room_id, COUNT(*) as exit_count FROM room_exits GROUP BY from_room_id) re_count ON re_count.from_room_id = r.id WHERE 1=1';
  const params = [];
  if (region_id) { q += ' AND r.region_id = ?'; params.push(region_id); }
  if (terrain_type) { q += ' AND r.terrain_type = ?'; params.push(terrain_type); }
  q += ' ORDER BY r.created_at DESC LIMIT ? OFFSET ?';
  params.push(Number(limit), Number(offset));
  res.json(getDb().prepare(q).all(...params));
});

router.get('/rooms/:id', (req, res) => {
  const room = getRoomWithExits(req.params.id);
  if (!room) return res.status(404).json({ error: 'Room not found.' });
  const itemCount = getItemCount(req.params.id);
  res.json({ ...room, item_count: itemCount, item_cap: room.item_cap });
});

router.post('/rooms', requireAdmin, (req, res) => {
  const { name, short_desc } = req.body;
  if (!name || !short_desc) return res.status(400).json({ error: 'name and short_desc required.' });
  const room = createRoom(req.body, req.account.id);
  res.status(201).json(room);
});

router.patch('/rooms/:id', requireAdmin, (req, res) => {
  const updated = updateRoom(req.params.id, req.body, req.account.id);
  if (!updated) return res.status(404).json({ error: 'Room not found.' });
  res.json(updated);
});

// ─── Exits ──────────────────────────────────────────────────────────────────

router.get('/rooms/:id/exits', (req, res) => {
  res.json(getExitsForRoom(req.params.id));
});

router.post('/rooms/:id/exits', requireAdmin, (req, res) => {
  const { direction, to_room_id, bidirectional = true, is_door, is_locked, door_name } = req.body;
  if (!direction || !to_room_id) return res.status(400).json({ error: 'direction and to_room_id required.' });
  if (!getRoomById(req.params.id)) return res.status(404).json({ error: 'From room not found.' });
  if (!getRoomById(to_room_id)) return res.status(404).json({ error: 'To room not found.' });

  linkRooms(req.params.id, direction, to_room_id, { bidirectional, isDoor: is_door, isLocked: is_locked, doorName: door_name }, req.account.id);
  res.json({ ok: true, exits: getExitsForRoom(req.params.id) });
});

router.delete('/rooms/:id/exits/:direction', requireAdmin, (req, res) => {
  unlinkExit(req.params.id, req.params.direction, req.account.id);
  res.json({ ok: true });
});

// Dig: create new room + bidirectional exit in one call
router.post('/rooms/:id/dig', requireAdmin, (req, res) => {
  const { direction, name, short_desc, ...rest } = req.body;
  if (!direction || !name || !short_desc) {
    return res.status(400).json({ error: 'direction, name, and short_desc required.' });
  }
  if (!getRoomById(req.params.id)) return res.status(404).json({ error: 'From room not found.' });

  const result = digRoom(req.params.id, direction, { name, short_desc, ...rest }, req.account.id);
  res.status(201).json(result);
});

// ─── Room Items ──────────────────────────────────────────────────────────────

router.get('/rooms/:id/items', (req, res) => {
  const items = getItemsInRoom(req.params.id);
  const cap = getRoomCap(req.params.id);
  res.json({ items, count: items.length, cap });
});

router.post('/rooms/:id/items', requireAdmin, (req, res) => {
  const { template_id, is_persistent = false, duration_seconds, stack_count = 1, overrides } = req.body;
  if (!template_id) return res.status(400).json({ error: 'template_id required.' });

  const result = placeItem(req.params.id, template_id, {
    isPersistent: !!is_persistent,
    durationSeconds: duration_seconds ?? null,
    stackCount: stack_count,
    overrides: overrides ?? null,
    placedBy: req.account.id,
  });

  if (!result.ok) return res.status(409).json({ error: result.error });
  res.status(201).json(result.item);
});

router.delete('/rooms/:id/items/:item_id', requireAdmin, (req, res) => {
  const removed = removeItem(req.params.item_id, req.params.id);
  if (!removed) return res.status(404).json({ error: 'Item not found in this room.' });
  res.json({ ok: true });
});

// ─── Item Templates ──────────────────────────────────────────────────────────

router.get('/item-templates', (req, res) => {
  const { type, limit = 50, offset = 0 } = req.query;
  let q = 'SELECT * FROM item_templates WHERE 1=1';
  const params = [];
  if (type) { q += ' AND type = ?'; params.push(type); }
  q += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(Number(limit), Number(offset));
  res.json(getDb().prepare(q).all(...params).map(r => ({ ...r, attributes: JSON.parse(r.attributes) })));
});

router.get('/item-templates/:id', (req, res) => {
  const row = getDb().prepare('SELECT * FROM item_templates WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found.' });
  res.json({ ...row, attributes: JSON.parse(row.attributes) });
});

router.post('/item-templates', requireAdmin, (req, res) => {
  const { name, type, description, attributes = {}, is_stackable = false, max_stack = 1, weight = 1, asset_id } = req.body;
  if (!name || !type) return res.status(400).json({ error: 'name and type required.' });
  const id = uuidv4();
  getDb().prepare(`
    INSERT INTO item_templates (id, asset_id, name, type, description, attributes, is_stackable, max_stack, weight, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, asset_id||null, name, type, description||null, JSON.stringify(attributes), is_stackable?1:0, max_stack, weight, req.account.id, Date.now());
  res.status(201).json(getDb().prepare('SELECT * FROM item_templates WHERE id = ?').get(id));
});

// Promote a committed_asset directly to an item_template
router.post('/item-templates/from-asset/:asset_id', requireAdmin, (req, res) => {
  const db = getDb();
  const asset = db.prepare('SELECT * FROM committed_assets WHERE id = ?').get(req.params.asset_id);
  if (!asset) return res.status(404).json({ error: 'Asset not found.' });

  const existing = db.prepare('SELECT id FROM item_templates WHERE asset_id = ?').get(asset.id);
  if (existing) return res.status(409).json({ error: 'Template already exists for this asset.', id: existing.id });

  const id = uuidv4();
  db.prepare(`
    INSERT INTO item_templates (id, asset_id, name, type, description, attributes, is_stackable, max_stack, weight, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, 1, 1, ?, ?)
  `).run(id, asset.id, asset.name, asset.type, asset.description, asset.attributes, req.account.id, Date.now());

  res.status(201).json({ id, name: asset.name, type: asset.type });
});

// ─── Admin stats ─────────────────────────────────────────────────────────────

router.get('/stats', requireAdmin, (req, res) => {
  const db = getDb();
  res.json({
    rooms: db.prepare('SELECT COUNT(*) as n FROM rooms').get().n,
    exits: db.prepare('SELECT COUNT(*) as n FROM room_exits').get().n,
    items_in_world: db.prepare('SELECT COUNT(*) as n FROM room_items').get().n,
    item_templates: db.prepare('SELECT COUNT(*) as n FROM item_templates').get().n,
    accounts: db.prepare('SELECT COUNT(*) as n FROM accounts').get().n,
    characters: db.prepare('SELECT COUNT(*) as n FROM characters').get().n,
  });
});

export default router;
