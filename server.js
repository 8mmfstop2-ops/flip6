/********************************************************************************************
 *  Flip‑to‑6 — FULL MULTIPLAYER GAME SERVER
 *  -----------------------------------------------------------------------------------------
 *  SECTION 1 — IMPORTS & SERVER SETUP
 *
 *  This section initializes:
 *    - Express (HTTP server framework)
 *    - HTTP server wrapper (required for Socket.IO)
 *    - Socket.IO (real‑time communication)
 *    - PostgreSQL connection pool
 *    - Static file hosting
 *    - JSON body parsing
 *
 *  No game logic lives here — it just prepares the environment for everything else.
 ********************************************************************************************/

// Core server libraries
const express = require("express");
const http = require("http");
const path = require("path");
const bodyParser = require("body-parser");

// PostgreSQL connection pool
const { Pool } = require("pg");

// Socket.IO for real‑time multiplayer communication
const { Server } = require("socket.io");

// Create the Express app
const app = express();

// Wrap Express in an HTTP server (Socket.IO requires this)
const server = http.createServer(app);

// Attach Socket.IO to the HTTP server
const io = new Server(server);

// Parse JSON request bodies
app.use(bodyParser.json());

// Serve static files from /public (table.html, JS, CSS, images)
app.use(express.static(path.join(__dirname, "public")));

// Serve the main game table page when a player visits /room/<code>
app.get("/room/:code", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "table.html"));
});

