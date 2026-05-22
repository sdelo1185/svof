import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/database.js';
import { generateAttributes, generateImagePrompt, validateLore } from '../services/claude.js';
import { generatePixelArtImage } from '../services/imageGen.js';

const router = Router();

const VALID_TYPES = ['room', 'weapon', 'armor', 'clothing', 'consumable', 'tool', 'furniture'];

// Preview: generate attributes + image prompt without saving
router.post('/preview', async (req, res) => {
  const { type, description, creator_name } = req.body;

  if (!VALID_TYPES.includes(type)) {
    return res.status(400).json({ error: `Invalid type. Must be one of: ${VALID_TYPES.join(', ')}` });
  }
  if (!description || description.trim().length < 10) {
    return res.status(400).json({ error: 'Description must be at least 10 characters.' });
  }
  if (!creator_name || creator_name.trim().length < 2) {
    return res.status(400).json({ error: 'Creator name required.' });
  }

  try {
    const [attributes, loreValidation] = await Promise.all([
      generateAttributes(type, description.trim()),
      // Lore validation runs after attributes, queue it
      Promise.resolve(null),
    ]);

    const [imagePrompt, lore] = await Promise.all([
      generateImagePrompt(type, description.trim(), attributes),
      validateLore(type, description.trim(), attributes),
    ]);

    res.json({
      type,
      description: description.trim(),
      creator_name: creator_name.trim(),
      attributes,
      image_prompt: imagePrompt,
      lore_validation: lore,
    });
  } catch (err) {
    if (err instanceof SyntaxError) {
      return res.status(500).json({ error: 'AI returned malformed response. Please try rephrasing your description.' });
    }
    console.error('Preview error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Submit: generate image and save to DB for admin review
router.post('/submit', async (req, res) => {
  const { type, description, creator_name, attributes, image_prompt, lore_notes } = req.body;

  if (!VALID_TYPES.includes(type)) {
    return res.status(400).json({ error: 'Invalid type.' });
  }
  if (!attributes || typeof attributes !== 'object') {
    return res.status(400).json({ error: 'Attributes required. Generate a preview first.' });
  }

  const id = uuidv4();

  try {
    let imageUrl = null;
    if (image_prompt) {
      const result = await generatePixelArtImage(image_prompt, id);
      imageUrl = result.url;
    }

    const db = getDb();
    db.prepare(`
      INSERT INTO submissions (id, type, creator_name, description, image_url, image_prompt, attributes, lore_notes, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      id,
      type,
      creator_name.trim(),
      description.trim(),
      imageUrl,
      image_prompt || null,
      JSON.stringify(attributes),
      lore_notes || null,
      Date.now(),
    );

    res.status(201).json({
      id,
      status: 'pending',
      image_url: imageUrl,
      message: 'Submission received. An administrator will review your creation.',
    });
  } catch (err) {
    console.error('Submit error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get a single submission's status (for creators to check)
router.get('/submission/:id', (req, res) => {
  const db = getDb();
  const row = db.prepare(
    'SELECT id, type, creator_name, status, admin_notes, created_at, reviewed_at FROM submissions WHERE id = ?'
  ).get(req.params.id);

  if (!row) return res.status(404).json({ error: 'Submission not found.' });
  res.json(row);
});

// List committed (approved) assets — public catalogue
router.get('/catalogue', (req, res) => {
  const { type, region, limit = 50, offset = 0 } = req.query;
  const db = getDb();

  let query = 'SELECT id, type, name, description, image_url, attributes, region, committed_at FROM committed_assets WHERE 1=1';
  const params = [];

  if (type && VALID_TYPES.includes(type)) { query += ' AND type = ?'; params.push(type); }
  if (region) { query += ' AND region LIKE ?'; params.push(`%${region}%`); }

  query += ' ORDER BY committed_at DESC LIMIT ? OFFSET ?';
  params.push(Number(limit), Number(offset));

  const rows = db.prepare(query).all(...params);
  res.json(rows.map(r => ({ ...r, attributes: JSON.parse(r.attributes) })));
});

export default router;
