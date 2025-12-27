/* setup → helpers → APIs → socket events → start */

/* ---------------- Setup ---------------- */
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

/* ---------------- Initialize Tables ---------------- */
(async () => {
  try {
    // table for card types + counts
    await pool.query(`
      CREATE TABLE IF NOT EXISTS card_types (
        value TEXT PRIMARY KEY,
        filename TEXT NOT NULL,
        count INT NOT NULL
      );
    `);

    // table for the actual deck sequence
    await pool.query(`
      CREATE TABLE IF NOT EXISTS deck (
        id SERIAL PRIMARY KEY,
        position INT NOT NULL,
        value TEXT NOT NULL
      );
    `);

    console.log("Tables ensured.");
  } catch (err) {
    console.error("Error initializing tables:", err);
  }
})();

/* ---------------- Helpers ---------------- */

// Fisher–Yates shuffle
function fisherYates(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
}

// Force a streak of n identical cards at a random location
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

// spread ActionCards shuffle
// Guarantees no clumping unless mathematically unavoidable

// ------------------------------------------------------------
//  ACTION DETECTION
// ------------------------------------------------------------
function isAction(value) {
  const num = parseInt(value, 10);
  return isNaN(num) || num < 0 || num > 12;
}

// ------------------------------------------------------------
//  ADVANCED ACTION SPACING (EVEN DISTRIBUTION)
// ------------------------------------------------------------
function advancedActionSpacing(deck) {
  const numberCards = [];
  const actionCards = [];

  for (const value of deck) {
    if (isAction(value)) actionCards.push(value);
    else numberCards.push(value);
  }

  // Shuffle both groups independently
  fisherYates(numberCards);
  fisherYates(actionCards);

  if (actionCards.length === 0) return numberCards;

  const result = [];
  const gaps = actionCards.length + 1;
  const gapSize = Math.ceil(numberCards.length / gaps);

  let numIndex = 0;
  let actIndex = 0;

  for (let g = 0; g < gaps; g++) {
    // Insert number block
    for (let i = 0; i < gapSize && numIndex < numberCards.length; i++) {
      result.push(numberCards[numIndex++]);
    }

    // Insert one action card
    if (actIndex < actionCards.length) {
      result.push(actionCards[actIndex++]);
    }
  }

  return result;
}

// ------------------------------------------------------------
//  RULE: IDENTICAL ACTION CARDS MUST BE ≥ 4 SPACES APART
// ------------------------------------------------------------
function enforceActionSpacingRules(deck) {
  for (let i = 0; i < deck.length; i++) {
    if (!isAction(deck[i])) continue;

    // Check next 4 positions
    for (let j = 1; j <= 4 && i + j < deck.length; j++) {
      if (deck[i] === deck[i + j]) {

        // Find a swap candidate further away
        let swapIndex = -1;

        for (let k = i + 5; k < deck.length; k++) {
          if (deck[k] !== deck[i]) {
            swapIndex = k;
            break;
          }
        }

        // Swap if possible
        if (swapIndex !== -1) {
          const temp = deck[i + j];
          deck[i + j] = deck[swapIndex];
          deck[swapIndex] = temp;
        }
      }
    }
  }

  return deck;
}

// ------------------------------------------------------------
//  RULE: NO TWO "6-" CARDS NEXT TO EACH OTHER
// ------------------------------------------------------------
function preventSequentialSixMinus(deck) {
  const target = "6-";

  for (let i = 0; i < deck.length - 1; i++) {
    if (deck[i] === target && deck[i + 1] === target) {

      let swapIndex = -1;

      // Look forward
      for (let j = i + 2; j < deck.length; j++) {
        if (deck[j] !== target) {
          swapIndex = j;
          break;
        }
      }

      // Look backward
      if (swapIndex === -1) {
        for (let j = i - 1; j >= 0; j--) {
          if (deck[j] !== target) {
            swapIndex = j;
            break;
          }
        }
      }

      if (swapIndex !== -1) {
        const temp = deck[i + 1];
        deck[i + 1] = deck[swapIndex];
        deck[swapIndex] = temp;
      }
    }
  }

  return deck;
}

// ------------------------------------------------------------
//  RULE: "TAKE 3" CANNOT APPEAR IN FIRST 8 CARDS
// ------------------------------------------------------------
function preventTake3InFirst8(deck) {
  const target = "Take 3";

  for (let i = 0; i < 8; i++) {
    if (deck[i] === target) {

      let swapIndex = -1;

      for (let j = 8; j < deck.length; j++) {
        if (deck[j] !== target) {
          swapIndex = j;
          break;
        }
      }

      if (swapIndex !== -1) {
        const temp = deck[i];
        deck[i] = deck[swapIndex];
        deck[swapIndex] = temp;
      }
    }
  }

  return deck;
}

// ------------------------------------------------------------
//  FINAL HYBRID SHUFFLE PIPELINE
// ------------------------------------------------------------
function hybridShuffle(deck, streakLengths = [2, 3]) {
  // Base shuffle
  fisherYates(deck);

  // Apply streak rules
  for (const length of streakLengths) {
    forceStreak(deck, length);
  }

  // Advanced spacing
  deck = advancedActionSpacing(deck);

  // Identical action spacing rule
  deck = enforceActionSpacingRules(deck);

  // No two 6- next to each other
  deck = preventSequentialSixMinus(deck);

  // Take 3 cannot be in first 8 cards
  deck = preventTake3InFirst8(deck);

  return deck;
}




/* ---------------- APIs ---------------- */

/* ---> Initialize card_types with fixed counts <---- */
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

    res.json({ success: true, message: "Deck initialized with filenames." });
  } catch (err) {
    console.error("init-deck error:", err);
    res.status(500).json({ success: false, error: "Initialization failed." });
  }
});


/**
 * Shuffle deck using hybrid shuffle, store in deck table, return sequence
 */
app.post("/api/shuffle-deck", async (req, res) => {
  try {
    // 1. Load card types
    const result = await pool.query("SELECT value, count FROM card_types ORDER BY value");
    const rows = result.rows;

    if (rows.length === 0) {
      return res.status(400).json({ success: false, error: "Deck not initialized." });
    }

    // 2. Expand into full deck
    let deck = [];
    for (const row of rows) {
      for (let i = 0; i < row.count; i++) {
        deck.push(row.value);
      }
    }

    // 3. Shuffle
    hybridShuffle(deck);

    // 4. Save shuffled deck
    await pool.query("DELETE FROM deck");
    for (let i = 0; i < deck.length; i++) {
      await pool.query(
        "INSERT INTO deck (position, value) VALUES ($1, $2)",
        [i, deck[i]]
      );
    }

    // 5. Emit via socket and respond
    io.emit("deckUpdated", deck);
    res.json({ success: true, deck });
  } catch (err) {
    console.error("shuffle-deck error:", err);
    res.status(500).json({ success: false, error: "Shuffle failed." });
  }
});

/**
 * Optional: get last shuffled deck
 */
app.get("/api/deck", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT position, value FROM deck ORDER BY position ASC"
    );
    res.json({ success: true, deck: result.rows });
  } catch (err) {
    console.error("get deck error:", err);
    res.status(500).json({ success: false, error: "Failed to get deck." });
  }
});

/* ---------------- Socket events ---------------- */

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
  });
});

/* ---------------- Start Server ---------------- */

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log("Server running on port " + PORT));





