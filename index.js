require('dotenv').config()
const express = require('express')
const XLSX = require('xlsx')
const cors = require('cors')
const cookieParser = require('cookie-parser')
const passport = require('passport')
const { Strategy: GoogleStrategy } = require('passport-google-oauth20')
const jwt = require('jsonwebtoken')
const { Pool } = require('pg')
const multer = require('multer')
const { GoogleGenerativeAI } = require('@google/generative-ai')
const webpush = require('web-push')
const cron = require('node-cron')
const pdfParse = require('pdf-parse')
const mammoth = require('mammoth')
const bcrypt = require('bcrypt')
const OpenAI = require('openai')

const app = express()

webpush.setVapidDetails(
  'mailto:abelespinozav@gmail.com',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
)

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } })

app.set('trust proxy', 1)

app.use(cors({
  origin: [
    'http://localhost:5173',
    'https://apprueba-production.up.railway.app',
    process.env.CLIENT_URL
  ].filter(Boolean),
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization']
}))
app.use(express.json())
app.use(cookieParser())
app.use(passport.initialize())

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id SERIAL PRIMARY KEY,
      google_id VARCHAR(255) UNIQUE,
      nombre VARCHAR(255),
      email VARCHAR(255) UNIQUE,
      avatar VARCHAR(500),
      password_hash VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ramos (
      id SERIAL PRIMARY KEY,
      usuario_id INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
      nombre VARCHAR(255) NOT NULL,
      min_aprobacion DECIMAL(3,1) DEFAULT 4.0,
      created_at TIMESTAMP DEFAULT NOW()
    );
    ALTER TABLE ramos ADD COLUMN IF NOT EXISTS nota_examen DECIMAL(3,1);
    ALTER TABLE ramos ADD COLUMN IF NOT EXISTS nota_final DECIMAL(3,1);
    ALTER TABLE ramos ADD COLUMN IF NOT EXISTS estado_final VARCHAR(50);
    ALTER TABLE ramos ADD COLUMN IF NOT EXISTS ponderacion_examen INTEGER DEFAULT 25;
    ALTER TABLE ramos ADD COLUMN IF NOT EXISTS nota_eximicion DECIMAL(3,1);
    ALTER TABLE ramos ADD COLUMN IF NOT EXISTS condiciones_eximicion TEXT;
    ALTER TABLE ramos ADD COLUMN IF NOT EXISTS sin_rojos BOOLEAN DEFAULT false;
    ALTER TABLE evaluaciones ADD COLUMN IF NOT EXISTS quiz_generado JSONB;
    ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS ejercicios_usados INTEGER DEFAULT 0;
    ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS quizzes_usados INTEGER DEFAULT 0;
    ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS planes_usados INTEGER DEFAULT 0;
    ALTER TABLE evaluaciones ADD COLUMN IF NOT EXISTS guias_tareas JSONB;
    DELETE FROM evaluaciones WHERE nombre IS NULL OR nombre = '';
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
    // Verificar si ya existe
    const { rows: existing } = await pool.query('SELECT id FROM usuarios WHERE google_id = $1', [profile.id])
    const esNuevo = existing.length === 0

    // Si es nuevo, verificar si hay cupo
    if (esNuevo) {
      const { rows: countRows } = await pool.query('SELECT COUNT(*) as total FROM usuarios')
      if (parseInt(countRows[0].total) >= 50) {
        return done(null, false, { message: 'lista_espera' })
      }
    }

    const { rows } = await pool.query(
      `INSERT INTO usuarios (google_id, nombre, email, avatar, last_login)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (google_id) DO UPDATE
       SET nombre = $2, avatar = $4, last_login = NOW()
       RETURNING *`,
      [profile.id, profile.displayName, profile.emails[0].value, profile.photos[0].value]
    )
    const usuario = rows[0]

    // Si es nuevo, marcar como fundador
    if (esNuevo) {
      const { rows: countRows } = await pool.query('SELECT COUNT(*) as total FROM usuarios WHERE es_fundador = TRUE')
      if (parseInt(countRows[0].total) < 50) {
        await pool.query('UPDATE usuarios SET es_fundador = TRUE WHERE id = $1', [usuario.id])
        usuario.es_fundador = true
      }
    }

    return done(null, usuario)
  } catch (err) {
    return done(err)
  }
}))

// Registro con email/contraseña
app.post('/auth/register', async (req, res) => {
  try {
    const { nombre, email, password } = req.body
    if (!nombre || !email || !password) return res.status(400).json({ error: 'Faltan campos' })
    if (password.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' })
    const existe = await pool.query('SELECT id FROM usuarios WHERE email = $1', [email])
    if (existe.rows.length > 0) return res.status(400).json({ error: 'El email ya está registrado' })
    const hash = await bcrypt.hash(password, 10)
    const result = await pool.query(
      'INSERT INTO usuarios (nombre, email, password_hash) VALUES ($1, $2, $3) RETURNING id, nombre, email, avatar',
      [nombre, email, hash]
    )
    const usuario = result.rows[0]
    const token = jwt.sign({ id: usuario.id, email: usuario.email, nombre: usuario.nombre }, process.env.JWT_SECRET, { expiresIn: '7d' })
    res.json({ token, usuario })
  } catch (err) {
    console.error('Register error:', err)
    res.status(500).json({ error: 'Error al registrar' })
  }
})

// Login con email/contraseña
app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body
    if (!email || !password) return res.status(400).json({ error: 'Faltan campos' })
    const result = await pool.query('SELECT * FROM usuarios WHERE email = $1 AND password_hash IS NOT NULL', [email])
    if (result.rows.length === 0) return res.status(400).json({ error: 'Email o contraseña incorrectos' })
    const usuario = result.rows[0]
    const ok = await bcrypt.compare(password, usuario.password_hash)
    if (!ok) return res.status(400).json({ error: 'Email o contraseña incorrectos' })
    const token = jwt.sign({ id: usuario.id, email: usuario.email, nombre: usuario.nombre }, process.env.JWT_SECRET, { expiresIn: '7d' })
    res.json({ token, usuario: { id: usuario.id, nombre: usuario.nombre, email: usuario.email, avatar: usuario.avatar } })
  } catch (err) {
    console.error('Login error:', err)
    res.status(500).json({ error: 'Error al iniciar sesión' })
  }
})

app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'], session: false, prompt: 'select_account' }))

