/**
 * Autonomous World Agent
 *
 * Two exported entry-points:
 *   runWorldAgent  — builds a brand-new area from a prompt
 *   expandArea     — reads nearby rooms and extends the existing area
 *
 * Both commit immediately (no draft/preview step) and stream progress via
 * progressFn(step, message).
 *
 * Image generation (OpenAI DALL-E 3) runs in parallel for all rooms and
 * NPCs after the DB writes are complete.  Skips gracefully if no key.
 */

import Anthropic from '@anthropic-ai/sdk';
import { createRoom, linkRooms, getRoomById, updateRoomImage } from '../engine/roomManager.js';
import { placeNpc, updateNpcImage } from '../engine/npcManager.js';
import { placeItem } from '../engine/itemManager.js';
import { generatePixelArtImage } from './imageGen.js';
import { getDb } from '../db/database.js';
import { v4 as uuidv4 } from 'uuid';

// ─── constants ────────────────────────────────────────────────────────────────

const VALID_TERRAINS = ['city','forest','dungeon','cave','ocean','river','plains','mountain','desert','tundra','ethereal','divine','void'];
const VALID_DIRS     = ['n','s','e','w','ne','nw','se','sw','u','d','in','out'];
const VALID_LIGHTS   = ['bright','normal','dim','dark','pitch_black'];
const VALID_RACES    = ['human','dwarf','atavian','rajamalan','xoran','grook','mhun','troll','horkval','siren'];
const VALID_TYPES    = ['weapon','armor','clothing','consumable','tool','furniture','misc'];
const MAX_IMAGES     = 4; // max rooms to generate images for per agent run

const SYSTEM = `You are a world-building AI for a pixel art MMO inspired by Achaea: Dreams of Divine Lands.
Setting: city-states (Ashtan, Targossas, Cyrene, Mhaldor, Eleusis, Hashan), ancient ruins, wilderness, divine realms.
Tone: high fantasy, politically complex, morally nuanced.
Room descriptions: second person, present tense, 1-2 sentences, no newlines.
Room names: 2-6 words, evocative. NPC dialogue: in-character, concise, hints at quests or lore.
Output ONLY valid JSON — no markdown fences, no commentary.`;

// ─── helpers ──────────────────────────────────────────────────────────────────

