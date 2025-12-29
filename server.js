/* ============================================================
   Flip‑to‑6 — Full Multiplayer Game Server
   Rooms • Players • Deck • Draw Pile • Discard • Hands • Scoring
   ============================================================ */

/**
 * ============================================================
 * Flip‑to‑6 (Flip‑7 style) — FULL GAME SERVER
 * ------------------------------------------------------------
 * Features:
 *  - Rooms with up to 6 players
 *  - Join / rejoin (reconnect-safe)
 *  - Room lock after first draw (no NEW players, old players can rejoin)
 *  - Full deck from card_types with PNG filenames
 *  - Hybrid shuffle + draw/discard piles in DB
 *  - Player hands persisted in DB
 *  - Turn order, Stay logic, End Round
 *  - Action cards:
 *      * Second Chance (optional use)
 *      * 2x, 4+, 5+, 6‑ (scoring)
 *      * Freeze (choose target → auto-stay)
 *      * Swap  (choose target → swap hands, self allowed)
 *      * Take 3 (choose target → target draws 3)
 *  - Bust rule:
 *      * Duplicate number with no Second Chance → bust → stayed + round score = 0
 *  - Game pause:
 *      * If ANY player disconnects → game paused (Option B)
 *      * Resume when all disconnected players rejoin or are removed
 *  - Reconnect:
 *      * Players rejoin by same name + room code, keep seat + cards + state
 *  - Socket.io real-time updates
 *  - Card metadata endpoint for PNGs
 * ============================================================
 */

const express = require("express");
const http = require("http");
const path = require("path");
const bodyParser = require("body-parser");
const { Pool } = require("pg");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/**
 * ============================================================
 * DATABASE INIT
 * ============================================================
 */
(async () => {
  try {
    // Card definitions
    await pool.query(`
      CREATE TABLE IF NOT EXISTS card_types (
        value TEXT PRIMARY KEY,
        filename TEXT NOT NULL,
        count INT NOT NULL
      );
    `);

    // Rooms
    await pool.query(`
      CREATE TABLE IF NOT EXISTS rooms (
        id SERIAL PRIMARY KEY,
        code TEXT UNIQUE NOT NULL,
        locked BOOLEAN NOT NULL DEFAULT FALSE,
        current_player_id INT,
        round_number INT NOT NULL DEFAULT 1,
        round_over BOOLEAN NOT NULL DEFAULT FALSE,
        paused BOOLEAN NOT NULL DEFAULT FALSE,
        pending_action_type TEXT,
        pending_action_actor_id INT,
        pending_action_value TEXT
      );
    `);

    // Players
    await pool.query(`
      CREATE TABLE IF NOT EXISTS room_players (
        id SERIAL PRIMARY KEY,
        room_id INT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        player_id INT NOT NULL,
        name TEXT NOT NULL,
        order_index INT NOT NULL,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        stayed BOOLEAN NOT NULL DEFAULT FALSE,
        total_score INT NOT NULL DEFAULT 0,
        socket_id TEXT,
        connected BOOLEAN NOT NULL DEFAULT TRUE,
        round_bust BOOLEAN NOT NULL DEFAULT FALSE
      );
    `);

    // Draw pile
    await pool.query(`
      CREATE TABLE IF NOT EXISTS draw_pile (
        id SERIAL PRIMARY KEY,
        room_id INT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        position INT NOT NULL,
        value TEXT NOT NULL
      );
    `);

    // Discard pile
    await pool.query(`
      CREATE TABLE IF NOT EXISTS discard_pile (
        id SERIAL PRIMARY KEY,
        room_id INT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        position INT NOT NULL,
        value TEXT NOT NULL
      );
    `);

    // Player hands
    await pool.query(`
      CREATE TABLE IF NOT EXISTS player_hands (
        id SERIAL PRIMARY KEY,
        room_id INT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        player_id INT NOT NULL REFERENCES room_players(id) ON DELETE CASCADE,
        position BIGINT NOT NULL,
        value TEXT NOT NULL
      );
    `);

    // Round scores
    await pool.query(`
      CREATE TABLE IF NOT EXISTS round_scores (
        id SERIAL PRIMARY KEY,
        room_id INT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        player_id INT NOT NULL REFERENCES room_players(id) ON DELETE CASCADE,
        round_number INT NOT NULL,
        score INT NOT NULL
      );
    `);

    console.log("Flip‑to‑6 tables ready.");
  } catch (err) {
    console.error("DB init error:", err);
  }
})();

/**
 * ============================================================
 * SHUFFLING HELPERS
 * ============================================================
 */

// Standard Fisher–Yates shuffle
function fisherYates(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
}

// Detect numeric vs action card
function isAction(value) {
  return !/^(?:[0-9]|1[0-2])$/.test(value);
}

// Try to force a streak of identical numeric cards
function forceStreak(deck, length) {
  const start = Math.floor(Math.random() * (deck.length - length + 1));

  for (let offset = 0; offset < deck.length - length + 1; offset++) {
    const i = (start + offset) % (deck.length - length + 1);
    let streak = true;

    for (let j = 1; j < length; j++) {
      if (deck[i].value !== deck[i + j].value) {
        streak = false;
        break;
      }
    }

    if (!streak) {
      const targetValue = deck[i].value;
      const idx = deck.findIndex((c, idx2) => idx2 >= i + length && c.value === targetValue);

      if (idx !== -1) {
        [deck[i + length - 1], deck[idx]] = [deck[idx], deck[i + length - 1]];
        return true;
      }
    }
  }
  return false;
}