app.get('/auth/google/callback',
  passport.authenticate('google', { session: false, failureRedirect: `${process.env.CLIENT_URL}?error=lista_espera` }),
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
  const { rows } = await pool.query('SELECT id, nombre, email, avatar, universidad, carrera, onboarding_completado, onboarding_v2, podcasts_usados, ejercicios_usados, quizzes_usados, planes_usados, es_fundador, numero_registro FROM usuarios WHERE id = $1', [req.user.id])
  if (!rows[0]) return res.status(401).json({ error: 'Usuario no encontrado' })
  const u = rows[0]
  res.json({ user: { id: u.id, name: u.nombre, email: u.email, picture: u.avatar, universidad: u.universidad, carrera: u.carrera, onboarding_completado: u.onboarding_completado, onboarding_v2: u.onboarding_v2, es_fundador: u.es_fundador, numero_registro: u.numero_registro }, podcasts_usados: u.podcasts_usados || 0, ejercicios_usados: u.ejercicios_usados || 0, quizzes_usados: u.quizzes_usados || 0, planes_usados: u.planes_usados || 0 })
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
        'guias_tareas', e.guias_tareas,
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
  for (const e of (evaluaciones || [])) {
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
        'tareas_completadas', e.tareas_completadas, 'archivos', COALESCE((SELECT json_agg(json_build_object('id', a.id, 'nombre', a.nombre, 'tipo', a.tipo)) FROM archivos a WHERE a.evaluacion_id = e.id), '[]'::json)
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
app.get('/evaluaciones/:id/archivos', authenticateToken, async (req, res) => {
  try {
    const rows = await pool.query(
      'SELECT a.id, a.nombre, a.tipo FROM archivos a JOIN evaluaciones e ON e.id = a.evaluacion_id JOIN ramos r ON r.id = e.ramo_id WHERE a.evaluacion_id = $1 AND r.usuario_id = $2',
      [req.params.id, req.user.id]
    )
    res.json(rows.rows)
  } catch(e) { res.status(500).json({ error: e.message }) }
})

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
app.post('/evaluaciones/:id/plan-estudio', authenticateToken, upload.array('archivo', 10), async (req, res) => {
  try {
    // Validar y parsear ID
    const evalId = parseInt(req.params.id, 10)
    if (!evalId || isNaN(evalId)) return res.status(400).json({ error: 'id_invalido', mensaje: 'ID de evaluación inválido' })
    // Guardar archivos nuevos en BD antes de generar plan
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const { rows: existe } = await pool.query('SELECT id FROM archivos WHERE evaluacion_id = $1 AND nombre = $2', [evalId, file.originalname])
        if (existe.length === 0) {
          await pool.query('INSERT INTO archivos (evaluacion_id, nombre, tipo, datos) VALUES ($1, $2, $3, $4)', [evalId, file.originalname, file.mimetype, file.buffer])
        }
      }
    }
    const { rows: evRows } = await pool.query(
      `SELECT e.*, r.nombre as ramo_nombre,
        (SELECT json_agg(json_build_object('nombre', a.nombre, 'tipo', a.tipo, 'datos', encode(a.datos, 'base64')))
         FROM archivos a WHERE a.evaluacion_id = e.id) as archivos
       FROM evaluaciones e JOIN ramos r ON r.id = e.ramo_id
       WHERE e.id = $1 AND r.usuario_id = $2`,
      [evalId, req.user.id]
    )
    if (!evRows[0]) return res.status(404).json({ error: 'Evaluación no encontrada' })
    const ev = evRows[0]

    // Cargar horario del usuario
    const horarioRes = await pool.query(
      'SELECT dia, hora_inicio, hora_fin, ramo_nombre FROM horario WHERE usuario_id = $1 ORDER BY dia, hora_inicio',
      [req.user.id]
    )
    const bloquesPorDia = {}
    for (const b of horarioRes.rows) {
      if (!bloquesPorDia[b.dia]) bloquesPorDia[b.dia] = []
      bloquesPorDia[b.dia].push(`${b.hora_inicio}-${b.hora_fin} ${b.ramo_nombre}`)
    }
    const horarioTexto = Object.keys(bloquesPorDia).length > 0
      ? Object.entries(bloquesPorDia).map(([dia, bloques]) => `${dia}: ${bloques.join(', ')}`).join('\n')
      : null

    const promptText = `Eres un tutor universitario experto. Crea un plan de estudio detallado para un estudiante universitario chileno.

Ramo: ${ev.ramo_nombre}
Evaluación: ${ev.nombre} (${ev.ponderacion}% del ramo)
${ev.fecha ? `Fecha de evaluación: ${ev.fecha}` : ''}
${horarioTexto ? `\nHORARIO SEMANAL DEL ESTUDIANTE (bloques ocupados con clases):\n${horarioTexto}\n\nINSTRUCCIÓN OBLIGATORIA: Debes asignar cada tarea a un bloque de tiempo LIBRE (no ocupado por clases). En el campo "fecha" de cada tarea escribe el día y hora sugerida en formato "Lunes 15:00-16:30". Distribuye las tareas a lo largo de la semana en los huecos libres entre clases.` : ''}
${ev.archivos && ev.archivos.length > 0 ? `El estudiante ha subido material de estudio. Analiza su contenido y basa el plan en ese material.` : ''}

Responde SOLO con un JSON válido con esta estructura exacta (sin markdown, sin bloques de código):
{
  "resumen": "descripción breve del plan en 1-2 oraciones",
  "tareas": [
    { "titulo": "título corto", "descripcion": "descripción detallada", "prioridad": "alta", "duracion": 45, "fecha": "Lunes 10:00-11:30" },
    { "titulo": "título corto", "descripcion": "descripción detallada", "prioridad": "media", "duracion": 30, "fecha": "Martes 14:00-14:30" }
  ]
}

Genera 5 tareas basadas en el material subido si existe. prioridad debe ser "alta", "media" o "baja". duracion en minutos (número). fecha DEBE ser el día y hora sugerida para estudiar esa tarea, en formato "Lunes 10:00-11:30", usando SOLO los bloques libres del horario.`

    // Extraer texto de los archivos`
    let textoArchivos = ''
    console.log('📎 Archivos encontrados:', ev.archivos ? ev.archivos.length : 0)
    if (ev.archivos && ev.archivos.length > 0) {
      for (const archivo of ev.archivos) {
        if (archivo.datos) {
          try {
            const buffer = Buffer.from(archivo.datos, 'base64')
            if (archivo.tipo && archivo.tipo.includes('pdf')) {
              const parsed = await pdfParse(buffer)
              console.log(`📄 Texto extraído de ${archivo.nombre}: ${parsed.text.slice(0,200)}`)
              textoArchivos += `\n\n--- Contenido de ${archivo.nombre} ---\n${parsed.text.slice(0, 8000)}`
            } else if (archivo.tipo && (archivo.tipo.includes('word') || archivo.tipo.includes('docx') || archivo.nombre?.endsWith('.docx'))) {
              const result = await mammoth.extractRawText({ buffer })
              console.log(`📝 Texto extraído de docx ${archivo.nombre}: ${result.value.slice(0,200)}`)
              textoArchivos += `\n\n--- Contenido de ${archivo.nombre} ---\n${result.value.slice(0, 8000)}`
            } else {
              textoArchivos += `\n\n--- Archivo: ${archivo.nombre} (formato no soportado) ---`
            }
          } catch(e) {
            console.error('Error extrayendo texto:', e.message)
            textoArchivos += `\n\n--- Archivo: ${archivo.nombre} (no se pudo extraer texto) ---`
          }
        }
      }
    }

    // Validar que el texto extraído sea real y no solo errores
    // BLOQUEO: no generar plan sin material
    if (!ev.archivos || ev.archivos.length === 0) {
      return res.status(400).json({ error: 'sin_material', mensaje: 'Debes subir material de estudio para generar el plan.' })
    }
    // BLOQUEO: límite de regeneraciones (solo si ya tiene plan)
    if (ev.plan_estudio) {
      const planesRes = await pool.query('SELECT planes_usados FROM usuarios WHERE id = $1', [req.user.id])
      const planesUsados = planesRes.rows[0]?.planes_usados || 0
      const limiteResP = await pool.query("SELECT valor FROM configuracion WHERE clave = 'limite_global'")
      const limiteGlobalP = limiteResP.rows.length ? parseInt(limiteResP.rows[0].valor) : 100
      if (planesUsados >= limiteGlobalP) return res.status(403).json({ error: 'limite_alcanzado', tipo: 'planes', usados: planesUsados, limite: limiteGlobalP })
    }
    const textoLimpio = textoArchivos.replace(/--- Archivo:.*\(no se pudo extraer texto\) ---/g, '').replace(/--- Archivo:.*\(formato no soportado\) ---/g, '').trim()
    if (textoArchivos && !textoLimpio) {
      return res.status(400).json({ error: 'archivo_no_legible', mensaje: 'No pudimos leer tu archivo. Por favor sube un PDF o Word (.docx)' })
    }

    const promptFinal = textoArchivos 
      ? promptText + `\n\nMATERIAL DE ESTUDIO DEL ESTUDIANTE:\n${textoArchivos}\n\nINSTRUCCIONES IMPORTANTES:\n- Debes generar el plan de estudio BASÁNDOTE EXCLUSIVAMENTE en el contenido del material subido.\n- NO importa si el material no parece relacionado con el nombre del ramo.\n- El estudiante sabe lo que necesita estudiar. Tu trabajo es crear tareas basadas en el contenido real del material.\n- NUNCA rechaces el material ni sugieras buscar otro. Usa lo que hay.`
      : promptText

    try {
      const result = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: promptFinal }],
        temperature: 0.7
      })
      const text = result.choices[0].message.content
      const jsonMatch = text.match(/\{[\s\S]*\}/)
      if (!jsonMatch) throw new Error('No JSON')
      const plan = JSON.parse(jsonMatch[0])
      await pool.query('UPDATE evaluaciones SET plan_estudio = $1, texto_material = $2 WHERE id = $3', [JSON.stringify(plan), textoArchivos || null, evalId])
      if (ev.plan_estudio) {
        await pool.query('UPDATE usuarios SET planes_usados = planes_usados + 1 WHERE id = $1', [req.user.id])
      }
      // Guardar archivos en tabla archivos si no existen ya
      if (ev.archivos && ev.archivos.length > 0) {
        for (const archivo of ev.archivos) {
          const { rows: existe } = await pool.query('SELECT id FROM archivos WHERE evaluacion_id = $1 AND nombre = $2', [evalId, archivo.nombre])
          if (existe.length === 0) {
            const buffer = Buffer.from(archivo.datos, 'base64')
            await pool.query('INSERT INTO archivos (evaluacion_id, nombre, tipo, datos) VALUES ($1, $2, $3, $4)', [evalId, archivo.nombre, archivo.tipo, buffer])
          }
        }
      }
      return res.json(plan)
    } catch(geminiErr) {
      console.error('GPT error:', geminiErr.message)
      // Fallback: reintentar
      const fallback = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: promptFinal }],
        temperature: 0.7
      })
      const text2 = fallback.choices[0].message.content
      const jsonMatch2 = text2.match(/\{[\s\S]*\}/)
      if (!jsonMatch2) throw new Error('No se pudo parsear respuesta de IA')
      const plan2 = JSON.parse(jsonMatch2[0])
      if (!textoArchivos) plan2._archivoNoProcessado = true
      await pool.query('UPDATE evaluaciones SET plan_estudio = $1 WHERE id = $2', [JSON.stringify(plan2), evalId])
      return res.json(plan2)
    }

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

// ── ONBOARDING ──────────────────────────────────────────────────
app.post('/auth/onboarding', authenticateToken, async (req, res) => {
  try {
    const { nombre, universidad, carrera } = req.body
    if (!nombre || !nombre.trim()) return res.status(400).json({ error: 'El nombre es requerido' })
    const { rows } = await pool.query(
      'UPDATE usuarios SET nombre = $1, universidad = $2, carrera = $3, onboarding_completado = true, onboarding_v2 = true WHERE id = $4 RETURNING id, nombre, email, avatar, universidad, carrera, onboarding_completado, onboarding_v2',
      [nombre.trim(), universidad || null, carrera ? carrera.trim() : null, req.user.id]
    )
    res.json({ usuario: rows[0] })
  } catch (err) {
    console.error('Error onboarding:', err)
    res.status(500).json({ error: 'Error al guardar datos' })
  }
})

initDB().then(() => {
  

// ── HORARIO ──────────────────────────────────────────────────────
app.get('/horario', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM horario WHERE usuario_id = $1 ORDER BY dia, hora_inicio',
      [req.user.id]
    )
    res.json(rows)
  } catch(err) { res.status(500).json({ error: err.message }) }
})

