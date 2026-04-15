require('dotenv').config()
const express = require('express')
const cors = require('cors')
const { Pool } = require('pg')
const jwt = require('jsonwebtoken')
const passport = require('passport')
const GoogleStrategy = require('passport-google-oauth20').Strategy

const app = express()
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false })

app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:5173', credentials: true }))
app.use(express.json())

// ── DB INIT ──────────────────────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id SERIAL PRIMARY KEY,
      google_id TEXT UNIQUE NOT NULL,
      nombre TEXT,
      email TEXT,
      foto TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ramos (
      id SERIAL PRIMARY KEY,
      usuario_id INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
      nombre TEXT NOT NULL,
      min_aprobacion NUMERIC DEFAULT 4.0,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS evaluaciones (
      id SERIAL PRIMARY KEY,
      ramo_id INTEGER REFERENCES ramos(id) ON DELETE CASCADE,
      nombre TEXT NOT NULL,
      ponderacion NUMERIC NOT NULL,
      fecha DATE,
      nota NUMERIC,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `)
  console.log('✅ DB lista')
}

// ── AUTH MIDDLEWARE ───────────────────────────────────────
function authMiddleware(req, res, next) {
  const header = req.headers.authorization
  if (!header) return res.status(401).json({ error: 'No token' })
  const token = header.replace('Bearer ', '')
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET)
    next()
  } catch (e) {
    res.status(401).json({ error: 'Token inválido' })
  }
}

// ── GOOGLE OAUTH ──────────────────────────────────────────
passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: process.env.GOOGLE_CALLBACK_URL || 'http://localhost:3001/auth/google/callback'
}, async (accessToken, refreshToken, profile, done) => {
  try {
    const { rows } = await pool.query(
      `INSERT INTO usuarios (google_id, nombre, email, foto)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (google_id) DO UPDATE SET nombre=$2, foto=$4
       RETURNING *`,
      [profile.id, profile.displayName, profile.emails[0].value, profile.photos[0].value]
    )
    done(null, rows[0])
  } catch (e) { done(e) }
}))

app.use(passport.initialize())

app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'], session: false }))

app.get('/auth/google/callback',
  passport.authenticate('google', { session: false, failureRedirect: `${process.env.FRONTEND_URL}?error=auth` }),
  (req, res) => {
    const token = jwt.sign({ id: req.user.id, email: req.user.email }, process.env.JWT_SECRET, { expiresIn: '30d' })
    const user = encodeURIComponent(JSON.stringify({ id: req.user.id, nombre: req.user.nombre, email: req.user.email, foto: req.user.foto, created_at: req.user.created_at }))
    res.redirect(`${process.env.FRONTEND_URL}?token=${token}&user=${user}`)
  }
)

// ── RAMOS ─────────────────────────────────────────────────
app.get('/ramos', authMiddleware, async (req, res) => {
  try {
    const { rows: ramos } = await pool.query(
      'SELECT * FROM ramos WHERE usuario_id = $1 ORDER BY created_at DESC',
      [req.user.id]
    )
    for (const ramo of ramos) {
      const { rows: evs } = await pool.query(
        'SELECT * FROM evaluaciones WHERE ramo_id = $1 ORDER BY created_at ASC',
        [ramo.id]
      )
      ramo.evaluaciones = evs
    }
    res.json(ramos)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.post('/ramos', authMiddleware, async (req, res) => {
  try {
    const { nombre, min_aprobacion, nota_eximicion, condiciones_eximicion, ponderacion_examen, sin_rojos } = req.body
    const { rows } = await pool.query(
      'INSERT INTO ramos (usuario_id, nombre, min_aprobacion, nota_eximicion, condiciones_eximicion, ponderacion_examen, sin_rojos) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
      [req.user.id, nombre, min_aprobacion || 4.0, nota_eximicion || null, condiciones_eximicion || null, ponderacion_examen || 25, sin_rojos || false]
    )
    res.json({ ...rows[0], evaluaciones: [] })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.put('/ramos/:id', authMiddleware, async (req, res) => {
  try {
    const { nombre, min_aprobacion, nota_eximicion, condiciones_eximicion, ponderacion_examen, sin_rojos, evaluaciones, nota_examen, nota_final, estado_final } = req.body
    const ramoId = req.params.id

    const { rows: check } = await pool.query(
      'SELECT id FROM ramos WHERE id = $1 AND usuario_id = $2',
      [ramoId, req.user.id]
    )
    if (check.length === 0) return res.status(403).json({ error: 'No autorizado' })

    await pool.query(
      'UPDATE ramos SET nombre = $1, min_aprobacion = $2, nota_eximicion = $3, condiciones_eximicion = $4, ponderacion_examen = $5, sin_rojos = $6, nota_examen = $7, nota_final = $8, estado_final = $9 WHERE id = $10',
      [nombre, min_aprobacion, nota_eximicion || null, condiciones_eximicion || null, ponderacion_examen || 25, sin_rojos || false, nota_examen || null, nota_final || null, estado_final || null, ramoId]
    )

    if (evaluaciones) {
      await pool.query('DELETE FROM evaluaciones WHERE ramo_id = $1', [ramoId])
      for (const ev of evaluaciones) {
        await pool.query(
          'INSERT INTO evaluaciones (ramo_id, nombre, ponderacion, fecha, nota) VALUES ($1, $2, $3, $4, $5)',
          [ramoId, ev.nombre, ev.ponderacion, ev.fecha || null, ev.nota || null]
        )
      }
    }

    const { rows: updated } = await pool.query('SELECT * FROM ramos WHERE id = $1', [ramoId])
    const { rows: evs } = await pool.query('SELECT * FROM evaluaciones WHERE ramo_id = $1 ORDER BY created_at ASC', [ramoId])
    res.json({ ...updated[0], evaluaciones: evs })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.delete('/ramos/:id', authMiddleware, async (req, res) => {
  try {
    const { rows: check } = await pool.query(
      'SELECT id FROM ramos WHERE id = $1 AND usuario_id = $2',
      [req.params.id, req.user.id]
    )
    if (check.length === 0) return res.status(403).json({ error: 'No autorizado' })
    await pool.query('DELETE FROM ramos WHERE id = $1', [req.params.id])
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

const planesRouter = require('./routes/planes')
app.use('/planes', authMiddleware, planesRouter)
const evaluacionesIARouter = require('./routes/evaluaciones_ia')
app.use('/evaluaciones-ia', authMiddleware, evaluacionesIARouter)

app.get('/health', (req, res) => res.json({ status: 'ok' }))

// ── START ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3001
initDB().then(() => {
  app.listen(PORT, () => console.log(`🚀 Backend corriendo en puerto ${PORT}`))
}).catch(e => { console.error('Error iniciando DB:', e); process.exit(1) })
