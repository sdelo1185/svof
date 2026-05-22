import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const WORLD_CONTEXT = `
You are a world-building AI for a pixel art MMO inspired by Achaea: Dreams of Divine Lands.
The world features:
- City-states with distinct cultures (like Ashtan, Targossas, Cyrene, Mhaldor, Eleusis, Hashan)
- Guilds/Houses with unique class identities (Serpentlords, Occultists, Magi, Monks, Paladins, etc.)
- Races: Human, Dwarf, Atavian (winged), Rajamalan (feline), Xoran (reptilian), Grook (amphibian), Mhun, Troll, Horkval (insectoid), Siren
- Deep mythology involving the Divine (gods), Elder Gods, and cosmic forces of Good, Evil, and Chaos
- Skill trees include: combat arts, magic schools, crafting, sailing, tattoos, devotion, curses
- Economy driven by player crafting and rare material harvesting
- Tone: high fantasy, politically complex, morally rich, occasionally dark
The pixel art style is 32-bit inspired (SNES/early PS1 era richness), roughly 16x16 to 64x64 sprites.
`;

const ATTRIBUTE_SCHEMAS = {
  weapon: {
    name: 'string — creative name fitting the world',
    damage_type: 'one of: slash, pierce, blunt, fire, cold, lightning, poison, shadow, divine',
    damage_min: 'integer 1-999',
    damage_max: 'integer damage_min+1 to 999',
    speed: 'one of: very_slow, slow, normal, fast, very_fast',
    hands: 'one of: one_handed, two_handed, off_hand',
    level_req: 'integer 1-100',
    rarity: 'one of: common, uncommon, rare, epic, legendary',
    special_properties: 'array of 0-3 short string effects (e.g. "20% chance to inflict bleed", "grants Nightsight")',
    lore_faction: 'optional — which city/guild/god this weapon aligns with',
    material: 'primary material (iron, dwarven steel, shadowweave, sunforged gold, etc.)',
  },
  armor: {
    name: 'string',
    slot: 'one of: head, chest, legs, feet, hands, wrists, neck, back, waist, ring, earring',
    defense_rating: 'integer 1-500',
    weight_class: 'one of: light, medium, heavy',
    resistances: 'object with optional keys (fire, cold, lightning, poison, shadow, divine) each integer 0-50 (% resist)',
    level_req: 'integer 1-100',
    rarity: 'one of: common, uncommon, rare, epic, legendary',
    special_properties: 'array of 0-2 short string effects',
    material: 'string',
    lore_faction: 'optional string',
  },
  clothing: {
    name: 'string',
    slot: 'one of: head, chest, legs, feet, hands, wrists, neck, back, waist, ring, earring, face, hair',
    visual_layer: 'one of: undergarment, base, over, accessory',
    rarity: 'one of: common, uncommon, rare, exotic',
    cultural_origin: 'which city-state or culture this style represents',
    dye_slots: 'integer 0-3 — how many color regions can be customized',
    special_properties: 'array of 0-1 cosmetic or minor effects',
  },
  room: {
    name: 'string — the room title as seen in-game',
    short_desc: 'one sentence atmospheric description shown on look',
    terrain_type: 'one of: city, forest, dungeon, cave, ocean, river, plains, mountain, desert, tundra, ethereal, divine',
    indoor: 'boolean',
    safe_zone: 'boolean — no PvP/monster spawns',
    light_level: 'one of: bright, normal, dim, dark, pitch_black',
    resource_nodes: 'array of 0-3 harvestable resources (e.g. "ironwood timber", "serpent herbs")',
    region: 'which larger area/city-state this belongs to',
    atmosphere_tags: 'array of 2-4 mood/ambience tags (e.g. "ancient", "foreboding", "bustling")',
  },
  consumable: {
    name: 'string',
    effect_type: 'one of: heal_health, heal_mana, heal_endurance, buff_stat, cure_affliction, grant_ability, food, drink',
    magnitude: 'integer — effect strength (e.g. HP restored, stat bonus amount)',
    duration_seconds: 'integer — 0 for instant, otherwise buff duration',
    cooldown_group: 'one of: herb, elixir, salve, food, pipe, potion — limits stacking',
    level_req: 'integer 1-60',
    rarity: 'one of: common, uncommon, rare',
    ingredients: 'array of 1-4 crafting ingredient names',
  },
  tool: {
    name: 'string',
    tool_type: 'one of: harvesting, crafting, navigation, utility, magical',
    skill_tree: 'which skill tree uses this tool (e.g. forging, tailoring, cooking, mining, fishing)',
    durability: 'integer 10-1000',
    level_req: 'integer 1-80',
    rarity: 'one of: common, uncommon, rare',
    special_properties: 'array of 0-2 effects',
  },
  furniture: {
    name: 'string',
    furniture_type: 'one of: seating, table, storage, bed, decoration, light_source, crafting_station',
    room_bonus: 'optional short string effect when placed in a player room',
    capacity: 'optional integer — storage slots if it is a storage piece',
    rarity: 'one of: common, uncommon, rare, exotic',
    cultural_origin: 'string',
  },
};

export async function generateAttributes(type, description) {
  const schema = ATTRIBUTE_SCHEMAS[type];
  if (!schema) throw new Error(`Unknown type: ${type}`);

  const schemaStr = JSON.stringify(schema, null, 2);

  const message = await client.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 1024,
    system: WORLD_CONTEXT,
    messages: [
      {
        role: 'user',
        content: `A player has submitted this ${type} for the world:

"${description}"

Generate appropriate game attributes for this ${type}. Return ONLY valid JSON matching this schema (use the descriptions as guidance for valid values):

${schemaStr}

Rules:
- Keep the lore grounded in the Achaea-inspired world context
- Balance rarity honestly — legendary items should be exceptional
- For rooms, name should be evocative but concise (max 8 words)
- Return raw JSON only, no markdown fences`,
      },
    ],
  });

  const raw = message.content[0].text.trim();
  return JSON.parse(raw);
}

export async function generateImagePrompt(type, description, attributes) {
  const name = attributes.name || description.slice(0, 40);

  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 256,
    system: WORLD_CONTEXT,
    messages: [
      {
        role: 'user',
        content: `Create a concise image generation prompt for a 32-bit pixel art game asset.

Type: ${type}
Name: ${name}
Player description: ${description}
Key attributes: ${JSON.stringify(attributes).slice(0, 300)}

Write a single image prompt (max 120 words) optimized for pixel art generation. Include:
- "32-bit pixel art" at the start
- Visual style cues (SNES-era RPG, 64x64 sprite, transparent background)
- Colors, materials, and mood from the description
- No text/words in image
Return only the prompt text, nothing else.`,
      },
    ],
  });

  return message.content[0].text.trim();
}

export async function validateLore(type, description, attributes) {
  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    system: WORLD_CONTEXT,
    messages: [
      {
        role: 'user',
        content: `Review this player-submitted ${type} for lore consistency with the world.

Description: "${description}"
Generated attributes: ${JSON.stringify(attributes, null, 2)}

Return JSON with:
{
  "passes": boolean,
  "concerns": ["list of lore issues if any"],
  "suggestions": ["1-2 suggestions to improve world-fit"],
  "lore_note": "1-2 sentence flavor note an admin can attach to the committed asset"
}

Be permissive — only flag genuine contradictions, not creative choices. Return raw JSON only.`,
      },
    ],
  });

  const raw = message.content[0].text.trim();
  return JSON.parse(raw);
}
