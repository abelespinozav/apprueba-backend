# APPrueba — Backend

App web para estudiantes universitarios chilenos que les ayuda a organizar ramos, preparar evaluaciones y estudiar con IA. Este repo es **solo el backend**; el frontend vive en otro proyecto y se sirve en `https://apprueba-production.up.railway.app`.

Admin y owner: Abel Espinoza (`abelespinozav@gmail.com`).

## Stack y deploy

- **Runtime**: Node.js >= 20 (ver `.nvmrc` → 20). Sin TypeScript, sin bundler.
- **Framework**: Express 4 monolítico en `index.js` (~2500 líneas). El directorio `routes/` existe pero está **vacío** (archivos stub de 3 líneas sin uso real).
- **DB**: PostgreSQL vía `pg` (`DATABASE_URL`). El esquema se crea en caliente dentro de `initDB()` con `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` — las migraciones se hacen así, no hay herramienta de migraciones.
- **Deploy**: Railway (`railway.json`, builder Nixpacks, `node index.js`). Puerto por defecto `3001`.
- **Scripts**: solo `npm start` / `npm run dev` (ambos corren `node index.js`). No hay tests.
- **CORS**: permite `localhost:5173` (Vite dev), el dominio de Railway y `CLIENT_URL`.

## Variables de entorno clave

`DATABASE_URL`, `JWT_SECRET`, `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, `GEMINI_API_KEY` (declarada pero actualmente no usada en los endpoints vivos — OpenAI es el motor real), `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `CLIENT_URL`, `PORT`.

## Dominio del producto

- **Usuarios**: login con Google OAuth o email+password (bcrypt). JWT de 7 días en header `Authorization: Bearer` o cookie `token`. Hay onboarding (nombre, universidad, carrera).
- **Cupo cerrado**: los primeros 50 usuarios son "fundadores" (`es_fundador`). Si ya hay 50, los nuevos caen a `lista_espera`.
- **Ramos** → **evaluaciones** (con ponderación, nota, fecha) → **archivos** (material de estudio).
- **Material soportado** (función `extraerContenido`): PDF (texto y escaneado vía `pdf2pic` + GPT-4o Vision), DOCX (`mammoth`), XLSX, PPTX (`officeparser`), imágenes (Vision), audio y video (extrae audio con `ffmpeg` y transcribe con Whisper), URLs de YouTube (descarga con `yt-dlp`, trocea en chunks de 15 min si >24 MB, transcribe con Whisper). Límite de upload: 25 MB por archivo (multer).
- **Generación con IA** (todo con `gpt-4o`):
  - **Plan de estudio** (SSE streaming): reparte tareas en los huecos libres del horario semanal del usuario.
  - **Guía de tarea**: explicación profunda + conceptos clave + ejemplos + ejercicios por tarea del plan.
  - **Quiz**: 20 preguntas de alternativas múltiples con shuffle de alternativas post-IA.
  - **Ejercicios PDF**: genera 20 ejercicios con 3 niveles de dificultad y los entrega como PDF diseñado con `pdfkit`.
  - **Podcasts**: guion conversacional entre "Constanza" y "Benjamín", sintetizado con ElevenLabs (voice IDs hardcoded en `index.js`).
- **Horario**: `/horario/extraer-excel` (xlsx nativo o XLS-HTML tipo U-Campus/SIGE) y `/horario/extraer` (imagen/PDF con GPT-4o Vision). Auto-crea ramos faltantes a partir de los bloques.
- **Novedades**: scraping de `ufro.cl` (WP REST API + `cheerio` en `/agenda/` y `dde.ufro.cl/noticias/`) como fallback si no hay novedades en DB.
- **Notificaciones push** (web-push / VAPID) con tres crons en timezone `America/Santiago`:
  - `0 8 * * *` → recordatorio N días antes de cada evaluación (configurable por usuario).
  - `*/15 * * * *` → aviso "clase en 15 minutos" desde el horario.
  - `*/30 7-22 * * *` → aviso de ventana de estudio libre próxima.
  Deduplicación vía tabla `notif_enviadas`.
- **Límites de uso**: cada usuario tiene contadores `podcasts_usados`, `ejercicios_usados`, `quizzes_usados`, `planes_usados`. El tope es un **límite global único** guardado en `configuracion.limite_global` (default 100) — aplica a todos los contadores por igual.
- **Admin**: panel bajo `/admin/*` protegido por `requireAdmin` + chequeo extra de que el email sea `abelespinozav@gmail.com`. Permite ver stats, detalle de usuario, resetear contadores, cambiar límite global, broadcast de notificaciones y borrar usuarios.

## Tablas (creadas en `initDB`)

`usuarios`, `ramos`, `evaluaciones` (con `plan_estudio` jsonb, `tareas_completadas` int[], `guias_tareas` jsonb, `quiz_generado` jsonb, `texto_material`, `plan_generando` flag), `archivos` (bytea), `horario`, `novedades`, `quiz_historial`, `push_subscriptions`, `notificacion_config`, `notif_enviadas`, `podcasts`, `configuracion`. Algunas columnas se agregan con `ALTER TABLE` al arrancar, así que si algo no existe en el esquema base, probablemente se agrega ahí.

## Convenciones del código

- Todo el UI-facing y los prompts de IA están en **español chileno** — cuando editar strings que ve el usuario, mantener ese tono (cercano, con "tutéalo", emojis suaves como 📚🧠✅).
- Los endpoints largos de generación IA usan **SSE** (`text/event-stream`) con un helper `enviar(tipo, datos)` + `terminar(tipo, datos)`. Los clientes pueden cerrar la conexión y la generación sigue en background vía `setImmediate`; al final se manda una push notification.
- Errores tipados por string: `limite_alcanzado`, `sin_material`, `archivo_no_legible`, `error_interno`, `sin_contenido`. El frontend discrimina por estos códigos.
- SQL está inline en los handlers (no hay capa de modelos). Muchos `JOIN` construyen el ramo completo con `json_agg` en una sola query.
- Archivos en la raíz con sufijos `.backup.*`, `.bak`, `.bak2`, `backend.pid`, `backend.log`, `nohup.out`, `debug_pdf*.js`, `pdfExtractor.js` son artefactos del workflow del dueño — `pdfExtractor.js` **sí se usa** (`extraerTextoPDF`), los demás `.backup/.bak` son snapshots manuales.

## Cosas a tener en cuenta al trabajar

- Antes de tocar el esquema, recordar que las ALTER viven dentro de `initDB` en `index.js` — no hay archivo de migraciones.
- `index.js` tiene endpoints dentro y fuera del callback de `initDB().then(...)` (mezcla a propósito). Al agregar un endpoint nuevo, imitar el estilo del bloque vecino.
- No duplicar: revisar si ya existe un helper antes de crear uno (ej. `extraerContenido`, `notificarUsuario`, `authenticateToken`, `requireAdmin`).
- La generación IA siempre pasa por OpenAI `gpt-4o` + Whisper; Gemini está importado pero inactivo — no asumir que está en uso.
- `GOOGLE_CALLBACK_URL` por defecto apunta a `localhost:3001/auth/google/callback`; en prod debe estar seteada al dominio de Railway.
- Las voice IDs de ElevenLabs (`imFXYz8XIletRKLZZQaA` para Constanza, `XgQWNZcJ8SRkxXwwhPTo` para Benjamín) están hardcoded.