// PostgreSQL connection (Heroku‑style SSL enabled)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/********************************************************************************************
 *  SECTION 2 — DATABASE INITIALIZATION
 *  -----------------------------------------------------------------------------------------
 *  This section creates all database tables the game needs.
 *
 *  WHY:
 *    - Rooms must survive refreshes
 *    - Player seats must persist
 *    - Decks, discard piles, and hands must be stored
 *    - Rounds and scores must be saved
 *
 *  HOW:
 *    - Runs on server startup
 *    - Uses CREATE TABLE IF NOT EXISTS (safe on fresh DBs)
 *    - Also creates a unique index for active player names per room
 ********************************************************************************************/

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

    // Players (player_id is per-room logical id, not row id)
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

    // Unique active name per room (case-insensitive)
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

    // Player hands (uses player_id, NOT row id)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS player_hands (
        id SERIAL PRIMARY KEY,
        room_id INT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        player_id INT NOT NULL,
        position BIGINT NOT NULL,
        value TEXT NOT NULL
      );
    `);

    // Round scores (uses player_id)
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

/********************************************************************************************
 *  SECTION 3 — SHUFFLING & DECK LOGIC
 *  -----------------------------------------------------------------------------------------
 *  This section covers:
 *    - Fisher–Yates shuffle
 *    - Detecting numeric vs action cards
 *    - Forcing numeric streaks (Flip‑7‑style)
 *    - Adaptive action-card distribution
 *    - Deck creation for each room
 *    - Reshuffling discard pile when deck is empty
 ********************************************************************************************/

/**
 * Standard Fisher–Yates shuffle (unbiased).
 */
function fisherYates(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
}

/**
 * Returns TRUE if the card is NOT a number (0–12).
 */
function isAction(value) {
  return !/^(?:[0-9]|1[0-2])$/.test(value);
}

/**
 * Attempts to create a streak of identical numeric cards
 * in the numeric portion of the deck.
 */
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
      const idx = deck.findIndex(
        (c, idx2) => idx2 >= i + length && c.value === targetValue
      );

      if (idx !== -1) {
        [deck[i + length - 1], deck[idx]] = [deck[idx], deck[i + length - 1]];
        return true;
      }
    }
  }
  return false;
}

/**
 * Splits a deck into 4 zones for action insertion.
 */
function makeZones(deckSize) {
  return [
    [Math.floor(deckSize * 0.10), Math.floor(deckSize * 0.30)],
    [Math.floor(deckSize * 0.30), Math.floor(deckSize * 0.65)],
    [Math.floor(deckSize * 0.65), Math.floor(deckSize * 0.80)],
    [Math.floor(deckSize * 0.80), deckSize - 1]
  ];
}

/**
 * Inserts action cards into numeric deck using adaptive zones.
 */
function distributeActionsAdaptive(result, actionCards) {
  const deckSize = result.length;
  const zones = makeZones(deckSize);

  let actionIndex = 0;

  for (let z = 0; z < zones.length; z++) {
    if (actionIndex >= actionCards.length) break;

    const [minPos, maxPos] = zones[z];
    if (minPos >= maxPos) continue; // tiny deck safety

    const count = Math.min(
      Math.floor(Math.random() * 3) + 1,
      actionCards.length - actionIndex
    );

    const insertPos =
      Math.floor(Math.random() * (maxPos - minPos + 1)) + minPos;

    for (let i = 0; i < count; i++) {
      result.splice(insertPos, 0, actionCards[actionIndex++]);
    }
  }

  return result;
}

/**
 * Main hybrid shuffle:
 *   - Split numeric vs action
 *   - Shuffle numeric
 *   - Force streaks of numerics
 *   - Shuffle actions
 *   - Insert some actions into numeric deck
 */
function hybridShuffle(deck, streakLengths = [2, 3]) {
  const numberCards = [];
  const actionCards = [];

  for (const card of deck) {
    if (isAction(card.value)) actionCards.push(card);
    else numberCards.push(card);
  }

  fisherYates(numberCards);
  streakLengths.forEach(len => forceStreak(numberCards, len));

  fisherYates(actionCards);

  // Limit how many actions are used for deck pacing
  const actionsToUse = actionCards.slice(0, 14);

  let result = [...numberCards];
  result = distributeActionsAdaptive(result, actionsToUse);

  return result;
}

/**
 * Builds a fresh shuffled deck for a room if none exists.
 * Also clears discard pile + hands when rebuilding.
 */
async function ensureDeck(roomId) {
  const check = await pool.query(
    "SELECT COUNT(*) FROM draw_pile WHERE room_id = $1",
    [roomId]
  );
  if (parseInt(check.rows[0].count, 10) > 0) return;

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

/**
 * Draws the top card from the draw pile.
 * If draw pile is empty, reshuffles discard into draw using hybridShuffle.
 */
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

/********************************************************************************************
 *  SECTION 4 — HAND / DISCARD HELPERS
 *  -----------------------------------------------------------------------------------------
 *  These are low-level DB operations:
 *    - Add/remove from hand
 *    - Add to discard
 *    - Queries about Second Chance
 *
 *  All higher-level game rules (bust, pending actions, etc.) call into these.
 ********************************************************************************************/

/**
 * Adds a card to a player's hand (uses player_id).
 * position uses a timestamp to preserve draw order.
 */
async function addToHand(roomId, playerId, value) {
  await pool.query(
    `INSERT INTO player_hands (room_id, player_id, position, value)
     VALUES ($1, $2, EXTRACT(EPOCH FROM NOW())::BIGINT, $3)`,
    [roomId, playerId, value]
  );
}

/**
 * Removes one instance of a card from a player's hand (latest position first).
 */
async function removeFromHand(roomId, playerId, value) {
  const card = await pool.query(
    `SELECT id FROM player_hands
     WHERE room_id = $1 AND player_id = $2 AND value = $3
     ORDER BY position DESC
     LIMIT 1`,
    [roomId, playerId, value]
  );
  if (card.rows.length) {
    await pool.query("DELETE FROM player_hands WHERE id = $1", [
      card.rows[0].id
    ]);
  }
}

/**
 * Adds a card to the discard pile with a timestamp position.
 */
async function addToDiscard(roomId, value) {
  await pool.query(
    `INSERT INTO discard_pile (room_id, position, value)
     VALUES ($1, EXTRACT(EPOCH FROM NOW())::BIGINT, $2)`,
    [roomId, value]
  );
}

/**
 * Returns TRUE if the player currently holds a "Second Chance" card.
 */
async function playerHasSecondChance(roomId, playerId) {
  const res = await pool.query(
    "SELECT id FROM player_hands WHERE room_id = $1 AND player_id = $2 AND value = 'Second Chance'",
    [roomId, playerId]
  );
  return res.rows.length > 0;
}

/********************************************************************************************
 *  SECTION 5 — PAUSE / RECONNECT LOGIC
 *  -----------------------------------------------------------------------------------------
 *  Game should pause when any active player disconnects and unpause when all return.
 ********************************************************************************************/

/**
 * Recomputes paused state:
 *   - paused = TRUE if any active player is disconnected
 *   - paused = FALSE if all active players are connected
 */
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

/********************************************************************************************
 *  SECTION 6 — TURN ORDER & ROUND FLOW (USES player_id)
 *  -----------------------------------------------------------------------------------------
 *  Controls:
 *    - Which player is current
 *    - Rotation order
 *    - Skipping stayed/bust players
 *    - Detecting end-of-round
 ********************************************************************************************/

/**
 * Advances turn to the next eligible player.
 *
 * options.forceCurrent = true:
 *   - If current_player_id is already set, do NOT rotate (used after endRound).
 */
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

  // Load active, not-stayed, not-bust players in turn order (using player_id)
  const playersRes = await pool.query(
    `SELECT player_id, stayed, round_bust
     FROM room_players
     WHERE room_id = $1 AND active = TRUE
     ORDER BY order_index ASC`,
    [roomId]
  );

  const candidates = playersRes.rows.filter(
    p => !p.stayed && !p.round_bust
  );

  const players = candidates.map(p => p.player_id);

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

  // Find current player index (by player_id)
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

/********************************************************************************************
 *  SECTION 7 — SCORING & NEXT ROUND (USES player_id)
 *  -----------------------------------------------------------------------------------------
 *  Implements:
 *    - computeScore: per-hand score
 *    - getNextStartingPlayer: round starter rotation
 *    - endRound: full scoring + reset + next round setup
 ********************************************************************************************/

/**
 * Computes score for a player's hand.
 * Numeric cards add their value; action scoring cards adjust score.
 */
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

/**
 * Determines which player should start the next round.
 * Rotates through active players in order_index.
 */
async function getNextStartingPlayer(roomId) {
  const roomRes = await pool.query(
    `SELECT round_starter_id FROM rooms WHERE id = $1`,
    [roomId]
  );
  const lastStarterId = roomRes.rows[0]?.round_starter_id || null;

  const playersRes = await pool.query(
    `SELECT player_id
     FROM room_players
     WHERE room_id = $1 AND active = TRUE
     ORDER BY order_index ASC`,
    [roomId]
  );

  const players = playersRes.rows.map(r => r.player_id);
  if (players.length === 0) return null;

  if (!lastStarterId) return players[0];

  const index = players.indexOf(lastStarterId);
  if (index === -1) return players[0];

  const nextIndex = (index + 1) % players.length;
  return players[nextIndex];
}

/**
 * Ends the round:
 *   - Scores all active players (except busts)
 *   - Applies +15 bonus for 6+ cards in hand
 *   - Writes round_scores and updates total_score
 *   - Discards all hands
 *   - Resets stayed and round_bust
 *   - Advances round_number
 *   - Rebuilds deck
 *   - Sets next round starter and current player
 */
async function endRound(roomId) {
  const roomRes = await pool.query(
    "SELECT round_number, current_player_id FROM rooms WHERE id = $1",
    [roomId]
  );
  const room = roomRes.rows[0];
  const round = room.round_number;

  const playersRes = await pool.query(
    `SELECT player_id, round_bust
     FROM room_players
     WHERE room_id = $1 AND active = TRUE
     ORDER BY order_index`,
    [roomId]
  );

  for (const p of playersRes.rows) {
    const pid = p.player_id;
    let score = 0;

    if (!p.round_bust) {
      score = await computeScore(roomId, pid);

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

    await pool.query(
      `INSERT INTO round_scores (room_id, player_id, round_number, score)
       VALUES ($1, $2, $3, $4)`,
      [roomId, pid, round, score]
    );

    await pool.query(
      "UPDATE room_players SET total_score = total_score + $1 WHERE player_id = $2 AND room_id = $3",
      [score, pid, roomId]
    );

    const hand = await pool.query(
      "SELECT value FROM player_hands WHERE room_id = $1 AND player_id = $2",
      [roomId, pid]
    );
    for (const h of hand.rows) {
      await addToDiscard(roomId, h.value);
    }
  }

  await pool.query("DELETE FROM player_hands WHERE room_id = $1", [roomId]);

  await pool.query(
    "UPDATE room_players SET stayed = FALSE, round_bust = FALSE WHERE room_id = $1",
    [roomId]
  );

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

  await ensureDeck(roomId);

  const nextStarter = await getNextStartingPlayer(roomId);

  await pool.query(
    `UPDATE rooms
     SET current_player_id = $1,
         round_starter_id = $1
     WHERE id = $2`,
    [nextStarter, roomId]
  );

  await advanceTurn(roomId, { forceCurrent: true });
}

/********************************************************************************************
 *  SECTION 8 — STATE PACKING FOR CLIENT
 *  -----------------------------------------------------------------------------------------
 *  getState(roomId) builds a full snapshot for the UI:
 *    - Room data
 *    - Players
 *    - Hands
 *    - Deck/discard counts
 *    - Top discard & top few draw cards
 *    - Pending action info
 *    - Disconnected players
 ********************************************************************************************/

async function getState(roomId) {
  const roomRes = await pool.query(
    "SELECT * FROM rooms WHERE id = $1",
    [roomId]
  );
  if (!roomRes.rows.length) return null;
  const room = roomRes.rows[0];

  const playersRes = await pool.query(
    `SELECT player_id AS id, name, order_index, active, stayed, total_score, connected, round_bust
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

    topDiscardCard: topDiscardRes.rows.length
      ? topDiscardRes.rows[0].value
      : null,

    topDrawCards: topCardsRes.rows.map(r => r.value),

    disconnectedPlayers
  };
}