function _getAnthropic() {
  if (!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY.startsWith('placeholder')) {
    throw new Error('ANTHROPIC_API_KEY not configured. Set it in server/.env.');
  }
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

function _parseJson(text) {
  const clean = text.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  return JSON.parse(clean);
}

/** Returns a multi-line text summary of rooms within one hop of currentRoomId. */
function _nearbyContext(db, currentRoomId) {
  const exits = db.prepare('SELECT to_room_id FROM room_exits WHERE from_room_id = ?').all(currentRoomId);
  if (!exits.length) return 'No connected rooms yet.';
  const ids = exits.map(e => e.to_room_id);
  const ph  = ids.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT r.id, r.name, r.terrain_type, r.short_desc,
      (SELECT COUNT(*) FROM npcs n   WHERE n.room_id = r.id AND n.is_active = 1) AS npc_count,
      (SELECT COUNT(*) FROM room_items ri WHERE ri.room_id = r.id)               AS item_count
    FROM rooms r WHERE r.id IN (${ph})
  `).all(...ids);
  return rows.map(r =>
    `  • "${r.name}" [${r.terrain_type}] — ${r.short_desc?.slice(0, 80) ?? ''} (${r.npc_count} NPCs, ${r.item_count} items)`
  ).join('\n');
}

/** Commit rooms + exits in one transaction.  Returns Map<temp_id → real_id> and rooms[]. */
function _commitRoomsAndExits(db, plan, currentRoomId) {
  const roomIdMap  = new Map();
  const createdRooms = [];
  db.transaction(() => {
    for (const r of (plan.rooms || [])) {
      const room = createRoom({
        name:         r.name,
        short_desc:   r.short_desc,
        long_desc:    r.long_desc    || null,
        terrain_type: VALID_TERRAINS.includes(r.terrain_type) ? r.terrain_type : 'plains',
        light_level:  VALID_LIGHTS.includes(r.light_level)    ? r.light_level  : 'normal',
        indoor:       !!r.indoor,
        safe_zone:    !!r.safe_zone,
        item_cap:     Math.max(10, Math.min(200, r.item_cap || 50)),
      }, 'world_agent');
      roomIdMap.set(r.temp_id, room.id);
      createdRooms.push({ ...room, _plan: r });
    }
    for (const exit of (plan.exits || [])) {
      const fromId = exit.from === 'current' ? currentRoomId : roomIdMap.get(exit.from);
      const toId   = exit.to   === 'current' ? currentRoomId : roomIdMap.get(exit.to);
      if (!fromId || !toId || !VALID_DIRS.includes(exit.direction)) continue;
      try { linkRooms(fromId, exit.direction, toId, { bidirectional: false }, 'world_agent'); } catch { /* duplicate */ }
    }
  })();
  return { roomIdMap, createdRooms };
}

/** Place NPCs from plan, return created array. */
function _placeNpcs(plan, roomIdMap, progressFn) {
  const createdNpcs = [];
  for (const n of (plan.npcs || [])) {
    const roomId = roomIdMap.get(n.room);
    if (!roomId) continue;
    try {
      const npc = placeNpc(roomId, {
        name:              n.name,
        title:             n.title             || null,
        race:              VALID_RACES.includes(n.race) ? n.race : 'human',
        role:              n.role              || 'citizen',
        description:       n.description       || null,
        is_combatant:      !!n.is_combatant,
        max_health:        n.max_health        ?? 100,
        attack_power:      n.attack_power      ?? 10,
        armor:             n.armor             ?? 0,
        experience_reward: n.experience_reward ?? 25,
        gold_reward:       n.gold_reward       ?? 0,
        respawn_seconds:   n.respawn_seconds   ?? 300,
        dialogue:          n.dialogue          ?? [],
      }, 'world_agent');
      createdNpcs.push({ ...npc, _plan: n });
    } catch (e) {
      progressFn('warn', `NPC "${n.name}" skipped: ${e.message}`);
    }
  }
  return createdNpcs;
}

/** Create item templates and place instances from plan, return created array. */
function _placeItems(db, plan, roomIdMap, progressFn) {
  const createdItems = [];
  for (const item of (plan.items || [])) {
    const roomId = roomIdMap.get(item.room);
    if (!roomId) continue;
    try {
      const templateId = uuidv4();
      db.prepare(`
        INSERT INTO item_templates
          (id, name, type, description, weight, is_stackable, max_stack, attributes, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'world_agent', ?)
      `).run(
        templateId, item.name,
        VALID_TYPES.includes(item.type) ? item.type : 'misc',
        item.description || null,
        item.weight      ?? 1.0,
        item.stackable   ? 1 : 0,
        item.stackable   ? 10 : 1,
        JSON.stringify(item.attributes || {}),
        Date.now(),
      );
      const result = placeItem(roomId, templateId, { isPersistent: false, stackCount: 1, placedBy: 'world_agent' });
      if (result.ok) createdItems.push(result.item);
    } catch (e) {
      progressFn('warn', `Item "${item.name}" skipped: ${e.message}`);
    }
  }
  return createdItems;
}

/**
 * Generate pixel art images for rooms (parallel, capped at MAX_IMAGES).
 * Updates DB and room objects in place.
 */
async function _generateRoomImages(createdRooms, areaSummary, progressFn) {
  const targets = createdRooms.slice(0, MAX_IMAGES);
  progressFn('images', `Generating pixel art for ${targets.length} room(s)…`);
  await Promise.allSettled(targets.map(async (room) => {
    try {
      const prompt =
        `32-bit pixel art MMO scene: ${room.name}. ${room.short_desc ?? ''} ` +
        `${areaSummary} ${room.terrain_type} terrain, game environment, ` +
        `vibrant retro palette, top-down perspective.`;
      const { url, placeholder } = await generatePixelArtImage(prompt, room.id);
      if (!placeholder && url) {
        updateRoomImage(room.id, url);
        room.image_url = url;
      }
    } catch { /* individual image failure is non-fatal */ }
  }));
  const count = targets.filter(r => r.image_url).length;
  progressFn('images_done', `${count}/${targets.length} room image(s) saved.`);
}

/**
 * Generate pixel art portraits for NPCs (parallel).
 * Updates DB and npc objects in place.
 */
async function _generateNpcPortraits(createdNpcs, progressFn) {
  if (!createdNpcs.length) return;
  progressFn('portraits', `Generating portraits for ${createdNpcs.length} NPC(s)…`);
  await Promise.allSettled(createdNpcs.map(async (npc) => {
    try {
      const prompt =
        `32-bit pixel art character portrait: ${npc.name}` +
        `${npc.title ? `, ${npc.title}` : ''}. ` +
        `${npc._plan?.description ?? ''} ${npc.race} ${npc.role}. ` +
        `Fantasy RPG character, face and upper body, dark background, ` +
        `pixel art style, expressive, vibrant colors.`;
      const { url, placeholder } = await generatePixelArtImage(prompt, `npc_${npc.id}`);
      if (!placeholder && url) {
        updateNpcImage(npc.id, url);
        npc.image_url = url;
      }
    } catch { /* non-fatal */ }
  }));
  const count = createdNpcs.filter(n => n.image_url).length;
  progressFn('portraits_done', `${count}/${createdNpcs.length} NPC portrait(s) saved.`);
}

// ─── build prompt ─────────────────────────────────────────────────────────────

function _buildPlanPrompt({ anchorDesc, prompt, roomCount, includeNpcs, includeItems, exitDir, nearbyContext }) {
  return `${anchorDesc}
${nearbyContext ? `\nNearby area context:\n${nearbyContext}\n` : ''}
Theme for new area: "${prompt}"

Build a complete, lore-rich area with ${roomCount} rooms. Return ONLY valid JSON:
{
  "area_name": "Short evocative name (3-5 words)",
  "theme_note": "One sentence summary.",
  "lore": "2-3 sentences of backstory/history that give this area depth.",
  "rooms": [
    {
      "temp_id": "new_1",
      "name": "Room Name",
      "short_desc": "Atmospheric, second person, present tense. 1-2 sentences.",
      "long_desc": "Optional richer description for examine. May be null.",
      "terrain_type": "${VALID_TERRAINS.join('|')}",
      "light_level": "${VALID_LIGHTS.join('|')}",
      "indoor": false,
      "safe_zone": false,
      "item_cap": 50
    }
  ],
  "exits": [
    { "from": "current", "direction": "${exitDir}", "to": "new_1" },
    { "from": "new_1",   "direction": "s",          "to": "current" }
  ],
  "npcs": ${includeNpcs ? `[
    {
      "room": "new_1",
      "name": "NPC Name",
      "title": "short title or null",
      "race": "${VALID_RACES.join('|')}",
      "role": "citizen|guard|merchant|innkeeper|trainer|quest|creature",
      "description": "Physical description, one sentence.",
      "is_combatant": false,
      "max_health": 100, "attack_power": 10, "armor": 0,
      "experience_reward": 25, "gold_reward": 0, "respawn_seconds": 300,
      "dialogue": [
        { "keywords": ["hello","hi"],  "response": "Greeting referencing area lore." },
        { "keywords": ["quest","help","task"], "response": "A hint at something to do here." }
      ]
    }
  ]` : '[]'},
  "items": ${includeItems ? `[
    {
      "room": "new_1",
      "name": "Item Name",
      "type": "${VALID_TYPES.join('|')}",
      "description": "Flavourful item description.",
      "weight": 1.0, "stackable": false,
      "attributes": {}
    }
  ]` : '[]'}
}

Rules:
- rooms array must have exactly ${roomCount} entries with temp_ids new_1 through new_${roomCount}
- exits reference only "current" or a valid temp_id; use the area lore to inform connections
- directions: ${VALID_DIRS.join(', ')}
- 1-3 NPCs total if includeNpcs; at least one should hint at a quest or local mystery
- 1-4 items total if includeItems; tie them to the lore
- nearby context (if provided) should influence names, terrain, tone — make expansions feel connected
- raw JSON only`;
}

// ─── public API ───────────────────────────────────────────────────────────────

/**
 * Build a brand-new area from a single prompt.
 */
export async function runWorldAgent(
  { prompt, currentRoomId, exitDir = 'n', roomCount = 5, includeNpcs = true, includeItems = true },
  progressFn = () => {},
) {
  const anthropic = _getAnthropic();
  roomCount = Math.max(2, Math.min(12, roomCount));

  const anchor = getRoomById(currentRoomId);
  const anchorDesc = anchor
    ? `Anchor room: "${anchor.name}" (${anchor.terrain_type}, ${anchor.light_level} light). First exit goes ${exitDir}.`
    : `No anchor room. First exit goes ${exitDir}.`;

  progressFn('plan', `Planning "${prompt}"…`);

  const response = await anthropic.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 4096,
    system: SYSTEM,
    messages: [{ role: 'user', content: _buildPlanPrompt({ anchorDesc, prompt, roomCount, includeNpcs, includeItems, exitDir, nearbyContext: null }) }],
  });

  let plan;
  try { plan = _parseJson(response.content[0].text); }
  catch (e) { throw new Error(`Agent plan parse error: ${e.message}`); }

  progressFn('plan_done', `"${plan.area_name}" — ${plan.rooms?.length || 0} rooms, ${plan.npcs?.length || 0} NPCs, ${plan.items?.length || 0} items.`);
  if (plan.lore) progressFn('lore', plan.lore);

  const db = getDb();

  progressFn('rooms', `Building ${plan.rooms.length} room(s)…`);
  const { roomIdMap, createdRooms } = _commitRoomsAndExits(db, plan, currentRoomId);

  // Store lore as long_desc on the entry room
  if (plan.lore && createdRooms[0]) {
    db.prepare('UPDATE rooms SET long_desc = ? WHERE id = ?').run(plan.lore, createdRooms[0].id);
    createdRooms[0].long_desc = plan.lore;
  }
  progressFn('rooms_done', `${createdRooms.length} room(s) created and linked.`);

  progressFn('npcs', `Placing NPCs…`);
  const createdNpcs = _placeNpcs(plan, roomIdMap, progressFn);
  progressFn('npcs_done', `${createdNpcs.length} NPC(s) placed.`);

  progressFn('items', `Placing items…`);
  const createdItems = _placeItems(db, plan, roomIdMap, progressFn);
  progressFn('items_done', `${createdItems.length} item(s) placed.`);

  // Images run in parallel after all DB writes
  await _generateRoomImages(createdRooms, plan.theme_note, progressFn);
  await _generateNpcPortraits(createdNpcs, progressFn);

  return {
    area_name:     plan.area_name  || 'Unnamed Area',
    theme_note:    plan.theme_note || '',
    lore:          plan.lore       || '',
    rooms:         createdRooms,
    npcs:          createdNpcs,
    items:         createdItems,
    entry_room_id: createdRooms[0]?.id    ?? null,
    entry_image:   createdRooms[0]?.image_url ?? null,
  };
}

/**
 * Expand an existing area — reads connected rooms as context so additions
 * feel thematically coherent with what's already there.
 */
export async function expandArea(
  { prompt, currentRoomId, exitDir = 'n', roomCount = 3, includeNpcs = true, includeItems = true },
  progressFn = () => {},
) {
  const anthropic = _getAnthropic();
  roomCount = Math.max(1, Math.min(8, roomCount));

  const db = getDb();
  const anchor = getRoomById(currentRoomId);
  const anchorDesc = anchor
    ? `You are EXPANDING an existing area. Current room: "${anchor.name}" (${anchor.terrain_type}).`
    : `Expanding from an unknown anchor room.`;

  const nearbyContext = _nearbyContext(db, currentRoomId);
  progressFn('plan', `Analysing area and planning expansion…`);

  const response = await anthropic.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 4096,
    system: SYSTEM,
    messages: [{ role: 'user', content: _buildPlanPrompt({ anchorDesc, prompt, roomCount, includeNpcs, includeItems, exitDir, nearbyContext }) }],
  });

  let plan;
  try { plan = _parseJson(response.content[0].text); }
  catch (e) { throw new Error(`Expansion plan parse error: ${e.message}`); }

  progressFn('plan_done', `"${plan.area_name}" — ${plan.rooms?.length || 0} rooms, ${plan.npcs?.length || 0} NPCs, ${plan.items?.length || 0} items.`);
  if (plan.lore) progressFn('lore', plan.lore);

  progressFn('rooms', `Building ${plan.rooms.length} room(s)…`);
  const { roomIdMap, createdRooms } = _commitRoomsAndExits(db, plan, currentRoomId);
  if (plan.lore && createdRooms[0]) {
    db.prepare('UPDATE rooms SET long_desc = ? WHERE id = ?').run(plan.lore, createdRooms[0].id);
    createdRooms[0].long_desc = plan.lore;
  }
  progressFn('rooms_done', `${createdRooms.length} room(s) created.`);

  progressFn('npcs', `Placing NPCs…`);
  const createdNpcs = _placeNpcs(plan, roomIdMap, progressFn);
  progressFn('npcs_done', `${createdNpcs.length} NPC(s) placed.`);

  progressFn('items', `Placing items…`);
  const createdItems = _placeItems(db, plan, roomIdMap, progressFn);
  progressFn('items_done', `${createdItems.length} item(s) placed.`);

  await _generateRoomImages(createdRooms, plan.theme_note, progressFn);
  await _generateNpcPortraits(createdNpcs, progressFn);

  return {
    area_name:     plan.area_name  || 'Expanded Area',
    theme_note:    plan.theme_note || '',
    lore:          plan.lore       || '',
    rooms:         createdRooms,
    npcs:          createdNpcs,
    items:         createdItems,
    entry_room_id: createdRooms[0]?.id    ?? null,
    entry_image:   createdRooms[0]?.image_url ?? null,
  };
}

/**
 * Generate (or regenerate) a pixel art portrait for a single NPC by ID.
 * Returns the image URL or null.
 */
export async function generateNpcPortrait(npcId) {
  const db = getDb();
  const npc = db.prepare('SELECT * FROM npcs WHERE id = ?').get(npcId);
  if (!npc) throw new Error(`NPC ${npcId} not found.`);

  const prompt =
    `32-bit pixel art character portrait: ${npc.name}` +
    `${npc.title ? `, ${npc.title}` : ''}. ` +
    `${npc.description ?? ''} ${npc.race} ${npc.role}. ` +
    `Fantasy RPG character, face and upper body, dark background, ` +
    `pixel art style, expressive, vibrant colors.`;

  const { url, placeholder } = await generatePixelArtImage(prompt, `npc_${npc.id}`);
  if (!placeholder && url) {
    updateNpcImage(npc.id, url);
    return url;
  }
  return null;
}
