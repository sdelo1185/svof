# Pixel MMO — AI Worldbuilding Pipeline

A player-driven worldbuilding system for a 32-bit pixel art MMO inspired by Achaea: Dreams of Divine Lands.

## Overview

Players describe items, rooms, weapons, clothing, and consumables in natural language. The AI pipeline:

1. **Generates typed attributes** (via Claude Opus) based on the creation type and description
2. **Validates lore consistency** against the world context (city-states, factions, divine lore)
3. **Generates a pixel art image** (via DALL-E 3) on submission
4. **Queues the submission** for admin review
5. **Admins approve/reject/request revisions** via a dashboard
6. **Approved assets are committed** to the world catalogue

## Supported Creation Types

| Type | Attributes Generated |
|------|---------------------|
| Weapon | damage type, range, speed, hands, rarity, special properties |
| Armor | slot, defense, weight class, resistances, rarity |
| Clothing | slot, visual layer, dye slots, cultural origin |
| Room | terrain, lighting, safe zone, resource nodes, region |
| Consumable | effect type, magnitude, duration, cooldown group |
| Tool | skill tree, durability, level req |
| Furniture | type, room bonus, capacity |

## Setup

```bash
cd pixel-mmo/server
cp .env.example .env
# Edit .env — add your ANTHROPIC_API_KEY (required) and OPENAI_API_KEY (optional)
npm install
npm start
```

Open:
- **Worldbuilder** → http://localhost:3000/worldbuilder/
- **Admin panel** → http://localhost:3000/admin/

## API Endpoints

### Player-facing
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/world/preview` | Generate attributes + lore check (no save) |
| POST | `/api/world/submit` | Submit for admin review (generates image) |
| GET | `/api/world/submission/:id` | Check submission status |
| GET | `/api/world/catalogue` | Browse committed world assets |

### Admin (requires `x-admin-token` header)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/submissions` | List submissions by status |
| POST | `/api/admin/submissions/:id/approve` | Approve & commit to world |
| POST | `/api/admin/submissions/:id/reject` | Reject |
| POST | `/api/admin/submissions/:id/revision` | Request revision |
| PATCH | `/api/admin/committed/:id` | Edit committed asset attributes |
| GET | `/api/admin/stats` | Overview counts |

## Next Steps

- [ ] Phaser.js game client with tilemap rendering
- [ ] Character creation (races & classes)
- [ ] Player accounts & auth
- [ ] In-game item/room integration from committed catalogue
- [ ] Revision workflow (player resubmits with admin feedback)
- [ ] Discord webhook notifications for new submissions