/**
 * ============================================================
 * ADAPTIVE ACTION-CARD DISTRIBUTION
 * ============================================================
 */

// Create zones based on deck size (percentages)
function makeZones(deckSize) {
  return [
    [Math.floor(deckSize * 0.10), Math.floor(deckSize * 0.30)],
    [Math.floor(deckSize * 0.30), Math.floor(deckSize * 0.65)],
    [Math.floor(deckSize * 0.65), Math.floor(deckSize * 0.80)],
    [Math.floor(deckSize * 0.80), deckSize - 1]
  ];
}

// Insert action cards into adaptive zones
function distributeActionsAdaptive(result, actionCards) {
  const deckSize = result.length;
  const zones = makeZones(deckSize);

  let actionIndex = 0;

  for (let z = 0; z < zones.length; z++) {
    if (actionIndex >= actionCards.length) break;

    const [minPos, maxPos] = zones[z];
    if (minPos >= maxPos) continue; // tiny deck safety

    // Insert 1–3 cards (capped by remaining)
    const count = Math.min(
      Math.floor(Math.random() * 3) + 1,
      actionCards.length - actionIndex
    );

    // Random insertion point inside the zone
    const insertPos = Math.floor(Math.random() * (maxPos - minPos + 1)) + minPos;

    for (let i = 0; i < count; i++) {
      result.splice(insertPos, 0, actionCards[actionIndex++]);
    }
  }

  return result;
}

/**
 * ============================================================
 * MAIN HYBRID SHUFFLE
 * ============================================================
 */

function hybridShuffle(deck, streakLengths = [2, 3]) {
  const numberCards = [];
  const actionCards = [];

  // Split deck
  for (const card of deck) {
    if (isAction(card.value)) actionCards.push(card);
    else numberCards.push(card);
  }

  // Shuffle numeric cards
  fisherYates(numberCards);

  // Force streaks
  streakLengths.forEach(len => forceStreak(numberCards, len));

  // Shuffle action cards
  fisherYates(actionCards);

  // Use up to 14 action cards (or fewer if deck is small)
  const actionsToUse = actionCards.slice(0, 14);

  // Start with numeric backbone
  let result = [...numberCards];

  // Distribute action cards adaptively
  result = distributeActionsAdaptive(result, actionsToUse);

  return result;
}


/**
 * ============================================================
 * DECK CREATION AND MANAGEMENT
 * ============================================================
 */

// Ensure a deck exists for a room (creates/shuffles if empty)
async function ensureDeck(roomId) {
  const check = await pool.query(
    "SELECT COUNT(*) FROM draw_pile WHERE room_id = $1",
    [roomId]
  );
  if (parseInt(check.rows[0].count, 10) > 0) return; // already have a deck

  const types = await pool.query(
    "SELECT value, count FROM card_types ORDER BY value"
  );

  let deck = [];
  types.rows.forEach(row => {
    for (let i = 0; i < row.count; i++) {
      deck.push({ value: row.value });
    }
  });

  deck = hybridShuffle(deck);

  await pool.query("DELETE FROM draw_pile WHERE room_id = $1", [roomId]);
  await pool.query("DELETE FROM discard_pile WHERE room_id = $1", [roomId]);
  await pool.query("DELETE FROM player_hands WHERE room_id = $1", [roomId]);

  for (let i = 0; i < deck.length; i++) {
    await pool.query(
      "INSERT INTO draw_pile (room_id, position, value) VALUES ($1, $2, $3)",
      [roomId, i, deck[i].value]
    );
  }
}

// Pop top card from draw pile; if empty, reshuffle discard
async function popTopCard(roomId) {
  let res = await pool.query(
    "SELECT * FROM draw_pile WHERE room_id = $1 ORDER BY position LIMIT 1",
    [roomId]
  );

  // If no draw pile, reshuffle discard into draw
  if (!res.rows.length) {
    const d = await pool.query(
      "SELECT value FROM discard_pile WHERE room_id = $1 ORDER BY position",
      [roomId]
    );
    const old = d.rows.map(r => ({ value: r.value }));
    if (!old.length) {
      // No cards anywhere (edge case). Return null.
      return null;
    }

    let deck = hybridShuffle(old);
    await pool.query("DELETE FROM discard_pile WHERE room_id = $1", [roomId]);
    await pool.query("DELETE FROM draw_pile WHERE room_id = $1", [roomId]);

    for (let i = 0; i < deck.length; i++) {
      await pool.query(
        "INSERT INTO draw_pile (room_id, position, value) VALUES ($1, $2, $3)",
        [roomId, i, deck[i].value]
      );
    }

    res = await pool.query(
      "SELECT * FROM draw_pile WHERE room_id = $1 ORDER BY position LIMIT 1",
      [roomId]
    );
  }

  const card = res.rows[0];
  await pool.query("DELETE FROM draw_pile WHERE id = $1", [card.id]);
  return card.value;
}

// Add card to player's hand
async function addToHand(roomId, playerId, value) {
  await pool.query(
    `INSERT INTO player_hands (room_id, player_id, position, value)
     VALUES ($1, $2, EXTRACT(EPOCH FROM NOW())::BIGINT, $3)`,
    [roomId, playerId, value]
  );
}

// Remove one specific card (value) from a player's hand (latest position)
async function removeFromHand(roomId, playerId, value) {
  const card = await pool.query(
    `SELECT id FROM player_hands
     WHERE room_id = $1 AND player_id = $2 AND value = $3
     ORDER BY position DESC
     LIMIT 1`,
    [roomId, playerId, value]
  );
  if (card.rows.length) {
    await pool.query("DELETE FROM player_hands WHERE id = $1", [card.rows[0].id]);
  }
}

