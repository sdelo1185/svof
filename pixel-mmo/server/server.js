import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import worldbuildingRouter from './routes/worldbuilding.js';
import adminRouter from './routes/admin.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();

app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Serve generated images and static client files
app.use('/assets', express.static(join(__dir, '../client/assets')));
app.use(express.static(join(__dir, '../client')));

app.use('/api/world', worldbuildingRouter);
app.use('/api/admin', adminRouter);

app.get('/health', (_, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.listen(PORT, () => {
  console.log(`Pixel MMO worldbuilding server running on http://localhost:${PORT}`);
  console.log(`  Admin dashboard: http://localhost:${PORT}/admin/`);
  console.log(`  Worldbuilder:    http://localhost:${PORT}/worldbuilder/`);
});
