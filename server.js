/********************************************************************************************
 *  Flip‑to‑X — Minimal Starter Server
 *  -----------------------------------------------------------------------------------------
 *  This server:
 *    - Connects to PostgreSQL
 *    - Initializes a simple "readme" table
 *    - Inserts "Hello World" if empty
 *    - Serves index.html
 *    - Provides /api/readme to fetch the value
 ********************************************************************************************/

import express from "express";
import pg from "pg";
import path from "path";
import { fileURLToPath } from "url";

/********************************************************************************************
 *  SECTION 1 — BASIC SERVER SETUP
 ********************************************************************************************/

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Serve static files from /public
app.use(express.static(path.join(__dirname, "public")));

// Parse JSON bodies
app.use(express.json());

// PostgreSQL connection
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

/********************************************************************************************
 *  SECTION 2 — DATABASE INITIALIZATION
 ********************************************************************************************/

(async () => {
  try {
    // Create table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS readme (
        value TEXT
      );
    `);

    // Check if empty
    const check = await pool.query(`SELECT COUNT(*) FROM readme`);
    const count = parseInt(check.rows[0].count, 10);

    // Insert default value
    if (count === 0) {
      await pool.query(`
        INSERT INTO readme (value)
        VALUES ('Hello World');
      `);
      console.log("Initialized readme table with default value.");
    }

  } catch (err) {
    console.error("Database initialization error:", err);
  }
})();

/********************************************************************************************
 *  SECTION 3 — API ROUTES
 ********************************************************************************************/

// GET /api/readme → returns the text from the database
app.get("/api/readme", async (req, res) => {
  try {
    const result = await pool.query("SELECT value FROM readme LIMIT 1");
    res.json({ text: result.rows[0].value });
  } catch (err) {
    console.error("readme fetch error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

/********************************************************************************************
 *  SECTION 4 — FRONTEND ROUTE
 ********************************************************************************************/

// Serve index.html for root
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/********************************************************************************************
 *  SECTION 5 — START SERVER
 ********************************************************************************************/

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log("Minimal server running on port", PORT)
);
