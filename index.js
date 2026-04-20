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
const webpush = require('web-push')
const cron = require('node-cron')
const { extraerTextoPDF, pdfAImagenes } = require('./pdfExtractor')
const mammoth = require('mammoth')
const { pdf2pic } = require('pdf2pic')
const sharp = require('sharp')
const ffmpeg = require('fluent-ffmpeg')
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path
// youtubei.js se importa dinámicamente (ES module)
const fs = require('fs')
const path = require('path')
const { execSync, exec } = require('child_process')
const os = require('os')
ffmpeg.setFfmpegPath(ffmpegPath)
const bcrypt = require('bcrypt')
const OpenAI = require('openai')

// Helper: enviar notificación push a usuario específico
async function notificarUsuario(usuarioId, titulo, cuerpo, url = '/') {
  try {
    const { rows: subs } = await pool.query('SELECT subscription FROM push_subscriptions WHERE usuario_id = $1', [usuarioId])
    const payload = JSON.stringify({ title: titulo, body: cuerpo, url })
    for (const row of subs) {
      try {
        const s = row.subscription
        await webpush.sendNotification(
          { endpoint: s.endpoint, expirationTime: s.expirationTime, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } },
          payload
        )
      } catch(e) { console.error('Push error:', e.message) }
    }
  } catch(e) { console.error('notificarUsuario error:', e.message) }
}



// ══════════════════════════════════════════════════════════════
// EXTRACCIÓN UNIVERSAL DE CONTENIDO
// Soporta: PDF (texto/escaneado), DOCX, XLSX, imagen, audio, video, YouTube
// ══════════════════════════════════════════════════════════════
const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 2, timeout: 180_000 })

async function extraerContenido(archivo, enviar = () => {}) {
  const { nombre, tipo, datos } = archivo
  const ext = nombre ? nombre.split('.').pop().toLowerCase() : ''

  // ── YouTube URL ──
  if (archivo.youtubeUrl) {
    const tmpAudio = path.join(os.tmpdir(), `yt_${Date.now()}.mp3`)
    let chunkDir = null
    try {
      const videoId = archivo.youtubeUrl.match(/(?:v=|youtu\.be\/)([\w-]{11})/)?.[1]
      if (!videoId) return '(No se pudo extraer el ID del video de YouTube)'
      console.log(`🎬 Descargando audio con yt-dlp: ${videoId}`)
      enviar('progreso', { msg: `🎬 Procesando video de YouTube...` })
      // Descargar audio en menor calidad posible para evitar límite 25MB
      await new Promise((resolve, reject) => {
        exec(
          `yt-dlp -f "worstaudio" -x --audio-format mp3 --audio-quality 9 -o "${tmpAudio}" --no-playlist "${archivo.youtubeUrl}"`,
          { timeout: 600000 },
          (err, stdout, stderr) => {
            if (err) reject(new Error(stderr || err.message))
            else resolve(stdout)
          }
        )
      })
      // Verificar que el archivo existe (yt-dlp puede agregar extensión)
      let audioFinal = tmpAudio
      if (!fs.existsSync(audioFinal)) {
        const alt = tmpAudio.replace('.mp3', '.mp3.mp3')
        if (fs.existsSync(alt)) fs.renameSync(alt, audioFinal)
        else throw new Error('Archivo de audio no generado')
      }
      // Si el archivo supera 24MB, dividir en chunks con ffmpeg
      const audioSize = fs.statSync(audioFinal).size
      const MAX_SIZE = 24 * 1024 * 1024
      let transcripcionCompleta = ''
      if (audioSize <= MAX_SIZE) {
        console.log(`🎤 Transcribiendo audio de YouTube con Whisper...`)
        enviar('progreso', { msg: '🎤 Transcribiendo audio...' })
        const audioBuffer = fs.readFileSync(audioFinal)
        const whisperResp = await openaiClient.audio.transcriptions.create({
          file: new File([audioBuffer], 'audio.mp3', { type: 'audio/mpeg' }),
          model: 'whisper-1',
          language: 'es'
        })
        transcripcionCompleta = whisperResp.text
      } else {
        // Dividir en chunks de 15 minutos
        console.log(`🎬 Audio grande (${Math.round(audioSize/1024/1024)}MB), dividiendo en chunks...`)
        enviar('progreso', { msg: `🎬 Video largo detectado (${Math.round(audioSize/1024/1024)}MB), dividiendo en partes...` })
        chunkDir = `/tmp/chunks_${videoId}_${Date.now()}`
        fs.mkdirSync(chunkDir, { recursive: true })
        await new Promise((resolve, reject) => {
          exec(
            `ffmpeg -i "${audioFinal}" -f segment -segment_time 900 -c copy "${chunkDir}/chunk_%03d.mp3" -y`,
            { timeout: 300000 },
            (err) => { if (err) reject(err); else resolve() }
          )
        })
        const chunks = fs.readdirSync(chunkDir).filter(f => f.endsWith('.mp3')).sort()
        console.log(`🎤 Transcribiendo ${chunks.length} chunks con Whisper...`)
        enviar('progreso', { msg: `🎤 Transcribiendo ${chunks.length} partes del audio...` })
        const retryWhisper = async (buf, numChunk, totalChunks, maxIntentos = 3) => {
          let lastErr
          for (let intento = 1; intento <= maxIntentos; intento++) {
            try {
              return await openaiClient.audio.transcriptions.create({
                file: new File([buf], 'audio.mp3', { type: 'audio/mpeg' }),
                model: 'whisper-1',
                language: 'es'
              })
            } catch(err) {
              lastErr = err
              if (err.status === 401 || err.status === 403) throw err
              if (intento < maxIntentos) {
                const delay = Math.pow(2, intento - 1) * 1000
                console.warn(`⚠️ Chunk ${numChunk}/${totalChunks} intento ${intento} falló (${err.status || err.code || 'error'}), reintentando en ${delay}ms`)
                enviar('progreso', { msg: `⏳ Parte ${numChunk}/${totalChunks} reintentando (${intento}/${maxIntentos})...` })
                await new Promise(r => setTimeout(r, delay))
              }
            }
          }
          throw lastErr
        }
        let exitosos = 0
        let fallidos = 0
        const tInicio = Date.now()
        for (let i = 0; i < chunks.length; i++) {
          const chunkPath = `${chunkDir}/${chunks[i]}`
          const chunkBuffer = fs.readFileSync(chunkPath)
          try { fs.unlinkSync(chunkPath) } catch(_) {}
          const elapsed = Date.now() - tInicio
          const avg = i > 0 ? elapsed / i : 0
          const etaMin = avg > 0 ? Math.max(1, Math.round(avg * (chunks.length - i) / 60000)) : null
          const stats = (exitosos + fallidos > 0) ? ` · ✓${exitosos} ✗${fallidos}` : ''
          const etaTxt = etaMin ? ` · ~${etaMin}min` : ''
          console.log(`🎤 Chunk ${i+1}/${chunks.length}...`)
          enviar('progreso', { msg: `🎤 Parte ${i+1}/${chunks.length}${etaTxt}${stats}` })
          try {
            const resp = await retryWhisper(chunkBuffer, i+1, chunks.length)
            if (!resp.text || !resp.text.trim()) {
              console.warn(`⚠️ Chunk ${i+1}/${chunks.length} devolvió texto vacío`)
            }
            transcripcionCompleta += (resp.text || '') + ' '
            exitosos++
          } catch(err) {
            console.error(`❌ Chunk ${i+1}/${chunks.length} falló definitivamente (${err.status || err.code || 'error'}): ${err.message}`)
            if (err.status === 401 || err.status === 403) {
              enviar('advertencia', { msg: `⚠️ No se pudo transcribir el audio: la clave de OpenAI está rechazando la solicitud (${err.status}). Avisa al administrador — el plan se generará sin este material.` })
            } else {
              enviar('advertencia', { msg: `⚠️ Parte ${i+1} no se pudo transcribir (${err.status || err.code || 'error'}) — continuando con las demás` })
            }
            fallidos++
          }
        }
      }
      console.log(`🎬 YouTube transcrito completo: ${transcripcionCompleta.slice(0,200)}`)
      enviar('progreso', { msg: '✅ Audio transcrito, analizando contenido...' })
      return transcripcionCompleta
    } catch(e) {
      console.error('Error YouTube yt-dlp:', e.message)
      // Fallback: intentar metadata con youtubei.js
      try {
        const { Innertube } = await import('youtubei.js')
        const yt = await Innertube.create({ retrieve_player: false })
        const info = await yt.getInfo(archivo.youtubeUrl.match(/(?:v=|youtu\.be\/)([\w-]{11})/)?.[1])
        const titulo = info.basic_info?.title || ''
        const descripcion = info.basic_info?.short_description || ''
        console.log(`🎬 Fallback metadata: ${titulo}`)
        return `Título: ${titulo}\n\nDescripción: ${descripcion}`.slice(0, 15000)
      } catch(e2) {
        return '(No se pudo procesar el video de YouTube)'
      }
    } finally {
      try { if (fs.existsSync(tmpAudio)) fs.unlinkSync(tmpAudio) } catch(_) {}
      try {
        const alt = tmpAudio.replace('.mp3', '.mp3.mp3')
        if (fs.existsSync(alt)) fs.unlinkSync(alt)
      } catch(_) {}
      try { if (chunkDir) fs.rmSync(chunkDir, { recursive: true, force: true }) } catch(_) {}
    }
  }

  const buffer = Buffer.from(datos, 'base64')

  // ── PDF ──
  if (tipo?.includes('pdf') || ext === 'pdf') {
    try {
      const textoRaw = await extraerTextoPDF(buffer)
      const texto = textoRaw?.trim()
      if (texto && texto.length > 100) {
        console.log(`📄 PDF texto extraído: ${texto.slice(0,200)}`)
        return texto.slice(0, 15000)
      }
      // PDF escaneado → Vision
      console.log(`🔍 PDF escaneado, usando Vision...`)
      const tmpPdf = path.join(os.tmpdir(), `apprueba_${Date.now()}.pdf`)
      let pngFiles = []
      try {
        fs.writeFileSync(tmpPdf, buffer)
        const converter = pdf2pic.fromPath(tmpPdf, { density: 300, saveFilename: 'page', savePath: os.tmpdir(), format: 'png', width: 1200, height: 1600 })
        const pages = await converter.bulk(-1, { responseType: 'base64' })
        pngFiles = pages.map(p => p.path).filter(Boolean)
        const imagenes = pages.slice(0, 5).map(p => ({
          type: 'image_url',
          image_url: { url: `data:image/png;base64,${p.base64}`, detail: 'high' }
        }))
        const resp = await openaiClient.chat.completions.create({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: [
            { type: 'text', text: 'Extrae y transcribe todo el texto de estas páginas de apuntes universitarios. Incluye fórmulas, títulos, listas y todo el contenido relevante.' },
            ...imagenes
          ]}],
          max_tokens: 4000
        })
        return resp.choices[0].message.content.slice(0, 15000)
      } finally {
        try { if (fs.existsSync(tmpPdf)) fs.unlinkSync(tmpPdf) } catch(_) {}
        for (const f of pngFiles) {
          try { if (fs.existsSync(f)) fs.unlinkSync(f) } catch(_) {}
        }
      }
    } catch(e) {
      console.error('Error PDF:', e.message)
      return '(No se pudo procesar el PDF)'
    }
  }

  // ── DOCX ──
  if (tipo?.includes('word') || tipo?.includes('docx') || ext === 'docx' || ext === 'doc') {
    try {
      const result = await mammoth.extractRawText({ buffer })
      console.log(`📝 DOCX extraído: ${result.value.slice(0,200)}`)
      return result.value.slice(0, 15000)
    } catch(e) {
      console.error('Error DOCX:', e.message)
      return '(No se pudo procesar el archivo Word)'
    }
  }

  // ── XLSX / Excel ──
  if (tipo?.includes('spreadsheet') || tipo?.includes('excel') || ext === 'xlsx' || ext === 'xls') {
    try {
      const wb = XLSX.read(buffer, { type: 'buffer' })
      let texto = ''
      wb.SheetNames.forEach(sheet => {
        const ws = wb.Sheets[sheet]
        texto += `\n--- Hoja: ${sheet} ---\n`
        texto += XLSX.utils.sheet_to_csv(ws)
      })
      console.log(`📊 Excel extraído: ${texto.slice(0,200)}`)
      return texto.slice(0, 15000)
    } catch(e) {
      console.error('Error Excel:', e.message)
      return '(No se pudo procesar el archivo Excel)'
    }
  }

  // ── Imagen (foto de apunte, captura, etc) ──
  if (tipo?.includes('image') || ['png','jpg','jpeg','webp','gif','heic'].includes(ext)) {
    try {
      // Convertir a JPEG optimizado para Vision
      const imgBuffer = await sharp(buffer).jpeg({ quality: 85 }).toBuffer()
      const base64 = imgBuffer.toString('base64')
      const resp = await openaiClient.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: [
          { type: 'text', text: 'Extrae y transcribe todo el texto de esta imagen de apuntes universitarios. Incluye fórmulas, diagramas descritos en texto, títulos y todo el contenido relevante para estudiar.' },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}`, detail: 'high' } }
        ]}],
        max_tokens: 3000
      })
      console.log(`🖼️ Imagen procesada con Vision`)
      return resp.choices[0].message.content.slice(0, 15000)
    } catch(e) {
      console.error('Error imagen Vision:', e.message)
      return '(No se pudo procesar la imagen)'
    }
  }

  // ── Audio (nota de voz, MP3, M4A, WAV) ──
  if (tipo?.includes('audio') || ['mp3','m4a','wav','ogg','aac','opus','weba'].includes(ext)) {
    try {
      const tmpIn = path.join(os.tmpdir(), `apprueba_audio_${Date.now()}.${ext || 'mp3'}`)
      const tmpMp3 = path.join(os.tmpdir(), `apprueba_audio_${Date.now()}.mp3`)
      try {
        fs.writeFileSync(tmpIn, buffer)
        await new Promise((resolve, reject) => {
          ffmpeg(tmpIn).toFormat('mp3').on('end', resolve).on('error', reject).save(tmpMp3)
        })
        const audioBuffer = fs.readFileSync(tmpMp3)
        const whisperResp = await openaiClient.audio.transcriptions.create({
          file: new File([audioBuffer], 'audio.mp3', { type: 'audio/mpeg' }),
          model: 'whisper-1',
          language: 'es'
        })
        console.log(`🎤 Audio transcrito: ${whisperResp.text.slice(0,200)}`)
        return whisperResp.text.slice(0, 15000)
      } finally {
        try { if (fs.existsSync(tmpIn)) fs.unlinkSync(tmpIn) } catch(_) {}
        try { if (fs.existsSync(tmpMp3)) fs.unlinkSync(tmpMp3) } catch(_) {}
      }
    } catch(e) {
      console.error('Error audio Whisper:', e.message)
      if (e.status === 401 || e.status === 403) {
        return '(⚠️ No se pudo transcribir este audio: la clave de OpenAI está rechazando las solicitudes de Whisper. Avisa al administrador de APPrueba para revisar la configuración.)'
      }
      return '(No se pudo transcribir el audio)'
    }
  }

  // ── Video (MP4, MOV) ──
  if (tipo?.includes('video') || ['mp4','mov','avi','mkv','webm'].includes(ext)) {
    try {
      const tmpVideo = path.join(os.tmpdir(), `apprueba_video_${Date.now()}.${ext || 'mp4'}`)
      const tmpAudio = path.join(os.tmpdir(), `apprueba_audio_${Date.now()}.mp3`)
      try {
        fs.writeFileSync(tmpVideo, buffer)
        await new Promise((resolve, reject) => {
          ffmpeg(tmpVideo).noVideo().audioCodec('libmp3lame').on('end', resolve).on('error', reject).save(tmpAudio)
        })
        const audioBuffer = fs.readFileSync(tmpAudio)
        const whisperResp = await openaiClient.audio.transcriptions.create({
          file: new File([audioBuffer], 'audio.mp3', { type: 'audio/mpeg' }),
          model: 'whisper-1',
          language: 'es'
        })
        console.log(`🎥 Video transcrito: ${whisperResp.text.slice(0,200)}`)
        return whisperResp.text.slice(0, 15000)
      } finally {
        try { if (fs.existsSync(tmpVideo)) fs.unlinkSync(tmpVideo) } catch(_) {}
        try { if (fs.existsSync(tmpAudio)) fs.unlinkSync(tmpAudio) } catch(_) {}
      }
    } catch(e) {
      console.error('Error video:', e.message)
      if (e.status === 401 || e.status === 403) {
        return '(⚠️ No se pudo transcribir este video: la clave de OpenAI está rechazando las solicitudes de Whisper. Avisa al administrador de APPrueba para revisar la configuración.)'
      }
      return '(No se pudo procesar el video)'
    }
  }

  // ── PPT / PPTX ──
  if (tipo?.includes('presentat') || tipo?.includes('powerpoint') || ['ppt','pptx'].includes(ext)) {
    try {
      const { parseOffice } = require('officeparser')
      const resultado = await parseOffice(buffer, { outputErrorToConsole: false })
      const texto = (typeof resultado === 'string' ? resultado : (resultado?.text || resultado?.value || '')).trim()
      if (texto.length > 100) {
        console.log(`📊 PPTX texto extraído: ${texto.slice(0,200)}`)
        return texto.slice(0, 15000)
      }
      // PPTX con poco/ningún texto → extraer imágenes embebidas y OCR con Vision
      console.log(`🔍 PPTX con ${texto.length} chars de texto, usando Vision sobre imágenes embebidas...`)
      enviar('progreso', { msg: '🔍 PPTX con pocas palabras, leyendo imágenes...' })
      const JSZip = require('jszip')
      const zip = await JSZip.loadAsync(buffer)
      const imageFiles = Object.keys(zip.files)
        .filter(name => /^ppt\/media\/.*\.(png|jpe?g|gif|webp)$/i.test(name))
        .sort()
      if (imageFiles.length === 0) {
        console.log(`📊 PPTX sin imágenes embebidas, devolviendo texto disponible`)
        return texto || '(PPTX sin contenido legible)'
      }
      const imagenes = []
      for (const name of imageFiles.slice(0, 5)) {
        const imgBuffer = await zip.files[name].async('nodebuffer')
        const imgExt = name.split('.').pop().toLowerCase()
        const mime = imgExt === 'png' ? 'image/png' : 'image/jpeg'
        const b64 = imgBuffer.toString('base64')
        imagenes.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${b64}`, detail: 'high' } })
      }
      const resp = await openaiClient.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: [
          { type: 'text', text: 'Son slides de una presentación universitaria chilena (probablemente apuntes escaneados insertados como imágenes). Extrae y transcribe todo el texto visible, fórmulas, diagramas descritos en palabras, títulos y contenido relevante para estudiar. Responde en español.' },
          ...imagenes
        ]}],
        max_tokens: 4000
      })
      const textoOCR = resp.choices[0].message.content || ''
      console.log(`🖼️ PPTX procesado con Vision: ${textoOCR.slice(0,200)}`)
      return ((texto ? texto + '\n\n' : '') + textoOCR).slice(0, 15000)
    } catch(e) {
      console.error(`Error PPTX (${e.code || e.name || 'unknown'}): ${e.message}`)
      return '(No se pudo procesar el archivo PowerPoint)'
    }
  }
  return '(Formato no soportado)'
}
// ══════════════════════════════════════════════════════════════
const app = express()

