/**
 * skillManager — class-based active skills.
 *
 * Each skill has: id, name, mpCost, epCost, cooldownMs, targetType, description, effect().
 * Effects call into combatManager for NPC damage (via setNpcHp + explicit death check)
 * to avoid duplicating death logic. Self-heal skills update the DB and emit Char.Vitals.
 */

import { getDb }            from '../db/database.js';
import { getSession }       from './playerManager.js';
import { getNpcsInRoom }    from './npcManager.js';
import { setNpcHp, handleNpcDeathExternal, getNpcCurrentHp } from './combatManager.js';
import { GM, send, broadcast, msg } from '../socket/gmcp.js';

// ─── Cooldown tracking per socket:skillId ─────────────────────────────────────
const cooldowns = new Map();

// ─── Skill definitions ────────────────────────────────────────────────────────

export const SKILLS = {
  // Universal
  focus: {
    name:'Focus', class:['all'], mpCost:0, epCost:20, cooldownMs:8000, targetType:'self',
    description:'Clear your mind, restoring 15% max MP.',
    effect({ char, db, session, socket }) {
      const r = Math.ceil(char.max_mana * 0.15);
      const mp = Math.min(char.max_mana, char.mana + r);
      db.prepare('UPDATE characters SET mana=? WHERE id=?').run(mp, session.characterId);
      _vitals(socket, { ...char, mana:mp });
      msg(socket, `You focus, restoring ${r} mana.`);
    },
  },

  // Adventurer
  secondwind: {
    name:'Second Wind', class:['adventurer'], mpCost:0, epCost:30, cooldownMs:30000, targetType:'self',
    description:'Recover 25% of your max HP.',
    effect({ char, db, session, socket }) {
      const r = Math.ceil(char.max_health * 0.25);
      const hp = Math.min(char.max_health, char.health + r);
      db.prepare('UPDATE characters SET health=? WHERE id=?').run(hp, session.characterId);
      _vitals(socket, { ...char, health:hp });
      msg(socket, `Second wind! You recover ${r} HP.`);
    },
  },
  rally: {
    name:'Rally', class:['adventurer'], mpCost:15, epCost:0, cooldownMs:20000, targetType:'npc',
    description:'A rallying strike dealing bonus damage.',
    effect({ io, socket, session, target, db }) {
      const dmg = 10 + Math.floor(Math.random() * 10);
      _damageNpc(io, socket, session, target, dmg, db);
      msg(socket, `You rally and strike ${target.name} for ${dmg} bonus damage!`);
    },
  },

  // Magi
  fireball: {
    name:'Fireball', class:['magi'], mpCost:30, epCost:0, cooldownMs:4000, targetType:'npc',
    description:'Launch arcane fire dealing heavy damage.',
    effect({ io, socket, session, target, db }) {
      const dmg = 15 + Math.floor(Math.random() * 15);
      broadcast(io, session.roomId, GM.COMBAT_HIT, { attacker:session.name, target:target.name, damage:dmg });
      _damageNpc(io, socket, session, target, dmg, db);
    },
  },
  arcaneshield: {
    name:'Arcane Shield', class:['magi'], mpCost:20, epCost:0, cooldownMs:60000, targetType:'self',
    description:'Absorb the next incoming hit with arcane energy.',
    effect({ socket }) {
      msg(socket, 'You conjure an arcane shield around yourself.');
      send(socket, GM.SERVER_MSG, { text:'Arcane Shield active (absorbs 1 hit).', type:'buff' });
    },
  },

  // Monk
  meditation: {
    name:'Meditation', class:['monk'], mpCost:0, epCost:0, cooldownMs:45000, targetType:'self',
    description:'Restore 20% HP and 30% MP.',
    effect({ char, db, session, socket }) {
      const hp = Math.min(char.max_health, char.health + Math.ceil(char.max_health * 0.20));
      const mp = Math.min(char.max_mana,   char.mana   + Math.ceil(char.max_mana   * 0.30));
      db.prepare('UPDATE characters SET health=?,mana=? WHERE id=?').run(hp, mp, session.characterId);
      _vitals(socket, { ...char, health:hp, mana:mp });
      msg(socket, 'You meditate, restoring body and mind.');
    },
  },
  flurry: {
    name:'Flurry', class:['monk'], mpCost:10, epCost:25, cooldownMs:6000, targetType:'npc',
    description:'Deliver 3 rapid strikes.',
    effect({ io, socket, session, target, db }) {
      let total = 0;
      for (let i = 0; i < 3; i++) { const d = 4+Math.floor(Math.random()*6); total+=d; _damageNpc(io, socket, session, target, d, db); }
      msg(socket, `Flurry: three strikes for ${total} total damage!`);
    },
  },

  // Paladin
  smite: {
    name:'Smite', class:['paladin'], mpCost:25, epCost:0, cooldownMs:8000, targetType:'npc',
    description:'Channel divine wrath in a powerful smite.',
    effect({ io, socket, session, target, db }) {
      const dmg = 12 + Math.floor(Math.random() * 12);
      broadcast(io, session.roomId, GM.COMBAT_HIT, { attacker:session.name, target:target.name, damage:dmg });
      _damageNpc(io, socket, session, target, dmg, db);
      msg(socket, `Divine light smites ${target.name} for ${dmg}!`);
    },
  },
  layonhands: {
    name:'Lay on Hands', class:['paladin'], mpCost:0, epCost:0, cooldownMs:300000, targetType:'self',
    description:'Fully restore HP. Very long cooldown.',
    effect({ char, db, session, socket }) {
      db.prepare('UPDATE characters SET health=max_health WHERE id=?').run(session.characterId);
      _vitals(socket, { ...char, health:char.max_health });
      msg(socket, 'Divine grace restores you to full health!');
    },
  },

  // Serpentlord
  envenom: {
    name:'Envenom', class:['serpentlord'], mpCost:20, epCost:10, cooldownMs:5000, targetType:'npc',
    description:'Poison your weapon for bonus damage.',
    effect({ io, socket, session, target, db }) {
      const dmg = 5 + Math.floor(Math.random() * 5);
      _damageNpc(io, socket, session, target, dmg, db);
      broadcast(io, session.roomId, GM.SERVER_MSG, { text:`${session.name} envenoms ${target.name}.` });
    },
  },
  shadowstep: {
    name:'Shadowstep', class:['serpentlord'], mpCost:15, epCost:20, cooldownMs:25000, targetType:'self',
    description:'Melt into shadow; next attack deals double damage.',
    effect({ socket }) {
      msg(socket, 'You step into shadow.');
      send(socket, GM.SERVER_MSG, { text:'Shadowstep active (2× next attack).', type:'buff' });
    },
  },

  // Bard
  inspire: {
    name:'Inspire', class:['bard'], mpCost:20, epCost:10, cooldownMs:30000, targetType:'room',
    description:'Play an inspiring melody boosting room morale.',
    effect({ io, session, socket }) {
      broadcast(io, session.roomId, GM.SERVER_MSG, { text:`${session.name} plays an inspiring melody!`, type:'inspire' });
      msg(socket, 'Your music fills the room with inspiration.');
    },
  },
  healingballad: {
    name:'Healing Ballad', class:['bard'], mpCost:35, epCost:0, cooldownMs:60000, targetType:'self',
    description:'Restore 30% HP through a soothing melody.',
    effect({ char, db, session, socket }) {
      const r = Math.ceil(char.max_health * 0.30);
      const hp = Math.min(char.max_health, char.health + r);
      db.prepare('UPDATE characters SET health=? WHERE id=?').run(hp, session.characterId);
      _vitals(socket, { ...char, health:hp });
      msg(socket, `Your ballad restores ${r} HP.`);
    },
  },

  // Blademaster
  whirlwind: {
    name:'Whirlwind', class:['blademaster'], mpCost:0, epCost:40, cooldownMs:10000, targetType:'npc',
    description:'Deadly spinning arc — heavy damage to primary target.',
    effect({ io, socket, session, target, db }) {
      const dmg = 18 + Math.floor(Math.random() * 14);
      broadcast(io, session.roomId, GM.COMBAT_HIT, { attacker:session.name, target:target.name, damage:dmg });
      _damageNpc(io, socket, session, target, dmg, db);
      broadcast(io, session.roomId, GM.SERVER_MSG, { text:`${session.name} unleashes a whirlwind!` });
    },
  },
  bladestorm: {
    name:'Bladestorm', class:['blademaster'], mpCost:20, epCost:30, cooldownMs:15000, targetType:'npc',
    description:'Furious 2-4 hit chain attack.',
    effect({ io, socket, session, target, db }) {
      const hits = 2 + Math.floor(Math.random() * 3);
      let total = 0;
      for (let i = 0; i < hits; i++) { const d = 8+Math.floor(Math.random()*8); total+=d; _damageNpc(io, socket, session, target, d, db); }
      msg(socket, `Bladestorm: ${hits} strikes for ${total} total!`);
    },
  },

  // Druid
  natureheal: {
    name:"Nature's Embrace", class:['druid'], mpCost:25, epCost:0, cooldownMs:20000, targetType:'self',
    description:"Heal 20% HP from nature's power.",
    effect({ char, db, session, socket }) {
      const r = Math.ceil(char.max_health * 0.20);
      const hp = Math.min(char.max_health, char.health + r);
      db.prepare('UPDATE characters SET health=? WHERE id=?').run(hp, session.characterId);
      _vitals(socket, { ...char, health:hp });
      msg(socket, `Nature's embrace restores ${r} HP.`);
    },
  },
  entangle: {
    name:'Entangle', class:['druid'], mpCost:20, epCost:0, cooldownMs:12000, targetType:'npc',
    description:'Root an enemy in vines.',
    effect({ io, session, socket, target }) {
      broadcast(io, session.roomId, GM.SERVER_MSG, { text:`Vines entangle ${target.name}!` });
      msg(socket, `You entangle ${target.name}.`);
    },
  },

  // Occultist
  shadowbolt: {
    name:'Shadow Bolt', class:['occultist'], mpCost:25, epCost:0, cooldownMs:3000, targetType:'npc',
    description:'Shadow energy bolt — moderate damage.',
    effect({ io, socket, session, target, db }) {
      const dmg = 10 + Math.floor(Math.random() * 10);
      broadcast(io, session.roomId, GM.COMBAT_HIT, { attacker:session.name, target:target.name, damage:dmg });
      _damageNpc(io, socket, session, target, dmg, db);
    },
  },
  lifedrain: {
    name:'Life Drain', class:['occultist'], mpCost:30, epCost:0, cooldownMs:8000, targetType:'npc',
    description:'Drain enemy life, healing yourself.',
    effect({ io, socket, session, target, char, db }) {
      const dmg = 8 + Math.floor(Math.random() * 8);
      _damageNpc(io, socket, session, target, dmg, db);
      const heal = Math.ceil(dmg * 0.6);
      const hp = Math.min(char.max_health, char.health + heal);
      db.prepare('UPDATE characters SET health=? WHERE id=?').run(hp, session.characterId);
      _vitals(socket, { ...char, health:hp });
      msg(socket, `You drain ${dmg} from ${target.name}, recovering ${heal} HP.`);
    },
  },

  // Priest
  heal: {
    name:'Heal', class:['priest'], mpCost:20, epCost:0, cooldownMs:5000, targetType:'self',
    description:'Channel divine healing to restore 25% HP.',
    effect({ char, db, session, socket }) {
      const r = Math.ceil(char.max_health * 0.25);
      const hp = Math.min(char.max_health, char.health + r);
      db.prepare('UPDATE characters SET health=? WHERE id=?').run(hp, session.characterId);
      _vitals(socket, { ...char, health:hp });
      msg(socket, `Divine light heals you for ${r} HP.`);
    },
  },
  smiteevil: {
    name:'Smite Evil', class:['priest'], mpCost:30, epCost:0, cooldownMs:7000, targetType:'npc',
    description:'Channel holy wrath against an enemy.',
    effect({ io, socket, session, target, db }) {
      const dmg = 10 + Math.floor(Math.random() * 10);
      broadcast(io, session.roomId, GM.COMBAT_HIT, { attacker:session.name, target:target.name, damage:dmg });
      _damageNpc(io, socket, session, target, dmg, db);
      msg(socket, `Holy wrath strikes ${target.name} for ${dmg}!`);
    },
  },
};