app.post('/horario', authenticateToken, async (req, res) => {
  try {
    const { dia, hora_inicio, hora_fin, ramo_nombre, codigo, sala, tipo } = req.body
    await pool.query(
      `INSERT INTO horario (usuario_id, dia, hora_inicio, hora_fin, ramo_nombre, codigo, sala, tipo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (usuario_id, dia, periodo)
       DO UPDATE SET hora_inicio=$3, hora_fin=$4, ramo_nombre=$5, codigo=$6, sala=$7, tipo=$8`,
      [req.user.id, dia, hora_inicio, hora_fin, ramo_nombre, codigo, sala, tipo || 'clase']
    )
    // Auto-crear ramo si no existe
    if (ramo_nombre && ramo_nombre.trim()) {
      const existe = await pool.query(
        'SELECT id FROM ramos WHERE usuario_id = $1 AND LOWER(nombre) = LOWER($2)',
        [req.user.id, ramo_nombre.trim()]
      )
      if (existe.rows.length === 0) {
        await pool.query(
          'INSERT INTO ramos (usuario_id, nombre, min_aprobacion) VALUES ($1, $2, $3)',
          [req.user.id, ramo_nombre.trim(), 4.0]
        )
      }
    }
    res.json({ ok: true })
  } catch(err) { res.status(500).json({ error: err.message }) }
})

app.delete('/horario/:id', authenticateToken, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM horario WHERE id=$1 AND usuario_id=$2',
      [req.params.id, req.user.id]
    )
    res.json({ ok: true })
  } catch(err) { res.status(500).json({ error: err.message }) }
})


app.post('/horario/sincronizar-ramos', authenticateToken, async (req, res) => {
  try {
    const bloques = await pool.query('SELECT DISTINCT ramo_nombre FROM horario WHERE usuario_id=$1', [req.user.id])
    for (const row of bloques.rows) {
      const existe = await pool.query('SELECT id FROM ramos WHERE usuario_id=$1 AND nombre=$2', [req.user.id, row.ramo_nombre])
      if (existe.rows.length === 0) {
        await pool.query('INSERT INTO ramos (usuario_id, nombre, min_aprobacion) VALUES ($1, $2, $3)', [req.user.id, row.ramo_nombre.trim(), 4.0])
      }
    }
    res.json({ ok: true })
  } catch(err) { res.status(500).json({ error: err.message }) }
})

app.post('/horario/limpiar', authenticateToken, async (req, res) => {
  try {
    await pool.query('DELETE FROM horario WHERE usuario_id=$1', [req.user.id])
    res.json({ ok: true })
  } catch(err) { res.status(500).json({ error: err.message }) }
})

// Extraer horario desde imagen con GPT-4o Vision
app.post('/horario/extraer-excel', authenticateToken, upload.single('archivo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No se subio archivo' })
    
    // Detectar si es XLSX nativo o XLS-HTML
    const buf = req.file.buffer
    const isXlsx = req.file.originalname.endsWith('.xlsx') || buf[0] === 0x50 && buf[1] === 0x4B
    
    if (isXlsx) {
      // Parsear con librería xlsx
      const workbook = XLSX.read(buf, { type: 'buffer' })
      const sheet = workbook.Sheets[workbook.SheetNames[0]]
      const data = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' })
      
      const dias = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado']
      const bloques = []
      
      // Buscar fila de encabezado con días
      let diaColumns = {}
      let headerRow = -1
      for (let r = 0; r < data.length; r++) {
        const row = data[r]
        const found = dias.filter(d => row.some(c => String(c).toLowerCase().includes(d.toLowerCase().substring(0,3))))
        if (found.length >= 3) {
          headerRow = r
          row.forEach((cell, ci) => {
            const cellStr = String(cell).toLowerCase()
            dias.forEach(d => {
              if (cellStr.includes(d.toLowerCase().substring(0,3))) diaColumns[ci] = d
            })
          })
          break
        }
      }
      
      if (headerRow === -1) return res.status(400).json({ error: 'No se encontro fila de dias en el Excel' })
      
      for (let r = headerRow + 1; r < data.length; r++) {
        const row = data[r]
        const periodoCell = String(row[0] || '')
        const horaMatch = periodoCell.match(/(d{1,2}:d{2})/)
        if (!horaMatch) continue
        
        // Buscar hora inicio y fin
        let hora_inicio = '', hora_fin = ''
        for (let c = 0; c < row.length; c++) {
          const val = String(row[c] || '')
          const horas = val.match(/(d{1,2}:d{2})/g)
          if (horas && horas.length >= 2) { hora_inicio = horas[0]; hora_fin = horas[1]; break }
          if (horas && horas.length === 1 && !hora_inicio) hora_inicio = horas[0]
        }
        if (!hora_inicio) continue
        
        Object.entries(diaColumns).forEach(([ci, dia]) => {
          const cell = String(row[ci] || '').trim()
          if (!cell) return
          const partes = cell.split('\n').map(p => p.trim()).filter(p => p)
          if (partes.length < 2) return
          bloques.push({ dia, hora_inicio, hora_fin, ramo_nombre: partes[1] || partes[0], codigo: partes[0], sala: partes[2] || '', tipo: 'clase' })
        })
      }
      
      if (bloques.length === 0) return res.status(400).json({ error: 'No se pudieron extraer bloques del archivo xlsx' })
      return res.json({ bloques })
    }
    
    const html = req.file.buffer.toString('latin1')

    const dias = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado']
    const bloques = []
    const rows = html.match(/<tr[\s\S]*?<\/tr>/gi) || []

    for (const row of rows) {
      const allCells = row.match(/<td[\s\S]*?<\/td>/gi) || []
      if (allCells.length !== 7) continue

      // Celda 0: período con hora
      const periodoText = allCells[0].replace(/<br\s*\/?>/gi, '|').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim()
      const partesPeriodo = periodoText.split('|').map(p => p.trim()).filter(p => p)
      if (partesPeriodo.length < 3) continue
      const hora_inicio = partesPeriodo[1]
      const hora_fin = partesPeriodo[2]
      if (!hora_inicio || !hora_fin) continue

      // Celdas 1-6: días Lunes a Sábado
      for (let i = 1; i <= 6; i++) {
        const cell = allCells[i]
        const texto = cell.replace(/<br\s*\/?>/gi, '|').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim()
        const partes = texto.split('|').map(p => p.trim()).filter(p => p)
        if (partes.length < 2) continue

        let tipo = 'clase'
        const bgMatch = cell.match(/background-colors*:s*([#w]+)/i) || cell.match(/bgcolor=["']?([#w]+)/i)
        if (bgMatch) {
          const color = bgMatch[1].toLowerCase().replace('#','')
          if (['ffd700','ffa500','ffb300','f90'].some(c => color.includes(c))) tipo = 'topon'
          else if (['90ee90','adff2f'].some(c => color.includes(c))) tipo = 'ayudantia'
        }

        bloques.push({
          dia: dias[i - 1],
          hora_inicio,
          hora_fin,
          ramo_nombre: partes[1],
          codigo: partes[0],
          sala: partes[2] || '',
          tipo
        })
      }
    }

    if (bloques.length === 0) return res.status(400).json({ error: 'No se pudieron extraer bloques del archivo' })
    console.log('Bloques extraidos:', bloques.length, bloques)
    res.json({ bloques })
  } catch(err) {
    console.error('Error XLS:', err)
    res.status(500).json({ error: err.message })
  }
})

