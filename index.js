require('dotenv').config()
const express = require('express')
const cors = require('cors')
const cookieParser = require('cookie-parser')
const passport = require('passport')
const { Strategy: GoogleStrategy } = require('passport-google-oauth20')
const jwt = require('jsonwebtoken')
const { Pool } = require('pg')
const multer = require('multer')
const { GoogleGenerativeAI } = require('@google/generative-ai')

const app = express()
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } })

app.set('trust proxy', 1)

app.use(cors({
  origin: process.env.CLIENT_URL,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}))
app.use(express.json())
app.use(cookieParser())
app.use(passport.initialize())

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id SERIAL PRIMARY KEY,
      google_id VARCHAR(255) UNIQUE NOT NULL,
      nombre VARCHAR(255),
      email VARCHAR(255),
      avatar VARCHAR(500),
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ramos (
      id SERIAL PRIMARY KEY,
      usuario_id INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
      nombre VARCHAR(255) NOT NULL,
      min_aprobacion DECIMAL(3,1) DEFAULT 4.0,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS evaluaciones (
      id SERIAL PRIMARY KEY,
      ramo_id INTEGER REFERENCES ramos(id) ON DELETE CASCADE,
      nombre VARCHAR(255) NOT NULL,
      ponderacion INTEGER NOT NULL,
      nota DECIMAL(3,1),
      fecha DATE,
      plan_estudio JSONB,
      tareas_completadas INTEGER[] DEFAULT '{}',
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS archivos (
      id SERIAL PRIMARY KEY,
      evaluacion_id INTEGER REFERENCES evaluaciones(id) ON DELETE CASCADE,
      nombre VARCHAR(255),
      tipo VARCHAR(100),
      datos BYTEA,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `)
  console.log('Base de datos lista ✅')
}

passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: process.env.GOOGLE_CALLBACK_URL || 'http://localhost:3001/auth/google/callback'
}, async (accessToken, refreshToken, profile, done) => {
  try {
    const { rows } = await pool.query(
      `INSERT INTO usuarios (google_id, nombre, email, avatar)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (google_id) DO UPDATE
       SET nombre = $2, avatar = $4
       RETURNING *`,
      [profile.id, profile.displayName, profile.emails[0].value, profile.photos[0].value]
    )
    return done(null, rows[0])
  } catch (err) {
    return done(err)
  }
}))

app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'], session: false }))

app.get('/auth/google/callback',
  passport.authenticate('google', { session: false, failureRedirect: `${process.env.CLIENT_URL}?error=true` }),
  (req, res) => {
    const token = jwt.sign(
      { id: req.user.id, email: req.user.email },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    )
    res.redirect(`${process.env.CLIENT_URL}?token=${token}`)
  }
)

app.get('/auth/me', authenticateToken, async (req, res) => {
  const { rows } = await pool.query('SELECT id, nombre, email, avatar FROM usuarios WHERE id = $1', [req.user.id])
  if (!rows[0]) return res.status(401).json({ error: 'Usuario no encontrado' })
  const u = rows[0]
  res.json({ user: { id: u.id, name: u.nombre, email: u.email, picture: u.avatar } })
})

app.post('/auth/logout', (req, res) => {
  res.clearCookie('token', { httpOnly: true, secure: true, sameSite: 'none' })
  res.json({ ok: true })
})

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization']
  const token = (authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null)
    || req.cookies.token
  if (!token) return res.status(401).json({ error: 'No autorizado' })
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET)
    next()
  } catch {
    res.status(401).json({ error: 'Token inválido' })
  }
}

app.get('/ramos', authenticateToken, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT r.*, json_agg(
      json_build_object(
        'id', e.id,
        'nombre', e.nombre,
        'ponderacion', e.ponderacion,
        'nota', e.nota,
        'fecha', e.fecha,
        'plan_estudio', e.plan_estudio,
        'tareas_completadas', e.tareas_completadas,
        'archivos', (
          SELECT json_agg(json_build_object('id', a.id, 'nombre', a.nombre, 'tipo', a.tipo))
          FROM archivos a WHERE a.evaluacion_id = e.id
        )
      ) ORDER BY e.id
    ) as evaluaciones
     FROM ramos r
     LEFT JOIN evaluaciones e ON e.ramo_id = r.id
     WHERE r.usuario_id = $1
     GROUP BY r.id ORDER BY r.created_at DESC`,
    [req.user.id]
  )
  res.json(rows)
})