/********************************************************************************************
 *  SECTION 9 — DRAW CARD LOGIC (FULL RULES)
 *  -----------------------------------------------------------------------------------------
 *  drawCardForPlayer(room, playerId) implements:
 *    - Numeric draws & duplicate bust handling
 *    - Second Chance prompt (YES/NO)
 *    - Scoring card draws
 *    - Instant action cards (Freeze, Swap, Take 3)
 *    - Room locking on first draw
 *    - Respecting pending_action_type
 ********************************************************************************************/

async function drawCardForPlayer(room, playerId) {
  const roomId = room.id;

  // Always reload latest room state: the passed-in room can be stale.
  const freshRoomRes = await pool.query(
    "SELECT pending_action_type FROM rooms WHERE id = $1",
    [roomId]
  );
  const freshRoom = freshRoomRes.rows[0];

  // If ANY pending action exists (Freeze, Swap, Take3, SecondChancePrompt, etc.)
  // the player is NOT allowed to draw.
  if (freshRoom.pending_action_type) {
    return;
  }

  await ensureDeck(roomId);

  // Lock room on first draw
  await pool.query(
    `UPDATE rooms SET locked = TRUE WHERE id = $1 AND locked = FALSE`,
    [roomId]
  );

  const value = await popTopCard(roomId);
  if (!value) return;

  const isNumber = /^(?:[0-9]|1[0-2])$/.test(value);
  const scoring = ["2x", "4+", "5+", "6-"];
  const instant = ["Freeze", "Swap", "Take 3", "Take3"];

  // 1) Numeric
  if (isNumber) {
    await addToHand(roomId, playerId, value);

    const dupRes = await pool.query(
      `SELECT COUNT(*) FROM player_hands
       WHERE room_id = $1 AND player_id = $2 AND value = $3`,
      [roomId, playerId, value]
    );
    const count = parseInt(dupRes.rows[0].count, 10);
    const isTrueDuplicate = count > 1;

    if (isTrueDuplicate) {
      const hasSecondChance = await playerHasSecondChance(roomId, playerId);

      if (hasSecondChance) {
        // Second Chance should prompt YES/NO, not target selection
        await pool.query(
          `UPDATE rooms
           SET pending_action_type = 'SecondChancePrompt',
               pending_action_actor_id = $1,
               pending_action_value = $2
           WHERE id = $3`,
          [playerId, value, roomId]
        );
        return;
      } else {
        // Bust: mark this player as bust + stayed (by player_id)
        await pool.query(
          `UPDATE room_players
           SET stayed = TRUE, round_bust = TRUE
           WHERE player_id = $1 AND room_id = $2`,
          [playerId, roomId]
        );
        return;
      }
    }

    return;
  }

  // 2) Scoring cards
  if (scoring.includes(value)) {
    await addToHand(roomId, playerId, value);
    return;
  }

  // 3) Second Chance card (normal draw)
  if (value === "Second Chance") {
    await addToHand(roomId, playerId, value);
    return;
  }

  // 4) Action cards (Freeze, Swap, Take 3)
  if (instant.includes(value)) {
    await addToHand(roomId, playerId, value);

    let actionType;
    if (value === "Freeze") actionType = "Freeze";
    if (value === "Swap") actionType = "Swap";
    if (value === "Take 3" || value === "Take3") actionType = "Take3";

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

  // 5) Anything else → discard
  await addToDiscard(roomId, value);
}

/********************************************************************************************
 *  SECTION 10 — EXPRESS ROUTES (REST API)
 *  -----------------------------------------------------------------------------------------
 *  Handles:
 *    - /api/init-deck       (card_types seed)
 *    - /api/cards/meta      (card metadata)
 *    - /api/player/join     (create/join room, assign player_id)
 *    - /room/:code          (serves table.html)
 *    - /api/room/:code/draw-pile (debug)
 ********************************************************************************************/

// Initialize card_types with values/filenames/counts (run once)
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

    res.json({
      success: true,
      message: "Flip‑to‑6 deck definitions initialized."
    });
  } catch (err) {
    console.error("init-deck error:", err);
    res.status(500).json({ success: false, error: "Initialization failed." });
  }
});