// Add card to discard pile
async function addToDiscard(roomId, value) {
  await pool.query(
    `INSERT INTO discard_pile (room_id, position, value)
     VALUES ($1, EXTRACT(EPOCH FROM NOW())::BIGINT, $2)`,
    [roomId, value]
  );
}

// Check if player has any card of a given numeric value
async function playerHasNumber(roomId, playerId, value) {
  const res = await pool.query(
    "SELECT id FROM player_hands WHERE room_id = $1 AND player_id = $2 AND value = $3",
    [roomId, playerId, value]
  );
  return res.rows.length > 0;
}

// Check if player has Second Chance
async function playerHasSecondChance(roomId, playerId) {
  const res = await pool.query(
    "SELECT id FROM player_hands WHERE room_id = $1 AND player_id = $2 AND value = 'Second Chance'",
    [roomId, playerId]
  );
  return res.rows.length > 0;
}

/**
 * ============================================================
 * PAUSE / RECONNECT HELPERS
 * ============================================================
 */

// After any connect/disconnect, recompute paused state:
// If ANY active player is disconnected → paused = TRUE
async function recomputePause(roomId) {
  const res = await pool.query(
    `SELECT connected FROM room_players
     WHERE room_id = $1 AND active = TRUE`,
    [roomId]
  );
  const anyDisconnected = res.rows.some(r => r.connected === false);
  await pool.query(
    "UPDATE rooms SET paused = $1 WHERE id = $2",
    [anyDisconnected, roomId]
  );
}

/**
 * ============================================================
 * TURN ORDER
 * ============================================================
 */

// Advance to next active + not stayed player; if none, round_over = TRUE
async function advanceTurn(roomId) {
  const playersRes = await pool.query(
    `SELECT id, order_index, active, stayed
     FROM room_players
     WHERE room_id = $1
     ORDER BY order_index`,
    [roomId]
  );
  const roomRes = await pool.query(
    "SELECT current_player_id FROM rooms WHERE id = $1",
    [roomId]
  );
  const list = playersRes.rows;
  let current = roomRes.rows[0].current_player_id;

  // If no current player, pick first active & not stayed
  if (!current) {
    const first = list.find(p => p.active && !p.stayed);
    if (first) {
      await pool.query(
        "UPDATE rooms SET current_player_id = $1 WHERE id = $2",
        [first.id, roomId]
      );
    }
    return;
  }

  const curPlayer = list.find(p => p.id === current);
  if (!curPlayer) {
    // If current not found (e.g. removed), pick first valid
    const first = list.find(p => p.active && !p.stayed);
    if (first) {
      await pool.query(
        "UPDATE rooms SET current_player_id = $1 WHERE id = $2",
        [first.id, roomId]
      );
    } else {
      await pool.query(
        "UPDATE rooms SET round_over = TRUE WHERE id = $1",
        [roomId]
      );
    }
    return;
  }

  let idx = curPlayer.order_index;
  let nextId = null;

  // Loop at most list.length times to find next
  for (let i = 0; i < list.length; i++) {
    idx = (idx + 1) % list.length;
    const candidate = list[idx];
    if (candidate.active && !candidate.stayed) {
      nextId = candidate.id;
      break;
    }
  }

  if (nextId) {
    await pool.query(
      "UPDATE rooms SET current_player_id = $1 WHERE id = $2",
      [nextId, roomId]
    );
  } else {
    await pool.query(
      "UPDATE rooms SET round_over = TRUE WHERE id = $1",
      [roomId]
    );
  }
}

/**
 * ============================================================
 * SCORING
 * ============================================================
 */

// Compute score from a player's hand, considering 2x, 4+, 5+, 6‑
// Note: bust rule is handled separately via round_bust flag
async function computeScore(roomId, playerId) {
  const res = await pool.query(
    `SELECT value FROM player_hands
     WHERE room_id = $1 AND player_id = $2
     ORDER BY position ASC`,
    [roomId, playerId]
  );

  let score = 0;
  let mult = 1;

  for (const row of res.rows) {
    const v = row.value;
    const num = parseInt(v, 10);

    if (!isNaN(num)) {
      score += num;
      continue;
    }

    if (v === "2x") mult *= 2;
    if (v === "4+") score += 4;
    if (v === "5+") score += 5;
    if (v === "6-") score -= 6;
    // Second Chance & instants are not scored
  }

  return score * mult;
}

// End of round: compute scores, move all cards to discard, reset round state
async function endRound(roomId) {
  const roomRes = await pool.query(
    "SELECT round_number FROM rooms WHERE id = $1",
    [roomId]
  );
  const round = roomRes.rows[0].round_number;

  const playersRes = await pool.query(
    `SELECT id, round_bust FROM room_players
     WHERE room_id = $1 AND active = TRUE
     ORDER BY order_index`,
    [roomId]
  );

  for (const p of playersRes.rows) {
    const pid = p.id;
    let score = 0;

    if (!p.round_bust) {
      score = await computeScore(roomId, pid);
    }

    await pool.query(
      `INSERT INTO round_scores (room_id, player_id, round_number, score)
       VALUES ($1, $2, $3, $4)`,
      [roomId, pid, round, score]
    );

    await pool.query(
      "UPDATE room_players SET total_score = total_score + $1 WHERE id = $2",
      [score, pid]
    );

    // Move player's cards to discard
    const hand = await pool.query(
      "SELECT value FROM player_hands WHERE room_id = $1 AND player_id = $2",
      [roomId, pid]
    );
    for (const h of hand.rows) {
      await addToDiscard(roomId, h.value);
    }
  }

  // Clear all hands
  await pool.query("DELETE FROM player_hands WHERE room_id = $1", [roomId]);

  // Reset stayed + bust flags
  await pool.query(
    "UPDATE room_players SET stayed = FALSE, round_bust = FALSE WHERE room_id = $1",
    [roomId]
  );

  // Advance round number, clear round_over, reset current_player_id and pending actions
  await pool.query(
    `UPDATE rooms
     SET round_number = round_number + 1,
         round_over = FALSE,
         current_player_id = NULL,
         pending_action_type = NULL,
         pending_action_actor_id = NULL,
         pending_action_value = NULL
     WHERE id = $1`,
    [roomId]
  );

  // Ensure new deck for next round
  await ensureDeck(roomId);

  // Pick first player for next round
  await advanceTurn(roomId);
}

