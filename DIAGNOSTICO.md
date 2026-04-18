# Reporte consolidado — APPrueba

Auditoría diagnóstica completa del backend (`~/apprueba-backend/index.js`) y frontend (`~/apprueba/src/`). Cubre seguridad, funcionalidad, consistencia, DB/auth y code hygiene.

## ✅ Lo que funciona bien y no tocar

- **Google OAuth + JWT**: el flujo de Passport, creación/actualización de usuario, marcado de fundador (primeros 50), y middleware `authenticateToken` están correctos.
- **`extraerContenido`** (`index.js:54-311`): la cadena de fallbacks para PDF (texto → Vision), DOCX, XLSX, PPTX, imagen, audio, video y YouTube (yt-dlp → metadata) es robusta en el camino feliz y cubre todos los formatos prometidos.
- **Función `calcular()`** (`App.jsx:801-854`): lógica chilena completa — eximición con `sin_rojos`, con_examen, reprobado_sin_examen, reprobado_imposible, y el caso de nota de examen ya rendida. Maneja bien el caso base.
- **Podcast + ElevenLabs + mini player**: guion conversacional Constanza/Benjamín, chunks de audio concatenados, player flotante con seek, persistencia de podcast por `tarea_idx`.
- **Panel admin**: stats, modal de detalle, reset de contadores granular, límite global configurable.
- **Onboarding 5 pasos + theming por universidad**: framer-motion + CSS vars + `useTheme`, bien estructurado.
- **Crons**: recordatorios de evaluaciones (9 AM Chile), avisos 15 min antes de clase, ventanas de estudio, limpieza de `notif_enviadas`. Timezone correcto.
- **PWA**: manifest, service worker para push, banner de instalación iOS/Android.
- **SSE básico en cliente**: tanto Quiz.jsx como PlanEstudio.jsx parsean correctamente el stream (buffer + split `\n`, ignora líneas parciales).

## ❌ Lo que está roto, incompleto o inconsistente

### 🔴 P0 — Seguridad (crítico, exponen datos de otros usuarios)

| # | Bug | Ubicación |
|---|-----|-----------|
| 1 | **IDOR**: cualquier usuario autenticado puede cambiar notas de otros. No hay JOIN con `ramos` para verificar ownership | `index.js:600` (PUT `/evaluaciones/:id/nota`) |
| 2 | **IDOR**: mismo bug, otra ruta | `index.js:2082` (PATCH `/ramos/:ramoId/evaluaciones/:evalId`) |
| 3 | **IDOR**: editar progreso de plan de otros | `index.js:1931` (PUT `/evaluaciones/:id/plan-progreso`) |
| 4 | **IDOR**: subir archivos a evaluaciones ajenas | `index.js:629` (POST `/evaluaciones/:id/archivos`) |
| 5 | **IDOR**: borrar archivos ajenos | `index.js:644` (DELETE `/archivos/:id`) |
| 6 | **JWT en URL** después de OAuth → queda en history, referrer y logs | `index.js:501` |
| 7 | **Bypass de cupo de 50 fundadores**: `/auth/register` email+password no verifica límite | `index.js:452-466` |

### 🟠 P1 — Features completamente rotas (silenciosamente)

| # | Bug | Ubicación |
|---|-----|-----------|
| 9 | Regex `/\\s+/g` busca literal `\s` → no normaliza espacios en scraping DDE → títulos salen con saltos de línea | `index.js:1028` |
| 10 | Regex `background-colors*:s*([#w]+)` → "s" literal y `[#w]` = `#` o "w" literal (no `\w`) → detección de tipo "topon"/"ayudantía" por color nunca funciona | `index.js:1233` |
| 11 | **Tablas ausentes de `initDB()`** pero usadas: `push_subscriptions`, `notificacion_config`, `notif_enviadas`, `podcasts`, `configuracion`, `horario`, `novedades`. En Railway ya existen, pero cualquier redeploy fresco revienta | `index.js:342-404` |
| 12 | **Columnas ausentes**: `evaluaciones.texto_material`, `evaluaciones.plan_generando` se leen/escriben pero nunca se declaran | `index.js:653, 840, 870` |
| 13 | ALTERs sobre tablas antes de su CREATE (quiz_historial línea 368 antes del CREATE de 369; evaluaciones.quiz_generado línea 367 antes del CREATE de 385). Fresh DB fallaría | `index.js:367-385` |
| 14 | SSE con `setImmediate` sin `res.on('close')` → si el cliente cierra mid-stream, `enviar()` sigue escribiendo a socket cerrado | `index.js:827, 2163` |

### 🟡 P2 — Inconsistencias y UX rota