webpush.setVapidDetails(
  'mailto:abelespinozav@gmail.com',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
)

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 2, timeout: 180_000 })
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } })

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
    CREATE TABLE IF NOT EXISTS quiz_historial (
      id SERIAL PRIMARY KEY,
      usuario_id INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
      evaluacion_id INTEGER REFERENCES evaluaciones(id) ON DELETE CASCADE,
      ramo_nombre TEXT,
      puntaje INTEGER,
      total INTEGER,
      porcentaje INTEGER,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id SERIAL PRIMARY KEY,
      usuario_id INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
      subscription JSONB NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS push_subscriptions_unique_endpoint
      ON push_subscriptions (usuario_id, (subscription->>'endpoint'));
    CREATE TABLE IF NOT EXISTS notificacion_config (
      id SERIAL PRIMARY KEY,
      usuario_id INTEGER UNIQUE REFERENCES usuarios(id) ON DELETE CASCADE,
      dias_antes INTEGER[] DEFAULT ARRAY[1,2,5],
      activo BOOLEAN DEFAULT true,
      notif_clases BOOLEAN DEFAULT true,
      notif_ventanas BOOLEAN DEFAULT true
    );
    CREATE TABLE IF NOT EXISTS notif_enviadas (
      id SERIAL PRIMARY KEY,
      usuario_id INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
      clave TEXT NOT NULL,
      enviada_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(usuario_id, clave)
    );
    CREATE TABLE IF NOT EXISTS podcasts (
      id SERIAL PRIMARY KEY,
      evaluacion_id INTEGER REFERENCES evaluaciones(id) ON DELETE CASCADE,
      tarea_idx INTEGER DEFAULT 0,
      titulo TEXT,
      audio TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(evaluacion_id, tarea_idx)
    );
    CREATE TABLE IF NOT EXISTS configuracion (
      clave TEXT PRIMARY KEY,
      valor TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS horario (
      id SERIAL PRIMARY KEY,
      usuario_id INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
      dia TEXT NOT NULL,
      hora_inicio TEXT,
      hora_fin TEXT,
      ramo_nombre TEXT,
      codigo TEXT,
      sala TEXT,
      tipo TEXT DEFAULT 'clase',
      periodo INTEGER,
      UNIQUE(usuario_id, dia, periodo)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS horario_usuario_dia_inicio_idx
      ON horario(usuario_id, dia, hora_inicio);
    CREATE TABLE IF NOT EXISTS novedades (
      id SERIAL PRIMARY KEY,
      universidad TEXT NOT NULL,
      tipo TEXT,
      emoji TEXT DEFAULT '📢',
      titulo TEXT NOT NULL,
      descripcion TEXT,
      color TEXT DEFAULT '#60a5fa',
      activa BOOLEAN DEFAULT true,
      creada_en TIMESTAMP DEFAULT NOW()
    );
    ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS universidad TEXT;
    ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS carrera TEXT;
    ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS onboarding_completado BOOLEAN DEFAULT false;
    ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS onboarding_v2 BOOLEAN DEFAULT false;
    ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS last_login TIMESTAMP;
    ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS es_fundador BOOLEAN DEFAULT false;
    ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS numero_registro INTEGER;
    -- Límites individuales por tipo. NULL = usar limite_global. Admin los
    -- setea desde el modal de detalle; sobrescriben el global solo para
    -- ese usuario y tipo.
    ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS planes_limite INTEGER;
    ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS quizzes_limite INTEGER;
    ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS podcasts_limite INTEGER;
    ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS ejercicios_limite INTEGER;
    ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS es_admin BOOLEAN DEFAULT false;
    ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS podcasts_usados INTEGER DEFAULT 0;
    ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS ejercicios_usados INTEGER DEFAULT 0;
    ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS quizzes_usados INTEGER DEFAULT 0;
    ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS planes_usados INTEGER DEFAULT 0;
    ALTER TABLE ramos ADD COLUMN IF NOT EXISTS nota_examen DECIMAL(3,1);
    ALTER TABLE ramos ADD COLUMN IF NOT EXISTS nota_final DECIMAL(3,1);
    ALTER TABLE ramos ADD COLUMN IF NOT EXISTS estado_final VARCHAR(50);
    ALTER TABLE ramos ADD COLUMN IF NOT EXISTS ponderacion_examen INTEGER DEFAULT 25;
    ALTER TABLE ramos ADD COLUMN IF NOT EXISTS nota_eximicion DECIMAL(3,1);
    ALTER TABLE ramos ADD COLUMN IF NOT EXISTS condiciones_eximicion TEXT;
    ALTER TABLE ramos ADD COLUMN IF NOT EXISTS sin_rojos BOOLEAN DEFAULT false;
    ALTER TABLE evaluaciones ADD COLUMN IF NOT EXISTS quiz_generado JSONB;
    ALTER TABLE evaluaciones ADD COLUMN IF NOT EXISTS guias_tareas JSONB;
    ALTER TABLE evaluaciones ADD COLUMN IF NOT EXISTS texto_material TEXT;
    ALTER TABLE evaluaciones ADD COLUMN IF NOT EXISTS plan_generando BOOLEAN DEFAULT false;
    ALTER TABLE evaluaciones ADD COLUMN IF NOT EXISTS ejercicios_pdf BYTEA;
    ALTER TABLE evaluaciones ADD COLUMN IF NOT EXISTS ejercicios_pdf_generado_at TIMESTAMP;
    ALTER TABLE evaluaciones ADD COLUMN IF NOT EXISTS ejercicios_pdf_tarea_index INTEGER;
    ALTER TABLE quiz_historial ADD COLUMN IF NOT EXISTS evaluacion_id INTEGER;
    ALTER TABLE novedades ADD COLUMN IF NOT EXISTS origen TEXT DEFAULT 'admin';
    ALTER TABLE novedades ADD COLUMN IF NOT EXISTS expira_en TIMESTAMP;
    DELETE FROM evaluaciones WHERE nombre IS NULL OR nombre = '';
  `)
  // Backfill/normaliza numero_registro de fundadores por orden de created_at.
  // Antes el código solo leía la columna — nunca la asignaba — así que
  // usuarios tenían números inconsistentes heredados de migraciones manuales
  // (ej. "#96" sin haber 50 usuarios). Idempotente: correr varias veces no
  // cambia nada si ya están ordenados.
  await pool.query(`
    UPDATE usuarios u SET numero_registro = sub.n
    FROM (
      SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id) AS n
      FROM usuarios WHERE es_fundador = TRUE
    ) sub
    WHERE u.id = sub.id AND u.es_fundador = TRUE
      AND (u.numero_registro IS DISTINCT FROM sub.n)
  `)
  console.log('Base de datos lista ✅')
}

// GOOGLE_CALLBACK_URL debe estar seteada explícitamente — antes había un
// fallback a localhost:3001 que dirigía OAuth en prod al lugar equivocado
// si la env var se olvidaba en el deploy.
if (!process.env.GOOGLE_CALLBACK_URL) {
  console.error('❌ FATAL: GOOGLE_CALLBACK_URL no está seteada. Setéala en las env vars (ej. https://api.apprueba.com/auth/google/callback para prod, http://localhost:3001/auth/google/callback para dev).')
  process.exit(1)
}

passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: process.env.GOOGLE_CALLBACK_URL
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

    // Si es nuevo, marcar como fundador y asignar numero_registro atómico.
    // UPDATE con subquery evita race condition entre dos altas simultáneas.
    if (esNuevo) {
      const { rows: countRows } = await pool.query('SELECT COUNT(*) as total FROM usuarios WHERE es_fundador = TRUE')
      if (parseInt(countRows[0].total) < 50) {
        const { rows: upd } = await pool.query(
          `UPDATE usuarios SET es_fundador = TRUE,
             numero_registro = (SELECT COALESCE(MAX(numero_registro), 0) + 1 FROM usuarios WHERE es_fundador = TRUE)
           WHERE id = $1 RETURNING numero_registro`,
          [usuario.id]
        )
        usuario.es_fundador = true
        usuario.numero_registro = upd[0]?.numero_registro
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
    const { rows: countRows } = await pool.query('SELECT COUNT(*) as total FROM usuarios')
    if (parseInt(countRows[0].total) >= 50) {
      return res.status(403).json({ error: 'lista_espera', mensaje: 'Los cupos están llenos' })
    }
    const hash = await bcrypt.hash(password, 10)
    const result = await pool.query(
      'INSERT INTO usuarios (nombre, email, password_hash) VALUES ($1, $2, $3) RETURNING id, nombre, email, avatar',
      [nombre, email, hash]
    )
    const usuario = result.rows[0]
    const { rows: fundRows } = await pool.query('SELECT COUNT(*) as total FROM usuarios WHERE es_fundador = TRUE')
    if (parseInt(fundRows[0].total) < 50) {
      const { rows: upd } = await pool.query(
        `UPDATE usuarios SET es_fundador = TRUE,
           numero_registro = (SELECT COALESCE(MAX(numero_registro), 0) + 1 FROM usuarios WHERE es_fundador = TRUE)
         WHERE id = $1 RETURNING numero_registro`,
        [usuario.id]
      )
      usuario.es_fundador = true
      usuario.numero_registro = upd[0]?.numero_registro
    }
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
    // Actualiza last_login: métricas del panel admin (DAU, activos hoy) lo
    // usan y antes solo se refrescaba en el flujo Google OAuth.
    await pool.query('UPDATE usuarios SET last_login = NOW() WHERE id = $1', [usuario.id]).catch(()=>{})
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
    // Redirigimos con el JWT en el fragment (hash). El fragment no viaja al
    // servidor → no aparece en logs de Railway/CDN ni en access logs. Resuelve
    // el bloqueo de third-party cookies de browsers modernos (Safari ITP,
    // Chrome Privacy Sandbox, Firefox ETP) que impedía usar cookies entre los
    // subdominios apprueba-production.up.railway.app y apprueba-backend-...
    res.redirect(`${process.env.CLIENT_URL}/#auth_token=${encodeURIComponent(token)}`)
  }
)

// Helper: badge especial para el owner / fundadores / usuarios regulares.
// Centralizado para que `/auth/me` y `/auth/onboarding` retornen la misma shape.
function buildBadge(email, esFundador, numeroRegistro) {
  if (email === 'abelespinozav@gmail.com') {
    return { badge: 'CEO', badge_emoji: '👑' }
  }
  if (esFundador) {
    return { badge: `Fundador #${numeroRegistro}`, badge_emoji: '🏅' }
  }
  return { badge: null, badge_emoji: null }
}

app.get('/auth/me', authenticateToken, async (req, res) => {
  // Refresca last_login en cada re-hidratación: sin esto, usuarios con
  // sesión válida de 7 días nunca aparecen como "activos hoy" aunque sí
  // estén usando la app, y los DAU del panel admin quedan subestimados.
  await pool.query('UPDATE usuarios SET last_login = NOW() WHERE id = $1', [req.user.id]).catch(()=>{})
  const { rows } = await pool.query('SELECT id, nombre, email, avatar, universidad, carrera, onboarding_completado, onboarding_v2, podcasts_usados, ejercicios_usados, quizzes_usados, planes_usados, es_fundador, numero_registro, created_at FROM usuarios WHERE id = $1', [req.user.id])
  if (!rows[0]) return res.status(401).json({ error: 'Usuario no encontrado' })
  const u = rows[0]
  const { badge, badge_emoji } = buildBadge(u.email, u.es_fundador, u.numero_registro)
  res.json({ user: { id: u.id, name: u.nombre, email: u.email, picture: u.avatar, universidad: u.universidad, carrera: u.carrera, onboarding_completado: u.onboarding_completado, onboarding_v2: u.onboarding_v2, es_fundador: u.es_fundador, numero_registro: u.numero_registro, badge, badge_emoji, created_at: u.created_at }, podcasts_usados: u.podcasts_usados || 0, ejercicios_usados: u.ejercicios_usados || 0, quizzes_usados: u.quizzes_usados || 0, planes_usados: u.planes_usados || 0 })
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

async function requireAdmin(req, res, next) {
  try {
    const { rows } = await pool.query('SELECT es_admin FROM usuarios WHERE id = $1', [req.user.id])
    if (!rows[0] || !rows[0].es_admin) {
      return res.status(403).json({ error: 'Acceso denegado: se requiere rol admin' })
    }
    next()
  } catch (e) {
    console.error('requireAdmin error:', e.message)
    res.status(500).json({ error: 'Error de autorización' })
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
        'quiz_generado', e.quiz_generado,
        'archivos', (
          SELECT json_agg(json_build_object('id', a.id, 'nombre', a.nombre, 'tipo', a.tipo))
          FROM archivos a WHERE a.evaluacion_id = e.id
        )
      ) ORDER BY e.id
    ) FILTER (WHERE e.id IS NOT NULL) as evaluaciones
     FROM ramos r
     LEFT JOIN evaluaciones e ON e.ramo_id = r.id
     WHERE r.usuario_id = $1
     GROUP BY r.id ORDER BY r.created_at DESC`,
    [req.user.id]
  )
  res.json(rows)
})

app.post('/ramos', authenticateToken, async (req, res) => {
  const {
    nombre,
    min_aprobacion, minAprobacion,  // acepta snake y camel
    nota_eximicion,
    condiciones_eximicion,
    sin_rojos,
    ponderacion_examen,
    evaluaciones
  } = req.body
  const minAp = min_aprobacion ?? minAprobacion ?? 4.0
  const { rows } = await pool.query(
    `INSERT INTO ramos (usuario_id, nombre, min_aprobacion, nota_eximicion, condiciones_eximicion, sin_rojos, ponderacion_examen)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [
      req.user.id,
      nombre,
      minAp,
      nota_eximicion || null,
      condiciones_eximicion || null,
      sin_rojos || false,
      ponderacion_examen || 25
    ]
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
  try {
    const { nota } = req.body
    const { rowCount } = await pool.query(
      `UPDATE evaluaciones SET nota = $1
       WHERE id = $2 AND ramo_id IN (SELECT id FROM ramos WHERE usuario_id = $3)`,
      [nota || null, req.params.id, req.user.id]
    )
    if (rowCount === 0) return res.status(404).json({ error: 'Evaluación no encontrada' })
    res.json({ ok: true })
  } catch (err) {
    console.error('Error actualizando nota:', err)
    res.status(500).json({ error: 'Error al guardar la nota' })
  }
})

app.delete('/ramos/limpiar-todos', authenticateToken, async (req, res) => {
  try {
    await pool.query('DELETE FROM ramos WHERE usuario_id = $1', [req.user.id])
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.delete('/ramos/:id', authenticateToken, async (req, res) => {
  try {
    await pool.query('DELETE FROM ramos WHERE id = $1 AND usuario_id = $2', [req.params.id, req.user.id])
    res.json({ ok: true })
  } catch (err) {
    console.error('Error eliminando ramo:', err)
    res.status(500).json({ error: 'Error al eliminar el ramo' })
  }
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
    const { rows: check } = await pool.query(
      `SELECT e.id FROM evaluaciones e JOIN ramos r ON r.id = e.ramo_id
       WHERE e.id = $1 AND r.usuario_id = $2`,
      [req.params.id, req.user.id]
    )
    if (check.length === 0) return res.status(404).json({ error: 'Evaluación no encontrada' })
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
  // Transacción: borra archivo + invalida material/plan/guías/podcasts en un
  // solo paso atómico. Antes, si la segunda o tercera query fallaba quedaba
  // material/plan huérfano apuntando a un archivo inexistente.
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      `SELECT a.evaluacion_id FROM archivos a
       JOIN evaluaciones e ON e.id = a.evaluacion_id
       JOIN ramos r ON r.id = e.ramo_id
       WHERE a.id = $1 AND r.usuario_id = $2`,
      [req.params.id, req.user.id]
    )
    if (rows.length === 0) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Archivo no encontrado' })
    }
    const evalId = rows[0].evaluacion_id
    await client.query('DELETE FROM archivos WHERE id = $1', [req.params.id])
    await client.query(
      'UPDATE evaluaciones SET texto_material = NULL, plan_estudio = NULL, guias_tareas = NULL WHERE id = $1',
      [evalId]
    )
    await client.query('DELETE FROM podcasts WHERE evaluacion_id = $1', [evalId])
    await client.query('COMMIT')
    res.json({ ok: true })
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('Error eliminando archivo:', err)
    res.status(500).json({ error: 'Error al eliminar el archivo' })
  } finally {
    client.release()
  }
})