/**
 * ============================================================
 * STATE PACKING FOR CLIENT
 * ============================================================
 */

async function getState(roomId) {
  const roomRes = await pool.query("SELECT * FROM rooms WHERE id = $1", [roomId]);
  const room = roomRes.rows[0];

  const playersRes = await pool.query(
    `SELECT id, name, order_index, active, stayed, total_score, connected, round_bust
     FROM room_players
     WHERE room_id = $1
     ORDER BY order_index`,
    [roomId]
  );

  const handsRes = await pool.query(
    `SELECT player_id, value
     FROM player_hands
     WHERE room_id = $1
     ORDER BY position`,
    [roomId]
  );

  const deckCountRes = await pool.query(
    "SELECT COUNT(*) FROM draw_pile WHERE room_id = $1",
    [roomId]
  );
  const discardCountRes = await pool.query(
    "SELECT COUNT(*) FROM discard_pile WHERE room_id = $1",
    [roomId]
  );

  const topCardsRes = await pool.query(
    `SELECT value FROM draw_pile
     WHERE room_id = $1
     ORDER BY position ASC
     LIMIT 5`,
    [roomId]
  );

  const disconnectedPlayers = playersRes.rows
    .filter(p => p.active && !p.connected)
    .map(p => ({ id: p.id, name: p.name }));

  return {
    roomId,
    code: room.code,
    locked: room.locked,
    currentPlayerId: room.current_player_id,
    roundNumber: room.round_number,
    roundOver: room.round_over,
    paused: room.paused,
    pendingActionType: room.pending_action_type,
    pendingActionActorId: room.pending_action_actor_id,
    pendingActionValue: room.pending_action_value,
    players: playersRes.rows,
    hands: handsRes.rows,
    deckCount: parseInt(deckCountRes.rows[0].count, 10),
    discardCount: parseInt(discardCountRes.rows[0].count, 10),
    topDrawCards: topCardsRes.rows.map(r => r.value),
    disconnectedPlayers
  };
}

/**
 * ============================================================
 * DRAW CARD LOGIC WITH FULL RULES
 * ============================================================
 *
 * IMPORTANT:
 * - This function ONLY draws the card and sets up pending actions/bust.
 * - It does NOT advance the turn. Caller must do that.
 * - It respects Second Chance and Bust rules.
 */

async function drawCardForPlayer(room, playerId) {
  const roomId = room.id;

  // If there's a pending action, do not allow new draw
  if (room.pending_action_type) {
    return; // should not happen if caller checks
  }

  // Make sure deck exists (first draw will create deck + effectively start the game)
  await ensureDeck(roomId);

  const value = await popTopCard(roomId);
  if (!value) return; // no cards at all (rare edge case)

  const isNumber = /^(?:[0-9]|1[0-2])$/.test(value);
  const scoring = ["2x", "4+", "5+", "6-"];
  const instant = ["Freeze", "Swap", "Take 3"];

  // 1) Numeric card
  if (isNumber) {
    // Add to hand
    await addToHand(roomId, playerId, value);

    // Check duplicate
    const hasDuplicate = await playerHasNumber(roomId, playerId, value);
    // Note: playerHasNumber sees at least this card; we need to know if they had it BEFORE.
    // Simple approach: check hand count of this value.
    const dupRes = await pool.query(
      `SELECT COUNT(*) FROM player_hands
       WHERE room_id = $1 AND player_id = $2 AND value = $3`,
      [roomId, playerId, value]
    );
    const count = parseInt(dupRes.rows[0].count, 10);
    const isTrueDuplicate = count > 1;

    if (isTrueDuplicate) {
      // If duplicate, check Second Chance
      const hasSecondChance = await playerHasSecondChance(roomId, playerId);

      if (hasSecondChance) {
        // Optional use: set pending action SecondChance
        await pool.query(
          `UPDATE rooms
           SET pending_action_type = 'SecondChance',
               pending_action_actor_id = $1,
               pending_action_value = $2
           WHERE id = $3`,
          [playerId, value, roomId]
        );
        return;
      } else {
        // Bust: mark this player as bust + stayed
        await pool.query(
          `UPDATE room_players
           SET stayed = TRUE, round_bust = TRUE
           WHERE id = $1 AND room_id = $2`,
          [playerId, roomId]
        );
        return;
      }
    }

    // Normal numeric draw; nothing else special
    return;
  }

  // 2) Scoring cards (2x, 4+, 5+, 6‑) — always go to hand
  if (scoring.includes(value)) {
    await addToHand(roomId, playerId, value);
    return;
  }

  // 3) Second Chance card itself — goes to hand
  if (value === "Second Chance") {
    await addToHand(roomId, playerId, value);
    return;
  }

  // 4) Action cards: Freeze, Swap, Take 3
  if (instant.includes(value)) {
    // Action card must appear in hand until resolved (Option 3)
    await addToHand(roomId, playerId, value);

    // Set pending action so client enters target selection mode
    let actionType;
    if (value === "Freeze") actionType = "Freeze";
    if (value === "Swap") actionType = "Swap";
    if (value === "Take 3") actionType = "Take3";

    await pool.query(
      `UPDATE rooms
       SET pending_action_type = $1,
           pending_action_actor_id = $2,
           pending_action_value = $3
       WHERE id = $4`,
      [actionType, playerId, value, roomId]
    );

    return;
  }

  // Fallback: if unknown, just discard
  await addToDiscard(roomId, value);
}