| # | Bug | Ubicación |
|---|-----|-----------|
| 15 | **Quiz.jsx usa `>= 5` hardcoded** para límite de quizzes (no respeta `limiteGlobal` del admin) | `Quiz.jsx:59, 97, 208-225` |
| 16 | `setPlanesUsados(3)` + alert "límite de 3 regeneraciones" hardcoded | `PlanEstudio.jsx:112-113` |
| 17 | `ejerciciosUsados >= 5` hardcoded dentro del botón (el resto del mismo archivo usa `limiteGlobal`) | `PlanEstudio.jsx:527-528` |
| 18 | `eliminarArchivo` borra plan entero + tareas completadas (destruye progreso del usuario al remover un solo archivo) | `PlanEstudio.jsx:48-56` |
| 19 | `regenerarPlan` solo limpia estado local; el backend aún tiene el plan viejo hasta que regenere | `PlanEstudio.jsx:62-65` |
| 20 | Rutas duplicadas POST y PUT `/evaluaciones/:id/plan-progreso` con cuerpos distintos (`completadas` vs `tareas_completadas`) | `index.js:912 + 1931` |
| 21 | Gemini SDK importado pero nunca usado (todo es OpenAI) | `index.js:322` |
| 22 | `/tmp` no tiene cleanup garantizado (chunks YouTube, PDF→imagen, video→audio) → acumulación hasta reinicio | múltiples |
| 23 | Temp files de YouTube fallan silenciosamente: si un chunk de Whisper da texto vacío, el loop no se entera → transcripción trunca sin aviso | `index.js:116-128` |
| 24 | `calcular()` con `pesoTotal != 100` + pendientes retorna `necesaria: null` → usuario no sabe cuánto necesita (solo muestra "faltan evaluaciones") | `App.jsx:850` |
| 25 | Navegación state-based sin router: refresh en `plan_rapido` / `ramo` / etc. pierde contexto y devuelve a `ramos` | `App.jsx:2196-2468` |
| 26 | `LoginScreen` usa `useState(() => fetch(...))` en vez de `useEffect` — el fetch corre en el init de useState, antipattern | `App.jsx:867-869` |
| 27 | Novedades de fallback hardcoded con fechas específicas de abril 2026 (quedan stale instantáneo para otras fechas) | `App.jsx:265-294` |
| 28 | Condicional `universidad === 'uautonoma' \|\| 'inacap' \|\| 'santotomas' \|\| 'uctemuco'` repetido ~12 veces para decidir color de texto | `App.jsx` múltiples |
| 29 | `horario` tiene `UNIQUE (usuario_id, dia, periodo)` pero el INSERT nunca popula `periodo` → queda NULL, ON CONFLICT jamás dispara, se acumulan duplicados al reimportar el mismo horario | `index.js:1086` |
| 8 | *(reclasificado desde P1)* Regex sin escapar `(d{1,2}:d{2})` en la rama `.xlsx` nativa. Busca letra "d" literal, no `\d` → la extracción desde `.xlsx` nunca matchea horas | `index.js:1181, 1188` |

**Nota sobre bug 8**: hay tres caminos de extracción de horario y solo uno está roto:

1. `.xlsx` nativo (`index.js:1149-1205`, rama `if (isXlsx)`) — **este es el roto**.
2. XLS-HTML fallback (`index.js:1207+`) — funciona, parsea HTML y splitea por `<br>`; no usa esa regex.
3. Imagen/PDF con GPT-4o Vision (`/horario/extraer`) — funciona, delega a la IA.

El tip de onboarding manda a la Intranet UFRO, que exporta `.xls` con HTML adentro → siempre cae al camino 2. El bug solo se dispara si alguien sube un `.xlsx` real (Excel moderno, Google Sheets, Numbers). Es una ruta cosméticamente presente pero efectivamente muerta. El fix vale la pena pero deja de ser "P1 feature rota silenciosamente" y pasa a ser P2.

### ⚪ P3 — Limpieza (no urgente pero ordenar)

- **Legacy backend completo** en `~/apprueba/backend/`: `index.js` viejo (178 líneas, solo auth+ramos), `routes/*.js` stubs, sus `migrations/` y `.env`. No se usa en producción. **Borrar carpeta entera**.
- **Backups y logs**: `App.jsx.backup`, `.bak`, `.bak2` en `~/apprueba/src/`; `index.js.backup.*`, `.bak`, `.bak2`, `.env.backup.*` en `~/apprueba-backend/`; `backend.pid`, `backend.log`, `nohup.out`, `debug_pdf.js`, `debug_pdf2.js`.
- **Tailwind instalado pero no usado** en JSX real — o se adopta o se saca del bundle.

---

## Orden de ataque sugerido

1. **P0** (seguridad) — los 5 IDORs y el JWT-en-URL se arreglan rápido con JOINs y cookies httpOnly.
2. **Bugs 8-10** (regex) — son literalmente features rotas pero los fixes son trivial (agregar `\`).
3. **Bugs 11-13** (schema) — sincronizar `initDB()` con la DB real antes de que alguien migre.
4. Después lo demás.