// ── Helpers IA ────────────────────────────────────────────────
// Contexto del estudiante + ramo para personalizar prompts.
async function getPerfilEstudiante(evaluacionId) {
  try {
    const { rows } = await pool.query(`
      SELECT u.nombre, u.universidad, u.carrera,
             r.nombre as ramo_nombre, r.min_aprobacion,
             r.nota_eximicion, r.ponderacion_examen,
             ROUND(
               (SUM(e2.nota * e2.ponderacion) / NULLIF(SUM(CASE WHEN e2.nota IS NOT NULL THEN e2.ponderacion END), 0))::numeric
             , 1) as promedio_actual,
             COALESCE(SUM(CASE WHEN e2.nota IS NOT NULL THEN e2.ponderacion ELSE 0 END), 0) as ponderacion_usada
      FROM evaluaciones e
      JOIN ramos r ON r.id = e.ramo_id
      JOIN usuarios u ON u.id = r.usuario_id
      LEFT JOIN evaluaciones e2 ON e2.ramo_id = r.id
      WHERE e.id = $1
      GROUP BY u.nombre, u.universidad, u.carrera, r.nombre, r.min_aprobacion, r.nota_eximicion, r.ponderacion_examen
    `, [evaluacionId])
    return rows[0] || null
  } catch (err) {
    console.error('getPerfilEstudiante:', err.message)
    return null
  }
}

function formatPerfilBloque(perfil) {
  if (!perfil) return ''
  const prom = perfil.promedio_actual
  const promNum = prom != null ? parseFloat(prom) : null
  const minNum = parseFloat(perfil.min_aprobacion)
  const critico = promNum != null && promNum < minNum
  const uni = perfil.universidad || 'universidad chilena'
  return [
    'PERFIL DEL ESTUDIANTE:',
    `- Nombre: ${perfil.nombre || 'estudiante'}`,
    `- Universidad: ${uni}`,
    `- Carrera: ${perfil.carrera || 'no especificada'}`,
    `- Ramo: ${perfil.ramo_nombre}`,
    `- Promedio actual en el ramo: ${promNum != null ? promNum.toFixed(1) : 'sin notas aún'}`,
    `- Ponderación evaluada hasta ahora: ${perfil.ponderacion_usada || 0}%`,
    `- Nota mínima para aprobar: ${perfil.min_aprobacion}`,
    `- Situación: ${critico ? '⚠️ CRÍTICA — el estudiante está bajo el mínimo, necesita recuperarse' : 'va bien en el ramo'}`
  ].join('\n')
}

// Retry con backoff para llamadas gpt-4o chat completions. Bail inmediato
// en 401/403 (no tiene sentido reintentar con credenciales rotas).
// Resuelve el límite efectivo para un usuario y tipo. Si el usuario tiene
// un override individual, usa ese; sino cae a configuracion.limite_global.
async function resolverLimite(userId, tipo) {
  const columnas = {
    planes: 'planes_limite',
    quizzes: 'quizzes_limite',
    podcasts: 'podcasts_limite',
    ejercicios: 'ejercicios_limite'
  }
  const col = columnas[tipo]
  if (!col) throw new Error(`Tipo de límite inválido: ${tipo}`)
  const { rows } = await pool.query(
    `SELECT u.${col} AS individual,
            (SELECT valor FROM configuracion WHERE clave = 'limite_global') AS global
     FROM usuarios u WHERE u.id = $1`,
    [userId]
  )
  const individual = rows[0]?.individual
  if (individual !== null && individual !== undefined) return parseInt(individual)
  const global = rows[0]?.global
  return global ? parseInt(global) : 100
}

async function callOpenAIWithRetry(params, maxRetries = 2) {
  let lastErr
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await openaiClient.chat.completions.create(params)
    } catch (err) {
      lastErr = err
      // Bail inmediato si el cliente abortó (AbortController): reintento inútil.
      if (err?.name === 'AbortError' || err?.message === 'aborted' || params.signal?.aborted) throw err
      if (err.status === 401 || err.status === 403) throw err
      if (attempt === maxRetries) throw err
      console.warn(`OpenAI retry ${attempt}/${maxRetries}: ${err.message}`)
      await new Promise(r => setTimeout(r, 1500 * attempt))
    }
  }
  throw lastErr
}

// Generar plan de estudio con IA
app.post('/evaluaciones/:id/plan-estudio', authenticateToken, upload.array('archivo', 10), async (req, res) => {
  // Configurar SSE
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()
  const enviar = (tipo, datos) => {
    if (!res.destroyed) res.write(`data: ${JSON.stringify({ tipo, ...datos })}\n\n`)
  }
  const terminar = (tipo, datos) => {
    if (res.destroyed) return
    res.write(`data: ${JSON.stringify({ tipo, ...datos })}\n\n`)
    res.end()
  }
  let planContadoEnLimite = false
  try {
    // Validar y parsear ID
    const evalId = parseInt(req.params.id, 10)
    if (!evalId || isNaN(evalId)) return terminar('error', { error: 'id_invalido', mensaje: 'ID de evaluación inválido' })
    // Guardar archivos nuevos en BD antes de generar plan
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const { rows: existe } = await pool.query('SELECT id FROM archivos WHERE evaluacion_id = $1 AND nombre = $2', [evalId, file.originalname])
        if (existe.length === 0) {
          await pool.query('INSERT INTO archivos (evaluacion_id, nombre, tipo, datos) VALUES ($1, $2, $3, $4)', [evalId, file.originalname, file.mimetype, file.buffer])
        }
      }
    }
    enviar('progreso', { msg: '📋 Cargando información de la evaluación...' })
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
    { "titulo": "título corto", "descripcion": "descripción detallada", "prioridad": "alta", "duracion": 45, "fecha": "Lunes 10:00-11:30", "fuente": "nombre del archivo o 'Video min 12:30-15:00'" },
    { "titulo": "título corto", "descripcion": "descripción detallada", "prioridad": "media", "duracion": 30, "fecha": "Martes 14:00-14:30", "fuente": "nombre del archivo o 'Video min 05:00-08:00'" }
  ]
}

Genera EXACTAMENTE las tareas necesarias para cubrir TODO el contenido del material — sin límite fijo:
- Material corto (1-2 temas): mínimo 3 tareas.
- Material mediano (3-6 temas): entre 6 y 10 tareas.
- Material extenso (7+ temas o múltiples archivos): entre 10 y 20 tareas.
- NUNCA omitas un tema. Cada tema o subtema importante debe tener al menos una tarea.
- NO repitas tareas genéricas. Cada tarea debe ser específica al contenido real del material.
- prioridad: "alta", "media" o "baja". duracion en minutos (número). fecha en formato "Lunes 10:00-11:30" usando SOLO bloques libres del horario.
- fuente: indica de dónde proviene el contenido. Si es archivo, escribe el nombre exacto (ej: "CURRALHUE PARTE 1.pptx"). Si es YouTube, escribe el rango de minutos (ej: "Video min 12:30-15:00"). Si son múltiples fuentes, sepáralas con coma.`

    // Extraer texto de los archivos
    let textoArchivos = ''
    console.log('📎 Archivos en BD:', ev.archivos ? ev.archivos.length : 0)
    // Procesar YouTube URLs enviadas en el request — guardarlas en BD para persistencia
    const youtubeUrlRaw = req.body.youtubeUrl || req.query.youtubeUrl
    const youtubeUrlsArr = youtubeUrlRaw ? (Array.isArray(youtubeUrlRaw) ? youtubeUrlRaw : [youtubeUrlRaw]) : []
    for (const yUrl of youtubeUrlsArr) {
      if (yUrl && typeof yUrl === 'string' && yUrl.trim()) {
        // Guardar en BD como archivo tipo youtube si no existe
        const { rows: ytExiste } = await pool.query(
          'SELECT id FROM archivos WHERE evaluacion_id = $1 AND nombre = $2',
          [evalId, yUrl.trim()]
        )
        if (ytExiste.length === 0) {
          await pool.query(
            'INSERT INTO archivos (evaluacion_id, nombre, tipo, datos) VALUES ($1, $2, $3, $4)',
            [evalId, yUrl.trim(), 'youtube', Buffer.from(yUrl.trim())]
          )
        }
      }
    }
    // Recargar archivos desde BD (ahora incluye YouTube recién guardados)
    const { rows: archivosActualizados } = await pool.query(
      `SELECT nombre, tipo, encode(datos, 'base64') as datos FROM archivos WHERE evaluacion_id = $1`,
      [evalId]
    )
    // Procesar TODOS los archivos (PDF, DOCX, YouTube, etc.)
    for (const archivo of archivosActualizados) {
      const esYoutube = archivo.tipo === 'youtube'
      // Nombre legible para YouTube
      const nombreLegible = esYoutube
        ? (() => { try { const u = new URL(archivo.nombre); const v = u.searchParams.get('v'); return v ? `YouTube:${v}` : 'Video YouTube' } catch(e) { return 'Video YouTube' } })()
        : archivo.nombre
      const archivoObj = esYoutube
        ? { youtubeUrl: archivo.nombre, nombre: nombreLegible }
        : { nombre: archivo.nombre, tipo: archivo.tipo, datos: archivo.datos }
      enviar('progreso', { msg: `📄 Leyendo: ${nombreLegible}...` })
      console.log('📎 Procesando:', nombreLegible, '| tipo:', archivo.tipo)
      const contenido = await extraerContenido(archivoObj, enviar)
      // Si es YouTube, intentar extraer título real del contenido
      let nombreFuente = nombreLegible
      if (esYoutube && contenido.startsWith('Título:')) {
        const tituloMatch = contenido.match(/^Título: (.+)/m)
        if (tituloMatch) nombreFuente = tituloMatch[1].trim().slice(0, 60)
      }
      textoArchivos += `\n\n--- Contenido de ${nombreFuente} ---\n${contenido}`
    }

    // BLOQUEO: no generar plan sin material (archivos O youtube)
    if ((!ev.archivos || ev.archivos.length === 0) && youtubeUrlsArr.length === 0) {
      return terminar('error', { error: 'sin_material', mensaje: 'Debes subir material de estudio para generar el plan.' })
    }
    // BLOQUEO: límite de regeneraciones (solo si ya tiene plan).
    // Check-and-set atómico: previene race condition (dos requests pasando el
    // check simultáneamente y gastando cupo doble). Si la IA falla después,
    // se hace refund decrementando el contador.
    if (ev.plan_estudio) {
      const limiteP = await resolverLimite(req.user.id, 'planes')
      const { rowCount } = await pool.query(
        'UPDATE usuarios SET planes_usados = planes_usados + 1 WHERE id = $1 AND planes_usados < $2',
        [req.user.id, limiteP]
      )
      if (rowCount === 0) return terminar('error', { error: 'limite_alcanzado', mensaje: 'Alcanzaste el límite de regeneraciones del plan de estudio.' })
      planContadoEnLimite = true
    }
    // Detectar archivos que fallaron
    const archivosConError = []
    const textoLimpio = textoArchivos.replace(/--- Contenido de ([^-]+) ---\n\(No se pudo[^)]+\)/g, (_, nombre) => {
      archivosConError.push(nombre.trim())
      return ''
    }).replace(/--- Contenido de ([^-]+) ---\n\(Formato no soportado\)/g, (_, nombre) => {
      archivosConError.push(nombre.trim())
      return ''
    }).trim()

    if (archivosConError.length > 0 && !textoLimpio) {
      return terminar('error', { error: 'archivo_no_legible', mensaje: `No pudimos leer el archivo "${archivosConError[0]}". Formatos soportados: PDF, Word, Excel, PowerPoint, imágenes, audio y video.` })
    }
    if (archivosConError.length > 0) {
      enviar('progreso', { msg: `⚠️ No se pudo leer: ${archivosConError.join(', ')}. Continuando con el resto del material...` })
    }

    // Contexto del estudiante para personalizar el plan
    const perfil = await getPerfilEstudiante(evalId)
    const perfilBloque = formatPerfilBloque(perfil)

    const promptFinal = (perfilBloque ? perfilBloque + '\n\n' : '') + (textoArchivos
      ? promptText + `\n\nMATERIAL DE ESTUDIO DEL ESTUDIANTE:\n${textoArchivos}\n\nINSTRUCCIONES IMPORTANTES:\n- Debes generar el plan de estudio BASÁNDOTE EXCLUSIVAMENTE en el contenido del material subido.\n- NO importa si el material no parece relacionado con el nombre del ramo.\n- El estudiante sabe lo que necesita estudiar. Tu trabajo es crear tareas basadas en el contenido real del material.\n- NUNCA rechaces el material ni sugieras buscar otro. Usa lo que hay.`
      : promptText)

    // Marcar como generando en DB
    await pool.query('UPDATE evaluaciones SET plan_generando = TRUE WHERE id = $1', [evalId])

    const usuarioId = req.user.id
    const nombreEval = ev.nombre || 'tu evaluación'

    // Abort cuando el cliente cierra la conexión o cuando pasan 15 min.
    // Antes: setImmediate corría sin corte, consumiendo OpenAI + CPU si el
    // usuario cerraba el tab o la generación se colgaba.
    const abortCtl = new AbortController()
    const abortTimer = setTimeout(() => abortCtl.abort(), 15 * 60 * 1000)
    res.on('close', () => { if (!abortCtl.signal.aborted) abortCtl.abort() })

    // Procesar en background — el usuario puede salir
    setImmediate(async () => {
      const refundYEnd = async (err) => {
        clearTimeout(abortTimer)
        await pool.query('UPDATE evaluaciones SET plan_generando = FALSE WHERE id = $1', [evalId]).catch(()=>{})
        if (planContadoEnLimite) {
          await pool.query('UPDATE usuarios SET planes_usados = GREATEST(planes_usados - 1, 0) WHERE id = $1', [usuarioId]).catch(()=>{})
        }
        const abortado = err?.name === 'AbortError' || abortCtl.signal.aborted
        terminar('error', {
          error: abortado ? 'cancelado' : 'error_interno',
          mensaje: abortado ? 'La generación fue cancelada.' : 'No se pudo generar el plan. Intenta de nuevo.'
        })
      }
      try {
        enviar('progreso', { msg: '🧠 Analizando todo el material con IA...' })
        const result = await openai.chat.completions.create({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: promptFinal }],
          temperature: 0.7
        }, { signal: abortCtl.signal })
        const text = result.choices[0].message.content
        const jsonMatch = text.match(/\{[\s\S]*\}/)
        if (!jsonMatch) throw new Error('No JSON')
        const plan = JSON.parse(jsonMatch[0])
        enviar('progreso', { msg: '✅ Plan generado, guardando...' })
        await pool.query('UPDATE evaluaciones SET plan_estudio = $1, texto_material = $2, guias_tareas = NULL, plan_generando = FALSE WHERE id = $3', [JSON.stringify(plan), textoArchivos || null, evalId])
        await pool.query('DELETE FROM podcasts WHERE evaluacion_id = $1', [evalId])
        // El contador ya se incrementó atómicamente antes del setImmediate.
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
        clearTimeout(abortTimer)
        terminar('plan', { plan })
        // Notificar al usuario
        await notificarUsuario(usuarioId, '📚 ¡Tu plan de estudio está listo!', `El plan para "${nombreEval}" ya está disponible.`, '/')
      } catch(geminiErr) {
        console.error('GPT error:', geminiErr.message)
        // Si ya fue abortado (cliente cerró o timeout), no reintentes.
        if (geminiErr?.name === 'AbortError' || abortCtl.signal.aborted) {
          return refundYEnd(geminiErr)
        }
        try {
          enviar('progreso', { msg: '⚠️ Reintentando...' })
          const fallback = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: [{ role: 'user', content: promptFinal }],
            temperature: 0.7
          }, { signal: abortCtl.signal })
          const text2 = fallback.choices[0].message.content
          const jsonMatch2 = text2.match(/\{[\s\S]*\}/)
          if (!jsonMatch2) throw new Error('No se pudo parsear respuesta de IA')
          const plan2 = JSON.parse(jsonMatch2[0])
          await pool.query('UPDATE evaluaciones SET plan_estudio = $1, guias_tareas = NULL, plan_generando = FALSE WHERE id = $2', [JSON.stringify(plan2), evalId])
          await pool.query('DELETE FROM podcasts WHERE evaluacion_id = $1', [evalId])
          clearTimeout(abortTimer)
          terminar('plan', { plan: plan2 })
          await notificarUsuario(usuarioId, '📚 ¡Tu plan de estudio está listo!', `El plan para "${nombreEval}" ya está disponible.`, '/')
        } catch(fallbackErr) {
          console.error('Fallback error:', fallbackErr.message)
          await refundYEnd(fallbackErr)
        }
      }
    })

  } catch (err) {
    console.error('Error generando plan:', err)
    await pool.query('UPDATE evaluaciones SET plan_generando = FALSE WHERE id = $1', [evalId]).catch(()=>{})
    if (planContadoEnLimite) {
      await pool.query('UPDATE usuarios SET planes_usados = GREATEST(planes_usados - 1, 0) WHERE id = $1', [req.user.id]).catch(()=>{})
    }
    try { terminar('error', { error: 'error_interno', mensaje: 'Error al generar plan de estudio' }) } catch(_) {}
  }
})


// Consultar estado de generación del plan
app.get('/evaluaciones/:id/plan-estado', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT e.plan_estudio, e.plan_generando FROM evaluaciones e
        JOIN ramos r ON r.id = e.ramo_id
        WHERE e.id = $1 AND r.usuario_id = $2`,
      [req.params.id, req.user.id]
    )
    if (!rows.length) return res.status(404).json({ error: 'No encontrada' })
    const ev = rows[0]
    res.json({
      generando: ev.plan_generando || false,
      listo: !!ev.plan_estudio && !ev.plan_generando,
      plan: ev.plan_estudio ? (typeof ev.plan_estudio === "string" ? JSON.parse(ev.plan_estudio) : ev.plan_estudio) : null
    })
  } catch(e) {
    console.error('❌ plan-estado error:', e.message, e.stack)
    res.status(500).json({ error: e.message })
  }
})

// Actualizar progreso del plan
app.post('/evaluaciones/:id/plan-progreso', authenticateToken, async (req, res) => {
  const { completadas } = req.body
  const { rowCount } = await pool.query(
    `UPDATE evaluaciones SET tareas_completadas = $1
     WHERE id = $2 AND ramo_id IN (SELECT id FROM ramos WHERE usuario_id = $3)`,
    [completadas, req.params.id, req.user.id]
  )
  if (rowCount === 0) return res.status(404).json({ error: 'Evaluación no encontrada' })
  res.json({ ok: true })
})

app.get('/health', (req, res) => res.json({ status: 'ok' }))