app.post('/horario/extraer', authenticateToken, upload.single('imagen'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No se subió imagen' })
    const base64 = req.file.buffer.toString('base64')
    const mime = req.file.mimetype

    // PASO 1: Transcribir la tabla en texto plano
    const paso1 = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Lee esta imagen de un horario universitario y transcribe EXACTAMENTE lo que ves en cada celda de la tabla.
            
Para cada celda NO vacía, escribe una línea con este formato exacto:
PERIODO | DIA | CODIGO | NOMBRE_RAMO | SALA | COLOR

Donde COLOR es: naranja=topon, verde=ayudantia, naranja_fuerte=prueba, blanco/azul=clase

Ejemplo:
1° | Martes | IME086-6 | ALGEBRA LINEAL | RA-2003 | clase
5° | Lunes | ICF177-8 | FÍSICA II | R2-202 | topon

No omitas ninguna celda. No inventes nada. Solo transcribe lo que ves.`
          },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } }
        ]
      }],
      max_tokens: 2000
    })

    const transcripcion = paso1.choices[0].message.content
    console.log('📋 Transcripción:\n', transcripcion)

    // PASO 2: Convertir transcripción a JSON
    const periodos = {
      '1°': { inicio: '08:30', fin: '09:30' },
      '2°': { inicio: '09:40', fin: '10:40' },
      '3°': { inicio: '10:50', fin: '11:50' },
      '4°': { inicio: '12:00', fin: '13:00' },
      'Alm.': { inicio: '13:10', fin: '14:10' },
      '5°': { inicio: '14:30', fin: '15:30' },
      '6°': { inicio: '15:40', fin: '16:40' },
      '7°': { inicio: '16:50', fin: '17:50' },
      '8°': { inicio: '18:00', fin: '19:00' },
      '9°': { inicio: '19:10', fin: '20:10' },
      '10°': { inicio: '20:20', fin: '21:20' }
    }

    const paso2 = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{
        role: 'user',
        content: `Convierte esta transcripción de horario universitario a un JSON array.

Transcripción:
${transcripcion}

Tabla de períodos:
${Object.entries(periodos).map(([p, h]) => `${p}: ${h.inicio}-${h.fin}`).join('\n')}

Para cada línea de la transcripción, crea un objeto JSON:
{ "dia": "Lunes", "hora_inicio": "08:30", "hora_fin": "09:30", "ramo_nombre": "ÁLGEBRA LINEAL", "codigo": "IME086-6", "sala": "RA-2003", "tipo": "clase" }

Dias válidos: Lunes, Martes, Miércoles, Jueves, Viernes, Sábado
tipo válidos: clase, topon, ayudantia, prueba, otra

Responde SOLO con el JSON array, sin markdown.`
      }],
      max_tokens: 2000
    })

    const text = paso2.choices[0].message.content
    const jsonMatch = text.match(/\[[\s\S]*\]/)
    if (!jsonMatch) return res.status(400).json({ error: 'No se pudo extraer el horario' })
    const bloques = JSON.parse(jsonMatch[0])
    res.json({ bloques })
  } catch(err) { res.status(500).json({ error: err.message }) }
})

// Panel admin - solo abelespinozav@gmail.com
app.get('/admin/stats', authenticateToken, async (req, res) => {
  if (req.user.email !== 'abelespinozav@gmail.com') return res.status(403).json({ error: 'No autorizado' })
  try {
    const usuarios = await pool.query(`
      SELECT id, nombre, email, created_at, last_login, podcasts_usados, ejercicios_usados, quizzes_usados, planes_usados
      FROM usuarios
      ORDER BY created_at DESC
    `)
    const stats = await pool.query(`
      SELECT
        COUNT(*) as total_usuarios,
        COUNT(CASE WHEN created_at > NOW() - INTERVAL '7 days' THEN 1 END) as nuevos_7d,
        COUNT(CASE WHEN last_login > NOW() - INTERVAL '7 days' THEN 1 END) as activos_7d
      FROM usuarios
    `)
    const ramos = await pool.query('SELECT COUNT(*) as total_ramos FROM ramos')
    const evals = await pool.query('SELECT COUNT(*) as total_evaluaciones FROM evaluaciones')
    res.json({
      stats: stats.rows[0],
      ramos: ramos.rows[0].total_ramos,
      evaluaciones: evals.rows[0].total_evaluaciones,
      usuarios: usuarios.rows
    })
  } catch(err) {
    res.status(500).json({ error: err.message })
  }
})


// Detalle completo de un usuario (solo admin)
app.get('/admin/usuario/:id/detalle', authenticateToken, async (req, res) => {
  if (req.user.email !== 'abelespinozav@gmail.com') return res.status(403).json({ error: 'No autorizado' })
  try {
    const uid = req.params.id
    const { rows: ramos } = await pool.query(`
      SELECT r.id, r.nombre, r.min_aprobacion,
        json_agg(
          json_build_object(
            'id', e.id,
            'nombre', e.nombre,
            'ponderacion', e.ponderacion,
            'nota', e.nota,
            'fecha', e.fecha,
            'tiene_plan', e.plan_estudio IS NOT NULL,
            'tiene_quiz', e.quiz_generado IS NOT NULL,
            'archivos', COALESCE((
              SELECT json_agg(json_build_object('nombre', a.nombre))
              FROM archivos a WHERE a.evaluacion_id = e.id
            ), '[]'::json)
          ) ORDER BY e.fecha ASC
        ) FILTER (WHERE e.id IS NOT NULL) as evaluaciones
      FROM ramos r
      LEFT JOIN evaluaciones e ON e.ramo_id = r.id
      WHERE r.usuario_id = $1
      GROUP BY r.id ORDER BY r.nombre
    `, [uid])

    const { rows: podcasts } = await pool.query(`
      SELECT p.titulo, p.created_at, r.nombre as ramo_nombre
      FROM podcasts p
      JOIN evaluaciones e ON e.id = p.evaluacion_id
      JOIN ramos r ON r.id = e.ramo_id
      WHERE r.usuario_id = $1
      ORDER BY p.created_at DESC LIMIT 10
    `, [uid])

    const limiteRes = await pool.query("SELECT valor FROM configuracion WHERE clave = 'limite_global'")
    const limiteGlobal = limiteRes.rows.length ? parseInt(limiteRes.rows[0].valor) : 100
    res.json({ ramos, podcasts, limiteGlobal })
  } catch(err) { console.error('ERROR DETALLE:', err.message); res.status(500).json({ error: err.message }) }
})

// Eliminar usuario (solo admin)
app.delete('/admin/usuario/:id', authenticateToken, async (req, res) => {
  if (req.user.email !== 'abelespinozav@gmail.com') return res.status(403).json({ error: 'No autorizado' })
  if (parseInt(req.params.id) === req.user.id) return res.status(400).json({ error: 'No puedes eliminarte a ti mismo' })
  try {
    await pool.query('DELETE FROM usuarios WHERE id = $1', [req.params.id])
    res.json({ ok: true })
  } catch(err) { res.status(500).json({ error: err.message }) }
})

// Reset contadores de un usuario (solo admin)
app.post('/admin/limite-global', authenticateToken, async (req, res) => {
  try {
    const { limite } = req.body
    if (typeof limite !== 'number' || limite < 0) return res.status(400).json({ error: 'Límite inválido' })
    await pool.query("INSERT INTO configuracion (clave, valor) VALUES ('limite_global', $1) ON CONFLICT (clave) DO UPDATE SET valor = $1", [String(limite)])
    res.json({ ok: true, limite })
  } catch(e) {
    console.error(e)
    res.status(500).json({ error: e.message })
  }
})

app.get('/admin/limite-global', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT valor FROM configuracion WHERE clave = 'limite_global'")
    const limite = rows.length ? parseInt(rows[0].valor) : 100
    res.json({ limite })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/admin/reset-contadores', authenticateToken, async (req, res) => {
  if (req.user.email !== 'abelespinozav@gmail.com') return res.status(403).json({ error: 'No autorizado' })
  try {
    const { usuario_id, campo } = req.body
    const camposValidos = ['podcasts_usados', 'ejercicios_usados', 'quizzes_usados', 'planes_usados']
    if (campo === 'todos') {
      await pool.query('UPDATE usuarios SET podcasts_usados=0, ejercicios_usados=0, quizzes_usados=0, planes_usados=0 WHERE id=$1', [usuario_id])
    } else if (camposValidos.includes(campo)) {
      await pool.query(`UPDATE usuarios SET ${campo}=0 WHERE id=$1`, [usuario_id])
    } else {
      return res.status(400).json({ error: 'Campo inválido' })
    }
    res.json({ ok: true })
  } catch(err) { res.status(500).json({ error: err.message }) }
})

// ── NOTIFICACIONES PUSH ──────────────────────────────────────────

// Guardar subscription del navegador
app.post('/notificaciones/subscribe', authenticateToken, async (req, res) => {
  try {
    const { subscription } = req.body
    await pool.query(
      `INSERT INTO push_subscriptions (usuario_id, subscription)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [req.user.id, JSON.stringify(subscription)]
    )
    res.json({ ok: true })
  } catch(err) { res.status(500).json({ error: err.message }) }
})

// Obtener config de notificaciones del usuario
app.get('/notificaciones/config', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM notificacion_config WHERE usuario_id = $1',
      [req.user.id]
    )
    if (rows.length === 0) {
      res.json({ dias_antes: [1, 2, 5], activo: true })
    } else {
      res.json(rows[0])
    }
  } catch(err) { res.status(500).json({ error: err.message }) }
})

// Guardar config de notificaciones
app.post('/notificaciones/config', authenticateToken, async (req, res) => {
  try {
    const { dias_antes, activo } = req.body
    if (!Array.isArray(dias_antes) || dias_antes.length > 3) {
      return res.status(400).json({ error: 'Máximo 3 recordatorios' })
    }
    const { rows } = await pool.query(
      `INSERT INTO notificacion_config (usuario_id, dias_antes, activo, notif_clases, notif_ventanas)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (usuario_id) DO UPDATE
       SET dias_antes = $2, activo = $3, notif_clases = $4, notif_ventanas = $5
       RETURNING *`,
      [req.user.id, dias_antes, activo, req.body.notif_clases !== false, req.body.notif_ventanas !== false]
    )
    res.json(rows[0])
  } catch(err) { res.status(500).json({ error: err.message }) }
})

// Endpoint para obtener la VAPID public key

// Broadcast notificación a todos los usuarios (solo admin)
app.post('/admin/notificacion-broadcast', authenticateToken, async (req, res) => {
  if (req.user.email !== 'abelespinozav@gmail.com') return res.status(403).json({ error: 'No autorizado' })
  try {
    const { titulo, mensaje, url } = req.body
    const { rows: subs } = await pool.query('SELECT subscription FROM push_subscriptions')
    const payload = JSON.stringify({ title: titulo || 'APPrueba', body: mensaje || '', url: url || '/' })
    let enviadas = 0, fallidas = 0
    for (const row of subs) {
      try {
        const s = row.subscription
        await webpush.sendNotification(
          { endpoint: s.endpoint, expirationTime: s.expirationTime, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } },
          payload
        )
        enviadas++
      } catch(e) { fallidas++ }
    }
    res.json({ ok: true, enviadas, fallidas, total: subs.length })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})


// Cuántos spots de fundador quedan
app.get('/fundadores/spots', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT COUNT(*) as total FROM usuarios WHERE es_fundador = TRUE')
    const usados = parseInt(rows[0].total)
    res.json({ usados, total: 50, quedan: Math.max(0, 50 - usados), lleno: usados >= 50 })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/notificaciones/vapid-key', (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY })
})