app.post('/ramos', authenticateToken, async (req, res) => {
  const { nombre, minAprobacion, evaluaciones } = req.body
  const { rows } = await pool.query(
    'INSERT INTO ramos (usuario_id, nombre, min_aprobacion) VALUES ($1, $2, $3) RETURNING *',
    [req.user.id, nombre, minAprobacion || 4.0]
  )
  const ramo = rows[0]
  for (const e of evaluaciones) {
    await pool.query(
      'INSERT INTO evaluaciones (ramo_id, nombre, ponderacion, nota, fecha) VALUES ($1, $2, $3, $4, $5)',
      [ramo.id, e.nombre, e.ponderacion, e.nota || null, e.fecha || null]
    )
  }
  const { rows: ramoCompleto } = await pool.query(
    `SELECT r.*, json_agg(
      json_build_object(
        'id', e.id, 'nombre', e.nombre, 'ponderacion', e.ponderacion,
        'nota', e.nota, 'fecha', e.fecha, 'plan_estudio', e.plan_estudio,
        'tareas_completadas', e.tareas_completadas, 'archivos', '[]'::json
      ) ORDER BY e.id
    ) as evaluaciones
     FROM ramos r
     LEFT JOIN evaluaciones e ON e.ramo_id = r.id
     WHERE r.id = $1
     GROUP BY r.id`,
    [ramo.id]
  )
  res.json(ramoCompleto[0])
})

app.put('/evaluaciones/:id/nota', authenticateToken, async (req, res) => {
  const { nota } = req.body
  await pool.query('UPDATE evaluaciones SET nota = $1 WHERE id = $2', [nota || null, req.params.id])
  res.json({ ok: true })
})

app.delete('/ramos/:id', authenticateToken, async (req, res) => {
  await pool.query('DELETE FROM ramos WHERE id = $1 AND usuario_id = $2', [req.params.id, req.user.id])
  res.json({ ok: true })
})

// Subir archivo
app.post('/evaluaciones/:id/archivos', authenticateToken, upload.single('archivo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No se recibió archivo' })
    const { rows } = await pool.query(
      'INSERT INTO archivos (evaluacion_id, nombre, tipo, datos) VALUES ($1, $2, $3, $4) RETURNING id, nombre, tipo',
      [req.params.id, req.file.originalname, req.file.mimetype, req.file.buffer]
    )
    res.json(rows[0])
  } catch (err) {
    console.error('Error subiendo archivo:', err)
    res.status(500).json({ error: 'Error al subir archivo' })
  }
})

// Eliminar archivo
app.delete('/archivos/:id', authenticateToken, async (req, res) => {
  await pool.query('DELETE FROM archivos WHERE id = $1', [req.params.id])
  res.json({ ok: true })
})

// Generar plan de estudio con IA
app.post('/evaluaciones/:id/plan-estudio', authenticateToken, async (req, res) => {
  try {
    const { rows: evRows } = await pool.query(
      `SELECT e.*, r.nombre as ramo_nombre,
        (SELECT json_agg(json_build_object('nombre', a.nombre, 'tipo', a.tipo, 'datos', encode(a.datos, 'base64')))
         FROM archivos a WHERE a.evaluacion_id = e.id) as archivos
       FROM evaluaciones e JOIN ramos r ON r.id = e.ramo_id
       WHERE e.id = $1`,
      [req.params.id]
    )
    if (!evRows[0]) return res.status(404).json({ error: 'Evaluación no encontrada' })
    const ev = evRows[0]

    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' })

    let prompt = `Eres un tutor universitario experto. Crea un plan de estudio detallado para un estudiante universitario chileno.

Ramo: ${ev.ramo_nombre}
Evaluación: ${ev.nombre} (${ev.ponderacion}% del ramo)
${ev.fecha ? `Fecha de evaluación: ${ev.fecha}` : ''}

Responde SOLO con un JSON válido con esta estructura exacta (sin markdown, sin bloques de código):
{
  "resumen": "descripción breve del plan en 1-2 oraciones",
  "tareas": [
    { "titulo": "título corto", "descripcion": "descripción detallada", "prioridad": "alta", "duracion": 45, "fecha": "" },
    { "titulo": "título corto", "descripcion": "descripción detallada", "prioridad": "media", "duracion": 30, "fecha": "" }
  ]
}

Genera 5 tareas. prioridad debe ser "alta", "media" o "baja". duracion en minutos (número). fecha puede ser string vacío.`

    const result = await model.generateContent(prompt)
    const text = result.response.text()
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error('No se pudo parsear respuesta de IA')
    const plan = JSON.parse(jsonMatch[0])

    await pool.query('UPDATE evaluaciones SET plan_estudio = $1 WHERE id = $2', [JSON.stringify(plan), req.params.id])
    res.json(plan)
  } catch (err) {
    console.error('Error generando plan:', err)
    res.status(500).json({ error: 'Error al generar plan de estudio' })
  }
})