// ─── Class → skills map ───────────────────────────────────────────────────────

export const CLASS_SKILL_MAP = {};
for (const [id, skill] of Object.entries(SKILLS)) {
  const classes = skill.class.includes('all')
    ? ['adventurer','magi','monk','paladin','serpentlord','occultist','bard','blademaster','druid','priest']
    : skill.class;
  for (const cls of classes) {
    (CLASS_SKILL_MAP[cls] ??= []).push(id);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function useSkill(io, socket, skillId, targetId) {
  const session = getSession(socket.id);
  if (!session?.characterId) return { ok:false, reason:'Not in world.' };

  const skill = SKILLS[skillId];
  if (!skill) return { ok:false, reason:`Unknown skill: ${skillId}. Type 'skills' to see yours.` };

  const db   = getDb();
  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(session.characterId);

  // Access check
  if (!(CLASS_SKILL_MAP[char.class] || []).includes(skillId)) {
    return { ok:false, reason:`${skill.name} is not available to your class.` };
  }

  // Cooldown
  const cdKey    = `${socket.id}:${skillId}`;
  const cdExpiry = cooldowns.get(cdKey) ?? 0;
  if (Date.now() < cdExpiry) {
    return { ok:false, reason:`${skill.name} on cooldown: ${Math.ceil((cdExpiry-Date.now())/1000)}s remaining.` };
  }

  // Resources
  if (char.mana      < skill.mpCost) return { ok:false, reason:`Need ${skill.mpCost} MP.` };
  if (char.endurance < skill.epCost) return { ok:false, reason:`Need ${skill.epCost} EP.` };

  // Target resolution
  let target = null;
  if (skill.targetType === 'npc') {
    if (!targetId) return { ok:false, reason:`${skill.name} requires a target. Usage: use ${skillId} <npc_id>` };
    target = getNpcsInRoom(session.roomId).find(n => n.id === targetId);
    if (!target) return { ok:false, reason:'Target not found in this room.' };
  }

  // Deduct resources
  const newMp = char.mana      - skill.mpCost;
  const newEp = char.endurance - skill.epCost;
  db.prepare('UPDATE characters SET mana=?,endurance=? WHERE id=?').run(newMp, newEp, session.characterId);
  cooldowns.set(cdKey, Date.now() + skill.cooldownMs);

  skill.effect({ io, socket, session, char:{ ...char, mana:newMp, endurance:newEp }, target, db });
  return { ok:true };
}

export function getCharSkills(cls) {
  return (CLASS_SKILL_MAP[cls] || []).map(id => {
    const s = SKILLS[id];
    return { id, name:s.name, description:s.description, mpCost:s.mpCost, epCost:s.epCost, cooldownSec:Math.floor(s.cooldownMs/1000) };
  });
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function _vitals(socket, char) {
  send(socket, GM.CHAR_VITALS, {
    hp:char.health, maxhp:char.max_health,
    mp:char.mana,   maxmp:char.max_mana,
    ep:char.endurance, maxep:char.max_endurance,
  });
}

function _damageNpc(io, socket, session, npc, damage, db) {
  const currentHp = getNpcCurrentHp(npc.id, npc.max_health);
  const newHp     = Math.max(0, currentHp - damage);

  if (newHp <= 0) {
    // Use combatManager's full death path which handles XP, respawn, etc.
    handleNpcDeathExternal(io, socket, session, npc, db);
  } else {
    setNpcHp(npc.id, newHp);
    broadcast(io, session.roomId, GM.COMBAT_HIT, {
      attacker:session.name, target:npc.name, damage, npcHp:newHp, npcMaxHp:npc.max_health,
    });
  }
}
