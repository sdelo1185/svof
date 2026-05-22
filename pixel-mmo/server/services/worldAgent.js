/**
 * Autonomous World Agent
 *
 * Plans and executes a complete area (rooms, exits, NPCs, items) from a single
 * natural-language prompt. Unlike the draft-based worldBuilder, this commits
 * everything immediately without a preview step.
 *
 * Usage:
 *   const summary = await runWorldAgent(options, progressFn);
 *
 * progressFn(step, message) is called at each stage so callers can relay
 * status to connected sockets.
 */

import Anthropic from '@anthropic-ai/sdk';
import { createRoom, linkRooms, getRoomById, updateRoomImage } from '../engine/roomManager.js';
import { placeNpc } from '../engine/npcManager.js';
import { placeItem } from '../engine/itemManager.js';
import { generatePixelArtImage } from './imageGen.js';
import { getDb } from '../db/database.js';
import { v4 as uuidv4 } from 'uuid';

const VALID_TERRAINS = ['city','forest','dungeon','cave','ocean','river','plains','mountain','desert','tundra','ethereal','divine','void'];
const VALID_DIRS     = ['n','s','e','w','ne','nw','se','sw','u','d','in','out'];
const VALID_LIGHTS   = ['bright','normal','dim','dark','pitch_black'];
const VALID_RACES    = ['human','dwarf','atavian','rajamalan','xoran','grook','mhun','troll','horkval','siren'];
const VALID_TYPES    = ['weapon','armor','clothing','consumable','tool','furniture','misc'];

const SYSTEM = `You are a world-building AI for a pixel art MMO inspired by Achaea: Dreams of Divine Lands.
Setting: city-states (Ashtan, Targossas, Cyrene, Mhaldor, Eleusis, Hashan), ancient ruins, wilderness, divine realms.
Tone: high fantasy, politically complex, morally nuanced. Room descriptions: second person present tense, 1-2 sentences, no newlines.
Room names: 2-6 words, evocative. NPC dialogue: in-character, concise. Output ONLY valid JSON — no markdown fences.`;

/**
 * Run the autonomous world agent.
 *
 * @param {object} options
 * @param {string}  options.prompt         - Theme/description for the area
 * @param {string}  options.currentRoomId  - Room the admin is standing in (anchor)
 * @param {string}  [options.exitDir='n']  - Direction of first exit from anchor room
 * @param {number}  [options.roomCount=5]  - Number of rooms to generate (2-12)
 * @param {boolean} [options.includeNpcs]  - Whether to place NPCs
 * @param {boolean} [options.includeItems] - Whether to place items
 * @param {Function} progressFn            - Called as progressFn(step, message)
 * @returns {Promise<{area_name, theme_note, rooms, npcs, items, entry_room_id}>}
 */
export async function runWorldAgent(
  { prompt, currentRoomId, exitDir = 'n', roomCount = 5, includeNpcs = true, includeItems = true },
  progressFn = () => {},
) {
  if (!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY.startsWith('placeholder')) {
    throw new Error('ANTHROPIC_API_KEY not configured. Set it in server/.env to use the world agent.');
  }

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  roomCount = Math.max(2, Math.min(12, roomCount));

  const anchor = getRoomById(currentRoomId);
  const anchorDesc = anchor
    ? `Anchor room: "${anchor.name}" (${anchor.terrain_type}, ${anchor.light_level} light). First exit goes ${exitDir}.`
    : `No anchor room. First exit goes ${exitDir}.`;

  progressFn('plan', `Planning "${prompt}"…`);

  // ── Step 1: Generate the area plan ──────────────────────────────────────────
  const response = await anthropic.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 4096,
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: `${anchorDesc}

Build a complete area (${roomCount} rooms) for this theme: "${prompt}"

Return ONLY valid JSON with this exact structure:
{
  "area_name": "Short area name (3-5 words)",
  "theme_note": "One sentence summary of what was built.",
  "rooms": [
    {
      "temp_id": "new_1",
      "name": "Room Name",
      "short_desc": "Atmospheric description, second person, present tense.",
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
      "role": "citizen|guard|merchant|innkeeper|trainer|creature",
      "description": "Physical description, one sentence.",
      "is_combatant": false,
      "max_health": 100,
      "attack_power": 10,
      "armor": 0,
      "experience_reward": 25,
      "gold_reward": 0,
      "respawn_seconds": 300,
      "dialogue": [{"keywords": ["hello","hi"], "response": "Greeting text."}]
    }
  ]` : '[]'},
  "items": ${includeItems ? `[
    {
      "room": "new_1",
      "name": "Item Name",
      "type": "${VALID_TYPES.join('|')}",
      "description": "Item description.",
      "weight": 1.0,
      "stackable": false,
      "attributes": {}
    }
  ]` : '[]'}
}