/**
 * ============================================================
 * EXPRESS ROUTES
 * ============================================================
 */

// Initialize card_types with values/filenames/counts (run once when setting up)
app.post("/api/init-deck", async (req, res) => {
  try {
    const cardData = [
      ["0", "0.png", 1],
      ["1", "1.png", 1],
      ["2", "2.png", 2],
      ["3", "3.png", 3],
      ["4", "4.png", 4],
      ["5", "5.png", 5],
      ["6", "6.png", 6],
      ["7", "7.png", 7],
      ["8", "8.png", 8],
      ["9", "9.png", 9],
      ["10", "10.png", 10],
      ["11", "11.png", 11],
      ["12", "12.png", 12],
      // Action cards (filenames/examples, adjust to your actual PNG names)
      ["2x", "action-2x.png", 1],
      ["4+", "action-4+.png", 2],
      ["5+", "action-5+.png", 2],
      ["6-", "action-6-.png", 2],
      ["Freeze", "action-freeze.png", 1],
      ["Second Chance", "action-secondchance.png", 3],
      ["Swap", "action-swap.png", 1],
      ["Take 3", "action-take3.png", 2]
    ];

    await pool.query("DELETE FROM card_types");
    for (const [value, filename, count] of cardData) {
      await pool.query(
        "INSERT INTO card_types (value, filename, count) VALUES ($1, $2, $3)",
        [value, filename, count]
      );
    }

    res.json({ success: true, message: "Flip‑to‑6 deck definitions initialized." });
  } catch (err) {
    console.error("init-deck error:", err);
    res.status(500).json({ success: false, error: "Initialization failed." });
  }
});

// Card metadata for PNGs (value -> filename)
app.get("/api/cards/meta", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT value, filename FROM card_types ORDER BY value"
    );
    res.json({ success: true, cards: result.rows });
  } catch (err) {
    console.error("cards/meta error:", err);
    res.status(500).json({ success: false, error: "Failed to load card metadata" });
  }
});

/**
 * Player join / rejoin:
 *
 * - If room not exist → create
 * - If room locked:
 *     * If name exists in room_players → rejoin (get same playerId)
 *     * Else → error: room locked
 * - If room unlocked:
 *     * If name exists → rejoin
 *     * Else → join as new player (max 6)
 */
app.post("/api/player/join", async (req, res) => {
  try {
    const { name, roomCode } = req.body;
    const cleanName = String(name || "").trim().toLowerCase();
    const code = String(roomCode || "").trim().toUpperCase();

    if (!cleanName || !code) {
      return res.status(400).json({ error: "Name and room code are required." });
    }

    // Get or create room
    let roomRes = await pool.query("SELECT * FROM rooms WHERE code = $1", [code]);
    if (!roomRes.rows.length) {
      const created = await pool.query(
        "INSERT INTO rooms (code, locked) VALUES ($1, FALSE) RETURNING *",
        [code]
      );
      roomRes = created;
    }
    const room = roomRes.rows[0];

    // Check if player with this name already exists in this room
    const existingRes = await pool.query(
      `SELECT * FROM room_players
       WHERE room_id = $1 AND LOWER(name) = LOWER($2)`,
      [room.id, cleanName]
    );
    const existing = existingRes.rows[0];

    // If room locked and player not already in this room → deny
    if (room.locked && !existing) {
      return res.status(400).json({ error: "Room locked. Game already started." });
    }

    // If player exists → rejoin (keep same playerId)
    if (existing) {
      const playerId = existing.id;
      return res.json({
        redirect: `/room/${code}?playerId=${playerId}`
      });
    }

   // Room unlocked and player not existing → create new slot
   const playersRes = await pool.query(
     `SELECT * FROM room_players
      WHERE room_id = $1 AND active = TRUE
      ORDER BY order_index`,
     [room.id]
   );
   
   if (playersRes.rows.length >= 6) {
     return res.status(400).json({ error: "Room is full (6 players)." });
   }
   
   // Compute next available player_id (1..6)
   const idRes = await pool.query(
     `SELECT player_id FROM room_players
      WHERE room_id = $1
      ORDER BY player_id ASC`,
     [room.id]
   );
   
   let playerId = 1;
   for (const row of idRes.rows) {
     if (row.player_id === playerId) {
       playerId++;
     } else {
       break;
     }
   }
   
   // Compute seat order
   const orderIndex = playersRes.rows.length;
   
   // Insert new player
   const inserted = await pool.query(
     `INSERT INTO room_players
      (room_id, player_id, name, order_index, active, stayed, connected, round_bust)
      VALUES ($1, $2, $3, $4, TRUE, FALSE, TRUE, FALSE)
      RETURNING player_id`,
     [room.id, playerId, cleanName, orderIndex]
   );
   
   res.json({
     redirect: `/room/${code}?playerId=${playerId}`
   });

   } catch (err) {
     console.error("JOIN ERROR:", err);
   
     // Return the REAL SQL error to the browser
     res.status(500).json({
       error: "JOIN ERROR: " + err.message
     });
   }
});

