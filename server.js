/********************************************************************************************
 *  Flip‑to‑6 — MINIMAL SHUFFLE-ONLY SERVER ver 0.0.1
 *  -----------------------------------------------------------------------------------------
 *  Features:
 *    - Express HTTP server
 *    - Socket.IO for real-time
 *    - PostgreSQL with in-server DB initialization
 *    - card_types table + /api/init-deck seeding
 *    - rooms + room_players + draw_pile
 *    - join via /api/player/join
 *    - joinRoom socket event
 *    - shuffleDeck socket event (rebuilds + shuffles entire deck)
 *    - stateUpdate broadcast with basic state:
 *        - roomId, code, deckCount
 ********************************************************************************************/

// Core server libraries
const express = require("express");
const http = require("http");
const path = require("path");
const bodyParser = require("body-parser");

// PostgreSQL connection pool
const { Pool } = require("pg");

// Socket.IO
const { Server } = require("socket.io");

// Create app/server
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Middleware
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

// Serve main table page
app.get("/room/:code", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "table.html"));
});

// PostgreSQL connection (Heroku-style SSL)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/********************************************************************************************
 *  SECTION 2 — DATABASE INITIALIZATION
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
        code TEXT UNIQUE NOT NULL
      );
    `);

    // Players (minimal for now)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS room_players (
        id SERIAL PRIMARY KEY,
        room_id INT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        player_id INT NOT NULL,
        name TEXT NOT NULL,
        order_index INT NOT NULL,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        socket_id TEXT,
        connected BOOLEAN NOT NULL DEFAULT FALSE
      );
    `);

    // Unique active name per room (case-insensitive)
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS unique_active_name_per_room
      ON room_players (room_id, LOWER(name))
      WHERE active = TRUE;
    `);

    // Draw pile only (no discard, no hands, no scores here)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS draw_pile (
        id SERIAL PRIMARY KEY,
        room_id INT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        position INT NOT NULL,
        value TEXT NOT NULL
      );
    `);

    console.log("Flip‑to‑6 minimal DB initialized.");
  } catch (err) {
    console.error("DB init error:", err);
  }
})();

/********************************************************************************************
 *  SECTION 3 — SHUFFLING & DECK LOGIC
 ********************************************************************************************/

// Standard Fisher–Yates shuffle
function fisherYates(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
}

/**
 * Builds a fresh shuffled deck for a room.
 * Clears any existing draw_pile for that room first.
 */
async function buildShuffledDeck(roomId) {
  // Load card definitions
  const types = await pool.query(
    "SELECT value, count FROM card_types ORDER BY value"
  );

  // Build raw deck
  let deck = [];
  types.rows.forEach(row => {
    for (let i = 0; i < row.count; i++) {
      deck.push({ value: row.value });
    }
  });

  // Shuffle
  fisherYates(deck);

  // Clear old draw pile
  await pool.query("DELETE FROM draw_pile WHERE room_id = $1", [roomId]);

  // Insert shuffled deck
  for (let i = 0; i < deck.length; i++) {
    await pool.query(
      "INSERT INTO draw_pile (room_id, position, value) VALUES ($1, $2, $3)",
      [roomId, i, deck[i].value]
    );
  }
}

/**
 * Ensures a deck exists; if not, build a fresh one.
 */
async function ensureDeck(roomId) {
  const check = await pool.query(
    "SELECT COUNT(*) FROM draw_pile WHERE room_id = $1",
    [roomId]
  );
  if (parseInt(check.rows[0].count, 10) > 0) return;
  await buildShuffledDeck(roomId);
}

/********************************************************************************************
 *  SECTION 4 — STATE PACKING FOR CLIENT
 ********************************************************************************************/

async function getState(roomId) {
  const roomRes = await pool.query(
    "SELECT * FROM rooms WHERE id = $1",
    [roomId]
  );
  if (!roomRes.rows.length) return null;
  const room = roomRes.rows[0];

  const deckCountRes = await pool.query(
    "SELECT COUNT(*) FROM draw_pile WHERE room_id = $1",
    [roomId]
  );

  return {
    roomId,
    code: room.code,
    deckCount: parseInt(deckCountRes.rows[0].count, 10)
  };
}

/********************************************************************************************
 *  SECTION 5 — EXPRESS ROUTES (REST API)
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
 * Player join / rejoin (simplified):
 *   - Creates room if it doesn't exist
 *   - Enforces unique active names per room
 *   - No room.locked logic yet
 */
app.post("/api/player/join", async (req, res) => {
  try {
    const { name, roomCode } = req.body;
    const code = String(roomCode || "").trim().toUpperCase();
    const cleanName = String(name || "").trim();

    if (!cleanName || !code) {
      return res.status(400).json({ error: "Missing name or room code." });
    }

    // Load or create room
    const roomRes = await pool.query(
      "SELECT * FROM rooms WHERE code = $1",
      [code]
    );

    let room;
    if (!roomRes.rows.length) {
      const createRes = await pool.query(
        `INSERT INTO rooms (code)
         VALUES ($1)
         RETURNING *`,
        [code]
      );
      room = createRes.rows[0];
    } else {
      room = roomRes.rows[0];
    }

    // Check for existing active player with same name
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
      // Rejoining disconnected player
      playerId = existing.player_id;
    } else {
      // New player
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

/********************************************************************************************
 *  SECTION 6 — SOCKET.IO LOGIC (SHUFFLE ONLY)
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

      // Prevent multiple devices for same player
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

      socket.join(code);

      // Ensure deck exists
      await ensureDeck(room.id);

      const state = await getState(room.id);
      io.to(code).emit("stateUpdate", state);
    } catch (err) {
      console.error("joinRoom error:", err);
    }
  });

  /**
   * SHUFFLE DECK
   *   - Rebuilds and shuffles the entire deck for the room
   *   - Broadcasts updated state
   */
  socket.on("shuffleDeck", async ({ roomCode }) => {
    try {
      const code = String(roomCode || "").trim().toUpperCase();

      const roomRes = await pool.query(
        "SELECT * FROM rooms WHERE code = $1",
        [code]
      );
      if (!roomRes.rows.length) return;
      const room = roomRes.rows[0];

      // Rebuild + shuffle entire deck
      await buildShuffledDeck(room.id);

      const state = await getState(room.id);
      io.to(code).emit("stateUpdate", state);
    } catch (err) {
      console.error("shuffleDeck error:", err);
    }
  });

  /**
   * DISCONNECT — mark player disconnected (no pause/turn logic here)
   */
  socket.on("disconnect", async () => {
    try {
      await pool.query(
        `UPDATE room_players
         SET connected = FALSE, socket_id = NULL
         WHERE socket_id = $1`,
        [socket.id]
      );
    } catch (err) {
      console.error("disconnect cleanup error:", err);
    }
  });
});

/********************************************************************************************
 *  SECTION 7 — SERVER START
 ********************************************************************************************/

const PORT = process.env.PORT || 3000;
server.listen(PORT, () =>
  console.log("Flip‑to‑6 minimal shuffle server running on port", PORT)
);