// ── ONBOARDING ──────────────────────────────────────────────────
app.post('/auth/onboarding', authenticateToken, async (req, res) => {
  try {
    const { nombre, universidad, carrera } = req.body
    if (!nombre || !nombre.trim()) return res.status(400).json({ error: 'El nombre es requerido' })
    const { rows } = await pool.query(
      'UPDATE usuarios SET nombre = $1, universidad = $2, carrera = $3, onboarding_completado = true, onboarding_v2 = true WHERE id = $4 RETURNING id, nombre, email, avatar, universidad, carrera, onboarding_completado, onboarding_v2, es_fundador, numero_registro',
      [nombre.trim(), universidad || null, carrera ? carrera.trim() : null, req.user.id]
    )
    if (!rows[0]) return res.status(404).json({ error: 'Usuario no encontrado' })
    const u = rows[0]
    const { badge, badge_emoji } = buildBadge(u.email, u.es_fundador, u.numero_registro)
    res.json({ usuario: { ...u, badge, badge_emoji } })
  } catch (err) {
    console.error('Error onboarding:', err)
    res.status(500).json({ error: 'Error al guardar datos' })
  }
})

initDB().then(() => {
  


// ── NOVEDADES ─────────────────────────────────────────────────────
// ── NOVEDADES · cache + scraping UFRO ─────────────────────────────
const NOVEDADES_CACHE_TTL_MS = 2 * 60 * 60 * 1000 // 2h
const novedadesCache = new Map() // universidad -> { timestamp, data }

function getCachedNovedades(uni) {
  const entry = novedadesCache.get(uni)
  if (!entry) return null
  if (Date.now() - entry.timestamp > NOVEDADES_CACHE_TTL_MS) return null
  return entry.data
}
function setCachedNovedades(uni, data) {
  novedadesCache.set(uni, { timestamp: Date.now(), data })
}

// Fuente nacional compartida por todas las universidades. Filtra por
// keywords universitarios y descarta posts con >45 días.
function scrapeJunaeb() {
  const axios = require('axios')
  return axios.get(
    'https://www.junaeb.cl/wp-json/wp/v2/posts?per_page=10&_fields=title,excerpt,date,link',
    { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } }
  ).then(({ data: posts }) => {
    const items = []
    const RELEVANTE = /\b(bes|baes|tne|beca|gratuidad|residencia familiar|fuas|superior|universi|alimentaci[oó]n|pae|bare|arancel)\b/i
    const DIAS_45_MS = 45 * 24 * 60 * 60 * 1000
    const now = Date.now()
    for (const post of posts) {
      if (items.length >= 2) break
      const titulo = post.title?.rendered?.replace(/&#[0-9]+;/g, '').replace(/<[^>]+>/g, '').trim()
      if (!titulo || !RELEVANTE.test(titulo)) continue
      const fechaMs = post.date ? new Date(post.date).getTime() : 0
      if (!fechaMs || now - fechaMs > DIAS_45_MS) continue
      const desc = post.excerpt?.rendered?.replace(/<[^>]+>/g, '').replace(/\n/g, ' ').trim().slice(0, 80)
      items.push({
        tipo: 'Beneficio', emoji: '💳',
        titulo: titulo.slice(0, 75),
        descripcion: desc ? desc.slice(0, 70) : 'JUNAEB · anuncio nacional',
        color: '#fbbf24',
        link: post.link
      })
    }
    return items
  })
}

// Scrape UFRO en paralelo (3 fuentes con Promise.allSettled).
// Worst-case ≈ timeout más largo (DDE, 15s) en vez de la suma (28s).
async function scrapeUfroNovedades() {
  const axios = require('axios')
  const cheerio = require('cheerio')
  const ua = { 'User-Agent': 'Mozilla/5.0' }

  const wp = axios.get(
    'https://www.ufro.cl/wp-json/wp/v2/posts?per_page=4&_fields=title,excerpt,date,link',
    { timeout: 8000, headers: ua }
  ).then(({ data: posts }) => {
    const items = []
    for (const post of posts) {
      const titulo = post.title?.rendered?.replace(/&#[0-9]+;/g, '').replace(/<[^>]+>/g, '').trim()
      const desc = post.excerpt?.rendered?.replace(/<[^>]+>/g, '').replace(/\n/g, ' ').trim().slice(0, 80)
      if (titulo) items.push({ tipo: 'Noticia', emoji: '📰', titulo: titulo.slice(0, 75), descripcion: desc ? desc.slice(0, 70) : 'UFRO al día', color: '#60a5fa', link: post.link })
    }
    return items
  })

  const agenda = axios.get(
    'https://www.ufro.cl/agenda/',
    { timeout: 5000, headers: ua }
  ).then(({ data: agendaHtml }) => {
    const $a = cheerio.load(agendaHtml)
    const eventosVistos = new Set()
    const items = []
    $a('.entry-content li, article h2, .agenda h2, main h2').each((i, el) => {
      if (eventosVistos.size >= 3) return
      const titulo = $a(el).text().trim()
      const fecha = $a(el).next().text().trim().replace(/\n/g,' ').slice(0,40)
      if (titulo && titulo.length > 10 && titulo.length < 120 && !eventosVistos.has(titulo)) {
        eventosVistos.add(titulo)
        items.push({ tipo: 'Evento', emoji: '📅', titulo: titulo.slice(0, 75), descripcion: fecha || 'Ver agenda UFRO', color: '#a78bfa', link: 'https://www.ufro.cl/agenda/' })
      }
    })
    if (eventosVistos.size === 0) {
      const h2regex = new RegExp('<h2[^>]*>([^<]{10,100})<\/h2>', 'g')
      const navWords = ['Institucional','Organización','Facultades','Pregrado','Postgrado','Investigación','Vinculación','Internacionalización','Educación']
      let match
      while ((match = h2regex.exec(agendaHtml)) !== null) {
        if (eventosVistos.size >= 3) break
        const titulo = match[1].trim()
        if (navWords.every(w => titulo.indexOf(w) === -1) && titulo.length > 10) {
          eventosVistos.add(titulo)
          items.push({ tipo: 'Evento', emoji: '📅', titulo: titulo.slice(0, 75), descripcion: 'Ver agenda UFRO', color: '#a78bfa', link: 'https://www.ufro.cl/agenda/' })
        }
      }
    }
    return items
  })

  const dde = axios.get(
    'https://dde.ufro.cl/noticias/',
    { timeout: 15000, headers: ua }
  ).then(({ data: ddeHtml }) => {
    const $d = cheerio.load(ddeHtml)
    const items = []
    let ddeCount = 0
    $d('a').each((i, el) => {
      if (ddeCount >= 2) return
      const titulo = $d(el).text().trim().replace(/\s+/g, ' ')
      const href = $d(el).attr('href') || ''
      if (titulo && titulo.length > 15 && titulo.length < 150 && href && href !== 'https://dde.ufro.cl/noticias/') {
        items.push({ tipo: 'Vida Estudiantil', emoji: '🎓', titulo: titulo.slice(0, 75), descripcion: 'DDE · Desarrollo Estudiantil UFRO', color: '#34d399', link: href })
        ddeCount++
      }
    })
    return items
  })

  const results = await Promise.allSettled([wp, agenda, dde, scrapeJunaeb()])
  const labels = ['WP REST', 'Agenda', 'DDE', 'JUNAEB']
  const novedades = []
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') novedades.push(...r.value)
    else console.log(`${labels[i]} scraping falló:`, r.reason?.message)
  })
  return novedades.slice(0, 8)
}

// Cron: cada 2h refresca tabla novedades con el scrape UFRO.
// Borra solo rows origen='scrape' para no tocar las entradas admin.
async function refrescarNovedadesUfro() {
  try {
    const items = await scrapeUfroNovedades()
    if (items.length === 0) return
    await pool.query("DELETE FROM novedades WHERE universidad = 'ufro' AND origen = 'scrape'")
    for (const n of items) {
      await pool.query(
        "INSERT INTO novedades (universidad, tipo, emoji, titulo, descripcion, color, origen) VALUES ('ufro', $1, $2, $3, $4, $5, 'scrape')",
        [n.tipo, n.emoji, n.titulo, n.descripcion, n.color]
      )
    }
    setCachedNovedades('ufro', items)
    console.log(`📰 Novedades UFRO refrescadas (${items.length} items)`)
  } catch (err) {
    console.error('❌ Error refrescando novedades UFRO:', err.message)
  }
}

cron.schedule('0 */2 * * *', refrescarNovedadesUfro, { timezone: 'America/Santiago' })

// Scrape Universidad Mayor (diariomayor.cl, Joomla sin WP REST ni RSS).
// Parsea microdatos schema.org: a[itemprop="url"] + span[itemprop="datePublished"].
// Agrega JUNAEB (mismo filtro que UFRO) como fuente nacional.
async function scrapeMayorNovedades() {
  const axios = require('axios')
  const cheerio = require('cheerio')
  const ua = { 'User-Agent': 'Mozilla/5.0' }

  const diario = axios.get(
    'https://www.diariomayor.cl/',
    { timeout: 10000, headers: ua }
  ).then(({ data: html }) => {
    const $ = cheerio.load(html)
    const categoriaDesde = (href) => {
      if (href.startsWith('/creando-universidad/estudiantes')) return { tipo: 'Vida Estudiantil', emoji: '🎓', color: '#34d399' }
      if (href.startsWith('/ciencia-um')) return { tipo: 'Ciencia', emoji: '🧪', color: '#a78bfa' }
      if (href.startsWith('/lo-ultimo/cultura')) return { tipo: 'Cultura', emoji: '🎭', color: '#f472b6' }
      if (href.startsWith('/creando-universidad/academicos')) return { tipo: 'Académico', emoji: '📚', color: '#60a5fa' }
      return { tipo: 'Noticia', emoji: '📰', color: '#60a5fa' }
    }
    // Secciones tipo prensa/columna/video — no son noticias internas, se saltan.
    const SKIP = ['/el-mercurio/', '/medios-regionales', '/videos/', '/marcando-pauta/', '/miradas/']
    const vistos = new Set()
    const items = []
    $('a[itemprop="url"]').each((_, el) => {
      if (items.length >= 5) return
      const href = ($(el).attr('href') || '').trim()
      const titulo = $(el).text().trim().replace(/\s+/g, ' ')
      if (!titulo || titulo.length < 12 || titulo.length > 200) return
      if (!href.startsWith('/') || SKIP.some(p => href.startsWith(p))) return
      if (vistos.has(href)) return
      vistos.add(href)
      const cat = categoriaDesde(href)
      const wrap = $(el).closest('article, [class*="sppb-addon"]')
      const fecha = wrap.length
        ? wrap.find('[itemprop="datePublished"]').first().text().replace(/\s+/g, ' ').trim()
        : ''
      items.push({
        tipo: cat.tipo,
        emoji: cat.emoji,
        titulo: titulo.slice(0, 75),
        descripcion: (fecha || 'Diario Mayor · U. Mayor').slice(0, 70),
        color: cat.color,
        link: 'https://www.diariomayor.cl' + href
      })
    })
    return items
  })

  const results = await Promise.allSettled([diario, scrapeJunaeb()])
  const labels = ['Diario Mayor', 'JUNAEB']
  const novedades = []
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') novedades.push(...r.value)
    else console.log(`${labels[i]} scraping falló:`, r.reason?.message)
  })
  return novedades.slice(0, 8)
}

async function refrescarNovedadesMayor() {
  try {
    const items = await scrapeMayorNovedades()
    if (items.length === 0) return
    await pool.query("DELETE FROM novedades WHERE universidad = 'umayor' AND origen = 'scrape'")
    for (const n of items) {
      await pool.query(
        "INSERT INTO novedades (universidad, tipo, emoji, titulo, descripcion, color, origen) VALUES ('umayor', $1, $2, $3, $4, $5, 'scrape')",
        [n.tipo, n.emoji, n.titulo, n.descripcion, n.color]
      )
    }
    setCachedNovedades('umayor', items)
    console.log(`📰 Novedades U. Mayor refrescadas (${items.length} items)`)
  } catch (err) {
    console.error('❌ Error refrescando novedades U. Mayor:', err.message)
  }
}

// Cron 15 min después de UFRO para no golpear JUNAEB en paralelo.
cron.schedule('15 */2 * * *', refrescarNovedadesMayor, { timezone: 'America/Santiago' })

// Scrape U. Autónoma. WP REST deshabilitada y /feed/ → 500, pero /noticias/
// renderiza cards con estructura estable: article.custom-card--news con
// .text (título), .date (dd/mm/aaaa), .tag (categoría) y a.stretched-link.
async function scrapeAutonomaNovedades() {
  const axios = require('axios')
  const cheerio = require('cheerio')
  const ua = { 'User-Agent': 'Mozilla/5.0' }

  const noticias = axios.get(
    'https://www.uautonoma.cl/noticias/',
    { timeout: 10000, headers: ua }
  ).then(({ data: html }) => {
    const $ = cheerio.load(html)
    const items = []
    $('article.custom-card--news').each((_, el) => {
      if (items.length >= 6) return
      const $el = $(el)
      const titulo = $el.find('.text').first().text().trim().replace(/\s+/g, ' ')
      const fecha = $el.find('.date').first().text().trim()
      const tag = $el.find('.tag').first().text().trim().replace(/\s+/g, ' ')
      const link = $el.find('a.stretched-link').first().attr('href') || ''
      if (!titulo || titulo.length < 10) return
      items.push({
        tipo: 'Noticia',
        emoji: '📰',
        titulo: titulo.slice(0, 75),
        descripcion: (tag || fecha || 'Noticias · U. Autónoma').slice(0, 70),
        color: '#60a5fa',
        link: link || 'https://www.uautonoma.cl/noticias/'
      })
    })
    return items
  })

  const results = await Promise.allSettled([noticias, scrapeJunaeb()])
  const labels = ['UA Noticias', 'JUNAEB']
  const novedades = []
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') novedades.push(...r.value)
    else console.log(`${labels[i]} scraping falló:`, r.reason?.message)
  })
  return novedades.slice(0, 8)
}

async function refrescarNovedadesAutonoma() {
  try {
    const items = await scrapeAutonomaNovedades()
    if (items.length === 0) return
    await pool.query("DELETE FROM novedades WHERE universidad = 'uautonoma' AND origen = 'scrape'")
    for (const n of items) {
      await pool.query(
        "INSERT INTO novedades (universidad, tipo, emoji, titulo, descripcion, color, origen) VALUES ('uautonoma', $1, $2, $3, $4, $5, 'scrape')",
        [n.tipo, n.emoji, n.titulo, n.descripcion, n.color]
      )
    }
    setCachedNovedades('uautonoma', items)
    console.log(`📰 Novedades U. Autónoma refrescadas (${items.length} items)`)
  } catch (err) {
    console.error('❌ Error refrescando novedades U. Autónoma:', err.message)
  }
}

cron.schedule('30 */2 * * *', refrescarNovedadesAutonoma, { timezone: 'America/Santiago' })

// Scrape INACAP. Sitio Liferay en portal.inacap.cl/noticias1 — cada nota
// es h2.component-heading con <a> al slug /w/..., seguida (en el mismo
// layout) por un .component-paragraph de descripción y fecha editable.
async function scrapeInacapNovedades() {
  const axios = require('axios')
  const cheerio = require('cheerio')
  const ua = { 'User-Agent': 'Mozilla/5.0' }

  const noticias = axios.get(
    'https://portal.inacap.cl/noticias1',
    { timeout: 12000, headers: ua }
  ).then(({ data: html }) => {
    const $ = cheerio.load(html)
    const vistos = new Set()
    const items = []
    $('h2.component-heading a').each((_, el) => {
      if (items.length >= 6) return
      const $a = $(el)
      const titulo = $a.text().trim().replace(/\s+/g, ' ')
      const link = ($a.attr('href') || '').trim()
      if (!titulo || titulo.length < 12 || !link) return
      if (vistos.has(link)) return
      vistos.add(link)
      // El col.d-flex.flex-column suele envolver UNA nota (título + párrafo
      // + fecha). Si no se encuentra, cae al row (agrupa varias — descarta
      // descripción para no pegarla al título equivocado).
      const col = $a.closest('.col.d-flex.flex-column')
      let desc = ''
      let fecha = ''
      if (col.length) {
        desc = col.find('.component-paragraph').first().text().trim().replace(/\s+/g, ' ')
        fecha = col.find('[data-lfr-editable-type="date-time"]').first().text().trim()
      } else {
        const row = $a.closest('[class*="lfr-layout-structure-item-row"]')
        // Solo toma fecha; descripción la saltamos para evitar mismatch.
        fecha = row.find('[data-lfr-editable-type="date-time"]').first().text().trim()
      }
      items.push({
        tipo: 'Noticia',
        emoji: '📰',
        titulo: titulo.slice(0, 75),
        descripcion: (desc || fecha || 'INACAP · Portal').slice(0, 70),
        color: '#60a5fa',
        link
      })
    })
    return items
  })

  const results = await Promise.allSettled([noticias, scrapeJunaeb()])
  const labels = ['INACAP Noticias', 'JUNAEB']
  const novedades = []
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') novedades.push(...r.value)
    else console.log(`${labels[i]} scraping falló:`, r.reason?.message)
  })
  return novedades.slice(0, 8)
}

async function refrescarNovedadesInacap() {
  try {
    const items = await scrapeInacapNovedades()
    if (items.length === 0) return
    await pool.query("DELETE FROM novedades WHERE universidad = 'inacap' AND origen = 'scrape'")
    for (const n of items) {
      await pool.query(
        "INSERT INTO novedades (universidad, tipo, emoji, titulo, descripcion, color, origen) VALUES ('inacap', $1, $2, $3, $4, $5, 'scrape')",
        [n.tipo, n.emoji, n.titulo, n.descripcion, n.color]
      )
    }
    setCachedNovedades('inacap', items)
    console.log(`📰 Novedades INACAP refrescadas (${items.length} items)`)
  } catch (err) {
    console.error('❌ Error refrescando novedades INACAP:', err.message)
  }
}

cron.schedule('45 */2 * * *', refrescarNovedadesInacap, { timezone: 'America/Santiago' })