// ── CRON JOB — todos los días a las 9:00 AM Chile (UTC-3) ────────
cron.schedule('0 12 * * *', async () => {
  console.log('🔔 Cron notificaciones ejecutándose...')
  try {
    // Obtener todas las evaluaciones con fecha futura y sus configs
    const { rows: configs } = await pool.query(`
      SELECT
        nc.usuario_id,
        nc.dias_antes,
        u.nombre as usuario_nombre,
        e.nombre as eval_nombre,
        e.fecha,
        r.nombre as ramo_nombre,
        e.ponderacion
      FROM notificacion_config nc
      JOIN usuarios u ON u.id = nc.usuario_id
      JOIN ramos r ON r.usuario_id = nc.usuario_id
      JOIN evaluaciones e ON e.ramo_id = r.id
      WHERE nc.activo = true
        AND e.fecha IS NOT NULL
        AND e.nota IS NULL
        AND e.fecha >= CURRENT_DATE
    `)

    for (const row of configs) {
      const fecha = new Date(row.fecha)
      const hoy = new Date()
      hoy.setHours(0,0,0,0)
      const diffDias = Math.round((fecha - hoy) / (1000 * 60 * 60 * 24))

      if (row.dias_antes.includes(diffDias)) {
        // Obtener subscriptions del usuario
        const { rows: subs } = await pool.query(
          'SELECT subscription FROM push_subscriptions WHERE usuario_id = $1',
          [row.usuario_id]
        )

        const mensaje = diffDias === 0
          ? `¡Hoy es ${row.eval_nombre} de ${row.ramo_nombre} (${row.ponderacion}%)!`
          : diffDias === 1
          ? `Mañana tienes ${row.eval_nombre} de ${row.ramo_nombre} (${row.ponderacion}%)`
          : `En ${diffDias} días: ${row.eval_nombre} de ${row.ramo_nombre} (${row.ponderacion}%)`

        for (const sub of subs) {
          try {
            await webpush.sendNotification({endpoint: sub.subscription.endpoint, expirationTime: sub.subscription.expirationTime, keys: {p256dh: sub.subscription.keys.p256dh, auth: sub.subscription.keys.auth}},
              JSON.stringify({
                title: '📚 APPrueba',
                body: mensaje,
                icon: '/icon-192.png'
              })
            )
          } catch(e) {
            if (e.statusCode === 410) {
              // Subscription expirada, eliminar
              await pool.query('DELETE FROM push_subscriptions WHERE subscription = $1', [JSON.stringify(sub.subscription)])
            }
          }
        }
      }
    }
    console.log('✅ Cron notificaciones completado')
  } catch(err) {
    console.error('❌ Error cron notificaciones:', err.message)
  }
}, { timezone: 'America/Santiago' })

// ── CRON — Clases próximas (cada 15 min) ─────────────────────────
cron.schedule('*/15 * * * *', async () => {
  try {
    const ahora = new Date()
    const diasSemana = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado']
    const diaHoy = diasSemana[ahora.getDay()]
    const horaAhora = ahora.toTimeString().slice(0,5)
    
    // Hora en 15 minutos
    const en15 = new Date(ahora.getTime() + 15 * 60000)
    const hora15 = en15.toTimeString().slice(0,5)

    // Buscar clases que empiezan entre ahora y 15 min
    const { rows } = await pool.query(`
      SELECT h.usuario_id, h.ramo_nombre, h.hora_inicio, h.hora_fin, h.sala, h.tipo
      FROM horario h
      JOIN notificacion_config nc ON nc.usuario_id = h.usuario_id
      WHERE nc.activo = true
        AND nc.notif_clases = true
        AND h.dia = $1
        AND h.hora_inicio > $2
        AND h.hora_inicio <= $3
    `, [diaHoy, horaAhora, hora15])

    for (const row of rows) {
      const { rows: subs } = await pool.query(
        'SELECT subscription FROM push_subscriptions WHERE usuario_id = $1',
        [row.usuario_id]
      )
      const tipoEmoji = row.tipo === 'topon' ? '⚡' : row.tipo === 'ayudantia' ? '🙋' : '🏫'
      const sala = row.sala ? ` · ${row.sala}` : ''
      const mensaje = `${row.ramo_nombre} empieza a las ${row.hora_inicio}${sala}`

      for (const sub of subs) {
        try {
          await webpush.sendNotification({endpoint: sub.subscription.endpoint, expirationTime: sub.subscription.expirationTime, keys: {p256dh: sub.subscription.keys.p256dh, auth: sub.subscription.keys.auth}}, JSON.stringify({
            title: `${tipoEmoji} Clase en 15 minutos`,
            body: mensaje,
            icon: '/icon-192.png'
          }))
        } catch(e) {
          if (e.statusCode === 410) {
            await pool.query('DELETE FROM push_subscriptions WHERE subscription = $1', [JSON.stringify(sub.subscription)])
          }
        }
      }
    }
  } catch(err) {
    console.error('❌ Error cron clases próximas:', err.message)
  }
}, { timezone: 'America/Santiago' })

// ── CRON — Ventanas de estudio (8:00 AM Chile) ───────────────────
cron.schedule('0 11 * * *', async () => {
  try {
    const ahora = new Date()
    const diasSemana = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado']
    const diaHoy = diasSemana[ahora.getDay()]

    // Obtener usuarios con notificaciones activas
    const { rows: usuarios } = await pool.query(`
      SELECT DISTINCT nc.usuario_id
      FROM notificacion_config nc
      WHERE nc.activo = true
        AND nc.notif_ventanas = true
    `)

    for (const u of usuarios) {
      // Obtener horario de hoy
      const { rows: clases } = await pool.query(`
        SELECT hora_inicio, hora_fin FROM horario
        WHERE usuario_id = $1 AND dia = $2
        ORDER BY hora_inicio
      `, [u.usuario_id, diaHoy])

      // Detectar ventanas libres de 1h+ entre 8:00 y 22:00
      const ventanas = []
      const bloques = [{ hora_inicio: '08:00', hora_fin: '08:00' }, ...clases, { hora_inicio: '22:00', hora_fin: '22:00' }]
      
      for (let i = 0; i < bloques.length - 1; i++) {
        const finAnterior = bloques[i].hora_fin
        const inicioSiguiente = bloques[i+1].hora_inicio
        const [fh, fm] = finAnterior.split(':').map(Number)
        const [ih, im] = inicioSiguiente.split(':').map(Number)
        const durMin = (ih * 60 + im) - (fh * 60 + fm)
        if (durMin >= 60) {
          ventanas.push({ desde: finAnterior, hasta: inicioSiguiente, durMin })
        }
      }

      if (ventanas.length === 0) continue

      // Obtener evaluación más próxima
      const { rows: evals } = await pool.query(`
        SELECT e.nombre, r.nombre as ramo_nombre, e.fecha
        FROM evaluaciones e
        JOIN ramos r ON r.id = e.ramo_id
        WHERE r.usuario_id = $1
          AND e.fecha >= CURRENT_DATE
          AND e.nota IS NULL
        ORDER BY e.fecha ASC
        LIMIT 1
      `, [u.usuario_id])

      const mejorVentana = ventanas.sort((a,b) => b.durMin - a.durMin)[0]
      const horas = Math.floor(mejorVentana.durMin / 60)
      const mins = mejorVentana.durMin % 60
      const durTexto = mins > 0 ? `${horas}h ${mins}min` : `${horas}h`

      let body = `Tienes ${durTexto} libres de ${mejorVentana.desde} a ${mejorVentana.hasta}`
      if (evals.length > 0) {
        body += ` · Aprovecha para estudiar ${evals[0].ramo_nombre}`
      }

      const { rows: subs } = await pool.query(
        'SELECT subscription FROM push_subscriptions WHERE usuario_id = $1',
        [u.usuario_id]
      )

      for (const sub of subs) {
        try {
          await webpush.sendNotification({endpoint: sub.subscription.endpoint, expirationTime: sub.subscription.expirationTime, keys: {p256dh: sub.subscription.keys.p256dh, auth: sub.subscription.keys.auth}}, JSON.stringify({
            title: '📖 Ventana de estudio disponible',
            body,
            icon: '/icon-192.png'
          }))
        } catch(e) {
          if (e.statusCode === 410) {
            await pool.query('DELETE FROM push_subscriptions WHERE subscription = $1', [JSON.stringify(sub.subscription)])
          }
        }
      }
    }
  } catch(err) {
    console.error('❌ Error cron ventanas estudio:', err.message)
  }
}, { timezone: 'America/Santiago' })



// ── UNIVERSIDAD ──────────────────────────────────────────────────

app.patch('/usuarios/universidad', authenticateToken, async (req, res) => {
  try {
    const { universidad } = req.body
    const { rows } = await pool.query(
      'UPDATE usuarios SET universidad = $1 WHERE id = $2 RETURNING *',
      [universidad, req.user.id]
    )
    res.json(rows[0])
  } catch(err) { res.status(500).json({ error: err.message }) }
})


app.get('/evaluaciones/:id/podcast/audio', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id
    const evId = req.params.id
    const tareaIdx = req.query.tareaIdx ?? null
    // Verificar que la evaluación pertenece al usuario
    const evRes = await pool.query(
      'SELECT e.id FROM evaluaciones e JOIN ramos r ON r.id = e.ramo_id WHERE e.id = $1 AND r.usuario_id = $2',
      [evId, userId]
    )
    if (!evRes.rows.length) return res.status(404).json({ error: 'No encontrada' })
    const podRes = await pool.query(
      'SELECT audio, titulo FROM podcasts WHERE evaluacion_id = $1 AND tarea_idx = $2',
      [evId, tareaIdx]
    )
    if (!podRes.rows.length || !podRes.rows[0].audio) return res.status(404).json({ error: 'No hay podcast' })
    const audioBuffer = Buffer.from(podRes.rows[0].audio, 'base64')
    res.set({ 'Content-Type': 'audio/mpeg', 'X-Podcast-Titulo': encodeURIComponent(podRes.rows[0].titulo || '') })
    res.send(audioBuffer)
  } catch(err) {
    res.status(500).json({ error: 'Error' })
  }
})

