/**
 * NPC Manager — static NPCs placed in rooms.
 *
 * NPCs live in the `npcs` DB table and are served via Room.Info
 * alongside players and items. They can have dialogue trees (JSON)
 * that support keyword matching.
 *
 * In-memory index: roomNpcIndex Map<roomId, NpcRecord[]>
 * Lazily populated when a room is first queried.
 */

import { getDb } from '../db/database.js';
import { v4 as uuidv4 } from 'uuid';

/** @type {Map<string, object[]>} roomId → NpcRecord[] */
const roomNpcIndex = new Map();

// ─── public API ──────────────────────────────────────────────────────────────

export function getNpcsInRoom(roomId) {
  if (roomNpcIndex.has(roomId)) return roomNpcIndex.get(roomId);
  const rows = getDb().prepare(
    'SELECT * FROM npcs WHERE room_id = ? AND is_active = 1 ORDER BY name'
  ).all(roomId);
  const records = rows.map(_hydrate);
  roomNpcIndex.set(roomId, records);
  return records;
}

export function placeNpc(roomId, fields, createdBy) {
  const id = uuidv4();
  const db = getDb();
  db.prepare(`
    INSERT INTO npcs (id, room_id, name, title, description, race, role, dialogue,
                      is_combatant, max_health, attack_power, armor,
                      experience_reward, respawn_seconds, gold_reward,
                      is_active, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(
    id, roomId,
    fields.name,
    fields.title       ?? null,
    fields.description ?? null,
    fields.race        ?? 'human',
    fields.role        ?? 'citizen',
    JSON.stringify(fields.dialogue ?? []),
    fields.is_combatant      ? 1 : 0,
    fields.max_health        ?? 100,
    fields.attack_power      ?? 10,
    fields.armor             ?? 0,
    fields.experience_reward ?? 25,
    fields.respawn_seconds   ?? 300,
    fields.gold_reward       ?? 0,
    createdBy,
    Date.now(),
  );
  const npc = _hydrate(db.prepare('SELECT * FROM npcs WHERE id = ?').get(id));
  roomNpcIndex.delete(roomId);
  return npc;
}

export function removeNpc(npcId, roomId) {
  const db = getDb();
  const npc = db.prepare('SELECT * FROM npcs WHERE id = ? AND room_id = ?').get(npcId, roomId);
  if (!npc) return null;
  db.prepare('UPDATE npcs SET is_active = 0 WHERE id = ?').run(npcId);
  roomNpcIndex.delete(roomId);
  return npc;
}

export function updateNpcImage(npcId, imageUrl) {
  getDb().prepare('UPDATE npcs SET image_url = ? WHERE id = ?').run(imageUrl, npcId);
  for (const [roomId, npcs] of roomNpcIndex) {
    if (npcs.some(n => n.id === npcId)) { roomNpcIndex.delete(roomId); break; }
  }
}

export function updateNpcDialogue(npcId, dialogue, updatedBy) {
  getDb().prepare('UPDATE npcs SET dialogue = ? WHERE id = ?')
    .run(JSON.stringify(dialogue), npcId);
  // Invalidate any cached room
  for (const [roomId, npcs] of roomNpcIndex) {
    if (npcs.some(n => n.id === npcId)) { roomNpcIndex.delete(roomId); break; }
  }
}

/**
 * Process a talk attempt. Returns the NPC's reply or null.
 * Dialogue is an array of { keywords: string[], response: string } entries.
 * Falls back to a generic greeting if no keyword matches.
 */
export function processTalk(npcId, roomId, message) {
  const npc = getNpcsInRoom(roomId).find(n => n.id === npcId);
  if (!npc) return null;

  const lower = (message || '').toLowerCase();
  for (const entry of npc.dialogue) {
    const matched = (entry.keywords || []).some(kw => lower.includes(kw.toLowerCase()));
    if (matched) return { npc: npc.name, response: entry.response };
  }
  return { npc: npc.name, response: npc.dialogue[0]?.response ?? `${npc.name} regards you quietly.` };
}

export function getNpcById(npcId) {
  const row = getDb().prepare('SELECT * FROM npcs WHERE id = ?').get(npcId);
  return row ? _hydrate(row) : null;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function _hydrate(row) {
  return {
    id:                row.id,
    room_id:           row.room_id,   // kept for combatManager respawn broadcast
    roomId:            row.room_id,
    name:              row.name,
    title:             row.title,
    description:       row.description,
    race:              row.race,
    role:              row.role,
    dialogue:          JSON.parse(row.dialogue || '[]'),
    isActive:          !!row.is_active,
    is_combatant:      row.is_combatant ?? 0,
    max_health:        row.max_health ?? 100,
    attack_power:      row.attack_power ?? 10,
    armor:             row.armor ?? 0,
    experience_reward: row.experience_reward ?? 25,
    respawn_seconds:   row.respawn_seconds ?? 300,
    gold_reward:       row.gold_reward ?? 0,
  };
}