// Actualizar progreso del plan
app.post('/evaluaciones/:id/plan-progreso', authenticateToken, async (req, res) => {
  const { completadas } = req.body
  await pool.query('UPDATE evaluaciones SET tareas_completadas = $1 WHERE id = $2', [completadas, req.params.id])
  res.json({ ok: true })
})

app.get('/health', (req, res) => res.json({ status: 'ok' }))

initDB().then(() => {
  app.listen(process.env.PORT || 3001, () => console.log(`Backend corriendo en puerto ${process.env.PORT || 3001} 🚀`))
})

// Actualizar progreso del plan
app.put('/evaluaciones/:id/plan-progreso', authenticateToken, async (req, res) => {
  try {
    const { tareas_completadas } = req.body
    await pool.query(
      'UPDATE evaluaciones SET tareas_completadas = $1 WHERE id = $2',
      [tareas_completadas, req.params.id]
    )
    res.json({ ok: true })
  } catch (err) {
    console.error('Error actualizando progreso:', err)
    res.status(500).json({ error: 'Error al actualizar progreso' })
  }
})

// Generar o recuperar guía de estudio para una tarea específica
app.post('/evaluaciones/:id/guia-tarea', authenticateToken, async (req, res) => {
  try {
    const { tarea, tareaIndex, forzar } = req.body
    const { rows: evRows } = await pool.query(
      `SELECT e.*, r.nombre as ramo_nombre,
        (SELECT json_agg(json_build_object('nombre', a.nombre, 'tipo', a.tipo, 'datos', encode(a.datos, 'base64')))
         FROM archivos a WHERE a.evaluacion_id = e.id) as archivos
       FROM evaluaciones e JOIN ramos r ON r.id = e.ramo_id
       WHERE e.id = $1`,
      [req.params.id]
    )
    if (!evRows[0]) return res.status(404).json({ error: 'Evaluación no encontrada' })
    const ev = evRows[0]

    // Si ya existe la guía y no se fuerza regenerar, devolverla
    const guiasGuardadas = ev.guias_tareas || {}
    const key = String(tareaIndex)
    if (guiasGuardadas[key] && !forzar) {
      return res.json({ ...guiasGuardadas[key], cached: true })
    }

    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' })
    let contenidoArchivos = ''
    if (ev.archivos && ev.archivos.length > 0) {
      contenidoArchivos = `\nEl estudiante ha subido los siguientes archivos de estudio: ${ev.archivos.map(a => a.nombre).join(', ')}. Usa estos temas como contexto.`
    }

    const prompt = `Eres un tutor universitario experto. Genera una guía de estudio detallada para un estudiante universitario chileno.

Ramo: ${ev.ramo_nombre}
Evaluación: ${ev.nombre}
Tarea a estudiar: ${tarea.titulo}
Descripción: ${tarea.descripcion}${contenidoArchivos}

Responde SOLO con un JSON válido (sin markdown, sin bloques de código):
{
  "titulo": "título de la guía",
  "introduccion": "párrafo introductorio del tema",
  "conceptos_clave": [
    { "termino": "nombre del concepto", "definicion": "explicación clara y concisa" }
  ],
  "desarrollo": "explicación detallada del tema en 3-4 párrafos",
  "ejemplos": [
    { "enunciado": "enunciado del ejemplo", "solucion": "solución paso a paso" }
  ],
  "ejercicios_practica": [
    { "enunciado": "enunciado del ejercicio", "pista": "pista para resolverlo" }
  ],
  "resumen_final": "resumen en 2-3 puntos clave para recordar"
}

Genera 3 conceptos clave, 2 ejemplos resueltos y 3 ejercicios de práctica.`

    const result = await model.generateContent(prompt)
    const text = result.response.text()
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error('No se pudo parsear respuesta de IA')
    const guia = JSON.parse(jsonMatch[0])

    // Guardar guía en DB
    guiasGuardadas[key] = guia
    await pool.query('UPDATE evaluaciones SET guias_tareas = $1 WHERE id = $2', [JSON.stringify(guiasGuardadas), req.params.id])

    res.json(guia)
  } catch (err) {
    console.error('Error generando guía:', err)
    res.status(500).json({ error: 'Error al generar guía de estudio' })
  }
})