app.get('/evaluaciones/:id/podcast', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id
    const evId = req.params.id
    // Verificar que la evaluación pertenece al usuario
    const evRes = await pool.query(
      'SELECT e.id FROM evaluaciones e JOIN ramos r ON r.id = e.ramo_id WHERE e.id = $1 AND r.usuario_id = $2',
      [evId, userId]
    )
    if (!evRes.rows.length) return res.status(404).json({ error: 'No encontrada' })
    // Devolver todos los podcasts de esta evaluación
    const podRes = await pool.query(
      'SELECT tarea_idx, titulo FROM podcasts WHERE evaluacion_id = $1',
      [evId]
    )
    return res.json({ podcasts: podRes.rows })
  } catch(err) {
    res.status(500).json({ error: 'Error' })
  }
})

app.post('/evaluaciones/:id/podcast', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id
    const evId = req.params.id
    const tareaIdx = req.body.tareaIdx ?? null
    const userRes = await pool.query('SELECT podcasts_usados FROM usuarios WHERE id = $1', [userId])
    const usados = userRes.rows[0]?.podcasts_usados || 0
    const limiteRes = await pool.query("SELECT valor FROM configuracion WHERE clave = 'limite_global'")
    const limiteGlobal = limiteRes.rows.length ? parseInt(limiteRes.rows[0].valor) : 100
    if (usados >= limiteGlobal) return res.status(403).json({ error: 'limite_alcanzado', usados, limite: limiteGlobal })
    const evRes = await pool.query(
      `SELECT e.*, r.nombre as ramo_nombre, e.texto_material, e.plan_estudio FROM evaluaciones e JOIN ramos r ON r.id = e.ramo_id WHERE e.id = $1 AND r.usuario_id = $2`,
      [evId, userId]
    )
    if (!evRes.rows.length) return res.status(404).json({ error: 'No encontrada' })
    const ev = evRes.rows[0]
    // Leer archivos directamente si no hay texto_material
    let material = ev.texto_material || ''
    if (!material) {
      const archivosRes = await pool.query('SELECT nombre, tipo, datos FROM archivos WHERE evaluacion_id = $1', [evId])
      for (const archivo of archivosRes.rows) {
        try {
          const buf = Buffer.isBuffer(archivo.datos) ? archivo.datos : Buffer.from(archivo.datos)
          if (archivo.tipo === 'application/pdf') {
            const parsed = await pdfParse(buf)
            material += parsed.text + ' '
          } else if (archivo.tipo && archivo.tipo.includes('word')) {
            const result = await mammoth.extractRawText({ buffer: buf })
            material += result.value + ' '
          }
        } catch(e) { console.error('Error leyendo archivo:', e.message) }
      }
      material = material.trim()
    }
    // BLOQUEO: no generar podcast sin material
    if (!material) {
      return res.status(400).json({ error: 'sin_material', mensaje: 'Debes subir material de estudio para generar el podcast.' })
    }
    const plan = ev.plan_estudio ? JSON.stringify(ev.plan_estudio) : ''
    const guionRes = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{
        role: 'system',
        content: 'Eres un generador de podcasts educativos en español. Genera un guión conversacional entre dos personas: "Ana" (profesora entusiasta y experta) y "Carlos" (estudiante curioso que hace preguntas inteligentes). El podcast debe durar aproximadamente 15 minutos. Formato estricto JSON: { "titulo": "...", "segmentos": [{ "voz": "ana"|"carlos", "texto": "..." }] }. Mínimo 60 segmentos, máximo 80. Cada segmento debe tener al menos 3-4 oraciones completas y detalladas. Estructura: introducción motivadora (5 seg), desarrollo profundo por subtemas con ejemplos reales (45 seg), preguntas y respuestas entre Ana y Carlos (10 seg), conclusión y consejos para el examen (5 seg). Habla natural, usa analogías, ejemplos cotidianos y humor ocasional.'
      }, {
        role: 'user',
        content: material
        ? 'Crea un podcast educativo de EXACTAMENTE 15 minutos para estudiar: "' + ev.nombre + '" del ramo "' + ev.ramo_nombre + '". Basa el podcast EXCLUSIVAMENTE en este material y cubre ABSOLUTAMENTE TODOS los temas con profundidad y ejemplos reales: ' + material.slice(0, 12000) + (plan ? ' Plan de estudio: ' + plan.slice(0, 2000) : '') + ' IMPORTANTE: El podcast debe tener mínimo 60 segmentos, cada uno con 3-4 oraciones. No resumas, desarrolla cada concepto en detalle como si fuera una clase completa.'
        : 'Crea un podcast educativo de EXACTAMENTE 15 minutos para estudiar: "' + ev.nombre + '" del ramo "' + ev.ramo_nombre + '". ' + (plan ? 'Basa el contenido en este plan de estudio y desarróllalo en máximo detalle: ' + plan.slice(0, 3000) : 'Explica en profundidad todos los conceptos clave que un estudiante universitario necesita saber sobre este tema, con ejemplos, aplicaciones y casos reales.') + ' IMPORTANTE: Mínimo 60 segmentos, cada uno con 3-4 oraciones detalladas.'
      }],
      response_format: { type: 'json_object' }
    })
    let guion
    try { guion = JSON.parse(guionRes.choices[0].message.content) }
    catch(e) { return res.status(500).json({ error: 'Error generando guion' }) }
    const voces = {
      ana: 'ajOR9IDAaubDK5qtLUqQ',
      carlos: '4g0zcFn3Yhp86jjySzFf'
    }
    const audioBuffers = []
    const elevenLabsKey = process.env.ELEVENLABS_API_KEY
    for (const seg of guion.segmentos) {
      const voiceId = voces[seg.voz] || voces.ana
      const voiceSettings = seg.voz === 'ana'
        ? { stability: 0.55, similarity_boost: 0.75, style: 0.15, use_speaker_boost: true }
        : { stability: 0.45, similarity_boost: 0.80, style: 0.25, use_speaker_boost: true }
      const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
        method: 'POST',
        headers: {
          'xi-api-key': elevenLabsKey,
          'Content-Type': 'application/json',
          'Accept': 'audio/mpeg'
        },
        body: JSON.stringify({
          text: seg.texto,
          model_id: 'eleven_multilingual_v2',
          voice_settings: voiceSettings
        })
      })
      if (!response.ok) {
        const errText = await response.text()
        throw new Error(`ElevenLabs error: ${response.status} - ${errText}`)
      }
      audioBuffers.push(Buffer.from(await response.arrayBuffer()))
    }
    const audioFinal = Buffer.concat(audioBuffers)
    await pool.query('UPDATE usuarios SET podcasts_usados = podcasts_usados + 1 WHERE id = $1', [userId])
    const audioBase64 = audioFinal.toString('base64')
    const tituloFinal = guion.titulo || ev.nombre
    await pool.query(
      'INSERT INTO podcasts (evaluacion_id, tarea_idx, titulo, audio) VALUES ($1, $2, $3, $4) ON CONFLICT (evaluacion_id, tarea_idx) DO UPDATE SET titulo = $3, audio = $4',
      [evId, tareaIdx ?? 0, tituloFinal, audioBase64]
    )
    res.set({ 'Content-Type': 'audio/mpeg', 'X-Podcasts-Usados': usados + 1, 'X-Podcast-Titulo': encodeURIComponent(tituloFinal) })
    res.send(audioFinal)
  } catch(err) {
    console.error('Error generando podcast:', err)
    res.status(500).json({ error: 'Error generando podcast' })
  }
})

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
       WHERE e.id = $1 AND r.usuario_id = $2`,
      [req.params.id, req.user.id]
    )
    if (!evRows[0]) return res.status(404).json({ error: 'Evaluación no encontrada' })
    const ev = evRows[0]

    // Si ya existe la guía y no se fuerza regenerar, devolverla
    const guiasGuardadas = ev.guias_tareas || {}
    const key = String(tareaIndex)
    if (guiasGuardadas[key] && !forzar) {
      return res.json({ ...guiasGuardadas[key], cached: true })
    }

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

    const result = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7
    })
    const text = result.choices[0].message.content
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

// Ruta PATCH para actualizar nota (usada por el frontend)
app.put('/ramos/:id', authenticateToken, async (req, res) => {
  try {
    const { nombre, min_aprobacion, evaluaciones, nota_examen, nota_final, estado_final, ponderacion_examen, nota_eximicion, condiciones_eximicion, sin_rojos } = req.body
    const ramoResult = await pool.query(
      'UPDATE ramos SET nombre=$1, min_aprobacion=$2, nota_examen=$3, nota_final=$4, estado_final=$5, ponderacion_examen=$6, nota_eximicion=$7, condiciones_eximicion=$8, sin_rojos=$9 WHERE id=$10 AND usuario_id=$11 RETURNING *',
      [nombre, min_aprobacion, nota_examen||null, nota_final||null, estado_final||null, ponderacion_examen||25, nota_eximicion||null, condiciones_eximicion||null, sin_rojos||false, req.params.id, req.user.id]
    )
    if (ramoResult.rows.length === 0) return res.status(404).json({ error: 'Ramo no encontrado' })
    const evIds = await pool.query('SELECT id FROM evaluaciones WHERE ramo_id=$1', [req.params.id])
    const realIds = new Set(evIds.rows.map(r => r.id))
    for (const e of evaluaciones) {
      if (e.id && realIds.has(e.id)) {
        await pool.query(
          'UPDATE evaluaciones SET nota=$1, fecha=$2, nombre=$3, ponderacion=$4 WHERE id=$5 AND ramo_id=$6',
          [e.nota || null, e.fecha || null, e.nombre, e.ponderacion, e.id, req.params.id]
        )
      } else if (!e.id || !realIds.has(e.id)) {
        if (!e.nombre || !e.nombre.trim()) continue
        await pool.query(
          'INSERT INTO evaluaciones (ramo_id, nombre, ponderacion, nota, fecha) VALUES ($1, $2, $3, $4, $5)',
          [req.params.id, e.nombre.trim(), e.ponderacion, e.nota || null, e.fecha || null]
        )
      }
    }
    const updated = await pool.query(
      `SELECT r.*, json_agg(json_build_object('id',e.id,'nombre',e.nombre,'ponderacion',e.ponderacion,'nota',e.nota,'fecha',e.fecha) ORDER BY e.id) as evaluaciones FROM ramos r LEFT JOIN evaluaciones e ON e.ramo_id = r.id WHERE r.id=$1 GROUP BY r.id`,
      [req.params.id]
    )
    res.json(updated.rows[0])
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }) }
})

app.patch('/ramos/:ramoId/evaluaciones/:evalId', authenticateToken, async (req, res) => {
  try {
    const { nota } = req.body
    await pool.query(
      'UPDATE evaluaciones SET nota = $1 WHERE id = $2',
      [nota || null, req.params.evalId]
    )
    res.json({ ok: true })
  } catch (err) {
    console.error('Error actualizando nota:', err)
    res.status(500).json({ error: 'Error al actualizar nota' })
  }
})
// Mon Apr  6 14:30:49 -04 2026
// Mon Apr  6 14:31:43 -04 2026

// ── QUIZ DE 20 PREGUNTAS ─────────────────────────────────────────
app.post('/evaluaciones/:id/quiz', authenticateToken, async (req, res) => {
  try {
    const { forzar } = req.body
    const { rows: evRows } = await pool.query(
      `SELECT e.*, e.texto_material, r.nombre as ramo_nombre,
        (SELECT json_agg(json_build_object('nombre', a.nombre, 'tipo', a.tipo, 'datos', encode(a.datos, 'base64')))
         FROM archivos a WHERE a.evaluacion_id = e.id) as archivos
       FROM evaluaciones e JOIN ramos r ON r.id = e.ramo_id
       WHERE e.id = $1 AND r.usuario_id = $2`,
      [req.params.id, req.user.id]
    )
    if (!evRows[0]) return res.status(404).json({ error: 'Evaluación no encontrada' })
    const ev = evRows[0]
    if (ev.quiz_generado && !forzar) return res.json({ preguntas: ev.quiz_generado, cached: true })
    // BLOQUEO: límite quizzes (solo nuevas generaciones, no cache)
    const quizzesRes = await pool.query('SELECT quizzes_usados FROM usuarios WHERE id = $1', [req.user.id])
    const quizzesUsados = quizzesRes.rows[0]?.quizzes_usados || 0
    const limiteResQ = await pool.query("SELECT valor FROM configuracion WHERE clave = 'limite_global'")
    const limiteGlobalQ = limiteResQ.rows.length ? parseInt(limiteResQ.rows[0].valor) : 100
    if (quizzesUsados >= limiteGlobalQ) return res.status(403).json({ error: 'limite_alcanzado', tipo: 'quizzes', usados: quizzesUsados, limite: limiteGlobalQ })
    // Usar texto ya extraído si existe
    let textoArchivos = ev.texto_material || ''
    if (!textoArchivos && (!ev.archivos || ev.archivos.length === 0)) {
      return res.status(400).json({ error: 'Debes subir material de estudio para generar el quiz' })
    }
    if (!textoArchivos) for (const archivo of ev.archivos) {
      if (archivo.datos) {
        try {
          const buffer = Buffer.from(archivo.datos, 'base64')
          if (archivo.tipo && archivo.tipo.includes('pdf')) {
            const parsed = await pdfParse(buffer)
            textoArchivos += `\n\n--- ${archivo.nombre} ---\n${parsed.text.slice(0, 10000)}`
          } else if (archivo.tipo && (archivo.tipo.includes('word') || archivo.tipo.includes('docx') || archivo.nombre?.endsWith('.docx'))) {
            const result = await mammoth.extractRawText({ buffer })
            textoArchivos += `\n\n--- ${archivo.nombre} ---\n${result.value.slice(0, 10000)}`
          }
        } catch(e) { console.error('Error extrayendo texto para quiz:', e.message) }
      }
    }
    if (!textoArchivos.trim()) return res.status(400).json({ error: 'No se pudo extraer texto del material subido' })
    const prompt = `Eres un profesor universitario experto en ${ev.ramo_nombre}. Tu tarea es crear un quiz que evalúe si el estudiante ENTIENDE y SABE APLICAR los conceptos del material, NO que recuerde cómo está organizado el documento.

