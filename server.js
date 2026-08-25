const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('./db');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || 'supersecret_instapay_key_for_local_dev';

// Middleware to authenticate JWT
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.sendStatus(401);

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
};

// Auth routes
app.post('/register', async (req, res) => {
  const { username, password, email } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (username, password, email) VALUES ($1, $2, $3) RETURNING id, username, email',
      [username, hashedPassword, email || null]
    );
    const user = result.rows[0];
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET);
    res.json({ token, user });
  } catch (error) {
    if (error.code === '23505') { // Postgres unique violation code
      res.status(400).json({ error: 'Username already exists' });
    } else {
      console.error(error);
      res.status(500).json({ error: 'Database error' });
    }
  }
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  
  try {
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (result.rows.length === 0) return res.status(400).json({ error: 'User not found' });

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ error: 'Invalid password' });

    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET);
    res.json({ token, user: { id: user.id, username: user.username, email: user.email } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Persons routes
app.get('/persons', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM persons WHERE user_id = $1', [req.user.id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/persons', authenticateToken, async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });

  try {
    const result = await pool.query(
      'INSERT INTO persons (user_id, name) VALUES ($1, $2) RETURNING *',
      [req.user.id, name]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

app.delete('/persons/:id', authenticateToken, async (req, res) => {
  const personId = req.params.id;
  try {
    await pool.query('DELETE FROM persons WHERE id = $1 AND user_id = $2', [personId, req.user.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// Transactions routes
app.get('/transactions', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT t.*, p.name as person_name 
      FROM transactions t 
      JOIN persons p ON t.person_id = p.id 
      WHERE t.user_id = $1 
      ORDER BY t.date DESC
    `, [req.user.id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/transactions', authenticateToken, async (req, res) => {
  const { person_id, amount, date, description } = req.body;
  if (!person_id || amount === undefined) return res.status(400).json({ error: 'Person and Amount required' });
  const txDate = date || new Date().toISOString();

  try {
    const result = await pool.query(
      'INSERT INTO transactions (user_id, person_id, amount, date, description) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [req.user.id, person_id, amount, txDate, description || '']
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// Monthly summary route
app.get('/summary', authenticateToken, async (req, res) => {
  const { month, year } = req.query; 
  
  let query = `
    SELECT p.id as person_id, p.name, SUM(t.amount) as total_amount 
    FROM persons p 
    LEFT JOIN transactions t ON p.id = t.person_id AND t.user_id = $1 
  `;
  const params = [req.user.id];

  if (month && year) {
    query += ` AND to_char(t.date, 'YYYY-MM') = $2 `;
    params.push(`${year}-${month.padStart(2, '0')}`);
  }

  query += ` WHERE p.user_id = $${params.length + 1} GROUP BY p.id`;
  params.push(req.user.id);

  try {
    const result = await pool.query(query, params);
    // Replace null totals with 0
    const summary = result.rows.map(s => ({ ...s, total_amount: parseFloat(s.total_amount) || 0 }));
    res.json(summary);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// For Render deployment, we also add a basic health check route
app.get('/', (req, res) => res.send('API is running'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log("Backend running on port " + PORT);
});
