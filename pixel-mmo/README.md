# Pixel MMO

A 32-bit pixel art MMO inspired by Achaea: Dreams of Divine Lands — with AI-assisted worldbuilding.

---

## Running It (ELI5)

**You need:** Node.js 18+ installed on your computer. That's it.

### Step 1 — Get the code

```bash
git clone https://github.com/sdelo1185/svof.git
cd svof/pixel-mmo/server
```

### Step 2 — Install packages

```bash
npm install
```

### Step 3 — Start the server

```bash
npm start
```

You'll see:
```
[boot] Admin account created: admin
[seed] Seeding starter world...
Pixel MMO server running on http://localhost:3000
```

### Step 4 — Open your browser

Go to **http://localhost:3000/game**

That's it. The game is running.

---

## How to Play

### First time
1. Click **Register** and create an account (username + password, min 8 chars)
2. Pick a **Race** (affects your stats) and **Class** (affects your skills and HP/MP)
3. Name your character and click **CREATE**
4. Click your character to enter the world

### You start in Town Square of Taroth
- Walk around by clicking the **direction buttons** (N/S/E/W) or typing `n`, `s`, `e`, `w`
- Type `look` to see the room description again
- Type `say hello` to talk

### Getting gear
- Walk **east** to Market Street — items are on the ground
- Click an item in the **Floor** tab (right panel) to pick it up
- Click the item in your **Bag** tab to equip it (weapons/armor equip automatically)
- Check the **Equip** tab to see your equipped gear and skills

### Fighting
- Walk **south → south** to reach the Darkwood forest
- In the **NPCs** tab you'll see wolves — click **attack** to fight
- Use `flee` if you're losing
- Type `skills` to see your class abilities, then click **use** to activate them

### Commands
| Command | What it does |
|---------|-------------|
| `n` `s` `e` `w` `ne` `nw` `se` `sw` | Move in a direction |
| `look` | Re-read the current room |
| `say <message>` | Talk to everyone in the room |
| `tell <name> <message>` | Whisper to a player |
| `inv` | Open your inventory |
| `get <item_id>` | Pick up an item (or click it) |
| `drop <item_id>` | Drop an item |
| `equip <item_id>` | Equip a weapon or armour |
| `unequip <slot>` | Take off equipment (e.g. `unequip chest`) |
| `skills` | Show your class skills |
| `use <skill_id>` | Use a skill on yourself |
| `use <skill_id> <npc_id>` | Use a skill on a target |
| `attack <npc_id>` | Attack an enemy |
| `flee` | Run away from combat |
| `talk <npc_id>` | Talk to an NPC |
| `look_npc <npc_id>` | Examine an NPC |
| Arrow keys | Move (when not typing in chat bar) |

---

## The World

### Starting Area — Taroth

```
              [North Gate]
                   │ s/n
         w ─ [Town Square] ─ e
         │         │          │
    [Temple]      s/n    [Market St]
                   │
              [South Road]
                   │ s/n
            [Edge of Darkwood]
                   │ s/n
             [Deep Darkwood]
      se ─────────┘
   [Tavern]
```

| Room | What's there |
|------|-------------|
| Town Square | Mayor Aldric (talks about the city) |
| Market Street | Gear on the ground: sword, armour, potions |
| Temple of the Luminary | Brother Cassian (advice for new players) |
| Rusted Flagon Tavern | Margot (directions + food) |
| North Gate | Guard Tobias |
| South Road | Old Fenwick the hermit, a rusty dagger |
| Edge of Darkwood | Grey Wolf, Snarling Wolf (combat), iron sword |
| Deep Darkwood | Darkwood Bandit, Darkwood Witch (harder combat) |

### Combat Progression
- Kill wolves → 40–50 XP each → level up fast
- Levelling up: XP needed = `level² × 100` (Level 2 = 400 XP, Level 3 = 900 XP, etc.)
- Higher levels restore more HP/MP/EP per regen tick
- Wolves respawn after ~2 minutes

