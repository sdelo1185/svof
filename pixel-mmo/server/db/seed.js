/**
 * World seed — runs once on first boot to populate the starting area.
 *
 * Creates:
 *   - Taroth City region
 *   - 8 connected rooms (safe city hub + dangerous outskirts)
 *   - Item templates: weapons, armor, consumables
 *   - Starting items placed in rooms
 *   - Friendly NPCs (dialogue) + combat NPCs
 */

import { getDb } from './database.js';
import { createRoom, linkRooms } from '../engine/roomManager.js';
import { placeNpc } from '../engine/npcManager.js';
import { v4 as uuidv4 } from 'uuid';

const SYSTEM = 'system';

export function seedWorld() {
  const db = getDb();

  // Already seeded if Town Square exists
  if (db.prepare("SELECT id FROM rooms WHERE name = 'Town Square of Taroth' LIMIT 1").get()) {
    return;
  }

  console.log('[seed] Seeding starter world...');

  // ── Region ──────────────────────────────────────────────────────────────────
  const regionId = uuidv4();
  db.prepare(
    'INSERT INTO regions (id, name, description, city_state, created_by, created_at) VALUES (?,?,?,?,?,?)'
  ).run(regionId, 'Taroth', 'A prosperous city-state on the edge of the wild frontier.', 'Taroth', SYSTEM, Date.now());

  // ── Rooms ────────────────────────────────────────────────────────────────────
  const square = createRoom({
    name: 'Town Square of Taroth',
    short_desc: 'The busy heart of Taroth, where merchants and adventurers meet.',
    long_desc: 'Cobblestones worn smooth by countless boots pave the wide square. A marble fountain burbles at the centre, surrounded by colourful market stalls. Adventurers fresh from the wilds rub shoulders with city folk. Roads lead in every direction.',
    terrain_type: 'city', indoor: false, safe_zone: true, light_level: 'bright',
    region_id: regionId,
  }, SYSTEM);

  const northGate = createRoom({
    name: 'North Gate',
    short_desc: 'The iron-shod north gate of Taroth, flanked by tall watchtowers.',
    long_desc: 'Two stone watchtowers rise on either side of a wide gate. Guards in city livery eye travellers warily. Beyond the gate, a dirt road stretches toward the distant plains.',
    terrain_type: 'city', indoor: false, safe_zone: true, light_level: 'bright',
    region_id: regionId,
  }, SYSTEM);

  const marketStreet = createRoom({
    name: 'Market Street',
    short_desc: 'A covered arcade packed with vendors hawking their wares.',
    long_desc: 'The smell of spices, leather, and hot food mingles under the arched stone roof. Traders shout prices. Hanging lanterns cast warm light over stalls piled with goods from across the world.',
    terrain_type: 'city', indoor: true, safe_zone: true, light_level: 'bright',
    region_id: regionId,
  }, SYSTEM);

  const temple = createRoom({
    name: 'Temple of the Luminary',
    short_desc: 'A serene marble temple suffused with golden light.',
    long_desc: 'Soaring marble columns support a domed roof painted with celestial figures. Incense smoke drifts between the pews. A priest tends the altar, offering blessings to all who enter.',
    terrain_type: 'city', indoor: true, safe_zone: true, light_level: 'bright',
    region_id: regionId,
  }, SYSTEM);

  const tavern = createRoom({
    name: 'The Rusted Flagon Tavern',
    short_desc: 'A rowdy tavern thick with pipe smoke and the smell of ale.',
    long_desc: 'Scarred tables are crowded with off-duty mercenaries swapping tales. A barmaid weaves between them with surprising grace. A fire crackles in a great stone hearth, and a wanted board is nailed near the door.',
    terrain_type: 'city', indoor: true, safe_zone: true, light_level: 'normal',
    region_id: regionId,
  }, SYSTEM);

  const southRoad = createRoom({
    name: 'South Road',
    short_desc: 'A rutted cart track leading south from Taroth\'s gate.',
    long_desc: 'The road narrows as the city walls recede behind you. Scraggly bushes line the verge and the light feels dimmer here. Travellers move quickly, eyes on the treeline ahead.',
    terrain_type: 'plains', indoor: false, safe_zone: false, light_level: 'normal',
    region_id: regionId,
  }, SYSTEM);

  const forestEdge = createRoom({
    name: 'Edge of the Darkwood',
    short_desc: 'The plains end abruptly at a wall of ancient, shadowed trees.',
    long_desc: 'The temperature drops as you approach the Darkwood. Twisted roots snake across the ground and the canopy above filters the light to a green gloom. Howls drift from deeper in. This is not a safe place.',
    terrain_type: 'forest', indoor: false, safe_zone: false, light_level: 'dim',
    region_id: regionId,
  }, SYSTEM);

  const deepForest = createRoom({
    name: 'Deep Darkwood',
    short_desc: 'Ancient trees press close, blocking almost all light.',
    long_desc: 'You are surrounded by gnarled oaks older than Taroth itself. The undergrowth is thick and the sounds of the city are long gone. Shadows move between the trunks. Something watches you.',
    terrain_type: 'forest', indoor: false, safe_zone: false, light_level: 'dark',
    region_id: regionId,
  }, SYSTEM);

  // ── Connect rooms ─────────────────────────────────────────────────────────────
  const now = Date.now();
  const link = (fromId, dir, toId) => {
    db.prepare(
      'INSERT INTO room_exits (id,from_room_id,direction,to_room_id,is_door,is_locked,created_by,created_at) VALUES (?,?,?,?,0,0,?,?)'
    ).run(uuidv4(), fromId, dir, toId, SYSTEM, now);
  };

  // Town Square hub
  link(square.id, 'n', northGate.id);    link(northGate.id,    's', square.id);
  link(square.id, 'e', marketStreet.id); link(marketStreet.id, 'w', square.id);
  link(square.id, 'w', temple.id);       link(temple.id,       'e', square.id);
  link(square.id, 'se', tavern.id);      link(tavern.id,       'nw', square.id);
  link(square.id, 's', southRoad.id);    link(southRoad.id,    'n', square.id);

  // South into the wild
  link(southRoad.id,  's', forestEdge.id); link(forestEdge.id, 'n', southRoad.id);
  link(forestEdge.id, 's', deepForest.id); link(deepForest.id, 'n', forestEdge.id);

  // ── Item templates ────────────────────────────────────────────────────────────
  const itemTpl = (fields) => {
    const id = uuidv4();
    db.prepare(`
      INSERT INTO item_templates (id,name,type,description,attributes,is_stackable,max_stack,weight,created_by,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(id, fields.name, fields.type, fields.description,
           JSON.stringify(fields.attributes ?? {}),
           fields.stackable ? 1 : 0, fields.maxStack ?? 1, fields.weight ?? 1, SYSTEM, Date.now());
    return id;
  };

  const woodenSword  = itemTpl({ name:'Wooden Sword',   type:'weapon', weight:2, description:'A practice blade of solid hardwood. Better than your fists.',    attributes:{ damage_bonus:3, equip_slot:'mainhand', visual:{ weapon_type:'sword',  color:'#8B7355' } } });
  const rustyDagger  = itemTpl({ name:'Rusty Dagger',   type:'weapon', weight:1, description:'A short blade marred with rust. Sharp enough to do the job.',     attributes:{ damage_bonus:2, equip_slot:'mainhand', visual:{ weapon_type:'dagger', color:'#8B5E3C' } } });
  const ironSword    = itemTpl({ name:'Iron Sword',     type:'weapon', weight:3, description:'A reliable iron longsword — the adventurer\'s staple.',            attributes:{ damage_bonus:6, equip_slot:'mainhand', visual:{ weapon_type:'sword',  color:'#A8A8B0' } } });
  const leatherArmor = itemTpl({ name:'Leather Armour', type:'armor',  weight:4, description:'Cured leather shaped into protective armour. Light and flexible.', attributes:{ armor_bonus:4, equip_slot:'chest',    visual:{ armor_type:'leather', color:'#7B5A3A' } } });
  const clothRobe    = itemTpl({ name:'Cloth Robe',     type:'clothing',weight:2,description:'A simple robe favoured by mages and priests.',                     attributes:{ armor_bonus:1, mp_bonus:10, equip_slot:'chest', visual:{ armor_type:'robe', color:'#6B4FA0' } } });
  const healthPotion = itemTpl({ name:'Health Potion',  type:'consumable', weight:1, stackable:true, maxStack:10, description:'A red vial that rapidly restores 50 HP when drunk.', attributes:{ heal_hp:50 } });
  const manaPotion   = itemTpl({ name:'Mana Potion',    type:'consumable', weight:1, stackable:true, maxStack:10, description:'A blue vial that restores 50 MP when drunk.',        attributes:{ heal_mp:50 } });
  const bread        = itemTpl({ name:'Loaf of Bread',  type:'consumable', weight:1, stackable:true, maxStack:5, description:'Hearty bread from the market bakery. Restores 20 HP.',attributes:{ heal_hp:20 } });

  // ── Place items in rooms ──────────────────────────────────────────────────────
  // All items are non-persistent so players can pick them up (prototype-friendly)
  const placeRoomItem = (roomId, templateId, count = 1) => {
    db.prepare(
      'INSERT INTO room_items (id,template_id,room_id,is_persistent,spawned_at,stack_count,placed_by) VALUES (?,?,?,0,?,?,?)'
    ).run(uuidv4(), templateId, roomId, Date.now(), count, SYSTEM);
  };

  // Market Street — starter gear players can pick up and use
  placeRoomItem(marketStreet.id, woodenSword);
  placeRoomItem(marketStreet.id, leatherArmor);
  placeRoomItem(marketStreet.id, clothRobe);
  placeRoomItem(marketStreet.id, healthPotion, 5);
  placeRoomItem(marketStreet.id, manaPotion, 3);
  placeRoomItem(marketStreet.id, bread, 4);

  // Tavern — comfort food
  placeRoomItem(tavern.id, bread, 3);
  placeRoomItem(tavern.id, healthPotion, 2);

  // Out in the wilds — better gear as reward for exploration
  placeRoomItem(southRoad.id,  rustyDagger);
  placeRoomItem(forestEdge.id, ironSword);
  placeRoomItem(forestEdge.id, healthPotion, 3);

  // ── NPCs ──────────────────────────────────────────────────────────────────────

  // Town Square — Mayor
  placeNpc(square.id, {
    name: 'Mayor Aldric',
    title: 'the Mayor of Taroth',
    description: 'A stout man in rich robes, surveying his city with an air of satisfied pride.',
    race: 'human', role: 'citizen',
    dialogue: [
      { keywords: ['hello','greet','hi'], response: 'Aldric beams. "Welcome to Taroth, adventurer! The finest city on the frontier. If you\'re looking for work, try the tavern south-east."' },
      { keywords: ['help','start','new'], response: '"New to the city? The Market Street to the east has gear for sale. The Temple to the west offers healing. And stay alert — the Darkwood to the south is dangerous."' },
      { keywords: ['taroth','city','town'], response: '"Taroth was founded three centuries ago by Dame Sereth the Unbowed. We\'ve survived every threat the wilds have thrown at us."' },
    ],
  }, SYSTEM);

  // Market Street — Merchant
  placeNpc(marketStreet.id, {
    name: 'Vera the Merchant',
    title: 'vendor of fine goods',
    description: 'A sharp-eyed woman who sizes up customers with a quick glance.',
    race: 'human', role: 'shopkeep',
    dialogue: [
      { keywords: ['hello','hi','buy','sell'], response: '"Looking to equip yourself? Pick up what you see on the floor — it\'s all for grabs in this market. More stock comes in daily."' },
      { keywords: ['price','gold','cost'], response: '"You\'ll find items lying around. In the wilds too. Take what you need, drop what you don\'t."' },
    ],
  }, SYSTEM);

  // Temple — Priest
  placeNpc(temple.id, {
    name: 'Brother Cassian',
    title: 'priest of the Luminary',
    description: 'A serene monk whose smile never quite leaves his lips.',
    race: 'human', role: 'healer',
    dialogue: [
      { keywords: ['hello','hi','bless'], response: '"May the Luminary\'s light guide you, adventurer. You look weary — rest here. This is a place of safety."' },
      { keywords: ['heal','hurt','help'], response: '"The temple\'s light is the best medicine. Sit, rest, and let your wounds close. Skills like \'focus\' or \'meditation\' also restore vitals."' },
      { keywords: ['luminary','god','divine'], response: '"The Luminary illuminates all paths. Paladins and Priests channel her grace most readily — but she watches over all."' },
    ],
  }, SYSTEM);

  // Tavern — Innkeeper
  placeNpc(tavern.id, {
    name: 'Margot the Innkeeper',
    title: 'keeper of the Rusted Flagon',
    description: 'Broad-shouldered and quick-witted, Margot has seen it all.',
    race: 'human', role: 'citizen',
    dialogue: [
      { keywords: ['hello','hi'], response: '"Hah! Another fresh face. Pull up a stool and tell Margot your troubles."' },
      { keywords: ['work','quest','job'], response: '"Work? The Darkwood to the south is full of wolves and bandits. Bring me their ears and I\'ll... well, I won\'t pay you, but you\'ll feel great about it."' },
      { keywords: ['ale','drink','food','bread'], response: '"Grab the bread off the counter, it\'s on the house for adventurers. We\'re not running a charity, mind — just keeping you alive long enough to spend gold here."' },
    ],
  }, SYSTEM);

  // North Gate — Guard
  placeNpc(northGate.id, {
    name: 'Gate Guard Tobias',
    title: 'city guard',
    description: 'A weathered soldier in city livery, one hand resting on his spear.',
    race: 'human', role: 'guard',
    dialogue: [
      { keywords: ['hello','hi','enter','leave'], response: '"Pass on through. Keep your weapons sheathed inside the walls — Taroth is a safe city."' },
      { keywords: ['danger','threat','wild'], response: '"The plains north of here are mostly safe, but don\'t wander too far. And whatever you do, don\'t go into the Darkwood at night."' },
    ],
  }, SYSTEM);

  // South Road — Wandering beggar
  placeNpc(southRoad.id, {
    name: 'Old Fenwick',
    title: 'a wandering hermit',
    description: 'A ragged old man muttering to himself, coins jingling in a worn pouch.',
    race: 'human', role: 'citizen',
    dialogue: [
      { keywords: ['hello','hi'], response: '"Hmm? Oh. Careful on that road, young one. The forest talks to you at night. Don\'t talk back."' },
      { keywords: ['forest','darkwood','south'], response: '"I\'ve lived on this road forty years. The wolves aren\'t the worst thing in those trees. Not by a long ways."' },
    ],
  }, SYSTEM);

  // Forest Edge — Combatant Wolf
  placeNpc(forestEdge.id, {
    name: 'Grey Wolf',
    title: null,
    description: 'A large grey wolf with yellow eyes that watch your every move.',
    race: 'human', role: 'monster',
    is_combatant: true, max_health: 80, attack_power: 14, armor: 2,
    experience_reward: 40, respawn_seconds: 120, gold_reward: 0,
    dialogue: [],
  }, SYSTEM);

  // Forest Edge — Second wolf
  placeNpc(forestEdge.id, {
    name: 'Snarling Wolf',
    title: null,
    description: 'A scarred wolf with bared teeth, crouched low and ready to spring.',
    race: 'human', role: 'monster',
    is_combatant: true, max_health: 90, attack_power: 16, armor: 3,
    experience_reward: 50, respawn_seconds: 150, gold_reward: 0,
    dialogue: [],
  }, SYSTEM);

  // Deep Forest — Bandit
  placeNpc(deepForest.id, {
    name: 'Darkwood Bandit',
    title: 'a desperate brigand',
    description: 'A rough man in mismatched armour, sizing you up for what you\'re worth.',
    race: 'human', role: 'bandit',
    is_combatant: true, max_health: 140, attack_power: 20, armor: 5,
    experience_reward: 80, respawn_seconds: 180, gold_reward: 12,
    dialogue: [
      { keywords: ['hello','hi','talk'], response: 'The bandit sneers. "Your gold or your life."' },
    ],
  }, SYSTEM);

  // Deep Forest — Darkwood Witch (harder)
  placeNpc(deepForest.id, {
    name: 'Darkwood Witch',
    title: 'the Crone of the Deep',
    description: 'An ancient woman wrapped in black rags, her eyes glowing faint green.',
    race: 'human', role: 'monster',
    is_combatant: true, max_health: 180, attack_power: 28, armor: 2,
    experience_reward: 120, respawn_seconds: 300, gold_reward: 25,
    dialogue: [
      { keywords: ['hello','hi','talk','spare'], response: '"You wander too deep, little adventurer. The forest will remember your bones."' },
    ],
  }, SYSTEM);

  console.log('[seed] Starter world seeded: 8 rooms, 10 NPCs, 8 item templates.');
  console.log(`[seed] Starting room: "${square.name}" (ID: ${square.id})`);

  return square.id;
}
