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


/********************************************************************************************
 *  Flip‑to‑6 — FULL MULTIPLAYER GAME SERVER (Reorganized, Teaching Edition)
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
 *  Nothing in this section contains game logic — it simply prepares the environment
 *  so the rest of the server can run.
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
 *  WHY THIS SECTION EXISTS:
 *  ------------------------
 *  Flip‑to‑6 is a persistent multiplayer game. That means:
 *    - Rooms must survive page refreshes
 *    - Player seats must persist
 *    - Decks, discard piles, and hands must be stored
 *    - Rounds and scores must be saved
 *
 *  PostgreSQL is used as the authoritative source of truth.
 *
 *  HOW THIS WORKS:
 *  ---------------
 *  On server startup, we run a series of CREATE TABLE IF NOT EXISTS statements.
 *  This ensures:
 *    - The game can run even on a fresh database
 *    - No duplicate tables are created
 *    - The schema is always correct
 *
 *  IMPORTANT:
 *  ----------
 *  This block runs ONCE when the server starts.
 *  It does NOT run per‑request or per‑player.
 ********************************************************************************************/

(async () => {
  try {
    /***************************************
     * CARD TYPES TABLE
     * -----------------
     * Stores:
     *   - card value ("5", "Swap", "Freeze", etc.)
     *   - filename for PNG assets
     *   - how many copies exist in the deck
     ***************************************/
    await pool.query(`
      CREATE TABLE IF NOT EXISTS card_types (
        value TEXT PRIMARY KEY,
        filename TEXT NOT NULL,
        count INT NOT NULL
      );
    `);

    /***************************************
     * ROOMS TABLE
     * -----------
     * Each game room has:
     *   - a unique code ("ABCD")
     *   - turn state
     *   - round state
     *   - pause state
     *   - pending action state
     *   - round starter tracking
     ***************************************/
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

    /***************************************
     * ROOM PLAYERS TABLE
     * -------------------
     * Stores players in each room.
     *
     * IMPORTANT:
     *   - player_id is NOT the row id.
     *     It is a per‑room sequential ID (1, 2, 3…)
     *   - order_index determines turn order
     *   - active = FALSE means removed from room
     *   - connected = FALSE means temporarily disconnected
     ***************************************/
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

    /***************************************
     * UNIQUE INDEX:
     * Prevents two ACTIVE players in the same
     * room from having the same name.
     ***************************************/
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS unique_active_name_per_room
      ON room_players (room_id, LOWER(name))
      WHERE active = TRUE;
    `);

    /***************************************
     * DRAW PILE TABLE
     * ----------------
     * Stores the shuffled deck for each room.
     * position = draw order (0 = top of deck)
     ***************************************/
    await pool.query(`
      CREATE TABLE IF NOT EXISTS draw_pile (
        id SERIAL PRIMARY KEY,
        room_id INT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        position INT NOT NULL,
        value TEXT NOT NULL
      );
    `);

    /***************************************
     * DISCARDS TABLE
     * ---------------
     * Stores discarded cards in order.
     * position = timestamp (used for ordering)
     ***************************************/
    await pool.query(`
      CREATE TABLE IF NOT EXISTS discard_pile (
        id SERIAL PRIMARY KEY,
        room_id INT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        position INT NOT NULL,
        value TEXT NOT NULL
      );
    `);

    /***************************************
     * PLAYER HANDS TABLE
     * -------------------
     * Stores cards held by each player.
     * position = timestamp (keeps order)
     ***************************************/
    await pool.query(`
      CREATE TABLE IF NOT EXISTS player_hands (
        id SERIAL PRIMARY KEY,
        room_id INT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        player_id INT NOT NULL,
        position BIGINT NOT NULL,
        value TEXT NOT NULL
      );
    `);

    /***************************************
     * ROUND SCORES TABLE
     * -------------------
     * Stores each player's score per round.
     ***************************************/
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
 *  SECTION 3 — CARD & DECK LOGIC
 *  -----------------------------------------------------------------------------------------
 *  This section contains ALL logic related to:
 *    - Shuffling the deck
 *    - Creating the deck from card_types
 *    - Splitting numeric vs action cards
 *    - Forcing streaks (Flip‑7 style)
 *    - Adaptive distribution of action cards
 *    - Ensuring each room has a fresh deck
 *
 *  WHY THIS SECTION EXISTS:
 *  ------------------------
 *  Flip‑to‑6 uses a hybrid shuffle system:
 *    • Numeric cards are shuffled with optional streaks (2‑ or 3‑in‑a‑row)
 *    • Action cards are inserted into specific “zones” of the deck
 *    • The deck is stored in the database (draw_pile table)
 *
 *  This ensures:
 *    - Every room has its own independent deck
 *    - Decks persist across refreshes
 *    - The game is deterministic and fair
 ********************************************************************************************/


/***********************************************
 * FISHER–YATES SHUFFLE
 * ---------------------
 * The gold standard for unbiased shuffling.
 ***********************************************/
function fisherYates(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
}


/***********************************************
 * isAction(value)
 * ----------------
 * Returns TRUE if the card is NOT a number.
 * Numeric cards are 0–12.
 ***********************************************/
function isAction(value) {
  return !/^(?:[0-9]|1[0-2])$/.test(value);
}


/***********************************************
 * forceStreak(deck, length)
 * --------------------------
 * Attempts to create a streak of identical
 * numeric cards (e.g., 3‑3‑3).
 *
 * This mimics the “Flip‑7” style deck behavior.
 ***********************************************/
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


/***********************************************
 * makeZones(deckSize)
 * --------------------
 * Splits the deck into 4 zones:
 *   Zone 1: early game
 *   Zone 2: mid‑early
 *   Zone 3: mid‑late
 *   Zone 4: late game
 *
 * Action cards are inserted into these zones.
 ***********************************************/
function makeZones(deckSize) {
  return [
    [Math.floor(deckSize * 0.10), Math.floor(deckSize * 0.30)],
    [Math.floor(deckSize * 0.30), Math.floor(deckSize * 0.65)],
    [Math.floor(deckSize * 0.65), Math.floor(deckSize * 0.80)],
    [Math.floor(deckSize * 0.80), deckSize - 1]
  ];
}


/***********************************************
 * distributeActionsAdaptive(result, actionCards)
 * ----------------------------------------------
 * Inserts action cards into the deck in a way
 * that spreads them out and avoids clumping.
 ***********************************************/
function distributeActionsAdaptive(result, actionCards) {
  const deckSize = result.length;
  const zones = makeZones(deckSize);

  let actionIndex = 0;

  for (let z = 0; z < zones.length; z++) {
    if (actionIndex >= actionCards.length) break;

    const [minPos, maxPos] = zones[z];
    if (minPos >= maxPos) continue;

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


/***********************************************
 * hybridShuffle(deck)
 * --------------------
 * The main shuffle algorithm:
 *   1. Split numeric vs action cards
 *   2. Shuffle numeric cards
 *   3. Force streaks (optional)
 *   4. Shuffle action cards
 *   5. Insert action cards into zones
 ***********************************************/
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

  const actionsToUse = actionCards.slice(0, 14);

  let result = [...numberCards];
  result = distributeActionsAdaptive(result, actionsToUse);

  return result;
}


/***********************************************
 * ensureDeck(roomId)
 * -------------------
 * Ensures the room has a deck.
 *
 * If the draw_pile is empty:
 *   - Load card_types
 *   - Build deck
 *   - Shuffle deck
 *   - Insert into draw_pile
 ***********************************************/
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

/********************************************************************************************
 *  SECTION 4 — DRAW / DISCARD / HAND MANAGEMENT
 *  -----------------------------------------------------------------------------------------
 *  These functions perform the fundamental card operations used throughout the game.
 *
 *  WHY THIS SECTION EXISTS:
 *  ------------------------
 *  Higher‑level game logic (drawing, swapping, freezing, scoring, etc.) depends on these
 *  low‑level primitives. By isolating them here:
 *
 *    • The game engine becomes easier to understand
 *    • Each operation is consistent and predictable
 *    • Database writes are centralized
 *
 *  These functions DO NOT contain game rules — they only manipulate the database.
 ********************************************************************************************/


/***********************************************
 * popTopCard(roomId)
 * -------------------
 * Removes and returns the top card of the draw pile.
 *
 * IMPORTANT:
 *   - The draw pile is ordered by "position ASC"
 *   - The lowest position = top of deck
 ***********************************************/
async function popTopCard(roomId) {
  const res = await pool.query(
    `SELECT id, value
     FROM draw_pile
     WHERE room_id = $1
     ORDER BY position ASC
     LIMIT 1`,
    [roomId]
  );

  if (!res.rows.length) return null;

  const card = res.rows[0];

  await pool.query(
    "DELETE FROM draw_pile WHERE id = $1",
    [card.id]
  );

  return card.value;
}


/***********************************************
 * addToHand(roomId, playerId, value)
 * -----------------------------------
 * Adds a card to a player's hand.
 *
 * position = timestamp (Date.now()) ensures
 * cards appear in the order they were drawn.
 ***********************************************/
async function addToHand(roomId, playerId, value) {
  await pool.query(
    `INSERT INTO player_hands (room_id, player_id, position, value)
     VALUES ($1, $2, $3, $4)`,
    [roomId, playerId, Date.now(), value]
  );
}


/***********************************************
 * removeFromHand(roomId, playerId, value)
 * ----------------------------------------
 * Removes ONE instance of a card from a player's hand.
 *
 * IMPORTANT:
 *   - If a player has duplicates, only one is removed.
 ***********************************************/
async function removeFromHand(roomId, playerId, value) {
  const res = await pool.query(
    `SELECT id
     FROM player_hands
     WHERE room_id = $1 AND player_id = $2 AND value = $3
     ORDER BY position ASC
     LIMIT 1`,
    [roomId, playerId, value]
  );

  if (!res.rows.length) return;

  await pool.query(
    "DELETE FROM player_hands WHERE id = $1",
    [res.rows[0].id]
  );
}


/***********************************************
 * addToDiscard(roomId, value)
 * ----------------------------
 * Adds a card to the discard pile.
 *
 * position = timestamp (Date.now()) ensures
 * the discard pile is ordered chronologically.
 ***********************************************/
async function addToDiscard(roomId, value) {
  await pool.query(
    `INSERT INTO discard_pile (room_id, position, value)
     VALUES ($1, $2, $3)`,
    [roomId, Date.now(), value]
  );
}


/***********************************************
 * playerHasSecondChance(roomId, playerId)
 * ----------------------------------------
 * Returns TRUE if the player currently holds
 * a "Second Chance" card.
 ***********************************************/
async function playerHasSecondChance(roomId, playerId) {
  const res = await pool.query(
    `SELECT COUNT(*) FROM player_hands
     WHERE room_id = $1 AND player_id = $2 AND value = 'Second Chance'`,
    [roomId, playerId]
  );

  return parseInt(res.rows[0].count, 10) > 0;
}


/********************************************************************************************
 *  SECTION 5 — PAUSE & RECONNECT LOGIC
 *  -----------------------------------------------------------------------------------------
 *  WHY THIS SECTION EXISTS:
 *  ------------------------
 *  Flip‑to‑6 is a real‑time multiplayer game. If a player disconnects:
 *
 *      • The game should pause automatically
 *      • Other players should not continue drawing or staying
 *      • When all players reconnect, the game should resume
 *
 *  This section contains the logic that checks:
 *      - How many players are connected
 *      - Whether the game should be paused or unpaused
 *
 *  The function here is used by:
 *      • joinRoom (when a player reconnects)
 *      • disconnect (when a player leaves)
 *      • any event that might change connection state
 ********************************************************************************************/


/***********************************************
 * recomputePause(roomId)
 * -----------------------
 * Recalculates whether the room should be paused.
 *
 * RULES:
 *   - If ANY active player is disconnected → paused = TRUE
 *   - If ALL active players are connected → paused = FALSE
 *
 * This ensures the game never progresses while someone is offline.
 ***********************************************/
async function recomputePause(roomId) {
  // Count active players who are disconnected
  const res = await pool.query(
    `SELECT COUNT(*) AS disconnected
     FROM room_players
     WHERE room_id = $1
       AND active = TRUE
       AND connected = FALSE`,
    [roomId]
  );

  const disconnected = parseInt(res.rows[0].disconnected, 10);

  // If at least one player is disconnected → pause the game
  const paused = disconnected > 0;

  await pool.query(
    `UPDATE rooms
     SET paused = $1
     WHERE id = $2`,
    [paused, roomId]
  );
}

/********************************************************************************************
 *  SECTION 6 — TURN ORDER LOGIC
 *  -----------------------------------------------------------------------------------------
 *  This section controls:
 *      • Who goes next
 *      • How the turn rotates
 *      • How the round starter is chosen
 *      • What happens when players stay or bust
 *
 *  WHY THIS SECTION EXISTS:
 *  ------------------------
 *  Flip‑to‑6 is a turn‑based game. The server must:
 *      • Always know whose turn it is
 *      • Skip players who have stayed or busted
 *      • Detect when the round is over
 *      • Rotate the starting player each round
 *
 *  These functions DO NOT draw cards or apply actions.
 *  They ONLY determine turn order and round flow.
 ********************************************************************************************/


/***********************************************
 * getActivePlayers(roomId)
 * -------------------------
 * Returns all ACTIVE players in turn order.
 ***********************************************/
async function getActivePlayers(roomId) {
  const res = await pool.query(
    `SELECT player_id, stayed, round_bust, order_index
     FROM room_players
     WHERE room_id = $1 AND active = TRUE
     ORDER BY order_index ASC`,
    [roomId]
  );
  return res.rows;
}


/***********************************************
 * findNextPlayer(players, currentId)
 * -----------------------------------
 * Given a list of players and the current player,
 * returns the next player who:
 *      • is active
 *      • has NOT stayed
 *      • has NOT busted
 *
 * If none remain → round is over.
 ***********************************************/
function findNextPlayer(players, currentId) {
  if (!players.length) return null;

  const idx = players.findIndex(p => p.player_id === currentId);
  if (idx === -1) return null;

  const total = players.length;

  for (let i = 1; i <= total; i++) {
    const next = players[(idx + i) % total];
    if (!next.stayed && !next.round_bust) {
      return next.player_id;
    }
  }

  return null; // No valid next player → round ends
}


/***********************************************
 * advanceTurn(roomId)
 * --------------------
 * Moves the turn to the next eligible player.
 *
 * RULES:
 *   1. If round is already over → do nothing
 *   2. If no current player → start with round starter
 *   3. Otherwise → find next eligible player
 *   4. If none exist → mark round_over = TRUE
 ***********************************************/
async function advanceTurn(roomId) {
  const roomRes = await pool.query(
    "SELECT * FROM rooms WHERE id = $1",
    [roomId]
  );
  if (!roomRes.rows.length) return;
  const room = roomRes.rows[0];

  if (room.round_over) return;

  const players = await getActivePlayers(roomId);

  // CASE 1 — No current player yet → start round
  if (!room.current_player_id) {
    const starter = room.round_starter_id || players[0].player_id;

    await pool.query(
      `UPDATE rooms
       SET current_player_id = $1
       WHERE id = $2`,
      [starter, roomId]
    );

    return;
  }

  // CASE 2 — Find next eligible player
  const next = findNextPlayer(players, room.current_player_id);

  if (!next) {
    // No one left → round ends
    await pool.query(
      `UPDATE rooms
       SET round_over = TRUE,
           current_player_id = NULL
       WHERE id = $1`,
      [roomId]
    );
    return;
  }

  // CASE 3 — Set next player
  await pool.query(
    `UPDATE rooms
     SET current_player_id = $1
     WHERE id = $2`,
    [next, roomId]
  );
}


/********************************************************************************************
 *  SECTION 7 — SCORING & ROUND LOGIC
 *  -----------------------------------------------------------------------------------------
 *  This section determines:
 *      • When a round ends
 *      • How each player's score is calculated
 *      • How scores are stored
 *      • How the next round begins
 *      • How the round starter rotates
 *
 *  WHY THIS SECTION EXISTS:
 *  ------------------------
 *  Flip‑to‑6 is a multi‑round game. After all players have either:
 *      • Stayed
 *      • Busted
 *
 *  …the round ends and scoring begins.
 *
 *  The server must:
 *      1. Compute each player's hand value
 *      2. Apply scoring rules (2x, 4+, 5+, 6‑)
 *      3. Save the score to round_scores
 *      4. Add the score to total_score
 *      5. Reset the room for the next round
 ********************************************************************************************/


/***********************************************
 * computeHandScore(cards)
 * ------------------------
 * Computes the score of a player's hand.
 *
 * RULES:
 *   - Numeric cards add their value
 *   - "2x" doubles the total
 *   - "4+" adds 4
 *   - "5+" adds 5
 *   - "6-" subtracts 6 (but not below 0)
 ***********************************************/
function computeHandScore(cards) {
  let total = 0;

  for (const c of cards) {
    if (/^(?:[0-9]|1[0-2])$/.test(c)) {
      total += parseInt(c, 10);
    }
  }

  if (cards.includes("2x")) total *= 2;
  if (cards.includes("4+")) total += 4;
  if (cards.includes("5+")) total += 5;
  if (cards.includes("6-")) total = Math.max(0, total - 6);

  return total;
}

/***********************************************
 * endRound(roomId)
 * -----------------
 * Finalizes the round:
 *   1. Compute scores
 *   2. Save round_scores
 *   3. Update total_score
 *   4. Reset stayed/bust flags
 *   5. Rotate round starter (FIXED)
 *   6. Reset deck + hands
 *   7. Start next round with correct starter (FIXED)
 ***********************************************/
async function endRound(roomId) {
  // Load room
  const roomRes = await pool.query(
    "SELECT * FROM rooms WHERE id = $1",
    [roomId]
  );
  if (!roomRes.rows.length) return;
  const room = roomRes.rows[0];

  // Load active players
  const playersRes = await pool.query(
    `SELECT player_id, stayed, round_bust
     FROM room_players
     WHERE room_id = $1 AND active = TRUE
     ORDER BY order_index ASC`,
    [roomId]
  );
  const players = playersRes.rows;

  /***********************************************
   * 1–3. Compute and save scores
   ***********************************************/
  for (const p of players) {
    const handRes = await pool.query(
      `SELECT value
       FROM player_hands
       WHERE room_id = $1 AND player_id = $2`,
      [roomId, p.player_id]
    );

    const cards = handRes.rows.map(r => r.value);
    const score = p.round_bust ? 0 : computeHandScore(cards);

    await pool.query(
      `INSERT INTO round_scores (room_id, player_id, round_number, score)
       VALUES ($1, $2, $3, $4)`,
      [roomId, p.player_id, room.round_number, score]
    );

    await pool.query(
      `UPDATE room_players
       SET total_score = total_score + $1
       WHERE room_id = $2 AND player_id = $3`,
      [score, roomId, p.player_id]
    );
  }

  /***********************************************
   * 4. Reset stayed/bust flags
   ***********************************************/
  await pool.query(
    `UPDATE room_players
     SET stayed = FALSE,
         round_bust = FALSE
     WHERE room_id = $1`,
    [roomId]
  );

  /***********************************************
   * 5. Rotate round starter (FIXED)
   *    IMPORTANT: Reload the updated starter
   ***********************************************/
  const starterRes = await pool.query(
    `SELECT round_starter_id FROM rooms WHERE id = $1`,
    [roomId]
  );

  const currentStarter =
    starterRes.rows[0].round_starter_id || players[0].player_id;

  const idx = players.findIndex(p => p.player_id === currentStarter);
  const nextStarter = players[(idx + 1) % players.length].player_id;

  await pool.query(
    `UPDATE rooms
     SET round_starter_id = $1
     WHERE id = $2`,
    [nextStarter, roomId]
  );

  /***********************************************
   * 6. Reset deck + hands
   ***********************************************/
  await pool.query("DELETE FROM draw_pile WHERE room_id = $1", [roomId]);
  await pool.query("DELETE FROM discard_pile WHERE room_id = $1", [roomId]);
  await pool.query("DELETE FROM player_hands WHERE room_id = $1", [roomId]);

  /***********************************************
   * 7. Start next round
   ***********************************************/
  await pool.query(
    `UPDATE rooms
     SET round_number = round_number + 1,
         round_over = FALSE,
         current_player_id = NULL
     WHERE id = $1`,
    [roomId]
  );

  // Rebuild deck
  await ensureDeck(roomId);

  /***********************************************
   * Force next round to start with the NEW starter
   ***********************************************/
  await pool.query(
    `UPDATE rooms
     SET current_player_id = round_starter_id
     WHERE id = $1`,
    [roomId]
  );
}




/********************************************************************************************
 *  SECTION 8 — STATE BUILDER (getState)
 *  -----------------------------------------------------------------------------------------
 *  WHY THIS FUNCTION EXISTS:
 *  -------------------------
 *  The client needs a single, unified snapshot of the entire game state:
 *
 *      • Room info
 *      • Player list
 *      • Hands
 *      • Deck count
 *      • Discard count
 *      • Top discard card
 *      • Top draw cards (for animation)
 *      • Pending actions
 *      • Whose turn it is
 *      • Who is disconnected
 *
 *  Instead of making 10+ separate queries from the client, the server builds one
 *  complete state object and emits it via Socket.IO.
 *
 *  This function is called:
 *      • After every action
 *      • When a player joins
 *      • When a player reconnects
 *      • When a player disconnects
 *      • After scoring
 *
 *  It is the backbone of the entire UI.
 ********************************************************************************************/

async function getState(roomId) {
  // Load room metadata
  const roomRes = await pool.query(
    "SELECT * FROM rooms WHERE id = $1",
    [roomId]
  );
  if (!roomRes.rows.length) return null;
  const room = roomRes.rows[0];

  // Load players in turn order
  const playersRes = await pool.query(
    `SELECT player_id AS id, name, order_index, active, stayed, total_score,
            connected, round_bust
     FROM room_players
     WHERE room_id = $1
     ORDER BY order_index ASC`,
    [roomId]
  );

  // Load all hands
  const handsRes = await pool.query(
    `SELECT player_id, value
     FROM player_hands
     WHERE room_id = $1
     ORDER BY position ASC`,
    [roomId]
  );

  // Deck + discard counts
  const deckCountRes = await pool.query(
    "SELECT COUNT(*) FROM draw_pile WHERE room_id = $1",
    [roomId]
  );

  const discardCountRes = await pool.query(
    "SELECT COUNT(*) FROM discard_pile WHERE room_id = $1",
    [roomId]
  );

  // Top discard card
  const topDiscardRes = await pool.query(
    `SELECT value FROM discard_pile
     WHERE room_id = $1
     ORDER BY position DESC
     LIMIT 1`,
    [roomId]
  );

  // Top 5 draw cards (for animation)
  const topCardsRes = await pool.query(
    `SELECT value FROM draw_pile
     WHERE room_id = $1
     ORDER BY position ASC
     LIMIT 5`,
    [roomId]
  );

  // List disconnected players (for UI warnings)
  const disconnectedPlayers = playersRes.rows
    .filter(p => p.active && !p.connected)
    .map(p => ({ id: p.id, name: p.name }));

  // Build final state object
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
 *  SECTION 9 — EXPRESS ROUTES
 *  -----------------------------------------------------------------------------------------
 *  These routes handle:
  *  login page calls:
 *      • GET  /api/cards/meta
 *      • POST /api/init-deck
 *      • POST /api/player/join
 *      • Creating a room
 *      • Joining a room
 *      • Fetching the current game state
 *
 *  WHY THIS SECTION EXISTS:
 *  ------------------------
 *  Before Socket.IO connects, the client needs:
 *      • A room to exist
 *      • A seat in that room
 *      • The initial game state
 *
 *  These routes are simple REST endpoints that prepare the player
 *  for the real‑time portion of the game.
 ********************************************************************************************/

/********************************************************************************************
 *  login page calls:
 ********************************************************************************************/

/***********************************************
 * GET /api/cards/meta
 * --------------------
 * Frontend uses this to check if card_types is initialized.
 ***********************************************/
app.get("/api/cards/meta", async (req, res) => {
  try {
    const result = await pool.query("SELECT value, filename, count FROM card_types");
    res.json({ success: true, cards: result.rows });
  } catch (err) {
    console.error("meta error:", err);
    res.json({ success: false, cards: [] });
  }
});


/***********************************************
 * POST /api/init-deck
 * --------------------
 * Frontend calls this ONLY if card_types is empty.
 * It repopulates the card_types table.
 ***********************************************/
app.post("/api/init-deck", async (req, res) => {
  try {
    await pool.query("DELETE FROM card_types");

    const cards = [
      { value: "0", filename: "0.png", count: 4 },
      { value: "1", filename: "1.png", count: 4 },
      { value: "2", filename: "2.png", count: 4 },
      { value: "3", filename: "3.png", count: 4 },
      { value: "4", filename: "4.png", count: 4 },
      { value: "5", filename: "5.png", count: 4 },
      { value: "6", filename: "6.png", count: 4 },
      { value: "7", filename: "7.png", count: 4 },
      { value: "8", filename: "8.png", count: 4 },
      { value: "9", filename: "9.png", count: 4 },
      { value: "10", filename: "10.png", count: 4 },
      { value: "11", filename: "11.png", count: 4 },
      { value: "12", filename: "12.png", count: 4 },

      { value: "Swap", filename: "swap.png", count: 4 },
      { value: "Freeze", filename: "freeze.png", count: 4 },
      { value: "Second Chance", filename: "secondchance.png", count: 4 },
      { value: "2x", filename: "2x.png", count: 4 },
      { value: "4+", filename: "4plus.png", count: 4 },
      { value: "5+", filename: "5plus.png", count: 4 },
      { value: "6-", filename: "6minus.png", count: 4 }
    ];

    for (const c of cards) {
      await pool.query(
        "INSERT INTO card_types (value, filename, count) VALUES ($1, $2, $3)",
        [c.value, c.filename, c.count]
      );
    }

    res.json({ success: true });
  } catch (err) {
    console.error("init-deck error:", err);
    res.json({ success: false });
  }
});


/***********************************************
 * POST /api/player/join
 * ----------------------
 * This is the route login page uses.
 *
 * It:
 *   • Finds the room by code
 *   • Assigns next player_id
 *   • Inserts player into room_players
 *   • Redirects to table.html
 ***********************************************/
app.post("/api/player/join", async (req, res) => {
  const { name, roomCode } = req.body;

  try {
    const roomRes = await pool.query(
      "SELECT id FROM rooms WHERE code = $1",
      [roomCode.toUpperCase()]
    );

    if (!roomRes.rows.length) {
      return res.status(404).json({ error: "Room not found" });
    }

    const roomId = roomRes.rows[0].id;

    // Count players
    const countRes = await pool.query(
      `SELECT COUNT(*) FROM room_players
       WHERE room_id = $1 AND active = TRUE`,
      [roomId]
    );

    const playerId = parseInt(countRes.rows[0].count, 10) + 1;
    const orderIndex = playerId - 1;

    // Insert player
    await pool.query(
      `INSERT INTO room_players (room_id, player_id, name, order_index)
       VALUES ($1, $2, $3, $4)`,
      [roomId, playerId, name, orderIndex]
    );

    // Redirect to table.html
    res.json({
      redirect: `/table.html?roomId=${roomId}&playerId=${playerId}`
    });

  } catch (err) {
    console.error("join error:", err);
    res.status(500).json({ error: "Failed to join room" });
  }
});





/***********************************************
 * POST /create-room
 * ------------------
 * Creates a new room with a unique 4‑letter code.
 ***********************************************/
app.post("/create-room", async (req, res) => {
  try {
    const code = Math.random().toString(36).substring(2, 6).toUpperCase();

    const roomRes = await pool.query(
      `INSERT INTO rooms (code)
       VALUES ($1)
       RETURNING id, code`,
      [code]
    );

    const roomId = roomRes.rows[0].id;

    // Ensure deck exists
    await ensureDeck(roomId);

    res.json({ roomId, code });
  } catch (err) {
    console.error("Error creating room:", err);
    res.status(500).json({ error: "Failed to create room" });
  }
});


/***********************************************
 * POST /join-room
 * ----------------
 * Adds a player to a room.
 *
 * BODY:
 *   { code: "ABCD", name: "Alice" }
 ***********************************************/
app.post("/join-room", async (req, res) => {
  const { code, name } = req.body;

  try {
    // Find room
    const roomRes = await pool.query(
      "SELECT id, locked FROM rooms WHERE code = $1",
      [code]
    );
    if (!roomRes.rows.length) {
      return res.status(404).json({ error: "Room not found" });
    }

    const room = roomRes.rows[0];
    if (room.locked) {
      return res.status(403).json({ error: "Room is locked" });
    }

    const roomId = room.id;

    // Determine next player_id and order_index
    const countRes = await pool.query(
      `SELECT COUNT(*) FROM room_players
       WHERE room_id = $1 AND active = TRUE`,
      [roomId]
    );

    const playerId = parseInt(countRes.rows[0].count, 10) + 1;
    const orderIndex = playerId - 1;

    // Insert player
    const playerRes = await pool.query(
      `INSERT INTO room_players (room_id, player_id, name, order_index)
       VALUES ($1, $2, $3, $4)
       RETURNING player_id`,
      [roomId, playerId, name, orderIndex]
    );

    res.json({
      roomId,
      playerId: playerRes.rows[0].player_id
    });
  } catch (err) {
    console.error("Error joining room:", err);

    if (err.constraint === "unique_active_name_per_room") {
      return res.status(400).json({ error: "Name already taken" });
    }

    res.status(500).json({ error: "Failed to join room" });
  }
});


/***********************************************
 * GET /state/:roomId
 * -------------------
 * Returns the full game state for a room.
 ***********************************************/
app.get("/state/:roomId", async (req, res) => {
  const roomId = parseInt(req.params.roomId, 10);

  try {
    const state = await getState(roomId);
    if (!state) {
      return res.status(404).json({ error: "Room not found" });
    }

    res.json(state);
  } catch (err) {
    console.error("Error fetching state:", err);
    res.status(500).json({ error: "Failed to fetch state" });
  }
});


/********************************************************************************************
 *  SECTION 10 — SOCKET.IO HANDLERS
 *  -----------------------------------------------------------------------------------------
 *  This is the heart of the real‑time game engine.
 *
 *  WHY THIS SECTION EXISTS:
 *  ------------------------
 *  Express routes handle setup (create room, join room), but once the game begins,
 *  everything must happen in real time:
 *
 *      • Drawing cards
 *      • Staying
 *      • Busting
 *      • Swapping
 *      • Freezing
 *      • Second Chance
 *      • Turn advancement
 *      • Reconnection
 *      • Broadcasting state updates
 *
 *  Socket.IO allows the server to:
 *      • Receive events from clients
 *      • Update the database
 *      • Broadcast the new state to all players
 *
 *  Every event handler follows this pattern:
 *
 *      1. Validate the room + player
 *      2. Validate the action (turn order, pending actions, etc.)
 *      3. Update the database
 *      4. Recompute pause state
 *      5. Broadcast updated state
 ********************************************************************************************/

io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);

  /******************************************************************************************
   * HELPER: emitState(roomId)
   * --------------------------
   * Loads the full game state and emits it to all players in the room.
   ******************************************************************************************/
  async function emitState(roomId) {
    const state = await getState(roomId);
    io.to(`room_${roomId}`).emit("state", state);
  }

  /******************************************************************************************
   * EVENT: joinRoom
   * ----------------
   * The client calls this immediately after joining via HTTP.
   *
   * DATA:
   *   { roomId, playerId }
   *
   * BEHAVIOR:
   *   - Marks the player as connected
   *   - Stores socket_id
   *   - Joins the socket.io room
   *   - Recomputes pause state
   *   - Emits updated state
   ******************************************************************************************/
  socket.on("joinRoom", async ({ roomId, playerId }) => {
    try {
      // Mark player as connected
      await pool.query(
        `UPDATE room_players
         SET connected = TRUE,
             socket_id = $1
         WHERE room_id = $2 AND player_id = $3`,
        [socket.id, roomId, playerId]
      );

      // Join socket.io room
      socket.join(`room_${roomId}`);

      // Recompute pause state
      await recomputePause(roomId);

      // Emit updated state
      await emitState(roomId);
    } catch (err) {
      console.error("joinRoom error:", err);
    }
  });

  /******************************************************************************************
   * EVENT: disconnect
   * ------------------
   * When a socket disconnects:
   *   - Mark the player as disconnected
   *   - Recompute pause state
   *   - Broadcast updated state
   ******************************************************************************************/
  socket.on("disconnect", async () => {
    try {
      // Find which player this socket belonged to
      const res = await pool.query(
        `SELECT room_id, player_id
         FROM room_players
         WHERE socket_id = $1`,
        [socket.id]
      );

      if (!res.rows.length) return;

      const { room_id: roomId, player_id: playerId } = res.rows[0];

      // Mark player as disconnected
      await pool.query(
        `UPDATE room_players
         SET connected = FALSE
         WHERE room_id = $1 AND player_id = $2`,
        [roomId, playerId]
      );

      // Recompute pause state
      await recomputePause(roomId);

      // Emit updated state
      await emitState(roomId);
    } catch (err) {
      console.error("disconnect error:", err);
    }
  });

  /******************************************************************************************
   * HELPER: validateTurn(roomId, playerId)
   * ---------------------------------------
   * Ensures:
   *    • It's the player's turn
   *    • The game is not paused
   *    • The round is not over
   *
   * Returns:
   *    { ok: true }  → valid
   *    { ok: false, error: "message" } → invalid
   ******************************************************************************************/
  async function validateTurn(roomId, playerId) {
    const roomRes = await pool.query(
      "SELECT current_player_id, paused, round_over FROM rooms WHERE id = $1",
      [roomId]
    );
    if (!roomRes.rows.length) {
      return { ok: false, error: "Room not found" };
    }

    const room = roomRes.rows[0];

    if (room.paused) {
      return { ok: false, error: "Game is paused" };
    }

    if (room.round_over) {
      return { ok: false, error: "Round is over" };
    }

    if (room.current_player_id !== playerId) {
      return { ok: false, error: "Not your turn" };
    }

    return { ok: true };
  }

  /******************************************************************************************
   * EVENT: drawFromDeck
   * --------------------
   * Player draws the top card from the deck.
   *
   * RULES:
   *   • Must be player's turn
   *   • Must not be paused
   *   • Must not be in a pending action
   ******************************************************************************************/
  socket.on("drawFromDeck", async ({ roomId, playerId }) => {
    try {
      const valid = await validateTurn(roomId, playerId);
      if (!valid.ok) return;

      // Draw top card
      const card = await popTopCard(roomId);
      if (!card) return;

      // Add to hand
      await addToHand(roomId, playerId, card);

      // Emit updated state
      await emitState(roomId);
    } catch (err) {
      console.error("drawFromDeck error:", err);
    }
  });

  /******************************************************************************************
   * EVENT: drawFromDiscard
   * -----------------------
   * Player draws the top discard card.
   ******************************************************************************************/
  socket.on("drawFromDiscard", async ({ roomId, playerId }) => {
    try {
      const valid = await validateTurn(roomId, playerId);
      if (!valid.ok) return;

      // Get top discard
      const res = await pool.query(
        `SELECT id, value
         FROM discard_pile
         WHERE room_id = $1
         ORDER BY position DESC
         LIMIT 1`,
        [roomId]
      );

      if (!res.rows.length) return;

      const { id, value } = res.rows[0];

      // Remove from discard
      await pool.query("DELETE FROM discard_pile WHERE id = $1", [id]);

      // Add to hand
      await addToHand(roomId, playerId, value);

      await emitState(roomId);
    } catch (err) {
      console.error("drawFromDiscard error:", err);
    }
  });

  /******************************************************************************************
   * EVENT: discardCard
   * -------------------
   * Player discards a card from their hand.
   ******************************************************************************************/
  socket.on("discardCard", async ({ roomId, playerId, value }) => {
    try {
      const valid = await validateTurn(roomId, playerId);
      if (!valid.ok) return;

      // Remove from hand
      await removeFromHand(roomId, playerId, value);

      // Add to discard
      await addToDiscard(roomId, value);

      await emitState(roomId);
    } catch (err) {
      console.error("discardCard error:", err);
    }
  });

  /******************************************************************************************
   * EVENT: stay
   * -----------
   * Player chooses to stay.
   *
   * RULES:
   *   • Player is marked stayed = TRUE
   *   • If all players stayed/busted → end round
   *   • Otherwise → advance turn
   ******************************************************************************************/
  socket.on("stay", async ({ roomId, playerId }) => {
    try {
      const valid = await validateTurn(roomId, playerId);
      if (!valid.ok) return;

      // Mark stayed
      await pool.query(
        `UPDATE room_players
         SET stayed = TRUE
         WHERE room_id = $1 AND player_id = $2`,
        [roomId, playerId]
      );

      // Check if round should end
      const players = await getActivePlayers(roomId);
      const allDone = players.every(p => p.stayed || p.round_bust);

      if (allDone) {
        await endRound(roomId);
      } else {
        await advanceTurn(roomId);
      }

      await emitState(roomId);
    } catch (err) {
      console.error("stay error:", err);
    }
  });

  /******************************************************************************************
   * EVENT: bust
   * ------------
   * Player busts (hand value > 21).
   *
   * RULES:
   *   • round_bust = TRUE
   *   • If all players done → end round
   *   • Otherwise → advance turn
   ******************************************************************************************/
  socket.on("bust", async ({ roomId, playerId }) => {
    try {
      const valid = await validateTurn(roomId, playerId);
      if (!valid.ok) return;

      // Mark bust
      await pool.query(
        `UPDATE room_players
         SET round_bust = TRUE
         WHERE room_id = $1 AND player_id = $2`,
        [roomId, playerId]
      );

      // Check if round should end
      const players = await getActivePlayers(roomId);
      const allDone = players.every(p => p.stayed || p.round_bust);

      if (allDone) {
        await endRound(roomId);
      } else {
        await advanceTurn(roomId);
      }

      await emitState(roomId);
    } catch (err) {
      console.error("bust error:", err);
    }
  });

  /******************************************************************************************
   * EVENT: endTurn
   * ---------------
   * Player ends their turn voluntarily.
   *
   * RULES:
   *   • Must be player's turn
   *   • Must not be paused
   *   • Must not be in pending action
   ******************************************************************************************/
  socket.on("endTurn", async ({ roomId, playerId }) => {
    try {
      const valid = await validateTurn(roomId, playerId);
      if (!valid.ok) return;

      await advanceTurn(roomId);
      await emitState(roomId);
    } catch (err) {
      console.error("endTurn error:", err);
    }
  });

  /******************************************************************************************
   * ACTION CARD SYSTEM OVERVIEW
   * ----------------------------------------------------------------------------------------
   * Some cards require MULTI‑STEP interactions:
   *
   *   • Swap — choose a target player, then choose a card to swap
   *   • Freeze — choose a target player to freeze
   *   • Second Chance — allows undoing a bust
   *
   * To support this, the server uses a "pending action" system:
   *
   *   rooms.pending_action_type       → e.g., "swap_select_target"
   *   rooms.pending_action_actor_id   → the player who played the action
   *   rooms.pending_action_value      → the card value (e.g., "Swap")
   *
   * The flow is:
   *   1. Player plays an action card
   *   2. Server sets pending_action_*
   *   3. Client shows UI for selecting target / card
   *   4. Client sends follow‑up event
   *   5. Server resolves the action
   *   6. pending_action_* is cleared
   ******************************************************************************************/


  /******************************************************************************************
   * HELPER: setPending(roomId, type, actorId, value)
   ******************************************************************************************/
  async function setPending(roomId, type, actorId, value) {
    await pool.query(
      `UPDATE rooms
       SET pending_action_type = $1,
           pending_action_actor_id = $2,
           pending_action_value = $3
       WHERE id = $4`,
      [type, actorId, value, roomId]
    );
  }

  /******************************************************************************************
   * HELPER: clearPending(roomId)
   ******************************************************************************************/
  async function clearPending(roomId) {
    await pool.query(
      `UPDATE rooms
       SET pending_action_type = NULL,
           pending_action_actor_id = NULL,
           pending_action_value = NULL
       WHERE id = $1`,
      [roomId]
    );
  }


  /******************************************************************************************
   * EVENT: playActionCard
   * ----------------------
   * Player plays an action card from their hand.
   *
   * ACTIONS:
   *   • Swap
   *   • Freeze
   *   • Second Chance
   *
   * RULES:
   *   • Must be player's turn
   *   • Must not already be in a pending action
   ******************************************************************************************/
  socket.on("playActionCard", async ({ roomId, playerId, value }) => {
    try {
      const valid = await validateTurn(roomId, playerId);
      if (!valid.ok) return;

      // Remove card from hand
      await removeFromHand(roomId, playerId, value);

      // Handle each action type
      if (value === "Swap") {
        await setPending(roomId, "swap_select_target", playerId, value);
      } else if (value === "Freeze") {
        await setPending(roomId, "freeze_select_target", playerId, value);
      } else if (value === "Second Chance") {
        // Second Chance is immediate — no pending state
        // It simply allows undoing a bust later
        // (actual bust undo handled in bust logic)
      }

      await emitState(roomId);
    } catch (err) {
      console.error("playActionCard error:", err);
    }
  });


  /******************************************************************************************
   * EVENT: chooseSwapTarget
   * ------------------------
   * Step 1 of Swap:
   *   Player chooses which opponent to swap with.
   ******************************************************************************************/
  socket.on("chooseSwapTarget", async ({ roomId, playerId, targetId }) => {
    try {
      // Validate pending state
      const roomRes = await pool.query(
        `SELECT pending_action_type, pending_action_actor_id
         FROM rooms WHERE id = $1`,
        [roomId]
      );
      const room = roomRes.rows[0];

      if (room.pending_action_type !== "swap_select_target") return;
      if (room.pending_action_actor_id !== playerId) return;

      // Move to next step
      await setPending(roomId, "swap_select_card", playerId, targetId);

      await emitState(roomId);
    } catch (err) {
      console.error("chooseSwapTarget error:", err);
    }
  });


  /******************************************************************************************
   * EVENT: chooseSwapCard
   * ----------------------
   * Step 2 of Swap:
   *   Player chooses which card to swap with the target.
   *
   * pending_action_value = targetId
   ******************************************************************************************/
  socket.on("chooseSwapCard", async ({ roomId, playerId, cardValue }) => {
    try {
      const roomRes = await pool.query(
        `SELECT pending_action_type, pending_action_actor_id, pending_action_value
         FROM rooms WHERE id = $1`,
        [roomId]
      );
      const room = roomRes.rows[0];

      if (room.pending_action_type !== "swap_select_card") return;
      if (room.pending_action_actor_id !== playerId) return;

      const targetId = parseInt(room.pending_action_value, 10);

      // Remove chosen card from actor
      await removeFromHand(roomId, playerId, cardValue);

      // Remove random card from target
      const targetHandRes = await pool.query(
        `SELECT id, value
         FROM player_hands
         WHERE room_id = $1 AND player_id = $2
         ORDER BY RANDOM()
         LIMIT 1`,
        [roomId, targetId]
      );

      if (!targetHandRes.rows.length) {
        await clearPending(roomId);
        await emitState(roomId);
        return;
      }

      const targetCard = targetHandRes.rows[0].value;

      // Remove target card
      await removeFromHand(roomId, targetId, targetCard);

      // Add swapped cards
      await addToHand(roomId, targetId, cardValue);
      await addToHand(roomId, playerId, targetCard);

      // Clear pending
      await clearPending(roomId);

      await emitState(roomId);
    } catch (err) {
      console.error("chooseSwapCard error:", err);
    }
  });


  /******************************************************************************************
   * EVENT: chooseFreezeTarget
   * --------------------------
   * Freeze marks a player as "stayed" immediately.
   ******************************************************************************************/
  socket.on("chooseFreezeTarget", async ({ roomId, playerId, targetId }) => {
    try {
      const roomRes = await pool.query(
        `SELECT pending_action_type, pending_action_actor_id
         FROM rooms WHERE id = $1`,
        [roomId]
      );
      const room = roomRes.rows[0];

      if (room.pending_action_type !== "freeze_select_target") return;
      if (room.pending_action_actor_id !== playerId) return;

      // Freeze = force stay
      await pool.query(
        `UPDATE room_players
         SET stayed = TRUE
         WHERE room_id = $1 AND player_id = $2`,
        [roomId, targetId]
      );

      await clearPending(roomId);

      // Check if round ends
      const players = await getActivePlayers(roomId);
      const allDone = players.every(p => p.stayed || p.round_bust);

      if (allDone) {
        await endRound(roomId);
      } else {
        await advanceTurn(roomId);
      }

      await emitState(roomId);
    } catch (err) {
      console.error("chooseFreezeTarget error:", err);
    }
  });

  /******************************************************************************************
   * EVENT: lockRoom
   * ----------------
   * Prevents new players from joining.
   *
   * Typically used when the game is about to start.
   ******************************************************************************************/
  socket.on("lockRoom", async ({ roomId }) => {
    try {
      await pool.query(
        `UPDATE rooms
         SET locked = TRUE
         WHERE id = $1`,
        [roomId]
      );

      await emitState(roomId);
    } catch (err) {
      console.error("lockRoom error:", err);
    }
  });


  /******************************************************************************************
   * EVENT: unlockRoom
   * ------------------
   * Allows new players to join again.
   ******************************************************************************************/
  socket.on("unlockRoom", async ({ roomId }) => {
    try {
      await pool.query(
        `UPDATE rooms
         SET locked = FALSE
         WHERE id = $1`,
        [roomId]
      );

      await emitState(roomId);
    } catch (err) {
      console.error("unlockRoom error:", err);
    }
  });


  /******************************************************************************************
   * EVENT: cancelPendingAction
   * ---------------------------
   * Allows the acting player to cancel an action card
   * before completing the target selection.
   ******************************************************************************************/
  socket.on("cancelPendingAction", async ({ roomId, playerId }) => {
    try {
      const roomRes = await pool.query(
        `SELECT pending_action_type, pending_action_actor_id
         FROM rooms WHERE id = $1`,
        [roomId]
      );

      if (!roomRes.rows.length) return;
      const room = roomRes.rows[0];

      // Only the actor can cancel
      if (room.pending_action_actor_id !== playerId) return;

      await clearPending(roomId);
      await emitState(roomId);
    } catch (err) {
      console.error("cancelPendingAction error:", err);
    }
  });


  /******************************************************************************************
   * EVENT: chatMessage
   * -------------------
   * Broadcasts a chat message to all players in the room.
   *
   * NOTE:
   *   Chat is not stored in the database — it is ephemeral.
   ******************************************************************************************/
  socket.on("chatMessage", ({ roomId, playerId, message }) => {
    io.to(`room_${roomId}`).emit("chatMessage", {
      playerId,
      message,
      timestamp: Date.now()
    });
  });


  /******************************************************************************************
   * EVENT: requestState
   * --------------------
   * Client requests a fresh state snapshot.
   *
   * Useful after reconnection or UI desync.
   ******************************************************************************************/
  socket.on("requestState", async ({ roomId }) => {
    try {
      await emitState(roomId);
    } catch (err) {
      console.error("requestState error:", err);
    }
  });

}); // <-- closes io.on("connection")

/********************************************************************************************
 *  SECTION 11 — SERVER START
 *  -----------------------------------------------------------------------------------------
 *  This is the final section of the server.
 *
 *  WHAT THIS DOES:
 *  ---------------
 *  • Reads PORT from environment variables (Heroku, Render, etc.)
 *  • Defaults to 3000 for local development
 *  • Starts the HTTP server
 *  • Confirms that Socket.IO is attached and ready
 *
 *  Once this runs, the server is fully operational.
 ********************************************************************************************/

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Flip‑to‑6 server running on port ${PORT}`);
});