// Scrape Santo Tomás. WP REST abierto, mismo patrón que UFRO.
async function scrapeSantoTomasNovedades() {
  const axios = require('axios')
  const ua = { 'User-Agent': 'Mozilla/5.0' }

  const wp = axios.get(
    'https://www.santotomas.cl/wp-json/wp/v2/posts?per_page=6&_fields=title,excerpt,date,link',
    { timeout: 8000, headers: ua }
  ).then(({ data: posts }) => {
    const items = []
    for (const post of posts) {
      const titulo = post.title?.rendered?.replace(/&#[0-9]+;/g, '').replace(/<[^>]+>/g, '').trim()
      const desc = post.excerpt?.rendered?.replace(/<[^>]+>/g, '').replace(/\n/g, ' ').trim().slice(0, 80)
      if (!titulo) continue
      items.push({
        tipo: 'Noticia', emoji: '📰',
        titulo: titulo.slice(0, 75),
        descripcion: desc ? desc.slice(0, 70) : 'Santo Tomás · Noticias',
        color: '#60a5fa',
        link: post.link
      })
    }
    return items
  })

  const results = await Promise.allSettled([wp, scrapeJunaeb()])
  const labels = ['UST WP REST', 'JUNAEB']
  const novedades = []
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') novedades.push(...r.value)
    else console.log(`${labels[i]} scraping falló:`, r.reason?.message)
  })
  return novedades.slice(0, 8)
}

async function refrescarNovedadesSantoTomas() {
  try {
    const items = await scrapeSantoTomasNovedades()
    if (items.length === 0) return
    await pool.query("DELETE FROM novedades WHERE universidad = 'santotomas' AND origen = 'scrape'")
    for (const n of items) {
      await pool.query(
        "INSERT INTO novedades (universidad, tipo, emoji, titulo, descripcion, color, origen) VALUES ('santotomas', $1, $2, $3, $4, $5, 'scrape')",
        [n.tipo, n.emoji, n.titulo, n.descripcion, n.color]
      )
    }
    setCachedNovedades('santotomas', items)
    console.log(`📰 Novedades Santo Tomás refrescadas (${items.length} items)`)
  } catch (err) {
    console.error('❌ Error refrescando novedades Santo Tomás:', err.message)
  }
}

cron.schedule('50 */2 * * *', refrescarNovedadesSantoTomas, { timezone: 'America/Santiago' })

// Scrape UCT (Temuco). WP REST 404 pero /feed/ sirve RSS 2.0.
// OJO: es U. Católica de Temuco (uct.cl), NO la PUC.
// El <description> del feed es basura generada ("The post X appeared first on UCT"),
// se descarta y se usa la categoría como descripción corta.
async function scrapeUctNovedades() {
  const axios = require('axios')
  const cheerio = require('cheerio')
  const ua = { 'User-Agent': 'Mozilla/5.0' }

  const rss = axios.get(
    'https://www.uct.cl/feed/',
    { timeout: 10000, headers: ua }
  ).then(({ data: xml }) => {
    const $ = cheerio.load(xml, { xmlMode: true })
    const items = []
    $('item').each((_, el) => {
      if (items.length >= 6) return
      const $el = $(el)
      const titulo = $el.find('title').first().text().trim().replace(/\s+/g, ' ')
      const link = $el.find('link').first().text().trim()
      const categoria = $el.find('category').first().text().trim()
      if (!titulo || !link) return
      items.push({
        tipo: categoria && categoria.toLowerCase() !== 'actualidad' ? categoria.slice(0, 25) : 'Noticia',
        emoji: '📰',
        titulo: titulo.slice(0, 75),
        descripcion: (categoria ? `UCT · ${categoria}` : 'UCT · Temuco').slice(0, 70),
        color: '#60a5fa',
        link
      })
    })
    return items
  })

  const results = await Promise.allSettled([rss, scrapeJunaeb()])
  const labels = ['UCT RSS', 'JUNAEB']
  const novedades = []
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') novedades.push(...r.value)
    else console.log(`${labels[i]} scraping falló:`, r.reason?.message)
  })
  return novedades.slice(0, 8)
}

async function refrescarNovedadesUct() {
  try {
    const items = await scrapeUctNovedades()
    if (items.length === 0) return
    await pool.query("DELETE FROM novedades WHERE universidad = 'uctemuco' AND origen = 'scrape'")
    for (const n of items) {
      await pool.query(
        "INSERT INTO novedades (universidad, tipo, emoji, titulo, descripcion, color, origen) VALUES ('uctemuco', $1, $2, $3, $4, $5, 'scrape')",
        [n.tipo, n.emoji, n.titulo, n.descripcion, n.color]
      )
    }
    setCachedNovedades('uctemuco', items)
    console.log(`📰 Novedades UCT Temuco refrescadas (${items.length} items)`)
  } catch (err) {
    console.error('❌ Error refrescando novedades UCT Temuco:', err.message)
  }
}

cron.schedule('55 */2 * * *', refrescarNovedadesUct, { timezone: 'America/Santiago' })

app.get('/novedades', authenticateToken, async (req, res) => {
  try {
    // La universidad se deriva del usuario autenticado, NO del query string.
    // Antes: const uni = req.query.universidad || 'ufro' — eso servía UFRO a
    // cualquier cliente que no mandara el param (bug real: usuarios UA viendo
    // noticias UFRO cuando la cadena de estado del frontend fallaba).
    const userRes = await pool.query('SELECT universidad FROM usuarios WHERE id = $1', [req.user.id])
    const uni = userRes.rows[0]?.universidad
    if (!uni) return res.json([])
    const { rows } = await pool.query(
      `SELECT * FROM novedades
       WHERE universidad = $1 AND activa = true
         AND (expira_en IS NULL OR expira_en > NOW())
       ORDER BY
         CASE origen WHEN 'telegram' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
         creada_en DESC`,
      [uni]
    )
    if (rows.length > 0) return res.json(rows)

    // Fallback live (con cache en memoria de 2h) para universidades con scraper
    const scrapers = {
      ufro: scrapeUfroNovedades,
      umayor: scrapeMayorNovedades,
      uautonoma: scrapeAutonomaNovedades,
      inacap: scrapeInacapNovedades,
      santotomas: scrapeSantoTomasNovedades,
      uctemuco: scrapeUctNovedades
    }
    if (scrapers[uni]) {
      const cached = getCachedNovedades(uni)
      if (cached) return res.json(cached)

      try {
        const novedades = await scrapers[uni]()
        if (novedades.length > 0) {
          setCachedNovedades(uni, novedades)
          return res.json(novedades)
        }
      } catch (scrapeErr) {
        console.log(`Scrape ${uni} falló:`, scrapeErr.message)
      }
    }

    res.json([])
  } catch(err) { res.status(500).json({ error: err.message }) }
})

app.post('/novedades', authenticateToken, async (req, res) => {
  try {
    const { universidad, tipo, emoji, titulo, descripcion, color } = req.body
    const { rows } = await pool.query(
      'INSERT INTO novedades (universidad, tipo, emoji, titulo, descripcion, color) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [universidad, tipo, emoji || '📢', titulo, descripcion, color || '#60a5fa']
    )
    res.json(rows[0])
  } catch(err) { res.status(500).json({ error: err.message }) }
})

app.delete('/novedades/:id', authenticateToken, async (req, res) => {
  try {
    await pool.query('UPDATE novedades SET activa = false WHERE id = $1', [req.params.id])
    res.json({ ok: true })
  } catch(err) { res.status(500).json({ error: err.message }) }
})