Rules:
- rooms array must have exactly ${roomCount} entries, temp_ids "new_1" through "new_${roomCount}"
- exits must reference only "current" or a valid temp_id
- directions must be one of: ${VALID_DIRS.join(', ')}
- include 0-2 NPCs across the area if includeNpcs, 0-3 items if includeItems
- return raw JSON only, no markdown fences`,
    }],
  });

  let plan;
  try {
    const raw = response.content[0].text.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    plan = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Agent plan parse error: ${e.message}`);
  }

  progressFn('plan_done', `Plan ready: "${plan.area_name}" — ${plan.rooms?.length || 0} rooms, ${plan.npcs?.length || 0} NPCs, ${plan.items?.length || 0} items.`);

  // ── Step 2: Create rooms + exits ─────────────────────────────────────────────
  progressFn('rooms', `Creating ${plan.rooms.length} rooms…`);

  const roomIdMap = new Map(); // temp_id → real uuid
  const createdRooms = [];

  const db = getDb();
  db.transaction(() => {
    for (const r of (plan.rooms || [])) {
      const room = createRoom({
        name:         r.name,
        short_desc:   r.short_desc,
        terrain_type: VALID_TERRAINS.includes(r.terrain_type) ? r.terrain_type : 'plains',
        light_level:  VALID_LIGHTS.includes(r.light_level)    ? r.light_level  : 'normal',
        indoor:       !!r.indoor,
        safe_zone:    !!r.safe_zone,
        item_cap:     Math.max(10, Math.min(200, r.item_cap || 50)),
      }, 'world_agent');
      roomIdMap.set(r.temp_id, room.id);
      createdRooms.push(room);
    }

    for (const exit of (plan.exits || [])) {
      const fromId = exit.from === 'current' ? currentRoomId : roomIdMap.get(exit.from);
      const toId   = exit.to   === 'current' ? currentRoomId : roomIdMap.get(exit.to);
      if (!fromId || !toId || !VALID_DIRS.includes(exit.direction)) continue;
      try { linkRooms(fromId, exit.direction, toId, { bidirectional: false }, 'world_agent'); } catch { /* duplicate exit — ignore */ }
    }
  })();

  progressFn('rooms_done', `Rooms created and exits linked.`);

  // ── Step 3: Place NPCs ───────────────────────────────────────────────────────
  const createdNpcs = [];
  if (includeNpcs && plan.npcs?.length) {
    progressFn('npcs', `Placing ${plan.npcs.length} NPC(s)…`);
    for (const n of plan.npcs) {
      const roomId = roomIdMap.get(n.room);
      if (!roomId) continue;
      try {
        const npc = placeNpc(roomId, {
          name:               n.name,
          title:              n.title             || null,
          race:               VALID_RACES.includes(n.race) ? n.race : 'human',
          role:               n.role              || 'citizen',
          description:        n.description       || null,
          is_combatant:       !!n.is_combatant,
          max_health:         n.max_health        ?? 100,
          attack_power:       n.attack_power      ?? 10,
          armor:              n.armor             ?? 0,
          experience_reward:  n.experience_reward ?? 25,
          gold_reward:        n.gold_reward       ?? 0,
          respawn_seconds:    n.respawn_seconds   ?? 300,
          dialogue:           n.dialogue          ?? [],
        }, 'world_agent');
        createdNpcs.push(npc);
      } catch (e) {
        progressFn('warn', `NPC "${n.name}" skipped: ${e.message}`);
      }
    }
    progressFn('npcs_done', `Placed ${createdNpcs.length} NPC(s).`);
  }

  // ── Step 4: Create item templates + place instances ──────────────────────────
  const createdItems = [];
  if (includeItems && plan.items?.length) {
    progressFn('items', `Placing ${plan.items.length} item(s)…`);
    for (const item of plan.items) {
      const roomId = roomIdMap.get(item.room);
      if (!roomId) continue;
      try {
        const templateId = uuidv4();
        db.prepare(`
          INSERT INTO item_templates
            (id, name, type, description, weight, is_stackable, max_stack, attributes, created_by, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'world_agent', ?)
        `).run(
          templateId,
          item.name,
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
    progressFn('items_done', `Placed ${createdItems.length} item(s).`);
  }

  // ── Step 5: Generate pixel art cover image for the entry room ────────────────
  const entryRoom = createdRooms[0];
  if (entryRoom) {
    progressFn('image', `Generating pixel art for "${entryRoom.name}"…`);
    try {
      const imagePrompt =
        `32-bit pixel art MMO scene: ${entryRoom.name}. ${entryRoom.short_desc} ` +
        `${plan.theme_note} ${entryRoom.terrain_type} terrain, game environment, ` +
        `vibrant retro palette, top-down perspective.`;
      const { url, placeholder } = await generatePixelArtImage(imagePrompt, entryRoom.id);
      if (!placeholder && url) {
        updateRoomImage(entryRoom.id, url);
        entryRoom.image_url = url;
        progressFn('image_done', `Cover image saved.`);
      } else {
        progressFn('image_done', `Image generation skipped (no OpenAI key).`);
      }
    } catch (e) {
      progressFn('warn', `Image generation failed: ${e.message}`);
    }
  }

  return {
    area_name:     plan.area_name     || 'Unnamed Area',
    theme_note:    plan.theme_note    || '',
    rooms:         createdRooms,
    npcs:          createdNpcs,
    items:         createdItems,
    entry_room_id: entryRoom?.id ?? null,
    entry_image:   entryRoom?.image_url ?? null,
  };
}
