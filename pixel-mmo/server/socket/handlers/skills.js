/**
 * Skill socket handler.
 *
 * Events:
 *   use { skill_id, target_id? }  → activate a skill
 *   skills                         → request skill list for your class
 */

import { getSession }          from '../../engine/playerManager.js';
import { useSkill, getCharSkills } from '../../engine/skillManager.js';
import { getDb }               from '../../db/database.js';
import { GM, send, err }       from '../gmcp.js';

export function registerSkillHandlers(io, socket) {
  socket.on('use',    (d) => handleUse(io, socket, d));
  socket.on('skills', ()  => handleSkillList(socket));
}

function handleUse(io, socket, data) {
  const { skill_id, target_id } = data || {};
  if (!skill_id) return err(socket, 'Usage: use <skill_id> [target_id]');

  const result = useSkill(io, socket, skill_id, target_id);
  if (!result.ok) err(socket, result.reason);
}

function handleSkillList(socket) {
  const session = getSession(socket.id);
  if (!session?.characterId) return;

  const db   = getDb();
  const char = db.prepare('SELECT class FROM characters WHERE id=?').get(session.characterId);
  if (!char) return;

  const skills = getCharSkills(char.class);
  send(socket, 'Char.Skills', { class: char.class, skills });
}