// ── TELEGRAM BOT · menú casino UFRO ──────────────────────────────
// Activado solo si TELEGRAM_BOT_TOKEN está definida. Arquitectura webhook:
// Telegram → POST /telegram/webhook → bot.processUpdate → handler 'photo'.
// Seguridad: secret header + allowlist de user IDs.
if (process.env.TELEGRAM_BOT_TOKEN) {
  const TelegramBot = require('node-telegram-bot-api')
  const axios = require('axios')
  const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false })

  const telegramAllowlist = new Set(
    (process.env.TELEGRAM_ALLOWED_USER_IDS || '')
      .split(',')
      .map(s => parseInt(s.trim(), 10))
      .filter(Number.isFinite)
  )

  // Preview pendiente de confirmación por chat. TTL 10 min.
  const pendingCasino = new Map() // chatId -> { titulo, descripcion, createdAt }
  const descuentoDraft = new Map() // chatId -> { step, titulo, descripcion, createdAt }
  const PENDING_TTL_MS = 10 * 60 * 1000
  function getPendingCasino(chatId) {
    const e = pendingCasino.get(chatId)
    if (!e) return null
    if (Date.now() - e.createdAt > PENDING_TTL_MS) { pendingCasino.delete(chatId); return null }
    return e
  }
  function getDescuentoDraft(chatId) {
    const e = descuentoDraft.get(chatId)
    if (!e) return null
    if (Date.now() - e.createdAt > PENDING_TTL_MS) { descuentoDraft.delete(chatId); return null }
    return e
  }

  const CASINO_PROMPT = 'Esta es una foto del menú del casino de la UFRO de hoy. '
    + 'Extrae los platos del día (entrada, plato de fondo, acompañamiento, postre, y vegetariano si aparece). '
    + 'Devuelve SOLO un JSON con esta estructura exacta: '
    + '{"platos":["Entrada: <nombre real>","Fondo: <nombre real>","Acompañamiento: <nombre real>","Postre: <nombre real>","Vegetariano: <nombre real>"],"destacado":"<nombre del plato de fondo principal, tal cual aparece en el menú>"}. '
    + 'REGLAS ESTRICTAS: '
    + '(1) "destacado" DEBE ser el nombre literal de un plato concreto del menú (p.ej. "Ragout de pollo"), NUNCA una frase genérica como "Plato estrella del día" o "Plato principal". '
    + '(2) Si no logras identificar un plato de fondo específico, devuelve "destacado":"". '
    + '(3) NO inventes platos. Si un campo (entrada/postre/etc.) no aparece en la foto, omítelo del arreglo — no generes placeholders. '
    + '(4) No repitas el mismo plato en varias entradas del arreglo. '
    + 'Si la imagen NO es un menú de casino, devuelve {"platos":[],"destacado":""}.'

  bot.on('photo', async (msg) => {
    const chatId = msg.chat.id
    const userId = msg.from?.id
    console.log(`📸 Telegram photo recibida · from.id=${userId} · username=${msg.from?.username || '—'} · allowed=${telegramAllowlist.has(userId)}`)
    if (!telegramAllowlist.has(userId)) {
      try { await bot.sendMessage(chatId, `🚫 No autorizado. Tu user ID es: ${userId}`) } catch(_) {}
      return
    }
    try {
      const photo = msg.photo[msg.photo.length - 1] // el más grande
      if (photo.file_size && photo.file_size > 20 * 1024 * 1024) {
        await bot.sendMessage(chatId, '📏 Imagen muy grande (>20 MB). Reenvía comprimida.')
        return
      }
      await bot.sendMessage(chatId, '👀 Procesando menú del casino...')

      const fileLink = await bot.getFileLink(photo.file_id)
      const { data: imgBuffer } = await axios.get(fileLink, { responseType: 'arraybuffer', timeout: 20000 })

      // Re-comprimir con sharp para ahorrar tokens Vision
      const compressed = await sharp(imgBuffer)
        .rotate()
        .resize({ width: 1400, withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer()
      const base64 = compressed.toString('base64')

      const visionResp = await openaiClient.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: [
          { type: 'text', text: CASINO_PROMPT },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}`, detail: 'high' } }
        ]}],
        max_tokens: 600,
        response_format: { type: 'json_object' }
      })

      const raw = visionResp.choices[0].message.content
      let parsed
      try { parsed = JSON.parse(raw) } catch (_) { parsed = { platos: [], destacado: '' } }

      if (!Array.isArray(parsed.platos) || parsed.platos.length === 0) {
        await bot.sendMessage(chatId, '🤔 No detecté platos en esta imagen. ¿Es realmente el menú del casino?')
        return
      }

      const platosUnicos = Array.from(new Set(
        parsed.platos.map(p => String(p).trim()).filter(Boolean)
      ))
      const descripcion = platosUnicos.join(' · ').slice(0, 500)
      const titulo = parsed.destacado
        ? `🍽️ Menú · ${String(parsed.destacado).slice(0, 60)}`
        : '🍽️ Menú del casino hoy'

      // Guardar preview en memoria — espera confirmación del usuario
      pendingCasino.set(chatId, { titulo, descripcion, createdAt: Date.now() })

      await bot.sendMessage(chatId,
        `📋 *Preview del menú:*\n\n${descripcion}\n\n¿Publicar en Apprueba?`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              { text: '✅ Publicar', callback_data: 'casino_publish' },
              { text: '❌ Cancelar', callback_data: 'casino_cancel' }
            ]]
          }
        }
      )
    } catch (err) {
      console.error('❌ Bot Telegram (photo):', err.message)
      try { await bot.sendMessage(chatId, `⚠️ Error procesando: ${err.message}`) } catch(_) {}
    }
  })

  // Comando /descuento · flujo conversacional 2 pasos (nombre → descripción)
  bot.onText(/^\/descuento\b/, async (msg) => {
    const chatId = msg.chat.id
    const userId = msg.from?.id
    if (!telegramAllowlist.has(userId)) {
      try { await bot.sendMessage(chatId, `🚫 No autorizado. Tu user ID es: ${userId}`) } catch(_) {}
      return
    }
    descuentoDraft.set(chatId, { step: 'titulo', titulo: '', descripcion: '', createdAt: Date.now() })
    await bot.sendMessage(chatId,
      '💸 *Nuevo descuento*\n\n¿Cómo se llama el lugar o negocio?\n\n_(envía /cancelar para abortar)_',
      { parse_mode: 'Markdown' }
    )
  })

  bot.onText(/^\/cancelar\b/, async (msg) => {
    const chatId = msg.chat.id
    if (descuentoDraft.has(chatId)) {
      descuentoDraft.delete(chatId)
      try { await bot.sendMessage(chatId, '✖️ Descuento descartado.') } catch(_) {}
    }
  })

  // Captura texto libre cuando hay un draft de descuento activo
  bot.on('message', async (msg) => {
    if (msg.photo) return                           // lo maneja el handler 'photo'
    if (!msg.text || msg.text.startsWith('/')) return // ignorar comandos
    const chatId = msg.chat.id
    const userId = msg.from?.id
    if (!telegramAllowlist.has(userId)) return
    const draft = getDescuentoDraft(chatId)
    if (!draft) return

    if (draft.step === 'titulo') {
      draft.titulo = msg.text.trim().slice(0, 80)
      draft.step = 'descripcion'
      try {
        await bot.sendMessage(chatId,
          '💸 ¿Qué descuento o promo ofrece?\n_(ej: "20% con TNE", "2x1 los miércoles", "Menú estudiantil $3.500")_',
          { parse_mode: 'Markdown' }
        )
      } catch(_) {}
      return
    }

    if (draft.step === 'descripcion') {
      draft.descripcion = msg.text.trim().slice(0, 200)
      draft.step = 'preview'
      try {
        await bot.sendMessage(chatId,
          `📋 *Preview del descuento:*\n\n💸 *${draft.titulo}*\n${draft.descripcion}\n\n¿Publicar en Apprueba?`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [[
                { text: '✅ Publicar', callback_data: 'descuento_publish' },
                { text: '❌ Cancelar', callback_data: 'descuento_cancel' }
              ]]
            }
          }
        )
      } catch(_) {}
    }
  })

  // Callback de los botones inline · dispatch por prefijo de `data`
  bot.on('callback_query', async (query) => {
    const chatId = query.message?.chat?.id
    const messageId = query.message?.message_id
    const userId = query.from?.id
    const data = query.data || ''

    if (!telegramAllowlist.has(userId)) {
      try { await bot.answerCallbackQuery(query.id, { text: '🚫 No autorizado' }) } catch(_) {}
      return
    }

    // ── Casino ──
    if (data.startsWith('casino_')) {
      const pending = getPendingCasino(chatId)
      if (!pending) {
        try {
          await bot.answerCallbackQuery(query.id, { text: 'No hay menú pendiente (expiró o ya fue procesado)' })
          if (messageId) await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId })
        } catch(_) {}
        return
      }
      if (data === 'casino_cancel') {
        pendingCasino.delete(chatId)
        try {
          await bot.answerCallbackQuery(query.id, { text: 'Cancelado' })
          await bot.editMessageText('❌ Cancelado, no se publicó nada.', { chat_id: chatId, message_id: messageId })
        } catch(_) {}
        return
      }
      if (data === 'casino_publish') {
        try {
          await pool.query(`
            DELETE FROM novedades
            WHERE universidad = 'ufro' AND origen = 'telegram' AND tipo = 'Casino'
              AND creada_en >= (date_trunc('day', NOW() AT TIME ZONE 'America/Santiago')) AT TIME ZONE 'America/Santiago'
          `)
          await pool.query(`
            INSERT INTO novedades (universidad, tipo, emoji, titulo, descripcion, color, origen, expira_en)
            VALUES ('ufro', 'Casino', '🍽️', $1, $2, '#fbbf24', 'telegram',
              (date_trunc('day', NOW() AT TIME ZONE 'America/Santiago') + INTERVAL '1 day') AT TIME ZONE 'America/Santiago')
          `, [pending.titulo, pending.descripcion])
          novedadesCache.delete('ufro')
          pendingCasino.delete(chatId)
          await bot.answerCallbackQuery(query.id, { text: '✅ Publicado' })
          await bot.editMessageText(
            `✅ Menú publicado en Apprueba · caduca a medianoche.\n\n${pending.descripcion}`,
            { chat_id: chatId, message_id: messageId }
          )
        } catch (err) {
          console.error('❌ Bot Telegram (casino publish):', err.message)
          try { await bot.answerCallbackQuery(query.id, { text: 'Error al guardar' }) } catch(_) {}
          try { await bot.sendMessage(chatId, `⚠️ Error: ${err.message}`) } catch(_) {}
        }
      }
      return
    }

    // ── Descuento ──
    if (data.startsWith('descuento_')) {
      const draft = getDescuentoDraft(chatId)
      if (!draft) {
        try {
          await bot.answerCallbackQuery(query.id, { text: 'No hay descuento pendiente (expiró o ya fue procesado)' })
          if (messageId) await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId })
        } catch(_) {}
        return
      }
      if (data === 'descuento_cancel') {
        descuentoDraft.delete(chatId)
        try {
          await bot.answerCallbackQuery(query.id, { text: 'Cancelado' })
          await bot.editMessageText('❌ Descuento descartado.', { chat_id: chatId, message_id: messageId })
        } catch(_) {}
        return
      }
      if (data === 'descuento_publish') {
        try {
          const tituloFinal = `💸 ${draft.titulo}`.slice(0, 100)
          await pool.query(`
            INSERT INTO novedades (universidad, tipo, emoji, titulo, descripcion, color, origen)
            VALUES ('ufro', 'Descuento', '💸', $1, $2, '#10b981', 'telegram')
          `, [tituloFinal, draft.descripcion])
          novedadesCache.delete('ufro')
          descuentoDraft.delete(chatId)
          await bot.answerCallbackQuery(query.id, { text: '✅ Publicado' })
          await bot.editMessageText(
            `✅ Descuento publicado en Apprueba.\n\n💸 *${draft.titulo}*\n${draft.descripcion}`,
            { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' }
          )
        } catch (err) {
          console.error('❌ Bot Telegram (descuento publish):', err.message)
          try { await bot.answerCallbackQuery(query.id, { text: 'Error al guardar' }) } catch(_) {}
          try { await bot.sendMessage(chatId, `⚠️ Error: ${err.message}`) } catch(_) {}
        }
      }
    }
  })

  // Webhook endpoint. Validación por secret header.
  app.post('/telegram/webhook', (req, res) => {
    const secret = req.header('X-Telegram-Bot-Api-Secret-Token')
    if (!process.env.TELEGRAM_WEBHOOK_SECRET || secret !== process.env.TELEGRAM_WEBHOOK_SECRET) {
      return res.sendStatus(401)
    }
    bot.processUpdate(req.body)
    res.sendStatus(200)
  })

  // Setup one-time del webhook — llama con POST { url: 'https://.../telegram/webhook' }
  app.post('/admin/telegram/setup-webhook', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const { url } = req.body
      if (!url) return res.status(400).json({ error: 'url requerida' })
      if (!process.env.TELEGRAM_WEBHOOK_SECRET) return res.status(500).json({ error: 'TELEGRAM_WEBHOOK_SECRET no seteada' })
      await bot.setWebHook(url, { secret_token: process.env.TELEGRAM_WEBHOOK_SECRET })
      const info = await bot.getWebHookInfo()
      res.json({ ok: true, webhook: info })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  console.log(`🤖 Bot Telegram activo (${telegramAllowlist.size} usuarios autorizados)`)
}

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
       ON CONFLICT (usuario_id, dia, hora_inicio)
       DO UPDATE SET hora_fin=$4, ramo_nombre=$5, codigo=$6, sala=$7, tipo=$8`,
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
        const horaMatch = periodoCell.match(/(\d{1,2}:\d{2})/)
        if (!horaMatch) continue
        
        // Buscar hora inicio y fin
        let hora_inicio = '', hora_fin = ''
        for (let c = 0; c < row.length; c++) {
          const val = String(row[c] || '')
          const horas = val.match(/(\d{1,2}:\d{2})/g)
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
        const bgMatch = cell.match(/background-color\s*:\s*([#\w]+)/i) || cell.match(/bgcolor=["']?([#\w]+)/i)
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

    let imagenesParaVision = []

    if (req.file.mimetype === 'application/pdf') {
      const { execSync } = require('child_process')
      const tmp = '/tmp/horario_' + Date.now()
      fs.writeFileSync(tmp + '.pdf', req.file.buffer)
      execSync(`pdftoppm -png -r 200 ${tmp}.pdf ${tmp}`)
      const pngs = fs.readdirSync('/tmp').filter(f => f.startsWith('horario_') && f.endsWith('.png') && f.includes(tmp.split('/tmp/')[1]))
      pngs.sort()
      imagenesParaVision = pngs.map(f => {
        const b64 = fs.readFileSync('/tmp/' + f).toString('base64')
        fs.unlinkSync('/tmp/' + f)
        return { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}`, detail: 'high' } }
      })
      fs.unlinkSync(tmp + '.pdf')
    } else {
      const base64 = req.file.buffer.toString('base64')
      const mime = req.file.mimetype
      imagenesParaVision = [{ type: 'image_url', image_url: { url: `data:${mime};base64,${base64}`, detail: 'high' } }]
    }

    // PASO 1: Transcribir la tabla en texto plano
    const paso1 = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{
        role: 'user',
        content: [
          ...imagenesParaVision,
          {
            type: 'text',
            text: `Extrae todos los bloques de clase de este horario universitario chileno. Procesa cada columna de día de forma independiente. Responde SOLO con JSON array sin markdown:
[{"dia":"Lunes","hora_inicio":"08:00","hora_fin":"09:10","ramo_nombre":"MATEMÁTICA","sala":"TRSR-602","tipo":"clase"}]`
          }
        ]
      }],
      max_tokens: 2000
    })

    const transcripcion = paso1.choices[0].message.content
    console.log('📋 Resultado GPT:\n', transcripcion)
    const jsonMatch = transcripcion.match(/\[[\s\S]*\]/)
    if (!jsonMatch) return res.status(400).json({ error: 'No se pudo extraer el horario' })
    const bloques = JSON.parse(jsonMatch[0])
    res.json({ bloques })
  } catch(err) { console.error('❌ Error horario/extraer:', err); res.status(500).json({ error: err.message }) }
})

// Panel admin - solo abelespinozav@gmail.com
app.get('/admin/stats', authenticateToken, requireAdmin, async (req, res) => {
  if (req.user.email !== 'abelespinozav@gmail.com') return res.status(403).json({ error: 'No autorizado' })
  try {
    // Antes solo traía id/nombre/email/timestamps/contadores, pero el frontend
    // necesita universidad, es_fundador, numero_registro, onboarding_v2 y
    // ramos_count para decidir la columna "Universidad", el badge de estado
    // y el filtro "Sin onboarding". Sin estos campos toda la tabla mostraba
    // "Sin onboarding" para cualquier usuario real.
    const usuarios = await pool.query(`
      SELECT u.id, u.nombre, u.email, u.universidad, u.carrera,
             u.created_at, u.last_login,
             u.podcasts_usados, u.ejercicios_usados, u.quizzes_usados, u.planes_usados,
             u.es_fundador, u.numero_registro,
             u.onboarding_v2, u.onboarding_completado,
             COALESCE(r.ramos_count, 0)::int AS ramos_count
      FROM usuarios u
      LEFT JOIN (
        SELECT usuario_id, COUNT(*) AS ramos_count
        FROM ramos
        GROUP BY usuario_id
      ) r ON r.usuario_id = u.id
      ORDER BY u.created_at DESC
    `)
    const stats = await pool.query(`
      SELECT
        COUNT(*) as total_usuarios,
        COUNT(CASE WHEN created_at > NOW() - INTERVAL '7 days' THEN 1 END) as nuevos_7d,
        COUNT(CASE WHEN last_login > NOW() - INTERVAL '1 day' THEN 1 END) as activos_hoy,
        COUNT(CASE WHEN last_login > NOW() - INTERVAL '7 days' THEN 1 END) as activos_7d,
        COUNT(CASE WHEN es_fundador = true THEN 1 END) as fundadores
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


// Distribución de usuarios por universidad (para el dashboard admin)
app.get('/admin/universidades-stats', authenticateToken, requireAdmin, async (req, res) => {
  if (req.user.email !== 'abelespinozav@gmail.com') return res.status(403).json({ error: 'No autorizado' })
  try {
    const { rows } = await pool.query(
      "SELECT universidad, COUNT(*) as count FROM usuarios WHERE universidad IS NOT NULL AND universidad <> '' GROUP BY universidad ORDER BY count DESC"
    )
    res.json(rows)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// Actividad diaria últimos 14 días (DAU basado en last_login)
app.get('/admin/actividad-diaria', authenticateToken, requireAdmin, async (req, res) => {
  if (req.user.email !== 'abelespinozav@gmail.com') return res.status(403).json({ error: 'No autorizado' })
  try {
    const { rows } = await pool.query(`
      SELECT TO_CHAR(DATE(last_login), 'YYYY-MM-DD') as fecha, COUNT(DISTINCT id)::int as usuarios
      FROM usuarios
      WHERE last_login > NOW() - INTERVAL '14 days'
      GROUP BY DATE(last_login)
      ORDER BY DATE(last_login) ASC
    `)
    res.json(rows)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// Estado del bot Telegram (admin dashboard)
app.get('/admin/telegram/status', authenticateToken, requireAdmin, async (req, res) => {
  if (req.user.email !== 'abelespinozav@gmail.com') return res.status(403).json({ error: 'No autorizado' })
  try {
    const activo = !!process.env.TELEGRAM_BOT_TOKEN
    const allowlist = (process.env.TELEGRAM_ALLOWED_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean)
    const countRes = await pool.query("SELECT COUNT(*) as total FROM novedades WHERE origen = 'telegram'")
    const ultimasRes = await pool.query(
      "SELECT id, tipo, emoji, titulo, creada_en FROM novedades WHERE origen = 'telegram' ORDER BY creada_en DESC LIMIT 5"
    )
    // Siempre responder con shape completa (arrays vacíos, no null) para que
    // el frontend no tenga que defender contra undefined en cada campo.
    res.json({
      activo,
      username: process.env.TELEGRAM_BOT_USERNAME || 'apprueba_bot',
      total_publicaciones: parseInt(countRes.rows[0].total) || 0,
      allowlist: allowlist || [],
      ultimas_publicaciones: ultimasRes.rows || []
    })
  } catch (err) {
    // En error devuelvo shape completa con defaults para que el UI no crashee
    res.status(500).json({
      activo: false, username: '', total_publicaciones: 0,
      allowlist: [], ultimas_publicaciones: [], error: err.message
    })
  }
})

// Todas las novedades (incluyendo expiradas) para el panel admin
app.get('/admin/novedades', authenticateToken, requireAdmin, async (req, res) => {
  if (req.user.email !== 'abelespinozav@gmail.com') return res.status(403).json({ error: 'No autorizado' })
  try {
    const { rows } = await pool.query(
      'SELECT * FROM novedades ORDER BY creada_en DESC LIMIT 200'
    )
    res.json(rows)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// Detalle completo de un usuario (solo admin)
app.get('/admin/usuario/:id/detalle', authenticateToken, requireAdmin, async (req, res) => {
  if (req.user.email !== 'abelespinozav@gmail.com') return res.status(403).json({ error: 'No autorizado' })
  try {
    const uid = req.params.id

    // El modal del frontend lee d.usuario?.nombre / email / universidad /
    // carrera / created_at / last_login. Antes no se devolvía nada sobre el
    // usuario y el modal mostraba "—" en todos los campos.
    const { rows: usuarioRows } = await pool.query(`
      SELECT id, nombre, email, universidad, carrera, avatar,
             created_at, last_login,
             es_fundador, numero_registro,
             onboarding_v2, onboarding_completado,
             podcasts_usados, ejercicios_usados, quizzes_usados, planes_usados,
             planes_limite, quizzes_limite, podcasts_limite, ejercicios_limite
      FROM usuarios WHERE id = $1
    `, [uid])
    if (usuarioRows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' })
    const usuario = usuarioRows[0]

    // Además de las evaluaciones en array, añado evaluaciones_count y
    // promedio ponderado — el modal los pinta por ramo.
    const { rows: ramos } = await pool.query(`
      SELECT r.id, r.nombre, r.min_aprobacion,
        COUNT(e.id)::int AS evaluaciones_count,
        CASE
          WHEN SUM(CASE WHEN e.nota IS NOT NULL THEN e.ponderacion ELSE 0 END) > 0
          THEN ROUND(
            (SUM(e.nota * e.ponderacion) FILTER (WHERE e.nota IS NOT NULL)
             / NULLIF(SUM(CASE WHEN e.nota IS NOT NULL THEN e.ponderacion END), 0))::numeric
          , 1)
          ELSE NULL
        END AS promedio,
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
    res.json({ usuario, ramos, podcasts, limiteGlobal })
  } catch(err) { console.error('ERROR DETALLE:', err.message); res.status(500).json({ error: err.message }) }
})

// Eliminar usuario (solo admin)
app.delete('/admin/usuario/:id', authenticateToken, requireAdmin, async (req, res) => {
  if (req.user.email !== 'abelespinozav@gmail.com') return res.status(403).json({ error: 'No autorizado' })
  if (parseInt(req.params.id) === req.user.id) return res.status(400).json({ error: 'No puedes eliminarte a ti mismo' })
  try {
    await pool.query('DELETE FROM usuarios WHERE id = $1', [req.params.id])
    res.json({ ok: true })
  } catch(err) { res.status(500).json({ error: err.message }) }
})

// Reset contadores de un usuario (solo admin)
app.post('/admin/limite-global', authenticateToken, requireAdmin, async (req, res) => {
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

app.get('/admin/limite-global', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT valor FROM configuracion WHERE clave = 'limite_global'")
    const limite = rows.length ? parseInt(rows[0].valor) : 100
    res.json({ limite })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

// Actualiza los 4 límites individuales de un usuario. null = usar global.
app.patch('/admin/usuarios/:id/limites', authenticateToken, requireAdmin, async (req, res) => {
  if (req.user.email !== 'abelespinozav@gmail.com') return res.status(403).json({ error: 'No autorizado' })
  try {
    const CAMPOS = ['planes_limite', 'quizzes_limite', 'podcasts_limite', 'ejercicios_limite']
    const sets = []
    const vals = []
    for (const c of CAMPOS) {
      if (!(c in req.body)) continue
      const v = req.body[c]
      // '' o null explícito → NULL (vuelve al global). Número negativo inválido.
      const parsed = (v === '' || v === null || v === undefined) ? null : parseInt(v)
      if (parsed !== null && (isNaN(parsed) || parsed < 0)) return res.status(400).json({ error: `${c} inválido` })
      sets.push(`${c} = $${vals.length + 1}`)
      vals.push(parsed)
    }
    if (sets.length === 0) return res.status(400).json({ error: 'Sin campos para actualizar' })
    vals.push(req.params.id)
    const { rowCount } = await pool.query(
      `UPDATE usuarios SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING planes_limite, quizzes_limite, podcasts_limite, ejercicios_limite`,
      vals
    )
    if (rowCount === 0) return res.status(404).json({ error: 'Usuario no encontrado' })
    res.json({ ok: true })
  } catch(err) {
    console.error('Error PATCH límites:', err)
    res.status(500).json({ error: 'Error al actualizar límites' })
  }
})

app.get('/config/limite-global', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT valor FROM configuracion WHERE clave = 'limite_global'")
    const limite = rows.length ? parseInt(rows[0].valor) : 100
    res.json({ limite })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/admin/reset-contadores', authenticateToken, requireAdmin, async (req, res) => {
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
app.post('/admin/notificacion-broadcast', authenticateToken, requireAdmin, async (req, res) => {
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
cron.schedule('0 8 * * *', async () => {
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
      // Deduplicar: no enviar dos veces el mismo aviso
      const claveClase = `clase_${row.usuario_id}_${diaHoy}_${row.hora_inicio}_${row.ramo_nombre}`
      try {
        await pool.query(
          'INSERT INTO notif_enviadas (usuario_id, clave) VALUES ($1, $2)',
          [row.usuario_id, claveClase]
        )
      } catch(e) {
        if (e.code === '23505') continue
        throw e
      }
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

// ── CRON — Ventanas de estudio (dinámico: avisa 30 min antes de la mejor ventana) ──
cron.schedule('*/30 7-22 * * *', async () => {
  try {
    const ahora = new Date()
    const diasSemana = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado']
    const diaHoy = diasSemana[ahora.getDay()]
    const horaAhora = ahora.toTimeString().slice(0,5)

    const { rows: usuarios } = await pool.query(`
      SELECT nc.usuario_id
      FROM notificacion_config nc
      WHERE nc.activo = true AND nc.notif_ventanas = true
    `)

    for (const u of usuarios) {
      const { rows: clases } = await pool.query(`
        SELECT hora_inicio, hora_fin FROM horario
        WHERE usuario_id = $1 AND dia = $2
        ORDER BY hora_inicio
      `, [u.usuario_id, diaHoy])

      const toMin = t => { const [h,m] = t.split(':').map(Number); return h*60+m }
      const fromMin = m => String(Math.floor(m/60)).padStart(2,'0')+':'+String(m%60).padStart(2,'0')

      const bloques = [
        { hora_inicio: '07:00', hora_fin: '07:00' },
        ...clases,
        { hora_inicio: '23:00', hora_fin: '23:00' }
      ]

      const ventanas = []
      for (let j = 0; j < bloques.length - 1; j++) {
        const finAnterior = bloques[j].hora_fin
        const inicioSiguiente = bloques[j+1].hora_inicio
        const durMin = toMin(inicioSiguiente) - toMin(finAnterior)
        if (durMin >= 60 && finAnterior >= horaAhora) {
          ventanas.push({ desde: finAnterior, hasta: inicioSiguiente, durMin })
        }
      }

      if (ventanas.length === 0) continue

      // Tomar la próxima ventana libre
      const proxVentana = ventanas[0]
      const minutosHasta = toMin(proxVentana.desde) - toMin(horaAhora)

      // Avisar solo si la ventana empieza en los próximos 30 min
      if (minutosHasta < 0 || minutosHasta > 30) continue

      // Deduplicar: no enviar dos veces el mismo aviso
      const clave = `ventana_${u.usuario_id}_${diaHoy}_${proxVentana.desde}`
      try {
        await pool.query(
          'INSERT INTO notif_enviadas (usuario_id, clave) VALUES ($1, $2)',
          [u.usuario_id, clave]
        )
      } catch(e) {
        if (e.code === '23505') continue // ya enviada
        throw e
      }

      const durHoras = Math.floor(proxVentana.durMin / 60)
      const durMins = proxVentana.durMin % 60
      const durTexto = durHoras > 0
        ? (durMins > 0 ? `${durHoras}h ${durMins}min` : `${durHoras}h`)
        : `${durMins}min`

      const { rows: subs } = await pool.query(
        'SELECT subscription FROM push_subscriptions WHERE usuario_id = $1',
        [u.usuario_id]
      )

      for (const sub of subs) {
        try {
          await webpush.sendNotification(
            { endpoint: sub.subscription.endpoint, expirationTime: sub.subscription.expirationTime, keys: { p256dh: sub.subscription.keys.p256dh, auth: sub.subscription.keys.auth } },
            JSON.stringify({
              title: '📖 Ventana de estudio',
              body: `Tienes ${durTexto} libres desde las ${proxVentana.desde} hasta las ${proxVentana.hasta}. ¡Buen momento para estudiar!`,
              icon: '/icon-192.png'
            })
          )
        } catch(e) {
          if (e.statusCode === 410) {
            await pool.query('DELETE FROM push_subscriptions WHERE subscription = $1', [JSON.stringify(sub.subscription)])
          }
        }
      }
    }
  } catch(err) {
    console.error('❌ Error cron ventanas dinámico:', err.message)
  }
}, { timezone: 'America/Santiago' })

// ── CRON — Limpieza notif_enviadas (cada día a las 00:05) ────────
cron.schedule('5 0 * * *', async () => {
  try {
    await pool.query("DELETE FROM notif_enviadas WHERE enviada_at < NOW() - INTERVAL '2 days'")
    console.log('🧹 notif_enviadas limpiada')
  } catch(err) {
    console.error('❌ Error limpieza notif_enviadas:', err.message)
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
  let podcastContadoEnLimite = false
  const userId = req.user.id
  try {
    const evId = req.params.id
    const tareaIdx = req.body.tareaIdx ?? null
    // Check-and-set atómico antes de invocar IA (previene race condition).
    const limiteGlobal = await resolverLimite(userId, 'podcasts')
    const { rows: incRows } = await pool.query(
      'UPDATE usuarios SET podcasts_usados = podcasts_usados + 1 WHERE id = $1 AND podcasts_usados < $2 RETURNING podcasts_usados',
      [userId, limiteGlobal]
    )
    if (incRows.length === 0) {
      const cur = await pool.query('SELECT podcasts_usados FROM usuarios WHERE id = $1', [userId])
      return res.status(403).json({ error: 'limite_alcanzado', usados: cur.rows[0]?.podcasts_usados || limiteGlobal, limite: limiteGlobal })
    }
    podcastContadoEnLimite = true
    const usados = incRows[0].podcasts_usados - 1 // valor previo, para compat con header X-Podcasts-Usados
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
            const parsed = { text: await extraerTextoPDF(buf) }
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
    const perfil = await getPerfilEstudiante(evId)
    const perfilBloque = formatPerfilBloque(perfil)
    const guionRes = await callOpenAIWithRetry({
      model: 'gpt-4o',
      messages: [{
        role: 'system',
        content: 'Eres un generador de podcasts educativos en español. Genera un guión conversacional entre dos personas: "Constanza" (profesora entusiasta y experta) y "Benjamín" (estudiante curioso que hace preguntas inteligentes). El podcast debe durar aproximadamente 7 minutos. Formato estricto JSON: { "titulo": "...", "segmentos": [{ "voz": "constanza"|"benjamin", "texto": "..." }] }. Mínimo 28 segmentos, máximo 35. Cada segmento debe tener 2-3 oraciones completas. Estructura: introducción motivadora (5 seg), desarrollo profundo por subtemas con ejemplos reales (45 seg), preguntas y respuestas entre Constanza y Benjamín (8 seg), conclusión y consejos para el examen (4 seg). Habla de forma MUY NATURAL como un podcast real. NUNCA uses el nombre del interlocutor para dirigirte a él/ella (nada de "así es Benjamín", "gracias Constanza", "qué buena pregunta"). Las transiciones deben ser naturales: "exacto", "claro", "mira", "lo que pasa es que...", "y ahí está la clave". Usa analogías, ejemplos cotidianos y humor ocasional.'
      }, {
        role: 'user',
        content: (perfilBloque ? perfilBloque + '\n\n' : '') + (material
        ? 'Crea un podcast educativo de 7 minutos para estudiar: "' + ev.nombre + '" del ramo "' + ev.ramo_nombre + '". Basa el podcast EXCLUSIVAMENTE en este material y cubre ABSOLUTAMENTE TODOS los temas con profundidad y ejemplos reales: ' + material.slice(0, 15000) + (plan ? ' Plan de estudio: ' + plan.slice(0, 2000) : '') + ' IMPORTANTE: El podcast debe tener entre 28 y 35 segmentos, cada uno con 2-3 oraciones. Sé conciso pero claro.'
        : 'Crea un podcast educativo de 7 minutos para estudiar: "' + ev.nombre + '" del ramo "' + ev.ramo_nombre + '". ' + (plan ? 'Basa el contenido en este plan de estudio y desarróllalo en máximo detalle: ' + plan.slice(0, 3000) : 'Explica en profundidad todos los conceptos clave que un estudiante universitario necesita saber sobre este tema, con ejemplos, aplicaciones y casos reales.') + ' IMPORTANTE: Entre 28 y 35 segmentos, cada uno con 2-3 oraciones.')
      }],
      response_format: { type: 'json_object' }
    })
    let guion
    try { guion = JSON.parse(guionRes.choices[0].message.content) }
    catch(e) { return res.status(500).json({ error: 'Error generando guion' }) }
    const voces = {
      constanza: 'imFXYz8XIletRKLZZQaA',
      benjamin: 'XgQWNZcJ8SRkxXwwhPTo'
    }
    const audioBuffers = []
    const elevenLabsKey = process.env.ELEVENLABS_API_KEY
    for (const seg of guion.segmentos) {
      const voiceId = voces[seg.voz] || voces.constanza
      const voiceSettings = seg.voz === 'constanza'
        ? { stability: 0.55, similarity_boost: 0.75, style: 0.15, use_speaker_boost: true, speed: 1.05 }
        : { stability: 0.45, similarity_boost: 0.80, style: 0.25, use_speaker_boost: true, speed: 1.05 }
      const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
        method: 'POST',
        headers: {
          'xi-api-key': elevenLabsKey,
          'Content-Type': 'application/json',
          'Accept': 'audio/mpeg'
        },
        body: JSON.stringify({
          text: seg.texto,
          model_id: 'eleven_turbo_v2_5',
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
    // El contador ya se incrementó atómicamente antes de llamar IA.
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
    if (podcastContadoEnLimite) {
      await pool.query('UPDATE usuarios SET podcasts_usados = GREATEST(podcasts_usados - 1, 0) WHERE id = $1', [userId]).catch(()=>{})
    }
    res.status(500).json({ error: 'Error generando podcast' })
  }
})

app.listen(process.env.PORT || 3001, () => console.log(`Backend corriendo en puerto ${process.env.PORT || 3001} 🚀`))
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
    // Siempre re-extraer desde archivos en BD para tener contenido actualizado
    const { rows: archivosGuia } = await pool.query(
      `SELECT nombre, tipo, encode(datos, 'base64') as datos FROM archivos WHERE evaluacion_id = $1`,
      [req.params.id]
    )
    if (archivosGuia.length > 0) {
      let textoExtraido = ''
      for (const archivo of archivosGuia) {
        try {
          const esYoutube = archivo.tipo === 'youtube'
          const archivoObj = esYoutube
            ? { youtubeUrl: archivo.nombre, nombre: 'Video YouTube' }
            : { nombre: archivo.nombre, tipo: archivo.tipo, datos: archivo.datos }
          const contenido = await extraerContenido(archivoObj)
          textoExtraido += `\n\n--- ${archivo.nombre} ---\n${contenido}`
        } catch(e) { console.error('Error extrayendo para guía:', e.message) }
      }
      if (textoExtraido.trim()) {
        contenidoArchivos = `\n\nMATERIAL DE ESTUDIO DEL ESTUDIANTE (úsalo como base principal para la guía):\n${textoExtraido.slice(0, 15000)}`
      }
    } else if (ev.texto_material && ev.texto_material.trim()) {
      contenidoArchivos = `\n\nMATERIAL DE ESTUDIO DEL ESTUDIANTE (úsalo como base principal para la guía):\n${ev.texto_material.slice(0, 15000)}`
    }

    const perfilGuia = await getPerfilEstudiante(req.params.id)
    const perfilBloqueGuia = formatPerfilBloque(perfilGuia)

    const prompt = `Eres el mejor tutor universitario del mundo — un experto que combina la claridad de Richard Feynman, la pedagogía de un profesor que realmente se preocupa por sus estudiantes, y la capacidad de hacer que cualquier tema sea fascinante. Tu misión es generar una guía de estudio TAN BUENA que el estudiante diga "¡WOW, esto es espectacular!".

${perfilBloqueGuia ? perfilBloqueGuia + '\n\n' : ''}Ramo: ${ev.ramo_nombre}
Evaluación: ${ev.nombre}
Tarea a estudiar: ${tarea.titulo}
Descripción: ${tarea.descripcion}${contenidoArchivos}

INSTRUCCIONES CRÍTICAS PARA UNA GUÍA ESPECTACULAR:
- Usa analogías creativas y memorables con situaciones de la vida cotidiana chilena
- Incluye trucos mnemotécnicos, acrónimos o frases para recordar conceptos difíciles
- Explica el "¿por qué importa esto?" — conecta el tema con aplicaciones reales
- En los ejemplos, muestra el razonamiento paso a paso como si fuera una conversación
- Usa un tono cercano, motivador y directo (tutéalo al estudiante)
- Los ejercicios deben ir de menor a mayor dificultad, con pistas inteligentes
- El resumen debe ser una "cheat sheet" mental ultra-práctica para el día del examen

Responde SOLO con un JSON válido (sin markdown, sin bloques de código):
{
  "titulo": "título atractivo y específico de la guía",
  "introduccion": "párrafo motivador que explica por qué este tema es importante y cómo conecta con la vida real — máximo 3 oraciones poderosas",
  "conceptos_clave": [
    { "termino": "nombre del concepto", "definicion": "explicación clara con analogía de la vida cotidiana", "truco": "truco mnemotécnico o frase para recordarlo fácil" }
  ],
  "desarrollo": "explicación profunda del tema en 4-5 párrafos, usando ejemplos concretos, analogías y conectando ideas entre sí. Debe sentirse como una conversación con un tutor experto, no como un libro de texto",
  "ejemplos": [
    { "enunciado": "problema concreto y realista", "solucion": "solución paso a paso explicando el RAZONAMIENTO detrás de cada paso, no solo los cálculos", "insight": "qué aprender de este ejemplo para el examen" }
  ],
  "ejercicios_practica": [
    { "enunciado": "ejercicio desafiante pero alcanzable", "pista": "pista que guía sin revelar la respuesta", "nivel": "básico/intermedio/avanzado" }
  ],
  "conexiones": "cómo este tema se relaciona con otros temas del ramo o con situaciones del mundo real — 2-3 conexiones que amplían la comprensión",
  "resumen_final": "cheat sheet mental: 4-5 puntos CLAVE ultra-concretos para recordar en el examen, en formato de frases cortas y poderosas"
}

Genera 4 conceptos clave con trucos mnemotécnicos, 3 ejemplos resueltos con insights, y 3 ejercicios de práctica (uno básico, uno intermedio, uno avanzado).`

    const result = await callOpenAIWithRetry({
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
    // Validación: suma de ponderaciones no puede superar 100%
    const sumaPond = (evaluaciones || []).reduce((acc, e) => acc + (parseFloat(e.ponderacion) || 0), 0)
    if (sumaPond > 100.01) {
      return res.status(400).json({ error: `La suma de ponderaciones es ${sumaPond.toFixed(1)}%, no puede superar 100%` })
    }
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
      `SELECT r.*, COALESCE(json_agg(json_build_object('id',e.id,'nombre',e.nombre,'ponderacion',e.ponderacion,'nota',e.nota,'fecha',e.fecha,'plan_estudio',e.plan_estudio,'tareas_completadas',e.tareas_completadas,'archivos',COALESCE((SELECT json_agg(json_build_object('id',a.id,'nombre',a.nombre,'tipo',a.tipo)) FROM archivos a WHERE a.evaluacion_id = e.id),'[]'::json)) ORDER BY e.id) FILTER (WHERE e.id IS NOT NULL),'[]'::json) as evaluaciones FROM ramos r LEFT JOIN evaluaciones e ON e.ramo_id = r.id WHERE r.id=$1 GROUP BY r.id`,
      [req.params.id]
    )
    res.json(updated.rows[0])
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }) }
})

app.patch('/ramos/:ramoId/evaluaciones/:evalId', authenticateToken, async (req, res) => {
  try {
    // Si viene 'ponderacion', validar que la suma (excluyendo la eval actual) + nueva <= 100
    if ('ponderacion' in req.body) {
      const nuevaPond = parseFloat(req.body.ponderacion) || 0
      const { rows } = await pool.query(
        `SELECT COALESCE(SUM(ponderacion), 0) AS suma
         FROM evaluaciones
         WHERE ramo_id = $1 AND id <> $2
         AND ramo_id IN (SELECT id FROM ramos WHERE usuario_id = $3)`,
        [req.params.ramoId, req.params.evalId, req.user.id]
      )
      const sumaOtras = parseFloat(rows[0].suma) || 0
      if (sumaOtras + nuevaPond > 100.01) {
        const disponible = Math.max(0, 100 - sumaOtras)
        return res.status(400).json({ error: `Ponderación excede el 100%. Disponible: ${disponible.toFixed(1)}%` })
      }
    }
    const ALLOWED = ['nota', 'nombre', 'fecha', 'ponderacion']
    const sets = []
    const vals = []
    for (const f of ALLOWED) {
      if (!(f in req.body)) continue
      let v = req.body[f]
      if (f === 'nota') v = (v === '' || v === null || v === undefined) ? null : parseFloat(v)
      if (f === 'fecha') v = (v === '' || v === null) ? null : v
      if (f === 'ponderacion') v = (v === '' || v === null || v === undefined) ? null : parseFloat(v)
      if (f === 'nombre') v = String(v || '').trim() || null
      sets.push(`${f} = $${vals.length + 1}`)
      vals.push(v)
    }
    if (sets.length === 0) return res.status(400).json({ error: 'Sin campos para actualizar' })
    const iEval = vals.length + 1, iRamo = vals.length + 2, iUser = vals.length + 3
    vals.push(req.params.evalId, req.params.ramoId, req.user.id)
    const { rowCount } = await pool.query(
      `UPDATE evaluaciones SET ${sets.join(', ')}
       WHERE id = $${iEval} AND ramo_id = $${iRamo}
       AND ramo_id IN (SELECT id FROM ramos WHERE usuario_id = $${iUser})`,
      vals
    )
    if (rowCount === 0) return res.status(404).json({ error: 'Evaluación no encontrada' })
    res.json({ ok: true })
  } catch (err) {
    console.error('Error actualizando evaluación:', err)
    res.status(500).json({ error: 'Error al actualizar evaluación' })
  }
})

app.delete('/ramos/:ramoId/evaluaciones/:evalId', authenticateToken, async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM evaluaciones
       WHERE id = $1 AND ramo_id = $2
       AND ramo_id IN (SELECT id FROM ramos WHERE usuario_id = $3)`,
      [req.params.evalId, req.params.ramoId, req.user.id]
    )
    if (rowCount === 0) return res.status(404).json({ error: 'Evaluación no encontrada' })
    res.json({ ok: true })
  } catch (err) {
    console.error('Error eliminando evaluación:', err)
    res.status(500).json({ error: 'Error al eliminar evaluación' })
  }
})
// Mon Apr  6 14:30:49 -04 2026
// Mon Apr  6 14:31:43 -04 2026

// ── QUIZ DE 20 PREGUNTAS ─────────────────────────────────────────
// Guardar resultado quiz
app.post('/quiz/historial', authenticateToken, async (req, res) => {
  try {
    const { evaluacion_id, ramo_id, ramo_nombre, puntaje, total } = req.body
    const porcentaje = Math.round((puntaje / total) * 100)
    await pool.query(
      'INSERT INTO quiz_historial (usuario_id, evaluacion_id, ramo_nombre, puntaje, total, porcentaje) VALUES ($1,$2,$3,$4,$5,$6)',
      [req.user.id, evaluacion_id || ramo_id || null, ramo_nombre, puntaje, total, porcentaje]
    )
    res.json({ ok: true })
  } catch(e) { console.error('❌ Error POST /quiz/historial:', e.message); res.status(500).json({ error: e.message }) }
})

// Historial de quizzes del usuario
app.get('/quiz/historial', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM quiz_historial WHERE usuario_id=$1 ORDER BY created_at DESC LIMIT 50',
      [req.user.id]
    )
    res.json(rows)
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.post('/evaluaciones/:id/quiz', authenticateToken, async (req, res) => {
  let quizContadoEnLimite = false
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
    // Check-and-set atómico antes de la IA.
    const limiteGlobalQ = await resolverLimite(req.user.id, 'quizzes')
    const { rows: incQ } = await pool.query(
      'UPDATE usuarios SET quizzes_usados = quizzes_usados + 1 WHERE id = $1 AND quizzes_usados < $2 RETURNING quizzes_usados',
      [req.user.id, limiteGlobalQ]
    )
    if (incQ.length === 0) {
      const cur = await pool.query('SELECT quizzes_usados FROM usuarios WHERE id = $1', [req.user.id])
      return res.status(403).json({ error: 'limite_alcanzado', tipo: 'quizzes', usados: cur.rows[0]?.quizzes_usados || limiteGlobalQ, limite: limiteGlobalQ })
    }
    quizContadoEnLimite = true
    if (!ev.texto_material && (!ev.archivos || ev.archivos.length === 0)) {
      // Refund inmediato — no se va a llamar IA.
      await pool.query('UPDATE usuarios SET quizzes_usados = GREATEST(quizzes_usados - 1, 0) WHERE id = $1', [req.user.id])
      return res.status(400).json({ error: 'Debes subir material de estudio para generar el quiz' })
    }

    // ── SSE setup ──
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders()

    const enviar = (tipo, datos) => {
      if (!res.destroyed) res.write(`data: ${JSON.stringify({ tipo, ...datos })}\n\n`)
    }

    enviar('progreso', { msg: '🧠 Iniciando generación del quiz...' })
    enviar('iniciado', { msg: 'Tu quiz se está generando. Puedes cerrar esta pantalla y te avisaremos cuando esté listo.' })

    const usuarioId = req.user.id
    const evalId = req.params.id

    // Abort si el cliente cierra o si pasan 15 min (generación colgada).
    const abortCtl = new AbortController()
    const abortTimer = setTimeout(() => abortCtl.abort(), 15 * 60 * 1000)
    res.on('close', () => { if (!abortCtl.signal.aborted) abortCtl.abort() })

    setImmediate(async () => {
      try {
        let textoArchivos = ev.texto_material || ''
        if (!textoArchivos) {
          for (const archivo of ev.archivos) {
            if (archivo.datos || archivo.youtubeUrl) {
              try {
                enviar('progreso', { msg: `📄 Leyendo: ${archivo.nombre || 'archivo'}...` })
                const contenido = await extraerContenido(archivo, enviar)
                textoArchivos += `\n\n--- ${archivo.nombre || archivo.youtubeUrl} ---\n${contenido}`
              } catch(e) { console.error('Error extrayendo texto para quiz:', e.message) }
            }
          }
        }
        if (!textoArchivos.trim()) {
          enviar('error', { error: 'sin_contenido', mensaje: 'No se pudo extraer texto del material subido' })
          if (!res.destroyed) res.end()
          return
        }
        enviar('progreso', { msg: '🤖 Generando 20 preguntas con IA...' })
        const perfilQuiz = await getPerfilEstudiante(evalId)
        const perfilBloqueQuiz = formatPerfilBloque(perfilQuiz)
        const prompt = `Eres un profesor universitario experto en ${ev.ramo_nombre}. Tu tarea es crear un quiz que evalúe si el estudiante ENTIENDE y SABE APLICAR los conceptos del material, NO que recuerde cómo está organizado el documento.

${perfilBloqueQuiz ? perfilBloqueQuiz + '\n\n' : ''}Ramo: ${ev.ramo_nombre}
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
{"preguntas":[{"id":1,"pregunta":"...","alternativas":{"A":"...","B":"...","C":"...","D":"..."},"correcta":"C","explicacion":"...","dificultad":"facil"},{"id":2,"pregunta":"...","alternativas":{"A":"...","B":"...","C":"...","D":"..."},"correcta":"B","explicacion":"...","dificultad":"media"}]}
IMPORTANTE: La respuesta correcta debe distribuirse aleatoriamente entre A, B, C y D. NO pongas siempre A como correcta.`
        const result = await callOpenAIWithRetry({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.7,
          signal: abortCtl.signal
        })
        let text = result.choices[0].message.content
        text = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim()
        const jsonMatch = text.match(/\{[\s\S]*\}/)
        if (!jsonMatch) throw new Error('No se pudo parsear respuesta de IA')
        let quizData
        try { quizData = JSON.parse(jsonMatch[0]); console.log('🔍 CORRECTAS:', quizData.preguntas.slice(0,5).map(p => p.correcta)) }
        catch (parseErr) { throw new Error('La IA devolvió JSON inválido') }
        if (!quizData.preguntas || quizData.preguntas.length === 0) throw new Error('La IA no generó preguntas válidas')
        // Shufflear alternativas para que la correcta no siempre quede en A
        const letras = ['A','B','C','D']
        quizData.preguntas = quizData.preguntas.map(p => {
          const entries = Object.entries(p.alternativas) // [['A','texto'],...]
          const correctaTexto = p.alternativas[p.correcta]
          // Fisher-Yates shuffle
          for (let i = entries.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [entries[i], entries[j]] = [entries[j], entries[i]]
          }
          const nuevasAlternativas = {}
          let nuevaCorrecta = p.correcta
          entries.forEach(([, texto], idx) => {
            nuevasAlternativas[letras[idx]] = texto
            if (texto === correctaTexto) nuevaCorrecta = letras[idx]
          })
          return { ...p, alternativas: nuevasAlternativas, correcta: nuevaCorrecta }
        })
        enviar('progreso', { msg: '✅ Quiz generado, guardando...' })
        await pool.query('UPDATE evaluaciones SET quiz_generado = $1 WHERE id = $2', [JSON.stringify(quizData.preguntas), evalId])
        // Contador ya incrementado atómicamente antes del setImmediate.
        clearTimeout(abortTimer)
        enviar('quiz', { preguntas: quizData.preguntas })
        if (!res.destroyed) res.end()
      } catch (err) {
        console.error('Error generando quiz:', err)
        clearTimeout(abortTimer)
        const abortado = err?.name === 'AbortError' || abortCtl.signal.aborted
        // Refund: IA falló o fue cancelada, devolvemos el cupo.
        await pool.query('UPDATE usuarios SET quizzes_usados = GREATEST(quizzes_usados - 1, 0) WHERE id = $1', [usuarioId]).catch(()=>{})
        enviar('error', {
          error: abortado ? 'cancelado' : 'fallo_ia',
          mensaje: abortado ? 'La generación fue cancelada.' : 'Error al generar quiz: ' + err.message
        })
        if (!res.destroyed) res.end()
      }
    })
  } catch (err) {
    console.error('Error generando quiz:', err)
    if (quizContadoEnLimite) {
      await pool.query('UPDATE usuarios SET quizzes_usados = GREATEST(quizzes_usados - 1, 0) WHERE id = $1', [req.user.id]).catch(()=>{})
    }
    res.status(500).json({ error: 'Error al generar quiz: ' + err.message })
  }
})

// ── EJERCICIOS PDF ───────────────────────────────────────────────
const PDFDocument = require('pdfkit')

app.post('/evaluaciones/:id/ejercicios-pdf', authenticateToken, async (req, res) => {
  let ejContadoEnLimite = false
  try {
    const { tarea, tareaIndex, forzar } = req.body
    const evRes = await pool.query(
      `SELECT e.*, r.nombre as ramo_nombre FROM evaluaciones e
       JOIN ramos r ON e.ramo_id = r.id
       WHERE e.id = $1 AND r.usuario_id = $2`,
      [req.params.id, req.user.id]
    )
    if (evRes.rows.length === 0) return res.status(404).json({ error: 'No encontrada' })
    const ev = evRes.rows[0]

    // CACHE: si hay PDF del mismo día para esta misma tarea, servirlo sin regenerar
    if (!forzar && ev.ejercicios_pdf && ev.ejercicios_pdf_generado_at &&
        ev.ejercicios_pdf_tarea_index === tareaIndex) {
      const generado = new Date(ev.ejercicios_pdf_generado_at)
      const hoy = new Date()
      const mismoDia = generado.toDateString() === hoy.toDateString()
      if (mismoDia) {
        res.setHeader('Content-Type', 'application/pdf')
        res.setHeader('Content-Disposition', `attachment; filename="ejercicios-${tareaIndex+1}.pdf"`)
        res.setHeader('X-Cached', '1')
        return res.send(Buffer.isBuffer(ev.ejercicios_pdf) ? ev.ejercicios_pdf : Buffer.from(ev.ejercicios_pdf))
      }
    }

    // Check-and-set atómico antes de la IA.
    const limiteGlobalE = await resolverLimite(req.user.id, 'ejercicios')
    const { rows: incE } = await pool.query(
      'UPDATE usuarios SET ejercicios_usados = ejercicios_usados + 1 WHERE id = $1 AND ejercicios_usados < $2 RETURNING ejercicios_usados',
      [req.user.id, limiteGlobalE]
    )
    if (incE.length === 0) {
      const cur = await pool.query('SELECT ejercicios_usados FROM usuarios WHERE id = $1', [req.user.id])
      return res.status(403).json({ error: 'limite_alcanzado', tipo: 'ejercicios', usados: cur.rows[0]?.ejercicios_usados || limiteGlobalE, limite: limiteGlobalE })
    }
    ejContadoEnLimite = true

    const perfilEj = await getPerfilEstudiante(req.params.id)
    const perfilBloqueEj = formatPerfilBloque(perfilEj)
    const materialEj = (ev.texto_material || '').slice(0, 10000)
    const materialBloque = materialEj
      ? `\n\nMATERIAL DE ESTUDIO DEL ESTUDIANTE (basa los ejercicios en este contenido real):\n${materialEj}`
      : ''

    const completion = await callOpenAIWithRetry({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: `${perfilBloqueEj ? perfilBloqueEj + '\n\n' : ''}Eres un profesor universitario experto en "${ev.ramo_nombre}".
Genera exactamente 20 ejercicios sobre el tema: "${tarea.titulo}".
Contexto: ${tarea.descripcion}${materialBloque}

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
    const chunks = []
    doc.on('data', c => chunks.push(c))
    doc.on('end', async () => {
      const pdfBuf = Buffer.concat(chunks)
      try {
        await pool.query(
          'UPDATE evaluaciones SET ejercicios_pdf = $1, ejercicios_pdf_generado_at = NOW(), ejercicios_pdf_tarea_index = $2 WHERE id = $3',
          [pdfBuf, tareaIndex, req.params.id]
        )
        // Contador ya incrementado atómicamente antes de la IA.
      } catch(err) { console.error('Error cacheando PDF ejercicios:', err.message) }
      res.setHeader('Content-Type', 'application/pdf')
      res.setHeader('Content-Disposition', `attachment; filename="ejercicios-${tareaIndex+1}.pdf"`)
      res.send(pdfBuf)
    })

    // ── Colores (fondo blanco) ────────────────────────────────────
    const ACCENT   = '#6c63ff'
    const ACCENT2  = '#4f46e5'
    const BLACK    = '#1a1a2e'
    const DARK     = '#374151'
    const MID      = '#6b7280'
    const LIGHT    = '#f3f4f6'
    const EASY_C   = '#059669'
    const MED_C    = '#d97706'
    const HARD_C   = '#dc2626'
    const W        = 595 - 100
    const PAGE_H   = 842

    const diffColor = (d) => {
      const dl = (d || '').toLowerCase()
      if (dl.includes('f')) return EASY_C
      if (dl.includes('m')) return MED_C
      return HARD_C
    }
    const diffLabel = (d) => {
      const dl = (d || '').toLowerCase()
      if (dl.includes('f')) return 'FÁCIL'
      if (dl.includes('m')) return 'MEDIO'
      return 'DIFÍCIL'
    }

    // ── PORTADA (todo con coordenadas absolutas para no mover cursor) ──
    doc.rect(0, 0, 595, PAGE_H).fill('#ffffff')
    doc.rect(0, 0, 595, 80).fill(ACCENT)

    // Logo
    doc.fontSize(18).fillColor('#ffffff').font('Helvetica-Bold')
       .text('APPrueba', 50, 28, { width: 200, lineBreak: false })

    // Calcular alturas dinámicas para título y subtítulos
    const titleH   = doc.heightOfString('Guía de Ejercicios', { fontSize: 26, width: W })
    const subtitleH = doc.heightOfString(tarea.titulo, { fontSize: 15, width: W })
    const ramH     = doc.heightOfString(ev.ramo_nombre + '  ·  ' + ev.nombre, { fontSize: 11, width: W })

    let py = 110
    doc.fontSize(26).fillColor(BLACK).font('Helvetica-Bold')
       .text('Guía de Ejercicios', 50, py, { width: W, lineBreak: false })
    py += titleH + 8
    doc.fontSize(15).fillColor(ACCENT2).font('Helvetica-Bold')
       .text(tarea.titulo, 50, py, { width: W, lineBreak: false })
    py += subtitleH + 8
    doc.fontSize(11).fillColor(MID).font('Helvetica')
       .text(ev.ramo_nombre + '  ·  ' + ev.nombre, 50, py, { width: W, lineBreak: false })
    py += ramH + 16

    // Línea divisora
    doc.rect(50, py, W, 2).fill(ACCENT)
    py += 20

    // Stats cards
    const cardW = (W - 20) / 3
    const cardY = py
    const stats = [
      { label: 'Ejercicios', value: '20', color: ACCENT },
      { label: 'Dificultades', value: '3 niveles', color: ACCENT2 },
      { label: 'Respuestas', value: 'Al final', color: EASY_C }
    ]
    stats.forEach((s, i) => {
      const cx = 50 + i * (cardW + 10)
      doc.roundedRect(cx, cardY, cardW, 60, 6).fill(LIGHT)
      doc.fontSize(20).fillColor(s.color).font('Helvetica-Bold')
         .text(s.value, cx, cardY + 10, { width: cardW, align: 'center', lineBreak: false })
      doc.fontSize(9).fillColor(MID).font('Helvetica')
         .text(s.label, cx, cardY + 36, { width: cardW, align: 'center', lineBreak: false })
    })

    // Leyenda dificultad
    const legY = cardY + 80
    doc.fontSize(10).fillColor(DARK).font('Helvetica-Bold')
       .text('Niveles de dificultad:', 50, legY, { lineBreak: false })
    const levels = [
      { label: 'Fácil  (1–7)', color: EASY_C },
      { label: 'Medio  (8–14)', color: MED_C },
      { label: 'Difícil  (15–20)', color: HARD_C }
    ]
    levels.forEach((l, i) => {
      const lx = 50 + i * 160
      doc.circle(lx + 6, legY + 22, 5).fill(l.color)
      doc.fontSize(10).fillColor(DARK).font('Helvetica')
         .text(l.label, lx + 16, legY + 16, { lineBreak: false })
    })

    // Footer portada
    doc.fontSize(9).fillColor(MID)
       .text('Generado por APPrueba · apprueba.cl', 50, PAGE_H - 40, { width: W, align: 'center', lineBreak: false })

    // ── EJERCICIOS ───────────────────────────────────────────────
    const LINES    = 4
    const LINE_GAP = 18
    const PAGE_BOTTOM = PAGE_H - 40

    const ejHeight = (ej) => {
      const h = doc.heightOfString(ej.enunciado, { width: W, fontSize: 11, lineGap: 3 })
      return 24 + h + 8 + 14 + LINE_GAP * LINES + 20
    }

    // Primera página de ejercicios
    doc.addPage()
    doc.rect(0, 0, 595, PAGE_H).fill('#ffffff')
    doc.rect(0, 0, 595, 6).fill(ACCENT)
    let curY = 30
    let misPageCount = 2 // portada + esta página

    ejercicios.forEach((ej) => {
      // Si no cabe en esta página, crear nueva
      if (curY + ejHeight(ej) > PAGE_BOTTOM) {
        doc.addPage()
        doc.rect(0, 0, 595, PAGE_H).fill('#ffffff')
        doc.rect(0, 0, 595, 6).fill(ACCENT)
        curY = 30
        misPageCount++
      }

      const dc = diffColor(ej.dificultad)
      const dl = diffLabel(ej.dificultad)

      // Badge dificultad
      doc.roundedRect(50, curY, 56, 18, 4).fill(dc)
      doc.fontSize(8).fillColor('#ffffff').font('Helvetica-Bold')
         .text(dl, 50, curY + 5, { width: 56, align: 'center' })

      // Número ejercicio
      doc.fontSize(11).fillColor(BLACK).font('Helvetica-Bold')
         .text(`Ejercicio ${ej.numero}`, 116, curY + 4)

      curY += 24

      // Enunciado
      const enunciadoH = doc.heightOfString(ej.enunciado, { width: W, fontSize: 11, lineGap: 3 })
      doc.fontSize(11).fillColor(DARK).font('Helvetica')
         .text(ej.enunciado, 50, curY, { width: W, lineGap: 3 })
      curY += enunciadoH + 8

      // "Tu respuesta:"
      doc.fontSize(9).fillColor(MID).font('Helvetica')
         .text('Tu respuesta:', 50, curY)
      curY += 14

      // Líneas de respuesta
      for (let l = 0; l < LINES; l++) {
        doc.rect(50, curY + l * LINE_GAP, W, 0.8).fill('#d1d5db')
      }
      curY += LINES * LINE_GAP + 8

      // Separador
      doc.rect(50, curY, W, 0.5).fill('#e5e7eb')
      curY += 12
    })

    // ── HOJA DE RESPUESTAS ───────────────────────────────────────
    doc.addPage()
    doc.rect(0, 0, 595, PAGE_H).fill('#ffffff')
    doc.rect(0, 0, 595, 6).fill(ACCENT)
    misPageCount++

    doc.fontSize(22).fillColor(BLACK).font('Helvetica-Bold').text('Respuestas', 50, 30, { width: W, lineBreak: false })
    doc.fontSize(11).fillColor(MID).font('Helvetica').text('Revisa tus respuestas solo después de completar todos los ejercicios', 50, 58, { width: W, lineBreak: false })
    doc.rect(50, 78, W, 2).fill(ACCENT)

    let ry = 95
    ejercicios.forEach((ej) => {
      const solOpts = { width: W - 36, lineGap: 3, lineBreak: false }
      const solH = doc.heightOfString(ej.solucion, { width: W - 36, lineGap: 3 })
      const blockH = 18 + 14 + solH + 28

      if (ry + blockH > PAGE_H - 40) {
        doc.addPage()
        doc.rect(0, 0, 595, PAGE_H).fill('#ffffff')
        doc.rect(0, 0, 595, 6).fill(ACCENT)
        ry = 30
        misPageCount++
      }
      const dc = diffColor(ej.dificultad)
      doc.roundedRect(50, ry, 26, 18, 4).fill(dc)
      doc.fontSize(9).fillColor('#ffffff').font('Helvetica-Bold')
         .text(String(ej.numero), 50, ry + 4, { width: 26, align: 'center', lineBreak: false })
      doc.fontSize(10).fillColor(BLACK).font('Helvetica-Bold')
         .text('Ejercicio ' + ej.numero, 86, ry + 4, { lineBreak: false })
      doc.fontSize(10).fillColor(DARK).font('Helvetica')
         .text(ej.solucion, 86, ry + 18, solOpts)
      ry = ry + 18 + solH + 12
      doc.rect(86, ry - 6, W - 36, 1).fill('#e5e7eb')
      ry += 8
    })

    // Footers solo en páginas que creamos nosotros (excluye páginas vacías auto-generadas)
    for (let p = 1; p < misPageCount; p++) {
      doc.switchToPage(p)
      doc.fontSize(8).fillColor(MID).font('Helvetica')
         .text(`${ev.ramo_nombre}  ·  APPrueba`, 50, PAGE_H - 20, { width: W, align: 'center', lineBreak: false })
    }

    doc.end()
  } catch(e) {
    console.error('Error ejercicios PDF:', e)
    if (ejContadoEnLimite) {
      await pool.query('UPDATE usuarios SET ejercicios_usados = GREATEST(ejercicios_usados - 1, 0) WHERE id = $1', [req.user.id]).catch(()=>{})
    }
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