Ramo: ${ev.ramo_nombre}
Evaluación: ${ev.nombre}

MATERIAL DE ESTUDIO:
${textoArchivos}

INSTRUCCIONES CRÍTICAS:
- Genera EXACTAMENTE 20 preguntas de alternativas múltiples (A, B, C, D)
- PROHIBIDO preguntar sobre: autores, capítulos, estructura del libro, cuándo fue escrito, en qué página aparece algo, o cualquier cosa sobre el documento en sí
- SOLO preguntas que evalúen COMPRENSIÓN REAL del contenido:
  * Definiciones y conceptos ("¿Qué es...?", "¿Cuál es la diferencia entre X e Y?")
  * Aplicación ("Si X ocurre, ¿qué sucede con Y?", "¿Cuál es el resultado de...?")
  * Resolución de problemas (ejercicios numéricos, cálculos, demostraciones)
  * Análisis ("¿Por qué...?", "¿Cuál de las siguientes afirmaciones es correcta sobre...?")
  * Ejemplos concretos ("¿Cuál de estos es un ejemplo de...?")
- Varía dificultad: 8 fáciles (recordar definición), 8 medias (aplicar concepto), 4 difíciles (analizar o resolver)
- Las alternativas incorrectas deben ser plausibles (errores comunes, no absurdos)
- La explicación debe enseñar POR QUÉ la respuesta es correcta, no solo decir cuál es
- SIEMPRE en ESPAÑOL, sin importar el idioma del material
- Responde SOLO JSON válido sin markdown

Formato:
{"preguntas":[{"id":1,"pregunta":"...","alternativas":{"A":"...","B":"...","C":"...","D":"..."},"correcta":"A","explicacion":"...","dificultad":"facil"}]}`
    const result = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7
    })
    let text = result.choices[0].message.content
    // Limpiar markdown si viene envuelto en ```json ... ```
    text = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim()
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error('No se pudo parsear respuesta de IA')
    let quizData
    try {
      quizData = JSON.parse(jsonMatch[0])
    } catch (parseErr) {
      console.error('JSON inválido:', jsonMatch[0].substring(0, 200))
      throw new Error('La IA devolvió JSON inválido')
    }
    if (!quizData.preguntas || quizData.preguntas.length === 0) throw new Error('La IA no generó preguntas válidas')
    await pool.query('UPDATE evaluaciones SET quiz_generado = $1 WHERE id = $2', [JSON.stringify(quizData.preguntas), req.params.id])
    await pool.query('UPDATE usuarios SET quizzes_usados = quizzes_usados + 1 WHERE id = $1', [req.user.id])
    res.json({ preguntas: quizData.preguntas })
  } catch (err) {
    console.error('Error generando quiz:', err)
    res.status(500).json({ error: 'Error al generar quiz: ' + err.message })
  }
})

// ── EJERCICIOS PDF ───────────────────────────────────────────────
const PDFDocument = require('pdfkit')

app.post('/evaluaciones/:id/ejercicios-pdf', authenticateToken, async (req, res) => {
  try {
    const { tarea, tareaIndex } = req.body
    const evRes = await pool.query(
      `SELECT e.*, r.nombre as ramo_nombre FROM evaluaciones e
       JOIN ramos r ON e.ramo_id = r.id
       WHERE e.id = $1 AND r.usuario_id = $2`,
      [req.params.id, req.user.id]
    )
    if (evRes.rows.length === 0) return res.status(404).json({ error: 'No encontrada' })
    const ev = evRes.rows[0]

    // BLOQUEO: límite ejercicios
    const ejerciciosRes = await pool.query('SELECT ejercicios_usados FROM usuarios WHERE id = $1', [req.user.id])
    const ejerciciosUsados = ejerciciosRes.rows[0]?.ejercicios_usados || 0
    const limiteResE = await pool.query("SELECT valor FROM configuracion WHERE clave = 'limite_global'")
    const limiteGlobalE = limiteResE.rows.length ? parseInt(limiteResE.rows[0].valor) : 100
    if (ejerciciosUsados >= limiteGlobalE) return res.status(403).json({ error: 'limite_alcanzado', tipo: 'ejercicios', usados: ejerciciosUsados, limite: limiteGlobalE })

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: `Eres un profesor universitario experto en "${ev.ramo_nombre}".
Genera exactamente 20 ejercicios sobre el tema: "${tarea.titulo}".
Contexto: ${tarea.descripcion}

- Ejercicios 1-7: FÁCILES (conceptos básicos)
- Ejercicios 8-14: MEDIOS (aplicación)
- Ejercicios 15-20: DIFÍCILES (análisis y síntesis)
- Cada ejercicio debe tener enunciado claro y solución detallada paso a paso