// Serve the playing board
app.get("/room/:code", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "table.html"));
});

// For debugging deck contents (e.g., cards.html)
app.get("/api/room/:code/draw-pile", async (req, res) => {
  try {
    const { code } = req.params;
    const roomRes = await pool.query(
      "SELECT id FROM rooms WHERE code = $1",
      [code.toUpperCase()]
    );
    if (!roomRes.rows.length) {
      return res.status(404).json({ error: "Room not found" });
    }

    const roomId = roomRes.rows[0].id;
    const pileRes = await pool.query(
      `SELECT position, value
       FROM draw_pile
       WHERE room_id = $1
       ORDER BY position ASC`,
      [roomId]
    );

    res.json({ success: true, drawPile: pileRes.rows });
  } catch (err) {
    console.error("draw-pile error:", err);
    res.status(500).json({ error: "Failed to load draw pile" });
  }
});

/**
 * ============================================================
 * SOCKET.IO GAME LOGIC
 * ============================================================
 */

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  /**
   * Player joins a room via socket after HTTP login redirect.
   * This:
   *  - Associates socket with room_players row
   *  - Marks player as connected
   *  - May unpause the room if no one is disconnected
   *  - Sends full stateUpdate to this socket
   */
  socket.on("joinRoom", async ({ roomCode, playerId }) => {
    try {
      const code = String(roomCode || "").trim().toUpperCase();
      const roomRes = await pool.query(
        "SELECT * FROM rooms WHERE code = $1",
        [code]
      );
      if (!roomRes.rows.length) return;

      const room = roomRes.rows[0];

      const playerRes = await pool.query(
        `SELECT * FROM room_players
         WHERE id = $1 AND room_id = $2 AND active = TRUE`,
        [playerId, room.id]
      );
      if (!playerRes.rows.length) return;

      const player = playerRes.rows[0];

      // Update socket id and mark connected
      await pool.query(
        `UPDATE room_players
         SET socket_id = $1, connected = TRUE
         WHERE id = $2`,
        [socket.id, player.id]
      );

      // Recompute paused state (if all connected, unpause)
      await recomputePause(room.id);

      // Join socket.io room
      socket.join(code);

      // If no current player (new round), pick the first
      const freshRoomRes = await pool.query(
        "SELECT * FROM rooms WHERE id = $1",
        [room.id]
      );
      const freshRoom = freshRoomRes.rows[0];

      if (!freshRoom.current_player_id && !freshRoom.round_over) {
        await advanceTurn(room.id);
      }

      const state = await getState(room.id);
      io.to(code).emit("stateUpdate", state);
    } catch (err) {
      console.error("joinRoom error:", err);
    }
  });

  /**
   * Draw card:
   *  - Only allowed if:
   *      * Not paused
   *      * No pending action
   *      * Not round_over
   *      * It's this player's turn
   *  - On first draw, room.locked is set TRUE (no new players)
   *  - Uses drawCardForPlayer to apply rules
   *  - Then advances turn (unless bust/stay logic changed it)
   */
  socket.on("drawCard", async ({ roomCode, playerId }) => {
    try {
      const code = String(roomCode || "").trim().toUpperCase();
      const roomRes = await pool.query(
        "SELECT * FROM rooms WHERE code = $1",
        [code]
      );
      if (!roomRes.rows.length) return;
      let room = roomRes.rows[0];

      // Refresh room state from DB to get latest flags
      const freshPlayers = await pool.query(
        `SELECT * FROM room_players
         WHERE room_id = $1 AND id = $2`,
        [room.id, playerId]
      );
      if (!freshPlayers.rows.length) return;

      const player = freshPlayers.rows[0];

      // Block if paused or round over
      if (room.paused || room.round_over) return;

      // Must be this player's turn
      if (room.current_player_id !== playerId) return;

      // If there's a pending action (Freeze/Swap/Take3/SecondChance) we can't draw
      if (room.pending_action_type) return;

      // Lock room on first draw (no new players after this)
      if (!room.locked) {
        await pool.query(
          "UPDATE rooms SET locked = TRUE WHERE id = $1",
          [room.id]
        );
      }

      // Ensure deck (first draw creates deck + shuffles)
      await ensureDeck(room.id);

      // Perform draw with full rules
      await drawCardForPlayer(room, playerId);

      // Reload room (pendingAction might have changed)
      const updatedRoomRes = await pool.query(
        "SELECT * FROM rooms WHERE id = $1",
        [room.id]
      );
      room = updatedRoomRes.rows[0];

      // If a pending action was created (Freeze/Swap/Take3/SecondChance),
      // we do NOT advance the turn yet; the action must be resolved first.
      if (!room.pending_action_type) {
        // Check if this player got marked stayed (bust or manual stay)
        const p2 = await pool.query(
          "SELECT stayed FROM room_players WHERE id = $1",
          [playerId]
        );
        const stayed = p2.rows[0].stayed;
        if (!stayed) {
          await advanceTurn(room.id);
        }
      }

      const state = await getState(room.id);
      io.to(code).emit("stateUpdate", state);
    } catch (err) {
      console.error("drawCard error:", err);
    }
  });

  /**
   * Stay:
   *  - Player chooses to stop drawing
   *  - Only allowed if:
   *      * Not paused
   *      * No pending action
   *      * It's their turn
   */
  socket.on("stay", async ({ roomCode, playerId }) => {
    try {
      const code = String(roomCode || "").trim().toUpperCase();
      const roomRes = await pool.query(
        "SELECT * FROM rooms WHERE code = $1",
        [code]
      );
      if (!roomRes.rows.length) return;
      const room = roomRes.rows[0];

      if (room.paused || room.round_over) return;
      if (room.current_player_id !== playerId) return;
      if (room.pending_action_type) return;

      // Mark player as stayed
      await pool.query(
        `UPDATE room_players
         SET stayed = TRUE
         WHERE id = $1 AND room_id = $2`,
        [playerId, room.id]
      );

      // Check if all active players have stayed
      const pRes = await pool.query(
        `SELECT stayed, active FROM room_players
         WHERE room_id = $1`,
        [room.id]
      );
      const allStayed = pRes.rows
        .filter(p => p.active)
        .every(p => p.stayed);

      if (allStayed) {
        await pool.query(
          "UPDATE rooms SET round_over = TRUE WHERE id = $1",
          [room.id]
        );
      } else {
        await advanceTurn(room.id);
      }

      const state = await getState(room.id);
      io.to(code).emit("stateUpdate", state);
    } catch (err) {
      console.error("stay error:", err);
    }
  });

  /**
   * End Round:
   *  - Only allowed if round_over = TRUE
   *  - Applies scoring, discards, sets up next round
   */
  socket.on("endRound", async ({ roomCode }) => {
    try {
      const code = String(roomCode || "").trim().toUpperCase();
      const roomRes = await pool.query(
        "SELECT * FROM rooms WHERE code = $1",
        [code]
      );
      if (!roomRes.rows.length) return;
      const room = roomRes.rows[0];

      if (!room.round_over) return;
      if (room.paused) return;

      await endRound(room.id);
      const state = await getState(room.id);
      io.to(code).emit("stateUpdate", state);
    } catch (err) {
      console.error("endRound error:", err);
    }
  });

  /**
   * Remove Player (Admin/Host control):
   *  - Marks player inactive + stayed
   *  - If game is paused due to this player disconnecting, may unpause
   *  - If removed player is current_player → advance turn
   */
  socket.on("removePlayer", async ({ roomCode, name }) => {
    try {
      const code = String(roomCode || "").trim().toUpperCase();
      const roomRes = await pool.query(
        "SELECT * FROM rooms WHERE code = $1",
        [code]
      );
      if (!roomRes.rows.length) return;
      const room = roomRes.rows[0];

      const pRes = await pool.query(
        `SELECT * FROM room_players
         WHERE room_id = $1 AND LOWER(name) = LOWER($2)`,
        [room.id, name]
      );
      if (!pRes.rows.length) return;

      const player = pRes.rows[0];

      // Mark player as inactive and stayed
      await pool.query(
        `UPDATE room_players
         SET active = FALSE,
             stayed = TRUE
         WHERE id = $1`,
        [player.id]
      );

      // If they had cards, keep them in hand until end round (your rules discard all at end)
      // Recompute pause state (might unpause if they were disconnected)
      await recomputePause(room.id);

      // If removed player was current player, advance turn
      const freshRoomRes = await pool.query(
        "SELECT * FROM rooms WHERE id = $1",
        [room.id]
      );
      const freshRoom = freshRoomRes.rows[0];

      if (freshRoom.current_player_id === player.id && !freshRoom.round_over) {
        await advanceTurn(room.id);
      }

      const state = await getState(room.id);
      io.to(code).emit("stateUpdate", state);
    } catch (err) {
      console.error("removePlayer error:", err);
    }
  });

  /**
   * Resolve Second Chance:
   *  - Client tells server whether to use Second Chance or not
   *  - If use:
   *      * Remove drawn duplicate card from hand
   *      * Remove one Second Chance from hand
   *      * Add both to discard
   *      * No bust
   *  - If not:
   *      * Mark player bust (round_bust = TRUE, stayed = TRUE)
   */
  socket.on("resolveSecondChance", async ({ roomCode, playerId, use }) => {
    try {
      const code = String(roomCode || "").trim().toUpperCase();
      const roomRes = await pool.query(
        "SELECT * FROM rooms WHERE code = $1",
        [code]
      );
      if (!roomRes.rows.length) return;
      const room = roomRes.rows[0];

      if (room.paused) return;
      if (room.pending_action_type !== "SecondChance") return;
      if (room.pending_action_actor_id !== playerId) return;

      const drawnValue = room.pending_action_value; // duplicate number card

      const roomId = room.id;

      if (use) {
        // Remove one drawn card of that value and one Second Chance, then discard both
        await removeFromHand(roomId, playerId, drawnValue);
        await removeFromHand(roomId, playerId, "Second Chance");
        await addToDiscard(roomId, drawnValue);
        await addToDiscard(roomId, "Second Chance");
      } else {
        // Bust: player stays and gets round score = 0
        await pool.query(
          `UPDATE room_players
           SET stayed = TRUE, round_bust = TRUE
           WHERE id = $1 AND room_id = $2`,
          [playerId, roomId]
        );
      }

      // Clear pending action
      await pool.query(
        `UPDATE rooms
         SET pending_action_type = NULL,
             pending_action_actor_id = NULL,
             pending_action_value = NULL
         WHERE id = $1`,
        [roomId]
      );

      // If player did NOT bust, we still need to advance turn
      if (!use) {
        // Already stayed due to bust; do NOT advance from them if round might end
        // We'll rely on the next draw/stay or round end logic.
      } else {
        // If they haven't stayed, advance turn
        const pRes = await pool.query(
          `SELECT stayed FROM room_players
           WHERE id = $1`,
          [playerId]
        );
        if (!pRes.rows[0].stayed && !room.round_over) {
          await advanceTurn(roomId);
        }
      }

      const state = await getState(roomId);
      io.to(code).emit("stateUpdate", state);
    } catch (err) {
      console.error("resolveSecondChance error:", err);
    }
  });

  /**
   * Resolve action target:
   *  - For Freeze, Swap, Take3
   *  - Client sends: roomCode, playerId (actor), action, targetId
   *
   * Rules:
   *  - Only pending_action_actor can resolve
   *  - Action card remains in actor's hand until resolved
   *  - When resolving:
   *      * Freeze: target.stayed = TRUE
   *      * Swap: swap full hands (actor <-> target)
   *      * Take3: target draws 3 cards (forced)
   *  - Action card then moves to discard
   */
  socket.on("actionTarget", async ({ roomCode, playerId, action, targetId }) => {
    try {
      const code = String(roomCode || "").trim().toUpperCase();
      const roomRes = await pool.query(
        "SELECT * FROM rooms WHERE code = $1",
        [code]
      );
      if (!roomRes.rows.length) return;
      const room = roomRes.rows[0];
      const roomId = room.id;

      if (room.paused) return;
      if (!room.pending_action_type) return;
      if (room.pending_action_actor_id !== playerId) return;

      const actionType = room.pending_action_type;

      // Validate target
      const targetRes = await pool.query(
        `SELECT * FROM room_players
         WHERE id = $1 AND room_id = $2`,
        [targetId, roomId]
      );
      if (!targetRes.rows.length) return;
      const target = targetRes.rows[0];

      // Freeze: target becomes stayed
      if (actionType === "Freeze") {
        await pool.query(
          `UPDATE room_players
           SET stayed = TRUE
           WHERE id = $1 AND room_id = $2`,
          [targetId, roomId]
        );
      }

      // Swap: swap full hands between actor and target (self allowed)
      if (actionType === "Swap") {
        // Get all cards for actor and target
        const handsRes = await pool.query(
          `SELECT id, player_id, value, position
           FROM player_hands
           WHERE room_id = $1 AND player_id IN ($2, $3)
           ORDER BY position`,
          [roomId, playerId, targetId]
        );

        const actorCards = handsRes.rows.filter(h => h.player_id === playerId);
        const targetCards = handsRes.rows.filter(h => h.player_id === targetId);

        // Remove all their cards
        await pool.query(
          `DELETE FROM player_hands
           WHERE room_id = $1 AND player_id IN ($2, $3)`,
          [roomId, playerId, targetId]
        );

        // Insert target's old cards to actor
        for (const c of targetCards) {
          await addToHand(roomId, playerId, c.value);
        }

        // Insert actor's old cards to target
        for (const c of actorCards) {
          await addToHand(roomId, targetId, c.value);
        }
      }

      // Take3: target draws 3 cards
      if (actionType === "Take3") {
        for (let i = 0; i < 3; i++) {
          const updatedRoomRes = await pool.query(
            "SELECT * FROM rooms WHERE id = $1",
            [roomId]
          );
          const r = updatedRoomRes.rows[0];
          await drawCardForPlayer(r, targetId);
        }
      }

      // Remove one copy of the action card from actor's hand and discard it
      let cardValueToDiscard = null;
      if (actionType === "Freeze") cardValueToDiscard = "Freeze";
      if (actionType === "Swap") cardValueToDiscard = "Swap";
      if (actionType === "Take3") cardValueToDiscard = "Take 3";

      if (cardValueToDiscard) {
        await removeFromHand(roomId, playerId, cardValueToDiscard);
        await addToDiscard(roomId, cardValueToDiscard);
      }

      // Clear pending action
      await pool.query(
        `UPDATE rooms
         SET pending_action_type = NULL,
             pending_action_actor_id = NULL,
             pending_action_value = NULL
         WHERE id = $1`,
        [roomId]
      );

      // After resolving action, advance turn if round not over
      const freshRoomRes = await pool.query(
        "SELECT * FROM rooms WHERE id = $1",
        [roomId]
      );
      const freshRoom = freshRoomRes.rows[0];
      if (!freshRoom.round_over) {
        await advanceTurn(roomId);
      }

      const state = await getState(roomId);
      io.to(code).emit("stateUpdate", state);
    } catch (err) {
      console.error("actionTarget error:", err);
    }
  });

  /**
   * Socket disconnect:
   *  - Find which player this socket belonged to
   *  - Mark connected = FALSE
   *  - Recompute pause (Option B: ANY disconnected → paused = TRUE)
   */
  socket.on("disconnect", async () => {
    try {
      console.log("Client disconnected:", socket.id);

      const playerRes = await pool.query(
        `SELECT id, room_id FROM room_players
         WHERE socket_id = $1`,
        [socket.id]
      );
      if (!playerRes.rows.length) return;

      const player = playerRes.rows[0];

      // Mark them disconnected
      await pool.query(
        `UPDATE room_players
         SET connected = FALSE, socket_id = NULL
         WHERE id = $1`,
        [player.id]
      );

      // Recompute paused state for that room
      await recomputePause(player.room_id);

      // Broadcast new state
      const roomRes = await pool.query(
        "SELECT code FROM rooms WHERE id = $1",
        [player.room_id]
      );
      if (!roomRes.rows.length) return;

      const code = roomRes.rows[0].code;
      const state = await getState(player.room_id);
      io.to(code).emit("stateUpdate", state);
    } catch (err) {
      console.error("disconnect handling error:", err);
    }
  });
});

/**
 * ============================================================
 * START SERVER
 * ============================================================
 */

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log("Flip‑to‑6 server running on port " + PORT);
});