---

## Admin & World-Building

### Admin Login
Log in with username **`admin`** / password **`admin1234`**.

The admin panel appears on the right side of the game screen. You can:
- **Dig** new rooms in any direction from your current location
- **Place NPCs** with dialogue and combat stats
- **Place items** in rooms
- **Teleport** to any room by ID

### AI Worldbuilder (requires API keys)
Players can describe items/rooms and the AI generates attributes and lore. Submissions go to the admin review queue.

To enable AI features, edit `server/.env`:
```
ANTHROPIC_API_KEY=your_key_here   # for attribute generation & lore check
OPENAI_API_KEY=your_key_here      # for pixel art image generation
```

The game works fine without these keys — AI features just won't generate previews.

---

## Classes (23 total)

| Class | Style | HP | MP | Power |
|-------|-------|----|----|-------|
| Adventurer | Balanced | ● | ● | ●● |
| Magi | Elemental mage | ▼ | ●●● | ▼ |
| Monk | Unarmed melee | ●●● | ● | ●●●● |
| Paladin | Holy knight | ●●● | ●● | ●●● |
| Serpentlord | Venom rogue | ● | ● | ●●● |
| Occultist | Dark mage | ▼ | ●●●● | ▼ |
| Bard | Support/music | ● | ●● | ● |
| Blademaster | Sword fighter | ●● | ● | ●●●●● |
| Druid | Nature magic | ●● | ●● | ● |
| Priest | Holy healer | ●● | ●● | ● |
| Alchemist | Chemical mage | ▼ | ●●● | ▼ |
| Apostate | Necromancer | ▼▼ | ●●●● | ▼ |
| Depthswalker | Time/shadow | ▼ | ●●● | ▼ |
| Infernal | Dark knight | ●●● | ●● | ●●●● |
| Jester | Trickster rogue | ● | ● | ●● |
| Pariah | Plague mage | ▼ | ●● | ▼ |
| Psion | Mental mage | ▼ | ●●●● | ▼ |
| Runewarden | Rune knight | ●●● | ●● | ●●● |
| Sentinel | Ranger | ●● | ● | ●● |
| Serpent | Venom assassin | ● | ● | ●●● |
| Shaman | Spirit mage | ● | ●●● | ▼ |
| Sylvan | Nature mage | ●● | ●●● | ▼ |
| Unnameable | Chaos warrior | ●●●●● | ● | ●●●●●● |

---

## File Structure

```
pixel-mmo/
  server/
    server.js           ← start here: npm start
    .env                ← API keys go here
    db/
      database.js       ← SQLite setup & migrations
      seed.js           ← starter world (auto-runs on first boot)
      schema.sql        ← table definitions
    engine/
      combatManager.js  ← HP, damage, XP, death, respawn
      skillManager.js   ← 60+ skills across 23 classes
      raceStats.js      ← race & class stat tables
      roomManager.js    ← room transitions, exits
      npcManager.js     ← NPC placement & dialogue
      itemManager.js    ← item pickup, drop, cap
      playerManager.js  ← session tracking
    socket/
      index.js          ← socket.io setup, regen tick
      handlers/         ← movement, combat, inventory, skills, comms, admin
    routes/
      auth.js           ← register, login, characters
      world.js          ← rooms, items, NPCs (REST)
      worldbuilding.js  ← AI pipeline
  client/
    game.html           ← the entire game client (single file)
    worldbuilder/       ← AI worldbuilder UI
    admin/              ← admin review panel
```

---

## Troubleshooting

**Port 3000 in use?**
```bash
PORT=3001 npm start
# Then open http://localhost:3001/game
```

**Want a fresh world?**
```bash
rm server/db/worldbuilding.db
npm start   # re-seeds automatically
```

**Node version issues?**
```bash
node --version   # needs 18+
```

**Worldbuilder says "AI error"?**  
Add your `ANTHROPIC_API_KEY` to `server/.env`. The rest of the game works without it.