Responde SOLO con JSON válido:
{"ejercicios":[{"numero":1,"dificultad":"fácil","enunciado":"...","solucion":"..."}]}` }],
      response_format: { type: 'json_object' }
    })

    const data = JSON.parse(completion.choices[0].message.content)
    const ejercicios = data.ejercicios || []

    const doc = new PDFDocument({ margin: 50, size: 'A4', bufferPages: true })
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="ejercicios-${tareaIndex+1}.pdf"`)
    await pool.query('UPDATE usuarios SET ejercicios_usados = ejercicios_usados + 1 WHERE id = $1', [req.user.id])
    doc.pipe(res)

    // ── Helpers ──────────────────────────────────────────────────
    const BG       = '#0f0f1a'
    const CARD     = '#1a1a2e'
    const ACCENT   = '#6c63ff'
    const ACCENT2  = '#a78bfa'
    const WHITE    = '#ffffff'
    const GRAY     = '#a0a0b8'
    const EASY     = '#34d399'
    const MED      = '#fbbf24'
    const HARD     = '#f87171'
    const W        = 595 - 100  // page width minus margins
    const PAGE_H   = 842

    const diffColor = (d) => {
      const dl = (d || '').toLowerCase()
      if (dl.includes('f')) return EASY
      if (dl.includes('m')) return MED
      return HARD
    }
    const diffLabel = (d) => {
      const dl = (d || '').toLowerCase()
      if (dl.includes('f')) return 'FÁCIL'
      if (dl.includes('m')) return 'MEDIO'
      return 'DIFÍCIL'
    }

    const drawPageBg = () => {
      doc.rect(0, 0, 595, PAGE_H).fill(BG)
    }

    // ── PORTADA ──────────────────────────────────────────────────
    drawPageBg()

    // Header bar
    doc.rect(0, 0, 595, 8).fill(ACCENT)

    // Logo pill
    doc.roundedRect(50, 40, 120, 32, 8).fill(ACCENT)
    doc.fontSize(15).fillColor(WHITE).font('Helvetica-Bold').text('APPrueba', 50, 49, { width: 120, align: 'center' })

    // Título principal
    doc.fontSize(28).fillColor(WHITE).font('Helvetica-Bold').text('Guía de Ejercicios', 50, 110, { width: W })
    doc.moveDown(0.4)
    doc.fontSize(16).fillColor(ACCENT2).font('Helvetica').text(tarea.titulo, 50, doc.y, { width: W })
    doc.moveDown(0.6)
    doc.fontSize(12).fillColor(GRAY).text(ev.ramo_nombre + '  ·  ' + ev.nombre, 50, doc.y, { width: W })

    // Divider
    doc.moveDown(1.2)
    doc.rect(50, doc.y, W, 2).fill(ACCENT)
    doc.moveDown(1.5)

    // Stats cards
    const cardY = doc.y
    const cardW = (W - 20) / 3
    const stats = [
      { label: 'Ejercicios', value: '20', color: ACCENT },
      { label: 'Dificultades', value: '3 niveles', color: ACCENT2 },
      { label: 'Respuestas', value: 'Al final', color: EASY }
    ]
    stats.forEach((s, i) => {
      const cx = 50 + i * (cardW + 10)
      doc.roundedRect(cx, cardY, cardW, 60, 8).fill(CARD)
      doc.fontSize(20).fillColor(s.color).font('Helvetica-Bold').text(s.value, cx, cardY + 10, { width: cardW, align: 'center' })
      doc.fontSize(9).fillColor(GRAY).font('Helvetica').text(s.label, cx, cardY + 36, { width: cardW, align: 'center' })
    })

    doc.moveDown(5)

    // Leyenda dificultad
    const legY = cardY + 80
    doc.fontSize(10).fillColor(GRAY).font('Helvetica').text('Niveles de dificultad:', 50, legY)
    const levels = [{ label: 'Fácil  (1–7)', color: EASY }, { label: 'Medio  (8–14)', color: MED }, { label: 'Difícil  (15–20)', color: HARD }]
    levels.forEach((l, i) => {
      const lx = 50 + i * 160
      doc.circle(lx + 6, legY + 22, 5).fill(l.color)
      doc.fontSize(10).fillColor(WHITE).text(l.label, lx + 16, legY + 16)
    })

    // Footer portada
    doc.fontSize(9).fillColor(GRAY).text('Generado por APPrueba · apprueba.cl', 50, PAGE_H - 40, { width: W, align: 'center' })

    // ── EJERCICIOS ───────────────────────────────────────────────
    ejercicios.forEach((ej, idx) => {
      doc.addPage()
      drawPageBg()
      doc.rect(0, 0, 595, 8).fill(diffColor(ej.dificultad))

      const dc = diffColor(ej.dificultad)
      const dl = diffLabel(ej.dificultad)

      // Número grande de fondo
      doc.fontSize(90).fillColor('#ffffff08').font('Helvetica-Bold').text(String(ej.numero), 400, 20, { width: 160, align: 'right' })

      // Badge dificultad
      doc.roundedRect(50, 20, 70, 22, 6).fill(dc)
      doc.fontSize(9).fillColor(BG).font('Helvetica-Bold').text(dl, 50, 26, { width: 70, align: 'center' })

      // Número ejercicio
      doc.fontSize(13).fillColor(GRAY).font('Helvetica').text('Ejercicio', 130, 20)
      doc.fontSize(22).fillColor(WHITE).font('Helvetica-Bold').text(String(ej.numero), 130, 34)

      // Línea separadora
      doc.rect(50, 58, W, 1).fill(ACCENT)

      // Enunciado
      doc.moveDown(0.5)
      doc.fontSize(11).fillColor(ACCENT2).font('Helvetica-Bold').text('Enunciado', 50, 72)
      doc.moveDown(0.3)
      doc.fontSize(11).fillColor(WHITE).font('Helvetica').text(ej.enunciado, 50, doc.y, { width: W, lineGap: 4 })

      // Espacio para respuesta del alumno
      doc.moveDown(1.5)
      doc.fontSize(10).fillColor(GRAY).font('Helvetica-Bold').text('Tu respuesta:', 50, doc.y)
      doc.moveDown(0.4)
      // Líneas para escribir
      const lineStartY = doc.y
      for (let l = 0; l < 5; l++) {
        const ly = lineStartY + l * 22
        if (ly < PAGE_H - 60) {
          doc.rect(50, ly, W, 1).fill('#2a2a4a')
        }
      }
      doc.y = lineStartY + 5 * 22

      // Footer
      doc.fontSize(8).fillColor(GRAY).text(`${ev.ramo_nombre}  ·  APPrueba`, 50, PAGE_H - 30, { width: W, align: 'center' })
    })

    // ── HOJA DE RESPUESTAS ───────────────────────────────────────
    doc.addPage()
    drawPageBg()
    doc.rect(0, 0, 595, 8).fill(ACCENT)

    doc.fontSize(22).fillColor(WHITE).font('Helvetica-Bold').text('Respuestas', 50, 30, { width: W })
    doc.fontSize(11).fillColor(GRAY).font('Helvetica').text('Revisa tus respuestas solo después de completar todos los ejercicios', 50, 58, { width: W })
    doc.rect(50, 78, W, 2).fill(ACCENT)

    let ry = 95
    ejercicios.forEach((ej) => {
      if (ry > PAGE_H - 120) {
        doc.addPage()
        drawPageBg()
        doc.rect(0, 0, 595, 8).fill(ACCENT)
        ry = 30
      }
      const dc = diffColor(ej.dificultad)
      // Número + badge
      doc.roundedRect(50, ry, 28, 18, 4).fill(dc)
      doc.fontSize(9).fillColor(BG).font('Helvetica-Bold').text(String(ej.numero), 50, ry + 4, { width: 28, align: 'center' })
      // Solución
      doc.fontSize(10).fillColor(WHITE).font('Helvetica-Bold').text('Ejercicio ' + ej.numero, 88, ry, { continued: false })
      doc.fontSize(10).fillColor(GRAY).font('Helvetica').text(ej.solucion, 88, ry + 14, { width: W - 38, lineGap: 3 })
      const textH = doc.heightOfString(ej.solucion, { width: W - 38 })
      ry += textH + 30
      // Divider
      doc.rect(88, ry - 10, W - 38, 1).fill('#2a2a4a')
    })

    doc.end()
  } catch(e) {
    console.error('Error ejercicios PDF:', e)
    if (!res.headersSent) res.status(500).json({ error: 'Error generando ejercicios' })
  }
})

// ── ENDPOINT TEMPORAL DE PRUEBA ──────────────────────────────────
app.post('/notificaciones/test', authenticateToken, async (req, res) => {
  try {
    const { rows: subs } = await pool.query(
      'SELECT subscription FROM push_subscriptions WHERE usuario_id = $1',
      [req.user.id]
    )
    if (subs.length === 0) return res.json({ ok: false, msg: 'No tienes subscripción push registrada' })
    
    const tipo = req.body.tipo || 'clase'
    let payload
    if (tipo === 'clase') {
      payload = { title: '🏫 Clase en 15 minutos', body: 'Álgebra Lineal empieza a las 14:30 · Sala B-101', icon: '/icon-192.png' }
    } else {
      payload = { title: '📖 Ventana de estudio disponible', body: 'Tienes 2h libres de 10:00 a 12:00 · Aprovecha para estudiar Física II', icon: '/icon-192.png' }
    }

    let enviadas = 0
    console.log("SUB DEBUG:", typeof subs[0].subscription, JSON.stringify(subs[0].subscription).slice(0,100))
    for (const sub of subs) {
      await webpush.sendNotification({endpoint: sub.subscription.endpoint, expirationTime: sub.subscription.expirationTime, keys: {p256dh: sub.subscription.keys.p256dh, auth: sub.subscription.keys.auth}}, JSON.stringify(payload))
      enviadas++
    }
    res.json({ ok: true, enviadas, payload })
  } catch(err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})
