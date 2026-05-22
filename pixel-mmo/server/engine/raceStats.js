/**
 * Race and class base stats — Achaea-inspired.
 *
 * Stat modifiers are applied on top of base values at character creation.
 * Base: 100 HP, 100 MP, 100 EP. Each stat point = +10 to the relevant pool.
 */

export const RACE_STATS = {
  human:     { str:0,  dex:0,  con:0,  int:0,  wis:0,  lore:'Adaptable and ambitious, humans excel in all paths.' },
  dwarf:     { str:2,  dex:-1, con:3,  int:0,  wis:1,  lore:'Stout and resilient, masters of stone and forge.' },
  atavian:   { str:-1, dex:2,  con:-1, int:2,  wis:0,  lore:'Winged and keen, born aloft in the sky cities.' },
  rajamalan: { str:2,  dex:3,  con:0,  int:-1, wis:-1, lore:'Feline hunters of uncanny grace and strength.' },
  xoran:     { str:2,  dex:-1, con:3,  int:-1, wis:0,  lore:'Scaled and ancient, heirs to draconic bloodlines.' },
  grook:     { str:-2, dex:0,  con:-1, int:3,  wis:3,  lore:'Amphibian scholars of unrivaled magical insight.' },
  mhun:      { str:0,  dex:3,  con:-2, int:1,  wis:0,  lore:'Cave-dwellers of the deep, swift and sure-footed.' },
  troll:     { str:3,  dex:-2, con:4,  int:-2, wis:-1, lore:'Mountain giants who regenerate wounds at will.' },
  horkval:   { str:1,  dex:0,  con:3,  int:-1, wis:-1, lore:'Insectoid warriors armored in chitinous plate.' },
  siren:     { str:-1, dex:1,  con:-2, int:3,  wis:2,  lore:'Enchantresses of sea and sky, weaving mind and magic.' },
};

export const CLASS_STATS = {
  adventurer: { hp_bonus:0,   mp_bonus:0,  ep_bonus:0,  atk_bonus:2,  lore:'A wanderer between paths.' },
  magi:       { hp_bonus:-10, mp_bonus:30, ep_bonus:0,  atk_bonus:-3, lore:'Wielders of elemental destruction and the Logos.' },
  monk:       { hp_bonus:20,  mp_bonus:0,  ep_bonus:30, atk_bonus:4,  lore:'Masters of unarmed combat and inner discipline.' },
  paladin:    { hp_bonus:20,  mp_bonus:10, ep_bonus:10, atk_bonus:3,  lore:'Holy knights sworn to the Light.' },
  serpentlord:{ hp_bonus:0,   mp_bonus:10, ep_bonus:10, atk_bonus:3,  lore:'Venomous assassins of House Ashtan.' },
  occultist:  { hp_bonus:-10, mp_bonus:40, ep_bonus:0,  atk_bonus:-4, lore:'Binders of demons and wielders of chaos.' },
  bard:       { hp_bonus:0,   mp_bonus:20, ep_bonus:10, atk_bonus:0,  lore:'Virtuosos who weave music into reality.' },
  blademaster:{ hp_bonus:10,  mp_bonus:0,  ep_bonus:20, atk_bonus:5,  lore:'Duellists of unmatched blade technique.' },
  druid:      { hp_bonus:10,  mp_bonus:20, ep_bonus:10, atk_bonus:0,  lore:'Guardians of Eleusis and the natural order.' },
  priest:     { hp_bonus:10,  mp_bonus:20, ep_bonus:0,  atk_bonus:1,  lore:'Devoted healers and warriors of the Divine.' },
};

export const VALID_RACES   = Object.keys(RACE_STATS);
export const VALID_CLASSES = Object.keys(CLASS_STATS);

/**
 * Calculate derived pool maximums for a race+class combination.
 */
export function deriveStats(race, cls) {
  const r = RACE_STATS[race]   ?? RACE_STATS.human;
  const c = CLASS_STATS[cls]   ?? CLASS_STATS.adventurer;

  // CON drives HP, INT drives MP, DEX drives EP
  const max_health    = Math.max(50, 100 + r.con * 10 + (c.hp_bonus ?? 0));
  const max_mana      = Math.max(30, 100 + r.int * 10 + (c.mp_bonus ?? 0));
  const max_endurance = Math.max(50, 100 + r.dex * 5  + (c.ep_bonus ?? 0));

  return {
    strength:    10 + r.str,
    dexterity:   10 + r.dex,
    constitution:10 + r.con,
    intelligence:10 + r.int,
    wisdom:      10 + r.wis,
    max_health,
    max_mana,
    max_endurance,
    health:      max_health,
    mana:        max_mana,
    endurance:   max_endurance,
  };
}
