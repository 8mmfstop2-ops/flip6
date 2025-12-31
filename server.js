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
 *      * Take 3 (choose target → target draws 3, can be self)
 *  - Bust rule:
 *      * Duplicate number with no Second Chance → bust → stayed + round score = 0
 *  - Game pause:
 *      * If ANY player disconnects → game paused
 *      * Resume when all disconnected players rejoin or are removed
 *  - Reconnect:
 *      * Players rejoin by same name + room code, keep seat + cards + state
 *  - Socket.io real-time updates
 *  - Card metadata endpoint for PNGs
 *  - UPDATED TURN FLOW:
 *      * Draw does NOT auto-advance
 *      * After draw/action, player chooses Stay or new Pass button
 *      * Bust auto-advances turn
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
 * DATABASE INIT (with unique index for player names)
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
        pending_action_value TEXT,
        round_starter_id INTEGER
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

    // 🔥 NEW: Unique index to prevent duplicate names in same room
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS unique_active_name_per_room
      ON room_players (room_id, LOWER(name))
      WHERE active = TRUE;
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
        player_id INT NOT NULL,
        position BIGINT NOT NULL,
        value TEXT NOT NULL
      );
    `);

    // Round scores
    await pool.query(`
      CREATE TABLE IF NOT EXISTS round_scores (
        id SERIAL PRIMARY KEY,
        room_id INT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        player_id INT NOT NULL,
        round_number INT NOT NULL,
        score INT NOT NULL
      );
    `);

    console.log("Flip‑to‑6 database tables initialized.");
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
async function advanceTurn(roomId, options = {}) {
  const { forceCurrent = false } = options;

  // Load room
  const roomRes = await pool.query(
    `SELECT current_player_id FROM rooms WHERE id = $1`,
    [roomId]
  );
  const room = roomRes.rows[0];

  // If we already set the starting player for the round, do NOT rotate
  if (forceCurrent && room.current_player_id) {
    return;
  }

  // Load active, not-stayed players in turn order
  const playersRes = await pool.query(
    `SELECT id, stayed, round_bust
     FROM room_players
     WHERE room_id = $1 AND active = TRUE
     ORDER BY order_index ASC`,
    [roomId]
  );

  const candidates = playersRes.rows.filter(p => !p.stayed && !p.round_bust);
  const players = candidates.map(p => p.id);

  // If no candidates left, mark round over and stop
  if (players.length === 0) {
    await pool.query(
      `UPDATE rooms
       SET round_over = TRUE,
           current_player_id = NULL
       WHERE id = $1`,
      [roomId]
    );
    return;
  }

  // If no current player, start with first
  if (!room.current_player_id) {
    await pool.query(
      `UPDATE rooms SET current_player_id = $1 WHERE id = $2`,
      [players[0], roomId]
    );
    return;
  }

  // Find current player index in the full active list
  const currentIdx = players.indexOf(room.current_player_id);

  // If current player not eligible or not found, reset to first
  if (currentIdx === -1) {
    await pool.query(
      `UPDATE rooms SET current_player_id = $1 WHERE id = $2`,
      [players[0], roomId]
    );
    return;
  }

  // Rotate to next eligible player
  const nextIndex = (currentIdx + 1) % players.length;

  await pool.query(
    `UPDATE rooms SET current_player_id = $1 WHERE id = $2`,
    [players[nextIndex], roomId]
  );
}



/**
 * ============================================================
 * SCORING
 * ============================================================
 */

// Compute score from a player's hand, considering 2x, 4+, 5+, 6‑
// Note: bust rule is handled separately via round_bust flag
// NOTE: You can later extend this to add the "6 cards in hand = +15" bonus.
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


async function getNextStartingPlayer(roomId) {
  // Load room to get the last starter (current_player_id from the round that just ended)
  const roomRes = await pool.query(
    `SELECT current_player_id FROM rooms WHERE id = $1`,
    [roomId]
  );
  const lastStarterId = roomRes.rows[0]?.current_player_id || null;

  // Load active players in seat/turn order
  const playersRes = await pool.query(
    `SELECT id
     FROM room_players
     WHERE room_id = $1 AND active = TRUE
     ORDER BY order_index ASC`,
    [roomId]
  );

  const players = playersRes.rows.map(r => r.id);

  if (players.length === 0) return null;

  // If no last starter, default to first player
  if (!lastStarterId) return players[0];

  const index = players.indexOf(lastStarterId);

  // If last starter not found (e.g. removed), default to first
  if (index === -1) return players[0];

  // Rotate to next player
  const nextIndex = (index + 1) % players.length;
  return players[nextIndex];
}



// End of round: compute scores, move all cards to discard, reset round state
async function endRound(roomId) {
  // Get current round number
  const roomRes = await pool.query(
    "SELECT round_number, current_player_id FROM rooms WHERE id = $1",
    [roomId]
  );
  const room = roomRes.rows[0];
  const round = room.round_number;

  // Load players in turn order
  const playersRes = await pool.query(
    `SELECT id, round_bust
     FROM room_players
     WHERE room_id = $1 AND active = TRUE
     ORDER BY order_index`,
    [roomId]
  );

  // Score each player
  for (const p of playersRes.rows) {
    const pid = p.id;
    let score = 0;

    if (!p.round_bust) {
      score = await computeScore(roomId, pid);

      // 6-card bonus
      const countRes = await pool.query(
        `SELECT COUNT(*) FROM player_hands
         WHERE room_id = $1 AND player_id = $2`,
        [roomId, pid]
      );
      const cardCount = parseInt(countRes.rows[0].count, 10);
      if (cardCount >= 6) {
        score += 15;
      }
    }

    // Insert round score
    await pool.query(
      `INSERT INTO round_scores (room_id, player_id, round_number, score)
       VALUES ($1, $2, $3, $4)`,
      [roomId, pid, round, score]
    );

    // Update total score
    await pool.query(
      "UPDATE room_players SET total_score = total_score + $1 WHERE id = $2",
      [score, pid]
    );

    // Move cards to discard
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

  // Advance round number and reset round state
  await pool.query(
    `UPDATE rooms
     SET round_number = round_number + 1,
         round_over = FALSE,
         pending_action_type = NULL,
         pending_action_actor_id = NULL,
         pending_action_value = NULL
     WHERE id = $1`,
    [roomId]
  );

  // Ensure new deck for next round
  await ensureDeck(roomId);

  // Determine next round's starting player
  const nextStarter = await getNextStartingPlayer(roomId);

  // Set next starter
   await pool.query(
     `UPDATE rooms
      SET current_player_id = $1,
          round_starter_id = $1
      WHERE id = $2`,
     [nextStarter, roomId]
   );


  // Begin next round with the chosen starter
  await advanceTurn(roomId, { forceCurrent: true });
}


/**
 * ============================================================
 * STATE PACKING FOR CLIENT
 * ============================================================
 */
async function getState(roomId) {
  const roomRes = await pool.query(
    "SELECT * FROM rooms WHERE id = $1",
    [roomId]
  );
  if (!roomRes.rows.length) return null;
  const room = roomRes.rows[0];

  const playersRes = await pool.query(
    `SELECT id, name, order_index, active, stayed, total_score, connected, round_bust
     FROM room_players
     WHERE room_id = $1
     ORDER BY order_index ASC`,
    [roomId]
  );

  const handsRes = await pool.query(
    `SELECT player_id, value
     FROM player_hands
     WHERE room_id = $1
     ORDER BY position ASC`,
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

  // fetch top discard card
  const topDiscardRes = await pool.query(
    `SELECT value FROM discard_pile
     WHERE room_id = $1
     ORDER BY position DESC
     LIMIT 1`,
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
    roundStarterId: room.round_starter_id,

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

    // client can show the discard pile
    topDiscardCard: topDiscardRes.rows.length ? topDiscardRes.rows[0].value : null,

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
 * - It does NOT advance the turn. Caller decides whether/when to advance.
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

   // 🔒 Lock the room once someone actually draws a card 
   await pool.query( `UPDATE rooms SET locked = TRUE WHERE id = $1 AND locked = FALSE`, [roomId] );
   
  const value = await popTopCard(roomId);
  if (!value) return; // no cards at all (rare edge case)

  const isNumber = /^(?:[0-9]|1[0-2])$/.test(value);
  const scoring = ["2x", "4+", "5+", "6-"];
  const instant = ["Freeze", "Swap", "Take 3"];

  // 1) Numeric card
  if (isNumber) {
    // Add to hand
    await addToHand(roomId, playerId, value);

    // Check duplicate (after adding)
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
    // Action card must appear in hand until resolved
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
    const code = String(roomCode || "").trim().toUpperCase();
    const cleanName = String(name || "").trim();

    if (!cleanName || !code) {
      return res.status(400).json({ error: "Missing name or room code." });
    }

    // Load room
    const roomRes = await pool.query(
      "SELECT * FROM rooms WHERE code = $1",
      [code]
    );

    let room;
    if (!roomRes.rows.length) {
      // Create new room automatically
      const createRes = await pool.query(
        `INSERT INTO rooms (code, locked, round_number, round_over, paused)
         VALUES ($1, FALSE, 1, FALSE, FALSE)
         RETURNING *`,
        [code]
      );
      room = createRes.rows[0];
    } else {
      room = roomRes.rows[0];
    }

    // CASE‑INSENSITIVE duplicate name check
    const dupRes = await pool.query(
      `SELECT player_id, connected
       FROM room_players
       WHERE room_id = $1
         AND LOWER(name) = LOWER($2)
         AND active = TRUE`,
      [room.id, cleanName]
    );

    let playerId;

    if (dupRes.rows.length > 0) {
      const existing = dupRes.rows[0];

      // If already connected → reject
      if (existing.connected) {
        return res.status(400).json({
          error: "A player by that name is already in the room."
        });
      }

      // Rejoin: reuse existing playerId
      playerId = existing.player_id;

    } else {
      // No existing player with that name
      // If room is locked → no new players allowed
      if (room.locked) {
        return res.status(400).json({
          error: "This room is locked. Only existing players can rejoin."
        });
      }

      // Create new player
      const insertRes = await pool.query(
        `
        INSERT INTO room_players (room_id, player_id, name, order_index, active, connected)
        VALUES (
          $1,
          COALESCE(
            (SELECT MAX(player_id) + 1 FROM room_players WHERE room_id = $1),
            1
          ),
          $2,
          COALESCE(
            (SELECT MAX(order_index) + 1 FROM room_players WHERE room_id = $1),
            0
          ),
          TRUE,
          FALSE
        )
        RETURNING player_id
        `,
        [room.id, cleanName]
      );
      playerId = insertRes.rows[0].player_id;
    }

    // Redirect to game table
    return res.json({
      redirect: `/room/${code}?playerId=${playerId}`
    });

  } catch (err) {
    console.error("JOIN ERROR:", err);

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

  // -----------------------------
  // JOIN ROOM
  // -----------------------------
  socket.on("joinRoom", async ({ roomCode, playerId }) => {
    try {
      const code = String(roomCode || "").trim().toUpperCase();

      // Load room
      const roomRes = await pool.query(
        "SELECT * FROM rooms WHERE code = $1",
        [code]
      );
      if (!roomRes.rows.length) return;
      const room = roomRes.rows[0];

      // Load player
      const playerRes = await pool.query(
        `SELECT * FROM room_players
         WHERE player_id = $1 AND room_id = $2 AND active = TRUE`,
        [playerId, room.id]
      );
      if (!playerRes.rows.length) return;

      const player = playerRes.rows[0];

      // Duplicate login check
      if (player.connected && player.socket_id && player.socket_id !== socket.id) {
        socket.emit("joinError", {
          message: "This player is already signed in on another device."
        });
        return;
      }

      // Mark player as connected
      await pool.query(
        `UPDATE room_players
         SET socket_id = $1, connected = TRUE
         WHERE player_id = $2 AND room_id = $3`,
        [socket.id, playerId, room.id]
      );

      await recomputePause(room.id);

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

  // -----------------------------
  // DRAW CARD
  // -----------------------------
  socket.on("drawCard", async ({ roomCode, playerId }) => {
    try {
      const code = String(roomCode || "").trim().toUpperCase();

      const roomRes = await pool.query(
        "SELECT * FROM rooms WHERE code = $1",
        [code]
      );
      if (!roomRes.rows.length) return;
      const room = roomRes.rows[0];

      // Get current state to validate turn
      const state = await getState(room.id);
      if (!state) return;

      const isMyTurn =
        state.currentPlayerId === playerId &&
        !state.roundOver &&
        !state.paused &&
        !state.pendingActionType;

      // Allow draw only if it's your turn
      if (!isMyTurn) return;

      await drawCardForPlayer(room, playerId);

      // After draw, DO NOT auto-advance; player will choose Stay or Pass
      const newState = await getState(room.id);
      io.to(code).emit("stateUpdate", newState);

    } catch (err) {
      console.error("drawCard error:", err);
    }
  });

  // -----------------------------
  // STAY
  // -----------------------------
  socket.on("stay", async ({ roomCode, playerId }) => {
    try {
      const code = String(roomCode || "").trim().toUpperCase();

      const roomRes = await pool.query(
        "SELECT * FROM rooms WHERE code = $1",
        [code]
      );
      if (!roomRes.rows.length) return;
      const room = roomRes.rows[0];

      const state = await getState(room.id);
      if (!state) return;

      const isMyTurn =
        state.currentPlayerId === playerId &&
        !state.roundOver &&
        !state.paused &&
        !state.pendingActionType;

      if (!isMyTurn) return;

      // Mark stayed
      await pool.query(
        `UPDATE room_players
         SET stayed = TRUE
         WHERE id = $1 AND room_id = $2`,
        [playerId, room.id]
      );

      // Advance to next player
      await advanceTurn(room.id);

      const newState = await getState(room.id);
      io.to(code).emit("stateUpdate", newState);

    } catch (err) {
      console.error("stay error:", err);
    }
  });

  // -----------------------------
  // PASS (no stay, just next player)
  // -----------------------------
  socket.on("pass", async ({ roomCode, playerId }) => {
    try {
      const code = String(roomCode || "").trim().toUpperCase();

      const roomRes = await pool.query(
        "SELECT * FROM rooms WHERE code = $1",
        [code]
      );
      if (!roomRes.rows.length) return;
      const room = roomRes.rows[0];

      const state = await getState(room.id);
      if (!state) return;

      const isMyTurn =
        state.currentPlayerId === playerId &&
        !state.roundOver &&
        !state.paused &&
        !state.pendingActionType;

      if (!isMyTurn) return;

      // Do NOT mark stayed, just advance
      await advanceTurn(room.id);

      const newState = await getState(room.id);
      io.to(code).emit("stateUpdate", newState);

    } catch (err) {
      console.error("pass error:", err);
    }
  });

  // -----------------------------
  // END ROUND
  // -----------------------------
  socket.on("endRound", async ({ roomCode }) => {
    try {
      const code = String(roomCode || "").trim().toUpperCase();

      const roomRes = await pool.query(
        "SELECT * FROM rooms WHERE code = $1",
        [code]
      );
      if (!roomRes.rows.length) return;
      const room = roomRes.rows[0];

      const state = await getState(room.id);
      if (!state || !state.roundOver) return;

      await endRound(room.id);

      const newState = await getState(room.id);
      io.to(code).emit("stateUpdate", newState);

    } catch (err) {
      console.error("endRound error:", err);
    }
  });

  // -----------------------------
  // ACTION TARGET (Freeze, Swap, Take 3)
  // -----------------------------
  socket.on("actionTarget", async ({ roomCode, playerId, action, targetId }) => {
    try {
      const code = String(roomCode || "").trim().toUpperCase();

      const roomRes = await pool.query(
        "SELECT * FROM rooms WHERE code = $1",
        [code]
      );
      if (!roomRes.rows.length) return;
      const room = roomRes.rows[0];

      const state = await getState(room.id);
      if (!state) return;

      if (!state.pendingActionType || state.pendingActionActorId !== playerId) {
        return;
      }

      // Action-specific logic here. You already have helpers for hands,
      // draw, discard, etc. Just sketching:

      if (action === "Freeze") {
        // Target auto-stays
        await pool.query(
          `UPDATE room_players
           SET stayed = TRUE
           WHERE id = $1 AND room_id = $2`,
          [targetId, room.id]
        );
      }

      if (action === "Swap") {
        // Swap hands between playerId and targetId
        await pool.query(
          `UPDATE player_hands
           SET player_id = CASE
             WHEN player_id = $1 THEN $2
             WHEN player_id = $2 THEN $1
             ELSE player_id
           END
           WHERE room_id = $3 AND player_id IN ($1, $2)`,
          [playerId, targetId, room.id]
        );
      }

      if (action === "Take3") {
        // Target draws 3 cards
        for (let i = 0; i < 3; i++) {
          await drawCardForPlayer(room, targetId);
        }
      }
      
      // remove action card from hand and discard it
      await removeFromHand(room.id, playerId, state.pendingActionValue);
      await addToDiscard(room.id, state.pendingActionValue);
      
      // Clear pending action
      await pool.query(
        `UPDATE rooms
         SET pending_action_type = NULL,
             pending_action_actor_id = NULL,
             pending_action_value = NULL
         WHERE id = $1`,
        [room.id]
      );

      const newState = await getState(room.id);
      io.to(code).emit("stateUpdate", newState);

    } catch (err) {
      console.error("actionTarget error:", err);
    }
  });

  // -----------------------------
  // REMOVE PLAYER (admin control)
  // -----------------------------
  socket.on("removePlayer", async ({ roomCode, name }) => {
    try {
      const code = String(roomCode || "").trim().toUpperCase();
      const cleanName = String(name || "").trim();

      const roomRes = await pool.query(
        "SELECT * FROM rooms WHERE code = $1",
        [code]
      );
      if (!roomRes.rows.length) return;
      const room = roomRes.rows[0];

      await pool.query(
        `UPDATE room_players
         SET active = FALSE
         WHERE room_id = $1 AND LOWER(name) = LOWER($2)`,
        [room.id, cleanName]
      );

      const newState = await getState(room.id);
      io.to(code).emit("stateUpdate", newState);

    } catch (err) {
      console.error("removePlayer error:", err);
    }
  });

  // -----------------------------
  // DISCONNECT
  // -----------------------------
  socket.on("disconnect", async () => {
    try {
      // Mark disconnected and recompute pause
      const res = await pool.query(
        `UPDATE room_players
         SET connected = FALSE, socket_id = NULL
         WHERE socket_id = $1
         RETURNING room_id`,
        [socket.id]
      );

      if (res.rows.length > 0) {
        const roomId = res.rows[0].room_id;
        await recomputePause(roomId);

        // Send updated state to that room
        const roomRes = await pool.query(
          "SELECT code FROM rooms WHERE id = $1",
          [roomId]
        );
        if (roomRes.rows.length) {
          const code = roomRes.rows[0].code;
          const newState = await getState(roomId);
          io.to(code).emit("stateUpdate", newState);
        }
      }
    } catch (err) {
      console.error("disconnect cleanup error:", err);
    }
  });

});

const PORT = process.env.PORT || 3000; 
server.listen(PORT, () => console.log("Server running on port", PORT));






