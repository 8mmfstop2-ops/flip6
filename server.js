/* ============================================================
   Flip‑to‑6 — Full Multiplayer Game Server
   Rooms • Players • Deck • Draw Pile • Discard • Hands • Scoring
   ============================================================ */

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

/* ============================================================
   DATABASE TABLES
   ============================================================ */

(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS card_types (
        value TEXT PRIMARY KEY,
        filename TEXT NOT NULL,
        count INT NOT NULL
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS rooms (
        id SERIAL PRIMARY KEY,
        code TEXT UNIQUE NOT NULL,
        locked BOOLEAN NOT NULL DEFAULT FALSE,
        current_player_id INT,
        round_number INT NOT NULL DEFAULT 1,
        round_over BOOLEAN NOT NULL DEFAULT FALSE
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS room_players (
        id SERIAL PRIMARY KEY,
        room_id INT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        order_index INT NOT NULL,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        stayed BOOLEAN NOT NULL DEFAULT FALSE,
        total_score INT NOT NULL DEFAULT 0,
        socket_id TEXT
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS draw_pile (
        id SERIAL PRIMARY KEY,
        room_id INT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        position INT NOT NULL,
        value TEXT NOT NULL
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS discard_pile (
        id SERIAL PRIMARY KEY,
        room_id INT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        position INT NOT NULL,
        value TEXT NOT NULL
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS player_hands (
        id SERIAL PRIMARY KEY,
        room_id INT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        player_id INT NOT NULL REFERENCES room_players(id) ON DELETE CASCADE,
        position INT NOT NULL,
        value TEXT NOT NULL
      );
    `);

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

/* ============================================================
   SHUFFLE HELPERS
   ============================================================ */

function fisherYates(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
}

function forceStreak(deck, length) {
  const start = Math.floor(Math.random() * (deck.length - length + 1));
  for (let offset = 0; offset < deck.length - length + 1; offset++) {
    const i = (start + offset) % (deck.length - length + 1);
    let streak = true;
    for (let j = 1; j < length; j++) {
      if (deck[i] !== deck[i + j]) {
        streak = false;
        break;
      }
    }
    if (!streak) {
      const idx = deck.indexOf(deck[i], i + length);
      if (idx !== -1) {
        [deck[i + length - 1], deck[idx]] = [deck[idx], deck[i + length - 1]];
        return true;
      }
    }
  }
  return false;
}

function isAction(value) {
  return !/^(?:[0-9]|1[0-2])$/.test(value);
}

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

  const maxActions = 14;
  const actionsToUse = actionCards.slice(0, maxActions);

  let result = [...numberCards];
  let insertPos = Math.floor(Math.random() * (18 - 7 + 1)) + 7;

  for (let i = 0; i < actionsToUse.length; i++) {
    result.splice(insertPos, 0, actionsToUse[i]);

    if (Math.random() < 0.25 && i + 1 < actionsToUse.length) {
      result.splice(insertPos + 1, 0, actionsToUse[i + 1]);
      i++;
    }

    insertPos += Math.floor(Math.random() * (8 - 2 + 1)) + 2;
    if (insertPos > result.length - 1) insertPos = result.length - 1;
  }

  return result;
}

/* ============================================================
   DECK INITIALIZATION FOR A ROOM
   ============================================================ */

async function ensureDeck(roomId) {
  const check = await pool.query(
    "SELECT COUNT(*) FROM draw_pile WHERE room_id = $1",
    [roomId]
  );
  if (parseInt(check.rows[0].count, 10) > 0) return;

  const types = await pool.query("SELECT value, count FROM card_types ORDER BY value");
  let deck = [];
  types.rows.forEach(row => {
    for (let i = 0; i < row.count; i++) deck.push({ value: row.value });
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

/* ============================================================
   DRAW CARD LOGIC
   ============================================================ */

async function popTopCard(roomId) {
  let res = await pool.query(
    "SELECT * FROM draw_pile WHERE room_id = $1 ORDER BY position LIMIT 1",
    [roomId]
  );

  if (!res.rows.length) {
    const d = await pool.query(
      "SELECT value FROM discard_pile WHERE room_id = $1 ORDER BY position",
      [roomId]
    );
    let deck = d.rows.map(r => ({ value: r.value }));
    deck = hybridShuffle(deck);

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

async function addToHand(roomId, playerId, value) {
  await pool.query(
    `INSERT INTO player_hands (room_id, player_id, position, value)
     VALUES ($1, $2, EXTRACT(EPOCH FROM NOW())::BIGINT, $3)`,
    [roomId, playerId, value]
  );
}

async function addToDiscard(roomId, value) {
  await pool.query(
    `INSERT INTO discard_pile (room_id, position, value)
     VALUES ($1, EXTRACT(EPOCH FROM NOW())::BIGINT, $2)`,
    [roomId, value]
  );
}

async function playerHas(roomId, playerId, value) {
  const res = await pool.query(
    "SELECT id FROM player_hands WHERE room_id = $1 AND player_id = $2 AND value = $3",
    [roomId, playerId, value]
  );
  return res.rows;
}

async function playerHasNumber(roomId, playerId, value) {
  const res = await pool.query(
    "SELECT id FROM player_hands WHERE room_id = $1 AND player_id = $2 AND value = $3",
    [roomId, playerId, value]
  );
  return res.rows.length > 0;
}

async function drawCard(roomId, playerId, forced = false) {
  const value = await popTopCard(roomId);
  const isNumber = /^(?:[0-9]|1[0-2])$/.test(value);
  const scoring = ["2x", "4+", "5+", "6-", "Second Chance"];
  const instant = ["Freeze", "Swap", "Take 3"];

  if (isNumber) {
    const dup = await playerHasNumber(roomId, playerId, value);
    await addToHand(roomId, playerId, value);

    if (dup && !forced) {
      const sc = await playerHas(roomId, playerId, "Second Chance");
      if (sc.length) {
        const newCard = await pool.query(
          `SELECT id FROM player_hands
           WHERE room_id = $1 AND player_id = $2 AND value = $3
           ORDER BY position DESC LIMIT 1`,
          [roomId, playerId, value]
        );

        await pool.query("DELETE FROM player_hands WHERE id = $1", [newCard.rows[0].id]);
        await pool.query("DELETE FROM player_hands WHERE id = $1", [sc[0].id]);

        await addToDiscard(roomId, value);
        await addToDiscard(roomId, "Second Chance");

        return await drawCard(roomId, playerId, true);
      }
    }

    return;
  }

  if (scoring.includes(value)) {
    await addToHand(roomId, playerId, value);
    return;
  }

  if (instant.includes(value)) {
    await addToDiscard(roomId, value);

    if (value === "Take 3") {
      for (let i = 0; i < 3; i++) {
        await drawCard(roomId, playerId, true);
      }
    }
    return;
  }

  await addToDiscard(roomId, value);
}

/* ============================================================
   TURN ORDER
   ============================================================ */

async function advanceTurn(roomId) {
  const players = await pool.query(
    "SELECT id, order_index, active, stayed FROM room_players WHERE room_id = $1 ORDER BY order_index",
    [roomId]
  );

  const room = await pool.query("SELECT current_player_id FROM rooms WHERE id = $1", [roomId]);
  let current = room.rows[0].current_player_id;

  if (!current) {
    const first = players.rows.find(p => p.active && !p.stayed);
    if (first) {
      await pool.query("UPDATE rooms SET current_player_id = $1 WHERE id = $2", [first.id, roomId]);
    }
    return;
  }

  const list = players.rows;
  const cur = list.find(p => p.id === current);
  let idx = cur.order_index;

  let next = null;
  for (let i = 0; i < list.length; i++) {
    idx = (idx + 1) % list.length;
    if (list[idx].active && !list[idx].stayed) {
      next = list[idx].id;
      break;
    }
  }

  if (next) {
    await pool.query("UPDATE rooms SET current_player_id = $1 WHERE id = $2", [next, roomId]);
  } else {
    await pool.query("UPDATE rooms SET round_over = TRUE WHERE id = $1", [roomId]);
  }
}

/* ============================================================
   SCORING
   ============================================================ */

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
  }

  return score * mult;
}

async function endRound(roomId) {
  const room = await pool.query("SELECT * FROM rooms WHERE id = $1", [roomId]);
  const round = room.rows[0].round_number;

  const players = await pool.query(
    "SELECT id FROM room_players WHERE room_id = $1 AND active = TRUE ORDER BY order_index",
    [roomId]
  );

  for (const p of players.rows) {
    const pid = p.id;
    const score = await computeScore(roomId, pid);

    await pool.query(
      "INSERT INTO round_scores (room_id, player_id, round_number, score) VALUES ($1, $2, $3, $4)",
      [roomId, pid, round, score]
    );

    await pool.query(
      "UPDATE room_players SET total_score = total_score + $1 WHERE id = $2",
      [score, pid]
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
  await pool.query("UPDATE room_players SET stayed = FALSE WHERE room_id = $1", [roomId]);
  await pool.query(
    "UPDATE rooms SET round_number = round_number + 1, round_over = FALSE WHERE id = $1",
    [roomId]
  );

  await ensureDeck(roomId);
  await advanceTurn(roomId);
}

/* ============================================================
   STATE PACKAGE
   ============================================================ */

async function getState(roomId) {
  const room = await pool.query("SELECT * FROM rooms WHERE id = $1", [roomId]);
  const players = await pool.query(
    "SELECT id, name, order_index, active, stayed, total_score FROM room_players WHERE room_id = $1 ORDER BY order_index",
    [roomId]
  );
  const hands = await pool.query(
    "SELECT player_id, value FROM player_hands WHERE room_id = $1 ORDER BY position",
    [roomId]
  );
  const deckCount = await pool.query(
    "SELECT COUNT(*) FROM draw_pile WHERE room_id = $1",
    [roomId]
  );
  const discardCount = await pool.query(
    "SELECT COUNT(*) FROM discard_pile WHERE room_id = $1",
    [roomId]
  );

  const topCards = await pool.query(
    `SELECT value FROM draw_pile
     WHERE room_id = $1
     ORDER BY position ASC
     LIMIT 5`,
    [roomId]
  );

  return {
    roomId,
    code: room.rows[0].code,
    locked: room.rows[0].locked,
    currentPlayerId: room.rows[0].current_player_id,
    roundNumber: room.rows[0].round_number,
    roundOver: room.rows[0].round_over,
    players: players.rows,
    hands: hands.rows,
    deckCount: parseInt(deckCount.rows[0].count, 10),
    discardCount: parseInt(discardCount.rows[0].count, 10),
    topDrawCards: topCards.rows.map(r => r.value)
  };
}

/* ============================================================
   API ENDPOINTS
   ============================================================ */

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

      // Action cards
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

    res.json({ success: true, message: "Flip‑to‑6 deck initialized." });
  } catch (err) {
    console.error("init-deck error:", err);
    res.status(500).json({ success: false, error: "Initialization failed." });
  }
});

app.post("/api/player/join", async (req, res) => {
  try {
    const { name, roomCode } = req.body;
    const code = roomCode.toUpperCase();

    let roomRes = await pool.query("SELECT * FROM rooms WHERE code = $1", [code]);
    if (!roomRes.rows.length) {
      const created = await pool.query(
        "INSERT INTO rooms (code, locked) VALUES ($1, FALSE) RETURNING *",
        [code]
      );
      roomRes = created;
    }
    const room = roomRes.rows[0];

    if (room.locked) {
      return res.status(400).json({ error: "Room locked. Game already started." });
    }

    const playersRes = await pool.query(
      "SELECT * FROM room_players WHERE room_id = $1 AND active = TRUE ORDER BY order_index",
      [room.id]
    );
    if (playersRes.rows.length >= 6) {
      return res.status(400).json({ error: "Room is full (6 players)." });
    }

    const orderIndex = playersRes.rows.length;
    const inserted = await pool.query(
      `INSERT INTO room_players (room_id, name, order_index, active, stayed)
       VALUES ($1, $2, $3, TRUE, FALSE)
       RETURNING id`,
      [room.id, name, orderIndex]
    );
    const playerId = inserted.rows[0].id;

    res.json({
      redirect: `/room/${code}?playerId=${playerId}`
    });
  } catch (err) {
    console.error("player/join error:", err);
    res.status(500).json({ error: "Join failed." });
  }
});

app.get("/room/:code", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "table.html"));
});


/*----- Draw Pile API for cards.html ----- */

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


// Returns mapping of card value -> filename (for PNGs)
app.get("/api/cards/meta", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT value, filename FROM card_types ORDER BY value"
    );
    res.json({
      success: true,
      cards: result.rows // [{ value, filename }, ...]
    });
  } catch (err) {
    console.error("cards/meta error:", err);
    res.status(500).json({ success: false, error: "Failed to load card metadata" });
  }
});




/*----- Socket.io Events ----- */
io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  socket.on("joinRoom", async ({ roomCode, playerId }) => {
    try {
      const roomRes = await pool.query("SELECT * FROM rooms WHERE code = $1", [roomCode]);
      if (!roomRes.rows.length) return;
      const room = roomRes.rows[0];

      const playerRes = await pool.query(
        "SELECT * FROM room_players WHERE id = $1 AND room_id = $2 AND active = TRUE",
        [playerId, room.id]
      );
      if (!playerRes.rows.length) return;

      await pool.query(
        "UPDATE room_players SET socket_id = $1 WHERE id = $2",
        [socket.id, playerId]
      );

      socket.join(roomCode);

      if (!room.current_player_id) {
        await advanceTurn(room.id);
      }

      const state = await getState(room.id);
      socket.emit("stateUpdate", state);
    } catch (err) {
      console.error("joinRoom error:", err);
    }
  });

  socket.on("drawCard", async ({ roomCode, playerId }) => {
    try {
      const roomRes = await pool.query("SELECT * FROM rooms WHERE code = $1", [roomCode]);
      if (!roomRes.rows.length) return;
      const room = roomRes.rows[0];

      if (room.current_player_id !== playerId || room.round_over) return;

      if (!room.locked) {
        await pool.query("UPDATE rooms SET locked = TRUE WHERE id = $1", [room.id]);
      }

      await ensureDeck(room.id);
      await drawCard(room.id, playerId, false);
      await advanceTurn(room.id);

      const state = await getState(room.id);
      io.to(roomCode).emit("stateUpdate", state);
    } catch (err) {
      console.error("drawCard error:", err);
    }
  });

  socket.on("stay", async ({ roomCode, playerId }) => {
    try {
      const roomRes = await pool.query("SELECT * FROM rooms WHERE code = $1", [roomCode]);
      if (!roomRes.rows.length) return;
      const room = roomRes.rows[0];

      if (room.current_player_id !== playerId || room.round_over) return;

      await pool.query(
        "UPDATE room_players SET stayed = TRUE WHERE id = $1 AND room_id = $2",
        [playerId, room.id]
      );

      const pRes = await pool.query(
        "SELECT stayed, active FROM room_players WHERE room_id = $1",
        [room.id]
      );
      const allStayed = pRes.rows.filter(p => p.active).every(p => p.stayed);

      if (allStayed) {
        await pool.query("UPDATE rooms SET round_over = TRUE WHERE id = $1", [room.id]);
      } else {
        await advanceTurn(room.id);
      }

      const state = await getState(room.id);
      io.to(roomCode).emit("stateUpdate", state);
    } catch (err) {
      console.error("stay error:", err);
    }
  });

  socket.on("endRound", async ({ roomCode }) => {
    try {
      const roomRes = await pool.query("SELECT * FROM rooms WHERE code = $1", [roomCode]);
      if (!roomRes.rows.length) return;
      const room = roomRes.rows[0];

      if (!room.round_over) return;

      await endRound(room.id);
      const state = await getState(room.id);
      io.to(roomCode).emit("stateUpdate", state);
    } catch (err) {
      console.error("endRound error:", err);
    }
  });

  socket.on("removePlayer", async ({ roomCode, name }) => {
    try {
      const roomRes = await pool.query("SELECT * FROM rooms WHERE code = $1", [roomCode]);
      if (!roomRes.rows.length) return;
      const room = roomRes.rows[0];

      await pool.query(
        "UPDATE room_players SET active = FALSE, stayed = TRUE WHERE room_id = $1 AND name = $2",
        [room.id, name]
      );

      const state = await getState(room.id);
      io.to(roomCode).emit("stateUpdate", state);
    } catch (err) {
      console.error("removePlayer error:", err);
    }
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
  });
});


/* ----- Start Server ----- */
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log("Flip‑to‑6 server running on port " + PORT));

