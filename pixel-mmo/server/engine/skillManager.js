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

  // ── Alchemist ────────────────────────────────────────────────────────────────
  miasma: {
    name:'Miasma', class:['alchemist'], mpCost:30, epCost:0, cooldownMs:8000, targetType:'npc',
    description:'Release a toxic vapour cloud dealing poison damage.',
    effect({ io, socket, session, target, db }) {
      const dmg = 12 + Math.floor(Math.random() * 12);
      broadcast(io, session.roomId, GM.COMBAT_HIT, { attacker:session.name, target:target.name, damage:dmg });
      _damageNpc(io, socket, session, target, dmg, db);
      broadcast(io, session.roomId, GM.SERVER_MSG, { text:`A toxic miasma engulfs ${target.name}!` });
    },
  },
  causticbolt: {
    name:'Caustic Bolt', class:['alchemist'], mpCost:20, epCost:0, cooldownMs:4000, targetType:'npc',
    description:'Launch a bolt of acid dealing moderate damage.',
    effect({ io, socket, session, target, db }) {
      const dmg = 8 + Math.floor(Math.random() * 10);
      broadcast(io, session.roomId, GM.COMBAT_HIT, { attacker:session.name, target:target.name, damage:dmg });
      _damageNpc(io, socket, session, target, dmg, db);
      msg(socket, `Your caustic bolt splashes ${target.name} for ${dmg}!`);
    },
  },
  transmute: {
    name:'Transmute', class:['alchemist'], mpCost:40, epCost:0, cooldownMs:60000, targetType:'self',
    description:'Transmute inner energies to restore 30% HP.',
    effect({ char, db, session, socket }) {
      const r = Math.ceil(char.max_health * 0.30);
      const hp = Math.min(char.max_health, char.health + r);
      db.prepare('UPDATE characters SET health=? WHERE id=?').run(hp, session.characterId);
      _vitals(socket, { ...char, health:hp });
      msg(socket, `Alchemical transmutation restores ${r} HP.`);
    },
  },

  // ── Apostate ─────────────────────────────────────────────────────────────────
  deathaura: {
    name:'Death Aura', class:['apostate'], mpCost:30, epCost:0, cooldownMs:6000, targetType:'npc',
    description:'Shroud yourself in necrotic energy, damaging a nearby foe.',
    effect({ io, socket, session, target, db }) {
      const dmg = 10 + Math.floor(Math.random() * 12);
      broadcast(io, session.roomId, GM.COMBAT_HIT, { attacker:session.name, target:target.name, damage:dmg });
      _damageNpc(io, socket, session, target, dmg, db);
      broadcast(io, session.roomId, GM.SERVER_MSG, { text:`Dark necrotic energy lashes ${target.name}!` });
    },
  },
  boneshatter: {
    name:'Boneshatter', class:['apostate'], mpCost:40, epCost:10, cooldownMs:12000, targetType:'npc',
    description:'Channel demonic force to shatter bone and deal heavy damage.',
    effect({ io, socket, session, target, db }) {
      const dmg = 20 + Math.floor(Math.random() * 15);
      broadcast(io, session.roomId, GM.COMBAT_HIT, { attacker:session.name, target:target.name, damage:dmg });
      _damageNpc(io, socket, session, target, dmg, db);
      msg(socket, `Your Boneshatter crushes ${target.name} for ${dmg}!`);
    },
  },
  evileye: {
    name:'Evileye', class:['apostate'], mpCost:25, epCost:0, cooldownMs:9000, targetType:'npc',
    description:'Lock eyes with a foe, dealing psychic necrotic damage.',
    effect({ io, socket, session, target, db }) {
      const dmg = 14 + Math.floor(Math.random() * 10);
      broadcast(io, session.roomId, GM.COMBAT_HIT, { attacker:session.name, target:target.name, damage:dmg });
      _damageNpc(io, socket, session, target, dmg, db);
      msg(socket, `Your Evileye withers ${target.name} for ${dmg}!`);
    },
  },

  // ── Depthswalker ─────────────────────────────────────────────────────────────
  timelock: {
    name:'Timelock', class:['depthswalker'], mpCost:35, epCost:0, cooldownMs:20000, targetType:'npc',
    description:'Freeze a foe in a temporal bubble, stunning them briefly.',
    effect({ io, session, socket, target }) {
      broadcast(io, session.roomId, GM.SERVER_MSG, { text:`${target.name} is locked in temporal stasis!` });
      msg(socket, `You lock ${target.name} in time.`);
    },
  },
  voidstep: {
    name:'Voidstep', class:['depthswalker'], mpCost:20, epCost:15, cooldownMs:18000, targetType:'self',
    description:'Step through the void to escape combat and restore 10% EP.',
    effect({ char, db, session, socket }) {
      const r = Math.ceil(char.max_endurance * 0.10);
      const ep = Math.min(char.max_endurance, char.endurance + r);
      db.prepare('UPDATE characters SET endurance=? WHERE id=?').run(ep, session.characterId);
      _vitals(socket, { ...char, endurance:ep });
      msg(socket, `You step through the void, recovering ${r} EP.`);
      send(socket, GM.SERVER_MSG, { text:'Voidstep: combat readied for escape.', type:'buff' });
    },
  },
  shadowmerge: {
    name:'Shadow Merge', class:['depthswalker'], mpCost:30, epCost:0, cooldownMs:45000, targetType:'npc',
    description:'Merge with shadow to deliver a precision strike.',
    effect({ io, socket, session, target, db }) {
      const dmg = 18 + Math.floor(Math.random() * 14);
      broadcast(io, session.roomId, GM.COMBAT_HIT, { attacker:session.name, target:target.name, damage:dmg });
      _damageNpc(io, socket, session, target, dmg, db);
      msg(socket, `Emerging from shadow you strike ${target.name} for ${dmg}!`);
    },
  },

  // ── Infernal ─────────────────────────────────────────────────────────────────
  demonfire: {
    name:'Demonfire', class:['infernal'], mpCost:25, epCost:0, cooldownMs:6000, targetType:'npc',
    description:'Summon hellish flames to scorch an enemy.',
    effect({ io, socket, session, target, db }) {
      const dmg = 14 + Math.floor(Math.random() * 14);
      broadcast(io, session.roomId, GM.COMBAT_HIT, { attacker:session.name, target:target.name, damage:dmg });
      _damageNpc(io, socket, session, target, dmg, db);
      broadcast(io, session.roomId, GM.SERVER_MSG, { text:`Hellfire engulfs ${target.name}!` });
    },
  },
  soulrend: {
    name:'Soul Rend', class:['infernal'], mpCost:35, epCost:0, cooldownMs:10000, targetType:'npc',
    description:'Tear the soul of an enemy, stealing their vitality.',
    effect({ io, socket, session, target, char, db }) {
      const dmg = 12 + Math.floor(Math.random() * 10);
      _damageNpc(io, socket, session, target, dmg, db);
      const heal = Math.ceil(dmg * 0.5);
      const hp = Math.min(char.max_health, char.health + heal);
      db.prepare('UPDATE characters SET health=? WHERE id=?').run(hp, session.characterId);
      _vitals(socket, { ...char, health:hp });
      msg(socket, `You rend ${target.name}'s soul for ${dmg}, absorbing ${heal} HP.`);
    },
  },
  malignblade: {
    name:'Malign Blade', class:['infernal'], mpCost:20, epCost:20, cooldownMs:8000, targetType:'npc',
    description:'A cursed weapon strike dripping with dark energy.',
    effect({ io, socket, session, target, db }) {
      const dmg = 16 + Math.floor(Math.random() * 12);
      broadcast(io, session.roomId, GM.COMBAT_HIT, { attacker:session.name, target:target.name, damage:dmg });
      _damageNpc(io, socket, session, target, dmg, db);
      msg(socket, `Your malign blade cleaves ${target.name} for ${dmg}!`);
    },
  },

  // ── Jester ───────────────────────────────────────────────────────────────────
  confuse: {
    name:'Confuse', class:['jester'], mpCost:20, epCost:10, cooldownMs:15000, targetType:'npc',
    description:'Bewilder an enemy with illusions, disorienting them.',
    effect({ io, session, socket, target }) {
      broadcast(io, session.roomId, GM.SERVER_MSG, { text:`${target.name} looks bewildered and confused!` });
      msg(socket, `You confuse ${target.name} with a dazzling display.`);
    },
  },
  smokebomb: {
    name:'Smoke Bomb', class:['jester'], mpCost:15, epCost:25, cooldownMs:20000, targetType:'self',
    description:'Vanish in a cloud of smoke, recovering 15% EP.',
    effect({ char, db, session, socket }) {
      const r = Math.ceil(char.max_endurance * 0.15);
      const ep = Math.min(char.max_endurance, char.endurance + r);
      db.prepare('UPDATE characters SET endurance=? WHERE id=?').run(ep, session.characterId);
      _vitals(socket, { ...char, endurance:ep });
      msg(socket, `You vanish in smoke, recovering ${r} EP.`);
      send(socket, GM.SERVER_MSG, { text:'Smokebomb active — evasion boosted.', type:'buff' });
    },
  },
  puppeteer: {
    name:'Puppeteer', class:['jester'], mpCost:30, epCost:0, cooldownMs:25000, targetType:'npc',
    description:'Pull the strings of a foe, causing them to stumble and take damage.',
    effect({ io, socket, session, target, db }) {
      const dmg = 8 + Math.floor(Math.random() * 8);
      broadcast(io, session.roomId, GM.COMBAT_HIT, { attacker:session.name, target:target.name, damage:dmg });
      _damageNpc(io, socket, session, target, dmg, db);
      broadcast(io, session.roomId, GM.SERVER_MSG, { text:`${target.name} stumbles like a puppet!` });
    },
  },

  // ── Pariah ───────────────────────────────────────────────────────────────────
  plague: {
    name:'Plague', class:['pariah'], mpCost:25, epCost:0, cooldownMs:10000, targetType:'npc',
    description:'Infect a target with a wasting disease that deals ongoing damage.',
    effect({ io, socket, session, target, db }) {
      const dmg = 8 + Math.floor(Math.random() * 10);
      broadcast(io, session.roomId, GM.COMBAT_HIT, { attacker:session.name, target:target.name, damage:dmg });
      _damageNpc(io, socket, session, target, dmg, db);
      broadcast(io, session.roomId, GM.SERVER_MSG, { text:`A plague spreads across ${target.name}!` });
    },
  },
  pestwave: {
    name:'Pestilence Wave', class:['pariah'], mpCost:40, epCost:0, cooldownMs:20000, targetType:'npc',
    description:'Release a wave of disease — heavy damage.',
    effect({ io, socket, session, target, db }) {
      const dmg = 18 + Math.floor(Math.random() * 14);
      broadcast(io, session.roomId, GM.COMBAT_HIT, { attacker:session.name, target:target.name, damage:dmg });
      _damageNpc(io, socket, session, target, dmg, db);
      msg(socket, `A wave of pestilence crashes into ${target.name} for ${dmg}!`);
    },
  },
  mortify: {
    name:'Mortify', class:['pariah'], mpCost:20, epCost:0, cooldownMs:8000, targetType:'npc',
    description:'Wither the flesh of an enemy with necrotic decay.',
    effect({ io, socket, session, target, db }) {
      const dmg = 12 + Math.floor(Math.random() * 8);
      _damageNpc(io, socket, session, target, dmg, db);
      msg(socket, `You mortify ${target.name}'s flesh for ${dmg}.`);
    },
  },

  // ── Psion ────────────────────────────────────────────────────────────────────
  mindblast: {
    name:'Mind Blast', class:['psion'], mpCost:30, epCost:0, cooldownMs:5000, targetType:'npc',
    description:'Unleash a psionic shockwave that ignores armour.',
    effect({ io, socket, session, target, db }) {
      const dmg = 14 + Math.floor(Math.random() * 14);
      broadcast(io, session.roomId, GM.COMBAT_HIT, { attacker:session.name, target:target.name, damage:dmg });
      _damageNpc(io, socket, session, target, dmg, db);
      msg(socket, `Your mind blast tears through ${target.name} for ${dmg}!`);
    },
  },
  weave: {
    name:'Weave', class:['psion'], mpCost:20, epCost:0, cooldownMs:15000, targetType:'npc',
    description:'Bind a foe in mental threads, dealing psychic damage.',
    effect({ io, socket, session, target, db }) {
      const dmg = 10 + Math.floor(Math.random() * 8);
      _damageNpc(io, socket, session, target, dmg, db);
      broadcast(io, session.roomId, GM.SERVER_MSG, { text:`${target.name} is caught in psychic weave!` });
      msg(socket, `Your weave snares ${target.name} for ${dmg}.`);
    },
  },
  psionicsurge: {
    name:'Psionic Surge', class:['psion'], mpCost:45, epCost:0, cooldownMs:30000, targetType:'self',
    description:'Channel inner psionic energy, restoring 25% MP.',
    effect({ char, db, session, socket }) {
      const r = Math.ceil(char.max_mana * 0.25);
      const mp = Math.min(char.max_mana, char.mana + r);
      db.prepare('UPDATE characters SET mana=? WHERE id=?').run(mp, session.characterId);
      _vitals(socket, { ...char, mana:mp });
      msg(socket, `Psionic surge restores ${r} MP.`);
    },
  },

  // ── Runewarden ───────────────────────────────────────────────────────────────
  runestrike: {
    name:'Runestrike', class:['runewarden'], mpCost:20, epCost:15, cooldownMs:7000, targetType:'npc',
    description:'An empowered weapon strike channelling active runes.',
    effect({ io, socket, session, target, db }) {
      const dmg = 16 + Math.floor(Math.random() * 12);
      broadcast(io, session.roomId, GM.COMBAT_HIT, { attacker:session.name, target:target.name, damage:dmg });
      _damageNpc(io, socket, session, target, dmg, db);
      msg(socket, `Glowing runes amplify your strike for ${dmg}!`);
    },
  },
  valkyrieward: {
    name:'Valkyrie Ward', class:['runewarden'], mpCost:30, epCost:0, cooldownMs:60000, targetType:'self',
    description:'Inscribe a warding rune granting temporary damage reduction.',
    effect({ socket }) {
      msg(socket, 'You inscribe a Valkyrie Ward — damage reduced for 30 seconds.');
      send(socket, GM.SERVER_MSG, { text:'Valkyrie Ward active (damage -20% for 30s).', type:'buff' });
    },
  },
  runebind: {
    name:'Runebind', class:['runewarden'], mpCost:25, epCost:0, cooldownMs:18000, targetType:'npc',
    description:'Bind an enemy in glowing runic chains dealing moderate damage.',
    effect({ io, socket, session, target, db }) {
      const dmg = 12 + Math.floor(Math.random() * 10);
      _damageNpc(io, socket, session, target, dmg, db);
      broadcast(io, session.roomId, GM.SERVER_MSG, { text:`Runic chains ensnare ${target.name}!` });
      msg(socket, `You bind ${target.name} in runes for ${dmg}.`);
    },
  },

  // ── Sentinel ─────────────────────────────────────────────────────────────────
  spearstrike: {
    name:'Spear Strike', class:['sentinel'], mpCost:10, epCost:20, cooldownMs:5000, targetType:'npc',
    description:'Drive your spear into the enemy with piercing force.',
    effect({ io, socket, session, target, db }) {
      const dmg = 14 + Math.floor(Math.random() * 12);
      broadcast(io, session.roomId, GM.COMBAT_HIT, { attacker:session.name, target:target.name, damage:dmg });
      _damageNpc(io, socket, session, target, dmg, db);
      msg(socket, `Your spear pierces ${target.name} for ${dmg}!`);
    },
  },
  beastform: {
    name:'Beast Form', class:['sentinel'], mpCost:20, epCost:0, cooldownMs:90000, targetType:'self',
    description:'Partially shift into beast form, recovering 15% HP.',
    effect({ char, db, session, socket }) {
      const r = Math.ceil(char.max_health * 0.15);
      const hp = Math.min(char.max_health, char.health + r);
      db.prepare('UPDATE characters SET health=? WHERE id=?').run(hp, session.characterId);
      _vitals(socket, { ...char, health:hp });
      msg(socket, `Beast instincts surge through you, restoring ${r} HP.`);
      send(socket, GM.SERVER_MSG, { text:'Beast Form active (ATK boosted).', type:'buff' });
    },
  },
  snare: {
    name:'Snare', class:['sentinel'], mpCost:15, epCost:10, cooldownMs:12000, targetType:'npc',
    description:'Throw a woodland snare to trap and damage a foe.',
    effect({ io, socket, session, target, db }) {
      const dmg = 6 + Math.floor(Math.random() * 8);
      _damageNpc(io, socket, session, target, dmg, db);
      broadcast(io, session.roomId, GM.SERVER_MSG, { text:`${target.name} is caught in a snare!` });
      msg(socket, `Your snare catches ${target.name} for ${dmg}.`);
    },
  },

  // ── Serpent ──────────────────────────────────────────────────────────────────
  hypnotize: {
    name:'Hypnotize', class:['serpent'], mpCost:30, epCost:0, cooldownMs:25000, targetType:'npc',
    description:'Lock eyes and mesmerize a foe, suppressing their actions.',
    effect({ io, session, socket, target }) {
      broadcast(io, session.roomId, GM.SERVER_MSG, { text:`${target.name} stares blankly, hypnotized!` });
      msg(socket, `You hypnotize ${target.name}.`);
    },
  },
  venomstrike: {
    name:'Venom Strike', class:['serpent'], mpCost:20, epCost:15, cooldownMs:5000, targetType:'npc',
    description:'Strike with a venomous blade for rapid poison damage.',
    effect({ io, socket, session, target, db }) {
      const dmg = 10 + Math.floor(Math.random() * 8);
      broadcast(io, session.roomId, GM.COMBAT_HIT, { attacker:session.name, target:target.name, damage:dmg });
      _damageNpc(io, socket, session, target, dmg, db);
      msg(socket, `Venom floods ${target.name}'s wounds for ${dmg}!`);
    },
  },
  disappear: {
    name:'Disappear', class:['serpent'], mpCost:15, epCost:20, cooldownMs:30000, targetType:'self',
    description:'Vanish from sight — your next strike is guaranteed to crit.',
    effect({ socket }) {
      msg(socket, 'You dissolve into the shadows.');
      send(socket, GM.SERVER_MSG, { text:'Disappear active (next attack crits).', type:'buff' });
    },
  },

  // ── Shaman ───────────────────────────────────────────────────────────────────
  spiritcall: {
    name:'Spirit Call', class:['shaman'], mpCost:30, epCost:0, cooldownMs:45000, targetType:'self',
    description:'Call upon the spirits to restore 25% HP.',
    effect({ char, db, session, socket }) {
      const r = Math.ceil(char.max_health * 0.25);
      const hp = Math.min(char.max_health, char.health + r);
      db.prepare('UPDATE characters SET health=? WHERE id=?').run(hp, session.characterId);
      _vitals(socket, { ...char, health:hp });
      msg(socket, `Ancestral spirits restore ${r} HP.`);
    },
  },
  hexbolt: {
    name:'Hex Bolt', class:['shaman'], mpCost:25, epCost:0, cooldownMs:4000, targetType:'npc',
    description:'Hurl a cursed bolt of spirit energy.',
    effect({ io, socket, session, target, db }) {
      const dmg = 12 + Math.floor(Math.random() * 10);
      broadcast(io, session.roomId, GM.COMBAT_HIT, { attacker:session.name, target:target.name, damage:dmg });
      _damageNpc(io, socket, session, target, dmg, db);
      msg(socket, `Your hex bolt strikes ${target.name} for ${dmg}!`);
    },
  },
  voduncurse: {
    name:'Vodun Curse', class:['shaman'], mpCost:35, epCost:0, cooldownMs:15000, targetType:'npc',
    description:'Place a Vodun curse on a foe, dealing necrotic damage.',
    effect({ io, socket, session, target, db }) {
      const dmg = 16 + Math.floor(Math.random() * 12);
      _damageNpc(io, socket, session, target, dmg, db);
      broadcast(io, session.roomId, GM.SERVER_MSG, { text:`A Vodun curse settles upon ${target.name}!` });
      msg(socket, `Your Vodun curse strikes ${target.name} for ${dmg}.`);
    },
  },

  // ── Sylvan ───────────────────────────────────────────────────────────────────
  tempest: {
    name:'Tempest', class:['sylvan'], mpCost:35, epCost:0, cooldownMs:12000, targetType:'npc',
    description:'Call down a storm blast dealing heavy lightning damage.',
    effect({ io, socket, session, target, db }) {
      const dmg = 16 + Math.floor(Math.random() * 16);
      broadcast(io, session.roomId, GM.COMBAT_HIT, { attacker:session.name, target:target.name, damage:dmg });
      _damageNpc(io, socket, session, target, dmg, db);
      broadcast(io, session.roomId, GM.SERVER_MSG, { text:`A tempest crashes down on ${target.name}!` });
    },
  },
  thornwall: {
    name:'Thorn Wall', class:['sylvan'], mpCost:25, epCost:0, cooldownMs:30000, targetType:'npc',
    description:'Raise a wall of thorns that lashes an enemy.',
    effect({ io, socket, session, target, db }) {
      const dmg = 10 + Math.floor(Math.random() * 10);
      _damageNpc(io, socket, session, target, dmg, db);
      broadcast(io, session.roomId, GM.SERVER_MSG, { text:`Thorns tear into ${target.name}!` });
      msg(socket, `Your thorn wall lashes ${target.name} for ${dmg}.`);
    },
  },
  leafsurge: {
    name:'Leaf Surge', class:['sylvan'], mpCost:20, epCost:0, cooldownMs:20000, targetType:'self',
    description:"Channel the forest's renewal to restore 20% HP and 10% MP.",
    effect({ char, db, session, socket }) {
      const hp = Math.min(char.max_health, char.health + Math.ceil(char.max_health * 0.20));
      const mp = Math.min(char.max_mana,   char.mana   + Math.ceil(char.max_mana   * 0.10));
      db.prepare('UPDATE characters SET health=?,mana=? WHERE id=?').run(hp, mp, session.characterId);
      _vitals(socket, { ...char, health:hp, mana:mp });
      msg(socket, 'A surge of leaf and wind renews your body.');
    },
  },

  // ── Unnameable ───────────────────────────────────────────────────────────────
  frenzy: {
    name:'Frenzy', class:['unnameable'], mpCost:0, epCost:40, cooldownMs:8000, targetType:'npc',
    description:'Attack in a wild frenzy with 4-6 rapid chaotic strikes.',
    effect({ io, socket, session, target, db }) {
      const hits = 4 + Math.floor(Math.random() * 3);
      let total = 0;
      for (let i = 0; i < hits; i++) { const d = 5+Math.floor(Math.random()*7); total+=d; _damageNpc(io, socket, session, target, d, db); }
      msg(socket, `Frenzy: ${hits} wild strikes for ${total} total!`);
    },
  },
  chaosbolt: {
    name:'Chaos Bolt', class:['unnameable'], mpCost:30, epCost:0, cooldownMs:6000, targetType:'npc',
    description:'Hurl a bolt of pure chaos — damage is wildly unpredictable.',
    effect({ io, socket, session, target, db }) {
      const dmg = 1 + Math.floor(Math.random() * 40);
      broadcast(io, session.roomId, GM.COMBAT_HIT, { attacker:session.name, target:target.name, damage:dmg });
      _damageNpc(io, socket, session, target, dmg, db);
      msg(socket, `Chaos erupts, striking ${target.name} for ${dmg}!`);
    },
  },
  anathema: {
    name:'Anathema', class:['unnameable'], mpCost:50, epCost:30, cooldownMs:60000, targetType:'npc',
    description:'Invoke the Dominion of the Unnameable for a devastating strike.',
    effect({ io, socket, session, target, db }) {
      const dmg = 35 + Math.floor(Math.random() * 25);
      broadcast(io, session.roomId, GM.COMBAT_HIT, { attacker:session.name, target:target.name, damage:dmg });
      _damageNpc(io, socket, session, target, dmg, db);
      broadcast(io, session.roomId, GM.SERVER_MSG, { text:`${session.name} invokes Anathema — reality fractures!` });
      msg(socket, `Anathema obliterates ${target.name} for ${dmg}!`);
    },
  },
};

// ─── Class → skills map ───────────────────────────────────────────────────────

export const CLASS_SKILL_MAP = {};
for (const [id, skill] of Object.entries(SKILLS)) {
  const classes = skill.class.includes('all')
    ? ['adventurer','magi','monk','paladin','serpentlord','occultist','bard','blademaster','druid','priest',
       'alchemist','apostate','depthswalker','infernal','jester','pariah','psion','runewarden','sentinel',
       'serpent','shaman','sylvan','unnameable']
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