// Card metadata for client
app.get("/api/cards/meta", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT value, filename FROM card_types ORDER BY value"
    );
    res.json({ success: true, cards: result.rows });
  } catch (err) {
    console.error("cards/meta error:", err);
    res
      .status(500)
      .json({ success: false, error: "Failed to load card metadata" });
  }
});

/**
 * Player join / rejoin:
 *   - Creates room if it doesn't exist
 *   - Enforces unique active names per room
 *   - Respects room.locked for new players
 *   - Allows reconnect for disconnected players
 */
app.post("/api/player/join", async (req, res) => {
  try {
    const { name, roomCode } = req.body;
    const code = String(roomCode || "").trim().toUpperCase();
    const cleanName = String(name || "").trim();

    if (!cleanName || !code) {
      return res
        .status(400)
        .json({ error: "Missing name or room code." });
    }

    const roomRes = await pool.query(
      "SELECT * FROM rooms WHERE code = $1",
      [code]
    );

    let room;
    if (!roomRes.rows.length) {
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

      if (existing.connected) {
        return res.status(400).json({
          error: "A player by that name is already in the room."
        });
      }

      playerId = existing.player_id;
    } else {
      if (room.locked) {
        return res.status(400).json({
          error: "This room is locked. Only existing players can rejoin."
        });
      }

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

// Debug route: view draw pile
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

/********************************************************************************************
 *  SECTION 11 — SOCKET.IO GAME LOGIC
 *  -----------------------------------------------------------------------------------------
 *  Handles all real-time events:
 *    - joinRoom
 *    - drawCard
 *    - stay
 *    - pass
 *    - endRound
 *    - actionTarget (Freeze/Swap/Take3)
 *    - secondChanceResponse (YES/NO)
 *    - removePlayer
 *    - disconnect
 ********************************************************************************************/

io.on("connection", socket => {
  console.log("Client connected:", socket.id);

  /**
   * JOIN ROOM (Socket)
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
         WHERE player_id = $1 AND room_id = $2 AND active = TRUE`,
        [playerId, room.id]
      );
      if (!playerRes.rows.length) return;

      const player = playerRes.rows[0];

      if (player.connected && player.socket_id && player.socket_id !== socket.id) {
        socket.emit("joinError", {
          message: "This player is already signed in on another device."
        });
        return;
      }

      await pool.query(
        `UPDATE room_players
         SET socket_id = $1, connected = TRUE
         WHERE player_id = $2 AND room_id = $3`,
        [socket.id, playerId, room.id]
      );

      await recomputePause(room.id);
      socket.join(code);

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
   * DRAW CARD
   *   - Only current player
   *   - Not paused
   *   - No pending_action_type
   */
  socket.on("drawCard", async ({ roomCode, playerId }) => {
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

      await drawCardForPlayer(room, playerId);

      const newState = await getState(room.id);
      io.to(code).emit("stateUpdate", newState);
    } catch (err) {
      console.error("drawCard error:", err);
    }
  });

  /**
   * STAY
   *   - Marks player stayed
   *   - Clears any pending action
   *   - Advances turn
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

      const state = await getState(room.id);
      if (!state) return;

      const isMyTurn =
        state.currentPlayerId === playerId &&
        !state.roundOver &&
        !state.paused &&
        !state.pendingActionType;

      if (!isMyTurn) return;

      // Clear any pending action (including "DREW" or SecondChancePrompt)
      await pool.query(
        `UPDATE rooms
         SET pending_action_type = NULL,
             pending_action_actor_id = NULL,
             pending_action_value = NULL
         WHERE id = $1`,
        [room.id]
      );

      // Mark player as stayed
      await pool.query(
        `UPDATE room_players
         SET stayed = TRUE
         WHERE player_id = $1 AND room_id = $2`,
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

  /**
   * PASS
   *   - Current player passes without staying
   *   - Clears pending action
   *   - Advances turn
   */
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

      // Clear any pending action
      await pool.query(
        `UPDATE rooms
         SET pending_action_type = NULL,
             pending_action_actor_id = NULL,
             pending_action_value = NULL
         WHERE id = $1`,
        [room.id]
      );

      // Move to next player
      await advanceTurn(room.id);

      const newState = await getState(room.id);
      io.to(code).emit("stateUpdate", newState);
    } catch (err) {
      console.error("pass error:", err);
    }
  });

  /**
   * END ROUND
   *   - Can be triggered by client once roundOver = true
   *   - Calls endRound() to score + reset + next round setup
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

      const state = await getState(room.id);
      if (!state || !state.roundOver) return;

      await endRound(room.id);

      const newState = await getState(room.id);
      io.to(code).emit("stateUpdate", newState);
    } catch (err) {
      console.error("endRound error:", err);
    }
  });

  /**
   * ACTION TARGET (Freeze, Swap, Take3)
   *   - Resolves pending action using targetId
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

      const state = await getState(room.id);
      if (!state) return;

      if (!state.pendingActionType || state.pendingActionActorId !== playerId) {
        return;
      }

      if (action === "Freeze") {
        await pool.query(
          `UPDATE room_players
           SET stayed = TRUE
           WHERE player_id = $1 AND room_id = $2`,
          [targetId, room.id]
        );
      }

      if (action === "Swap") {
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
        for (let i = 0; i < 3; i++) {
          await drawCardForPlayer(room, targetId);
        }
      }

      await removeFromHand(room.id, playerId, state.pendingActionValue);
      await addToDiscard(room.id, state.pendingActionValue);

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

  /**
   * REMOVE PLAYER
   *   - Marks player as inactive in room_players
   */
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

  /**
   * Second Chance YES/NO:
   *   - Triggered after SecondChancePrompt
   *   - If use = false → player busts
   *   - If use = true  → discard duplicate + Second Chance
   */
  socket.on("secondChanceResponse", async ({ roomCode, playerId, use }) => {
    try {
      const roomRes = await pool.query(
        "SELECT * FROM rooms WHERE code = $1",
        [roomCode]
      );
      if (!roomRes.rows.length) return;
      const room = roomRes.rows[0];

      const dupValue = room.pending_action_value;

      if (!use) {
        // Player chooses NOT to use Second Chance → they bust
        await pool.query(
          `UPDATE room_players
           SET stayed = TRUE, round_bust = TRUE
           WHERE player_id = $1 AND room_id = $2`,
          [playerId, room.id]
        );
      } else {
        // Remove duplicate card
        await removeFromHand(room.id, playerId, dupValue);

        // Remove Second Chance card
        await removeFromHand(room.id, playerId, "Second Chance");

        // Discard both cards
        await addToDiscard(room.id, dupValue);
        await addToDiscard(room.id, "Second Chance");
      }

      // Clear ALL pending action fields so the turn system works correctly.
      await pool.query(
        `UPDATE rooms
         SET pending_action_type = NULL,
             pending_action_actor_id = NULL,
             pending_action_value = NULL
         WHERE id = $1`,
        [room.id]
      );

      // Send updated state to all players
      const newState = await getState(room.id);
      io.to(roomCode).emit("stateUpdate", newState);

    } catch (err) {
      console.error("secondChanceResponse error:", err);
    }
  });

  /**
   * DISCONNECT
   *   - Marks player disconnected
   *   - Recomputes paused state
   *   - Broadcasts updated state
   */
  socket.on("disconnect", async () => {
    try {
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

/********************************************************************************************
 *  SECTION 12 — SERVER START
 *  -----------------------------------------------------------------------------------------
 *  Binds the HTTP server to a port and starts listening for connections.
 ********************************************************************************************/

const PORT = process.env.PORT || 3000;
server.listen(PORT, () =>
  console.log("Flip‑to‑6 server running on port", PORT)
);
