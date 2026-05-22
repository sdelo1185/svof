/**
 * combatManager — real-time PvE combat engine.
 *
 * Design:
 *  - Player-initiated: each `attack` command fires one player hit + schedules NPC retaliation.
 *  - NPC health tracked in-memory; loaded lazily from the npc record on first hit.
 *  - Player death: partial HP restore + move to nearest safe zone after 3 seconds.
 *  - NPC death: XP/gold granted, respawn timer set; respawn broadcasts Room.Npcs.respawned.
 *  - Level-up: xpForLevel(n) = n² × 100. Cap 100.
 */

import { getDb }           from '../db/database.js';
import { getSession, getPlayersInRoom } from './playerManager.js';
import { getNpcsInRoom }   from './npcManager.js';
import { GM, send, broadcast } from '../socket/gmcp.js';
import { RACE_STATS, CLASS_STATS } from './raceStats.js';

// ─── In-memory state ──────────────────────────────────────────────────────────
const npcHealth    = new Map();   // npcId → currentHealth
const retalPending = new Set();   // npcIds that have a pending counter-attack
const respawnTimers = new Map();  // npcId → TimeoutHandle

let _io = null;
export function setIO(io) { _io = io; }

// ─── Public API ───────────────────────────────────────────────────────────────

export function attackNpc(io, socket, session, npcId) {
  const npc = getNpcsInRoom(session.roomId).find(n => n.id === npcId);
  if (!npc)           return { ok: false, reason: 'That target is not here.' };
  if (!npc.is_combatant) return { ok: false, reason: `${npc.name} does not wish to fight.` };
  if (!npcHealth.has(npcId)) npcHealth.set(npcId, npc.max_health);
  if (npcHealth.get(npcId) <= 0) return { ok: false, reason: `${npc.name} is already dead.` };

  const db = getDb();
  const { damage, missed } = _calcPlayerAttack(session, db);

  if (missed) {
    broadcast(io, session.roomId, GM.COMBAT_MISS, { attacker: session.name, target: npc.name });
    _scheduleRetaliation(io, npc, session.roomId, db);
    return { ok: true };
  }

  const prevHp = npcHealth.get(npcId);
  const newHp  = Math.max(0, prevHp - damage);
  npcHealth.set(npcId, newHp);

  broadcast(io, session.roomId, GM.COMBAT_HIT, {
    attacker: session.name, target: npc.name,
    damage, npcHp: newHp, npcMaxHp: npc.max_health,
  });

  if (newHp <= 0) {
    _handleNpcDeath(io, socket, session, npc, db);
  } else {
    _scheduleRetaliation(io, npc, session.roomId, db);
  }
  return { ok: true };
}

export function getNpcCurrentHp(npcId, maxHealth) {
  return npcHealth.has(npcId) ? npcHealth.get(npcId) : maxHealth;
}

// ─── Damage formulas ──────────────────────────────────────────────────────────

function _calcPlayerAttack(session, db) {
  const char      = db.prepare('SELECT * FROM characters WHERE id = ?').get(session.characterId);
  const raceData  = RACE_STATS[char.race]  ?? RACE_STATS.human;
  const classData = CLASS_STATS[char.class] ?? CLASS_STATS.adventurer;
  const effectiveStr = 10 + raceData.str;

  const weapon = db.prepare(`
    SELECT it.attributes FROM character_items ci
    JOIN item_templates it ON it.id = ci.template_id
    WHERE ci.character_id = ? AND ci.equipped_slot = 'mainhand'
  `).get(session.characterId);

  let wMin = 1, wMax = 4;
  if (weapon) {
    const a = JSON.parse(weapon.attributes);
    wMin = a.damage_min ?? wMin;
    wMax = a.damage_max ?? wMax;
  }

  if (Math.random() < 0.10) return { damage: 0, missed: true };

  const roll   = Math.floor(Math.random() * (wMax - wMin + 1)) + wMin;
  const bonus  = Math.max(0, effectiveStr - 10) + (classData.atk_bonus ?? 0);
  const damage = Math.max(1, roll + bonus);
  return { damage, missed: false };
}

function _calcNpcAttack(npc, characterId, db) {
  const armorRows = db.prepare(`
    SELECT it.attributes FROM character_items ci
    JOIN item_templates it ON it.id = ci.template_id
    WHERE ci.character_id = ? AND ci.equipped_slot IS NOT NULL AND ci.equipped_slot != 'mainhand'
  `).all(characterId);
  const playerArmor = armorRows.reduce((sum, r) => sum + (JSON.parse(r.attributes).armor ?? 0), 0);

  if (Math.random() < 0.10) return { damage: 0, missed: true };

  const base   = npc.attack_power ?? 10;
  const roll   = Math.floor(Math.random() * 6) + 1;
  const damage = Math.max(1, base + roll - Math.floor(playerArmor / 2));
  return { damage, missed: false };
}

// ─── NPC retaliation ──────────────────────────────────────────────────────────

