import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/database.js';

const router = Router();

// Simple token auth middleware for admin routes
function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }
  next();
}

router.use(adminAuth);

// List submissions by status
router.get('/submissions', (req, res) => {
  const { status = 'pending', type, limit = 20, offset = 0 } = req.query;
  const db = getDb();

  let query = 'SELECT * FROM submissions WHERE 1=1';
  const params = [];

  if (status) { query += ' AND status = ?'; params.push(status); }
  if (type) { query += ' AND type = ?'; params.push(type); }

  query += ' ORDER BY created_at ASC LIMIT ? OFFSET ?';
  params.push(Number(limit), Number(offset));

  const rows = db.prepare(query).all(...params);
  res.json(rows.map(r => ({ ...r, attributes: JSON.parse(r.attributes) })));
});

// Get full submission detail
router.get('/submissions/:id', (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM submissions WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found.' });
  res.json({ ...row, attributes: JSON.parse(row.attributes) });
});

// Approve: moves to committed_assets
router.post('/submissions/:id/approve', (req, res) => {
  const { admin_id = 'admin', region, attribute_overrides } = req.body;
  const db = getDb();

  const submission = db.prepare('SELECT * FROM submissions WHERE id = ? AND status = ?').get(req.params.id, 'pending');
  if (!submission) return res.status(404).json({ error: 'Pending submission not found.' });

  const attributes = {
    ...JSON.parse(submission.attributes),
    ...(attribute_overrides || {}),
  };

  const committedId = uuidv4();
  const now = Date.now();

  const commitTx = db.transaction(() => {
    db.prepare(`
      UPDATE submissions SET status = 'approved', admin_id = ?, admin_notes = ?, reviewed_at = ?
      WHERE id = ?
    `).run(admin_id, req.body.admin_notes || null, now, submission.id);

    db.prepare(`
      INSERT INTO committed_assets (id, submission_id, type, name, description, image_url, attributes, region, committed_at, committed_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      committedId,
      submission.id,
      submission.type,
      attributes.name || submission.description.slice(0, 60),
      submission.description,
      submission.image_url,
      JSON.stringify(attributes),
      region || attributes.region || null,
      now,
      admin_id,
    );
  });

  commitTx();

  res.json({
    message: 'Approved and committed to world.',
    committed_id: committedId,
    submission_id: submission.id,
  });
});

// Reject submission
router.post('/submissions/:id/reject', (req, res) => {
  const { admin_id = 'admin', admin_notes } = req.body;
  const db = getDb();

  const result = db.prepare(`
    UPDATE submissions SET status = 'rejected', admin_id = ?, admin_notes = ?, reviewed_at = ?
    WHERE id = ? AND status = 'pending'
  `).run(admin_id, admin_notes || null, Date.now(), req.params.id);

  if (result.changes === 0) return res.status(404).json({ error: 'Pending submission not found.' });
  res.json({ message: 'Submission rejected.' });
});

// Request revision
router.post('/submissions/:id/revision', (req, res) => {
  const { admin_id = 'admin', admin_notes } = req.body;
  if (!admin_notes) return res.status(400).json({ error: 'admin_notes required for revision requests.' });

  const db = getDb();
  const result = db.prepare(`
    UPDATE submissions SET status = 'revision', admin_id = ?, admin_notes = ?, reviewed_at = ?
    WHERE id = ? AND status = 'pending'
  `).run(admin_id, admin_notes, Date.now(), req.params.id);

  if (result.changes === 0) return res.status(404).json({ error: 'Pending submission not found.' });
  res.json({ message: 'Revision requested.' });
});

// Edit attributes on a committed asset
router.patch('/committed/:id', (req, res) => {
  const { attributes, region } = req.body;
  const db = getDb();

  const existing = db.prepare('SELECT * FROM committed_assets WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Committed asset not found.' });

  const merged = { ...JSON.parse(existing.attributes), ...(attributes || {}) };

  db.prepare(`
    UPDATE committed_assets SET attributes = ?, region = COALESCE(?, region) WHERE id = ?
  `).run(JSON.stringify(merged), region || null, req.params.id);

  res.json({ message: 'Asset updated.', attributes: merged });
});

// Stats overview
router.get('/stats', (req, res) => {
  const db = getDb();
  const pending = db.prepare("SELECT COUNT(*) as n FROM submissions WHERE status='pending'").get().n;
  const approved = db.prepare("SELECT COUNT(*) as n FROM submissions WHERE status='approved'").get().n;
  const rejected = db.prepare("SELECT COUNT(*) as n FROM submissions WHERE status='rejected'").get().n;
  const committed = db.prepare('SELECT COUNT(*) as n FROM committed_assets').get().n;
  const byType = db.prepare(
    "SELECT type, COUNT(*) as n FROM committed_assets GROUP BY type"
  ).all();

  res.json({ pending, approved, rejected, committed, by_type: byType });
});

export default router;
