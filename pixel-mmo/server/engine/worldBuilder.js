/**
 * worldBuilder — AI-assisted room generation.
 *
 * Admin workflow:
 *   1. admin:ai:generate  →  Claude produces a draft {rooms[], exits[]}
 *   2. Draft is stored in pendingDrafts keyed by adminSocketId
 *   3. Admin previews via Admin.AIDraft packet
 *   4. admin:ai:commit   →  draft is written to DB and world loads it
 *   5. admin:ai:discard  →  draft cleared
 */

import Anthropic from '@anthropic-ai/sdk';
import { createRoom, linkRooms, getRoomById } from './roomManager.js';
import { getDb } from '../db/database.js';
import { v4 as uuidv4 } from 'uuid';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/** In-memory draft store: socketId → DraftRecord */
const pendingDrafts = new Map();

const WORLD_SYSTEM = `
You are a world-building AI for a pixel art MMO inspired by Achaea: Dreams of Divine Lands.
The world has city-states (Ashtan, Targossas, Cyrene, Mhaldor, Eleusis, Hashan), ancient ruins,
wilderness, and divine realms. Tone is high fantasy with political complexity and moral depth.
Room names are short (2-6 words), evocative, and don't start with "The" unless essential.
Room descriptions are atmospheric — second person present tense, 1-3 sentences. No newlines.
`;

const VALID_TERRAINS = ['city','forest','dungeon','cave','ocean','river','plains','mountain','desert','tundra','ethereal','divine','void'];
const VALID_DIRS = ['n','s','e','w','ne','nw','se','sw','u','d','in','out'];
const VALID_LIGHTS = ['bright','normal','dim','dark','pitch_black'];

/**
 * Generate a draft of interconnected rooms from a natural-language prompt.
 *
 * @param {string}  prompt        - Admin's description of what to build
 * @param {string}  currentRoomId - The room the admin is standing in
 * @param {string}  exitDir       - Direction from current room to first new room
 * @param {number}  count         - Number of rooms to generate (1-8)
 * @returns {DraftRecord}
 */
export async function generateRoomDraft(prompt, currentRoomId, exitDir, count = 3) {
  count = Math.max(1, Math.min(8, count));

  const currentRoom = getRoomById(currentRoomId);
  const contextDesc = currentRoom
    ? `Current room: "${currentRoom.name}" (${currentRoom.terrain_type}, ${currentRoom.light_level} light)`
    : 'Current room: unknown';

  const response = await client.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 2048,
    system: WORLD_SYSTEM,
    messages: [{
      role: 'user',
      content: `${contextDesc}
Admin wants to build ${count} new connected room(s) to the ${exitDir} of the current room.
Theme/description: "${prompt}"

Return ONLY valid JSON matching exactly this structure:
{
  "theme_note": "1 sentence summary of what was built",
  "rooms": [
    {
      "temp_id": "new_1",
      "name": "Room Name",
      "short_desc": "One sentence shown on look.",
      "long_desc": "Optional longer description, 1-3 sentences.",
      "terrain_type": "${VALID_TERRAINS.join('|')}",
      "indoor": false,
      "safe_zone": false,
      "light_level": "${VALID_LIGHTS.join('|')}",
      "item_cap": 50
    }
  ],
  "exits": [
    { "from": "current", "direction": "${exitDir}", "to": "new_1" },
    { "from": "new_1", "direction": "n", "to": "new_2" }
  ]
}

Rules:
- All exits must reference either "current" or a temp_id from the rooms array
- Rooms array must have exactly ${count} entries with temp_ids "new_1" through "new_${count}"
- All directions must be one of: ${VALID_DIRS.join(', ')}
- Return raw JSON only, no markdown`,
    }],
  });

  const raw = response.content[0].text.trim();
  const draft = JSON.parse(raw);

  _validateDraft(draft, currentRoomId, count);

  return {
    id: uuidv4(),
    prompt,
    currentRoomId,
    exitDir,
    theme_note: draft.theme_note,
    rooms: draft.rooms,
    exits: draft.exits,
    generatedAt: Date.now(),
  };
}

/**
 * Store a draft for the given socket so it can be committed later.
 */
export function storeDraft(socketId, draft) {
  pendingDrafts.set(socketId, draft);
}

export function getDraft(socketId) {
  return pendingDrafts.get(socketId) ?? null;
}

export function clearDraft(socketId) {
  pendingDrafts.delete(socketId);
}

/**
 * Commit a pending draft to the database and return the created room objects.
 */
export function commitDraft(socketId, createdBy) {
  const draft = pendingDrafts.get(socketId);
  if (!draft) throw new Error('No pending draft to commit.');

  const db = getDb();
  const roomIdMap = new Map(); // temp_id → real uuid
  const created = [];

  const commitTx = db.transaction(() => {
    // Create rooms
    for (const r of draft.rooms) {
      const room = createRoom({
        name: r.name,
        short_desc: r.short_desc,
        long_desc: r.long_desc || null,
        terrain_type: VALID_TERRAINS.includes(r.terrain_type) ? r.terrain_type : 'plains',
        indoor: !!r.indoor,
        safe_zone: !!r.safe_zone,
        light_level: VALID_LIGHTS.includes(r.light_level) ? r.light_level : 'normal',
        item_cap: Math.max(0, Math.min(500, r.item_cap || 50)),
      }, createdBy);
      roomIdMap.set(r.temp_id, room.id);
      created.push(room);
    }

    // Create exits
    for (const exit of draft.exits) {
      const fromId = exit.from === 'current' ? draft.currentRoomId : roomIdMap.get(exit.from);
      const toId = exit.to === 'current' ? draft.currentRoomId : roomIdMap.get(exit.to);
      if (!fromId || !toId || !VALID_DIRS.includes(exit.direction)) continue;
      linkRooms(fromId, exit.direction, toId, { bidirectional: false }, createdBy);
    }
  });

  commitTx();
  pendingDrafts.delete(socketId);
  return created;
}

// ─── validation ──────────────────────────────────────────────────────────────

function _validateDraft(draft, currentRoomId, expectedCount) {
  if (!Array.isArray(draft.rooms) || draft.rooms.length !== expectedCount) {
    throw new Error(`AI returned ${draft.rooms?.length} rooms, expected ${expectedCount}.`);
  }
  if (!Array.isArray(draft.exits)) throw new Error('AI draft missing exits array.');

  const validIds = new Set(['current', ...draft.rooms.map(r => r.temp_id)]);
  for (const exit of draft.exits) {
    if (!validIds.has(exit.from)) throw new Error(`Unknown from: ${exit.from}`);
    if (!validIds.has(exit.to)) throw new Error(`Unknown to: ${exit.to}`);
    if (!VALID_DIRS.includes(exit.direction)) throw new Error(`Invalid direction: ${exit.direction}`);
  }
}