function _scheduleRetaliation(io, npc, roomId, db) {
  if (retalPending.has(npc.id)) return;
  retalPending.add(npc.id);

  setTimeout(() => {
    retalPending.delete(npc.id);
    if ((npcHealth.get(npc.id) ?? 0) <= 0) return;

    const playersInRoom = getPlayersInRoom(roomId);
    if (!playersInRoom.length) return;

    const target = playersInRoom[Math.floor(Math.random() * playersInRoom.length)];
    const targetSocket = io.sockets.sockets.get(target.socketId);
    if (!targetSocket) return;

    const targetSession = getSession(target.socketId);
    if (!targetSession) return;

    const { damage, missed } = _calcNpcAttack(npc, targetSession.characterId, db);

    if (missed) {
      broadcast(io, roomId, GM.COMBAT_MISS, { attacker: npc.name, target: target.name });
      return;
    }

    broadcast(io, roomId, GM.COMBAT_HIT, { attacker: npc.name, target: target.name, damage });
    _applyDamageToPlayer(io, targetSocket, targetSession, damage, db);
  }, 2000 + Math.floor(Math.random() * 1000));
}

// ─── Player damage / death ────────────────────────────────────────────────────

function _applyDamageToPlayer(io, socket, session, damage, db) {
  const char   = db.prepare('SELECT * FROM characters WHERE id = ?').get(session.characterId);
  const newHp  = Math.max(0, char.health - damage);
  db.prepare('UPDATE characters SET health = ? WHERE id = ?').run(newHp, session.characterId);

  send(socket, GM.CHAR_VITALS, {
    hp: newHp, maxhp: char.max_health,
    mp: char.mana, maxmp: char.max_mana,
    ep: char.endurance, maxep: char.max_endurance,
  });

  if (newHp <= 0) _handlePlayerDeath(io, socket, session, char);
}

function _handlePlayerDeath(io, socket, session, char) {
  const db = getDb();
  db.prepare('UPDATE characters SET deaths = deaths + 1 WHERE id = ?').run(session.characterId);
  send(socket, GM.COMBAT_DEATH, { name: session.name });
  broadcast(io, session.roomId, GM.SERVER_MSG, { text: `${session.name} has been slain.` });

  setTimeout(async () => {
    const restoreHp = Math.max(1, Math.floor(char.max_health * 0.25));
    db.prepare('UPDATE characters SET health = ? WHERE id = ?').run(restoreHp, session.characterId);

    const safeRoom = db.prepare("SELECT id FROM rooms WHERE safe_zone = 1 LIMIT 1").get()
      ?? db.prepare("SELECT id FROM rooms WHERE name = 'The Void' LIMIT 1").get();

    if (safeRoom) {
      const { enterRoom } = await import('./roomManager.js');
      enterRoom(io, socket, session, safeRoom.id);
    }

    const updatedChar = db.prepare('SELECT * FROM characters WHERE id = ?').get(session.characterId);
    send(socket, GM.CHAR_VITALS, {
      hp: restoreHp, maxhp: updatedChar.max_health,
      mp: updatedChar.mana, maxmp: updatedChar.max_mana,
      ep: updatedChar.endurance, maxep: updatedChar.max_endurance,
    });
  }, 3000);
}

// ─── NPC death / respawn ──────────────────────────────────────────────────────

function _handleNpcDeath(io, socket, session, npc, db) {
  npcHealth.set(npc.id, 0);

  broadcast(io, session.roomId, GM.COMBAT_KILL, {
    killer: session.name, npc: npc.name, npcId: npc.id,
    xp: npc.experience_reward, gold: npc.gold_reward ?? 0,
  });

  // Remove NPC from room display
  broadcast(io, session.roomId, 'Room.Npcs', { removed: [npc.id] });

  // Grant XP + gold to attacker
  const char = db.prepare('SELECT * FROM characters WHERE id = ?').get(session.characterId);
  const newXp   = char.experience + npc.experience_reward;
  const newGold = char.gold + (npc.gold_reward ?? 0);

  let newLevel = char.level;
  let didLevelUp = false;
  if (char.level < 100 && newXp >= _xpForLevel(char.level)) {
    newLevel = char.level + 1;
    didLevelUp = true;
  }

  db.prepare('UPDATE characters SET experience = ?, gold = ?, kills = kills + 1, level = ? WHERE id = ?')
    .run(newXp, newGold, newLevel, session.characterId);

  send(socket, GM.CHAR_XP, {
    xp: newXp, xpNeeded: _xpForLevel(newLevel), level: newLevel,
    gained: npc.experience_reward, goldGained: npc.gold_reward ?? 0,
  });

  if (didLevelUp) {
    send(socket, GM.COMBAT_LEVELUP, { level: newLevel });
    send(socket, GM.SERVER_MSG, { text: `You have reached level ${newLevel}!`, type: 'levelup' });
  }

  // Schedule respawn
  if (npc.respawn_seconds > 0 && _io) {
    if (respawnTimers.has(npc.id)) clearTimeout(respawnTimers.get(npc.id));
    const t = setTimeout(() => {
      respawnTimers.delete(npc.id);
      npcHealth.set(npc.id, npc.max_health);
      broadcast(_io, npc.room_id, 'Room.Npcs', {
        respawned: [{ id: npc.id, name: npc.name, title: npc.title, race: npc.race, role: npc.role, is_combatant: 1 }],
      });
      broadcast(_io, npc.room_id, GM.SERVER_MSG, { text: `${npc.name} has returned.` });
    }, npc.respawn_seconds * 1000);
    respawnTimers.set(npc.id, t);
  }
}

function _xpForLevel(level) {
  return level * level * 100;
}
