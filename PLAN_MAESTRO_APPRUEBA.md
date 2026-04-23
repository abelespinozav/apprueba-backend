# PLAN MAESTRO — APPRUEBA

**Versión:** 1.1 (actualizada 23 abril 2026, fin del día 1)
**Founder:** Abel Espinoza
**Director del proyecto (sparring/advisor):** Claude Opus
**Apoyo táctico:** Claude Sonnet + Claude Code
**Fecha de inicio:** 23 de abril de 2026 (jueves)
**Fecha del punto de decisión final:** 22 de julio de 2026 (90 días)
**Runway personal declarado:** 250.000 CLP/mes
**Dedicación:** Full-time, solo

---

## 0. PROPÓSITO DE ESTE DOCUMENTO

Este es **el único documento de dirección** del proyecto APPrueba durante los próximos 90 días. No se duplica, no se fragmenta, no se reemplaza. Si algo importante cambia, se actualiza **acá**.

**Reglas de uso:**

1. Abel lee este documento cada mañana antes de tocar código.
2. Al final de cada día, Abel marca las tareas completadas con `[x]` y agrega una nota corta.
3. Cada domingo a las 20:00 (hora Chile), Abel hace un reporte semanal a Claude Opus basado en este documento.
4. Nada se ejecuta fuera de este plan sin discusión previa. Si aparece una urgencia, se evalúa contra el plan.
5. Este documento es **honesto**. Si una tarea no se hizo, se escribe "no hecho" + razón real. Sin mentiras, sin suavizar.

**Ubicación oficial del archivo:** `~/apprueba-backend/PLAN_MAESTRO_APPRUEBA.md` (versionado en git).

---

## 1. CONTEXTO OPERATIVO

### 1.1 Estado al cierre del día 1 (23 abril 2026, 19:00 CLT)

**Producto:**
- Web app (React + Vite) + backend Express monolítico + Postgres (Railway)
- 9 tipos de archivo procesados (PDF, DOCX, DOC, XLSX, PPTX, imagen, audio, video, YouTube)
- 7 features de generación con IA (plan, quiz, guía, ejercicios, podcast, horario, menú casino)
- Sistema completo de créditos/gamificación/suscripciones desarrollado en local

**Usuarios:**
- 36 registrados en producción
- 27 de UFRO (75%), resto distribuido entre UCT, UMayor, INACAP, UAutónoma, Santo Tomás
- 36 fundadores de 50 cupos (cupo cerrado)
- **DAU real pendiente de confirmar** con analytics

**Operación:**
- Código en dos repos separados: `~/apprueba-backend` y `~/apprueba`
- **DB staging operativa desde 23/04** (Railway, proyecto `adventurous-smile`, host `shortline.proxy.rlwy.net`)
- Backend local apunta a staging (ya no a producción)
- Cero tests automatizados, cero monitoring, cero analytics de comportamiento (a instalar en semana 1)

**Runway:**
- Aportes personales: 250.000 CLP/mes
- Ingresos: $0 CLP. Usuarios pagando: 0.
- Runway personal estimado sin ingresos: 3-4 meses

### 1.2 Hipótesis de producto actual

APPrueba es **una app de productividad académica con IA para universitarios chilenos**. Integra:

- Gestión de ramos y evaluaciones
- Cálculo de notas necesarias
- Horario con notificaciones contextuales
- Generación de material de estudio (quiz, plan, guía, ejercicios, podcast) desde cualquier archivo del estudiante
- Gamificación (XP, nivel, racha, logros)

**Supuesto no validado:** los universitarios chilenos pagan $2.990-$4.990 CLP/mes por esto.

---

## 2. TESIS ESTRATÉGICA Y CRITERIO DE DECISIÓN A 90 DÍAS

### 2.1 Tesis

APPrueba tiene chance real de convertirse en herramienta recurrente para universitarios chilenos si (a) cierra el loop de usuario pagando rápido, (b) acumula data real de comportamiento, (c) simplifica scope al core que más importa.

### 2.2 Criterio de éxito al 22 de julio de 2026

**APPrueba sigue adelante si al día 90 se cumple AL MENOS UNO de estos dos objetivos:**

- **Opción A (tracción de usuarios):** 150+ usuarios activos semanales (WAU)
- **Opción B (tracción de revenue):** 15+ usuarios con suscripción activa pagada

**APPrueba pivotea o se mata si al día 90 no se cumple ninguno.**

### 2.3 Métricas de seguimiento semanal

1. Usuarios activos semanales (WAU)
2. Retención D7
3. Generaciones de IA totales
4. Créditos consumidos totales
5. Usuarios pagando + MRR (a partir de semana 3)
6. Costos de IA del mes en curso (USD)
7. Bugs críticos reportados por usuarios
8. Sesiones de feedback con usuarios realizadas

---

## 3. LOS 5 PRINCIPIOS QUE RIGEN ESTE PLAN

1. **Deploy > perfección.** Mejor imperfecto en producción que perfecto en local.
2. **Datos > opiniones.** Toda decisión de producto después del día 15 se toma con datos.
3. **Matar antes de construir.** Cada feature nueva requiere matar o congelar una feature existente.
4. **Una cosa a la vez.** No más de 3 tareas activas en paralelo.
5. **Transparencia total con el director.** Si algo no se hace, se dice.

---

## 4. FASES DEL PLAN (90 DÍAS)

### FASE 1 — ESTABILIZACIÓN (Semanas 1-2) | 23 abr → 7 may

**Objetivo:** Apagar incendios operacionales y quedar en condiciones de crecer.

**Metas medibles al fin de fase:**
- [x] DB staging creada y local apuntando a ella (23/04)
- [x] Bug A arreglado (mammoth .doc) (23/04)
- [x] Bug B arreglado (texto_material sticky) (23/04)
- [x] Confabulación de IA con material basura corregida (23/04)
- [ ] `main` deployado a producción sin cherry-picks (planeado 24/04)
- [ ] Sentry + PostHog instalados y reportando
- [ ] 10 eventos clave instrumentados
- [ ] 0 secrets expuestos, dependencias muertas eliminadas

### FASE 2 — VALIDACIÓN DE ECONOMICS Y FEEDBACK (Semanas 3-4)
### FASE 3 — REDUCCIÓN DE DEUDA TÉCNICA (Semanas 5-6)
### FASE 4 — CRECIMIENTO FOCALIZADO (Semanas 7-10)
### FASE 5 — DECISIÓN (Semanas 11-12)

---

## 5. PLAN DETALLADO — SEMANA 1

### DÍA 1 — Jueves 23 abr — CERRADO

**Resultado:** Día muy productivo. Se cumplieron T1 (preparación) + T2 (fix bugs críticos). Descubrimiento importante: filosofía del prompt de IA permitía confabulación — se corrigió.

**Completadas:**
- [x] T1.1 — DB staging en Railway creada
- [x] T1.2 — `.env` local apuntando a staging
- [x] T1.3 — DATABASE_URL reemplazado (con rotación post-leak de password en chat — lección aprendida)
- [x] T1.4 — Primer arranque contra staging, 19 tablas creadas OK
- [x] T1.5 — Validación E2E: detectó bugs A y B
- [x] T2.1 — Fix Bug A (detección por magic bytes)
- [x] T2.2 — Fix Bug B (textoArchivosValido + reset en upload)
- [x] T2.3 — Fix efecto colateral (regex + cambio de filosofía del prompt en 5 endpoints)
- [x] T2.4 — Validación post-fix en staging: quiz genera OK
- [x] T2.5 — Commit local (sin push aún — deploy mañana)

### DÍA 2 — Viernes 24 abr — QA FINAL + DEPLOY

**Objetivo único:** Deployar los fixes de hoy a producción con cuidado.

- [ ] T3.1 — QA final en staging: 3 escenarios (PDF bueno, .doc rechazado, PDF + .doc combinado)
- [ ] T3.2 — Push a origin/main
- [ ] T3.3 — Deploy backend a Railway producción (09:00 CLT, horario de poco tráfico)
- [ ] T3.4 — Smoke test en producción inmediatamente post-deploy
- [ ] T3.5 — Monitoreo activo 4 horas post-deploy
- [ ] T3.6 — Comunicado a usuarios por push notification

### DÍA 3 — Sábado 25 abr

- [ ] T4.1 — Instalar Sentry (backend + frontend)
- [ ] T4.2 — Test: provocar error controlado y verificar captura
- [ ] T4.3 — Crear cuenta PostHog e instalar SDK

### DÍA 4 — Domingo 26 abr

- [ ] T5.1 — Implementar los 10 eventos clave de PostHog
- [ ] T5.2 — Test manual del flujo completo y verificación en dashboard
- [ ] T5.3 — Reporte semanal a Opus (primera review)

### DÍAS 5-7 — Lunes 27 a Miércoles 29 abr

**Se planifican el domingo 26 tras reporte semanal.** Dependen de:
- Qué bugs post-deploy aparecen
- Qué insights dan los primeros eventos de PostHog
- Feedback orgánico de los 36 usuarios tras ver las nuevas features

---

## 6. MÉTRICAS SEMANALES

| Semana | Fecha | WAU | DAU | Retention D7 | Generaciones IA | Créditos consumidos | Pagando | MRR (CLP) | Costo IA (USD) | Bugs críticos |
|--------|-------|-----|-----|--------------|-----------------|---------------------|---------|-----------|----------------|---------------|
| Base | 23 abr | ? | ~12 | - | - | - | 0 | 0 | - | 3 (quiz, A, B) |
| 1 | 30 abr | | | | | | 0 | 0 | | |
| 2 | 7 may | | | | | | | | | |
| 3 | 14 may | | | | | | | | | |
| 4 | 21 may | | | | | | | | | |
| 5 | 28 may | | | | | | | | | |
| 6 | 4 jun | | | | | | | | | |
| 7 | 11 jun | | | | | | | | | |
| 8 | 18 jun | | | | | | | | | |
| 9 | 25 jun | | | | | | | | | |
| 10 | 2 jul | | | | | | | | | |
| 11 | 9 jul | | | | | | | | | |
| 12 | 16 jul | | | | | | | | | |
| **FINAL** | **22 jul** | | | | | | | | | |

**Criterio de éxito al 22 jul:** ≥150 WAU **O** ≥15 usuarios pagando.

---

## 7. INSIGHTS DE PRODUCTO

### 2026-04-23

- **Insight crítico:** El prompt de IA del plan de estudio tenía instrucción "NUNCA rechaces el material. Usa lo que hay". Esto causaba confabulación cuando el material era ilegible (app generaba contenido ficticio sobre el ramo basado solo en el nombre). Corregido: ahora la IA devuelve error explícito si material <200 chars.
- **Insight de ejecución:** El flujo de dirección Opus → Sonnet → Code funcionó bien pero requiere disciplina de Abel para no saltar pasos. Regla confirmada: nunca pegar credentials en chat con Opus.
- **Insight de producto:** El copy del frontend tiene sesgo rioplatense ("tenés", "subí") — no es chileno. A corregir en semana 2.
- **Insight de onboarding:** Campo "carrera" del onboarding es saltable sin querer. Usuario quedó con carrera vacía. A corregir en semana 2.
- **Insight de auth:** Frontend solo ofrece Google OAuth visible. Endpoints email/password existen en backend. Decisión: mantener solo Google para MVP.

---

## 8. LOG DE BUGS

| Fecha | Bug | Severidad | Estado | Fix |
|-------|-----|-----------|--------|-----|
| 2026-04-22 | Quiz genera opciones "C. A", "D. facil", "undefined" | CRÍTICO | Postponed (Escenario A confirmado tras fixes A+B) | Validación Zod si reaparece |
| 2026-04-22 | Nombre archivo "PrecÃ¡lculo" (UTF-8) | MEDIO | Pendiente semana 2 | Normalizar al guardar |
| 2026-04-22 | Plan IA genera 12 tareas irreales para ramo pequeño | MEDIO | Pendiente semana 2 | Ajustar prompt: pedir proporción al volumen |
| 2026-04-22 | "FUTBOL" detectado como clase académica | BAJO | Pendiente | Filtro por palabras no-académicas |
| 2026-04-23 | Bug A: mammoth no soporta .doc binario (OLE Word 97-2003) | CRÍTICO | Arreglado local (pending deploy) | Magic bytes + mensaje claro |
| 2026-04-23 | Bug B: texto_material sticky, no se re-procesa tras fallo | CRÍTICO | Arreglado local (pending deploy) | textoArchivosValido() + reset en upload |
| 2026-04-23 | IA confabula plan de estudio con material ilegible | CRÍTICO (integridad pedagógica) | Arreglado local (pending deploy) | Cambio filosofía prompt + backend maneja error |
| 2026-04-23 | Copy con acento rioplatense ("tenés", "subí") | MEDIO | Pendiente semana 2 | Revisar strings y neutralizar a chileno |
| 2026-04-23 | Campo "carrera" queda vacío en onboarding sin validación | MEDIO | Pendiente semana 2 | Forzar validación en UI + backend |
| 2026-04-23 | KHIPU_API_KEY no match con nombres en .env (tiene KHIPU_SECRET, KHIPU_RECEIVER_ID) | MEDIO | Pendiente antes de abrir pagos | Unificar naming según docs Khipu v3 |
| 2026-04-23 | Toast de logros aparece truncado, sin confeti | BAJO | Pendiente | Revisar CSS/animaciones del toast |
| 2026-04-23 | "Quiz semanal disponible" no responde al click | MEDIO | Pendiente semana 2 | Revisar handler del botón |

---

## 9. LOG DE DEPLOYS

| Fecha | Versión | Cambios principales | Responsable | Rollback | Notas |
|-------|---------|---------------------|-------------|----------|-------|
| 2026-04-22 | prod actual | Tip: `b0f1ec6` en `deploy/fix-latex` | Abel | N | Estado pre-plan |
| 2026-04-23 | staging v1.0 | initDB 19 tablas aplicadas a `adventurous-smile` | Abel | N | DB limpia. Password rotado tras exposición accidental en chat. |
| 2026-04-23 | staging v1.1 | Fix Bug A + Bug B + filosofía prompt IA | Abel | N | Testeado E2E. Commit local, sin push. |
| 2026-04-24 (planeado) | prod v1.1 | Deploy de fix bugs críticos | Abel | (si falla) volver a `b0f1ec6` | 09:00 CLT, monitoreo 4h. |

---

## 10. DECISIONES TOMADAS

| Fecha | Decisión | Razonamiento | Quien propuso |
|-------|----------|--------------|---------------|
| 2026-04-23 | Criterio de éxito: 150 WAU o 15 pagando al día 90 | Necesitamos números objetivos para decidir. Ambos alcanzables desde 36. | Opus |
| 2026-04-23 | Deploy `main` completo en semana 1, no cherry-picks | Cherry-pick frágil, bloquea valor. Riesgo de deployar 6 fases < costo de no deployar. | Opus |
| 2026-04-23 | Telegram bot del casino NO se mata | Abel clarificó que alimenta "Vive UFRO". Se mantiene como deuda, se reemplazará por panel admin. | Abel |
| 2026-04-23 | Staging arranca sin datos de producción | Código debe funcionar desde DB vacía. Copiar prod introduce riesgo de leak. | Opus |
| 2026-04-23 | Password de staging rotado por exposición en chat | Regla: nunca pegar credentials en chat con Opus. Solo en Code. | Abel+Opus |
| 2026-04-23 | Fix Bug A con Plan B (mensaje claro al usuario) | Plan A requería libreoffice (no disponible). word-extractor rechazado (abandonado + encoding español roto). Mensaje claro > confabulación. | Opus |
| 2026-04-23 | Zod validation del quiz postergada | Escenario A: quiz se generó OK tras fix A+B, sin bugs de undefined. No urgente. | Opus |
| 2026-04-23 | Cambio de filosofía del prompt: "es preferible rechazar que confabular" | Confabulación daña al estudiante (aprende cosas erróneas) y es riesgo reputacional. Integridad pedagógica > cobertura. | Abel detectó, Opus decidió |
| 2026-04-23 | Deploy programado para 24 abril 09:00 CLT | Deploy en pico de actividad (14:00 jueves) es mal timing. Mañana tempranito con QA fresco. | Opus |
| 2026-04-23 | Mantener solo Google OAuth en UI (email/password en backend pero oculto) | Universitarios chilenos tienen Gmail. Menos fricción, sin manejo de passwords. Revisar semana 4. | Opus |
| 2026-04-23 | `.reports/` versionado en git (bitácora histórica) | Valor histórico del proyecto. `.logs/` sí va al .gitignore. | Opus |

---

## 11. COMPROMISOS RECÍPROCOS

### Abel se compromete a:

1. Leer este plan cada mañana antes de escribir código
2. Ejecutar con honestidad total — si algo no se hace, se dice
3. Reportar semanalmente a Opus los domingos 20:00 CHT
4. No introducir features nuevas fuera del plan sin discutirlo primero
5. Deployar `main` antes del martes 28 de abril (ahora viernes 24)
6. Buscar activamente en semanas 4-6 al menos un contacto de cofounder potencial o mentor semanal

### Claude Opus se compromete a:

1. Evaluar cada reporte semanal con objetividad, sin suavizar
2. Ajustar el plan cuando la realidad cambie (no aferrarse al papel)
3. Dar prioridades claras cuando haya ambigüedad
4. Avisar si detecta que Abel está desviándose del criterio de éxito
5. Al día 90, dar un veredicto claro: seguir, pivotear o matar

### Flujo operativo Opus → Sonnet → Code

- **Opus** dirige estrategia y diseña baterías de tareas
- **Sonnet** supervisa ejecución de baterías y consolida reportes
- **Code** ejecuta comandos técnicos en el ambiente local
- **Abel** hace clicks de usuario (testing browser) y decide producto
- **Credentials:** solo en Code, nunca en Opus ni Sonnet

---

## 12. POSTERGABLE / CONGELADO

**Cosas que Abel quiere hacer pero NO están en el plan de 90 días:**

- [ ] Rediseño UX/UI completo con Claude Design (post-90 días, solo si proyecto sigue vivo)
- [ ] Procesador de archivos "nuevo" (innecesario, ya existe)
- [ ] SEO + SSR de la landing page (Fase 4, semanas 7-10)
- [ ] Expansión a más universidades (post-validación UFRO)
- [ ] App nativa iOS/Android (post-90 días)
- [ ] Modo offline
- [ ] Chat con tutor IA en tiempo real
- [ ] Compartir quizzes entre compañeros
- [ ] Competencia/ranking entre amigos
- [ ] Scraping de más universidades chilenas
- [ ] Migración de archivos de Postgres BYTEA a S3/R2
- [ ] Librería `word-extractor` para soporte .doc real (abandonada 4 años, rechazada)
- [ ] LibreOffice en nixpacks (complejidad innecesaria)

---

## 13. NOTAS AL CIERRE DEL DÍA 1

**Lo bueno:**
- Día productivo con cumplimiento alto (T1 + T2 completas)
- Abel mostró juicio ético (detectar confabulación como problema, no celebrarla)
- Flujo Opus-Sonnet-Code funcionó bien
- Staging operativa = riesgo operacional eliminado

**Lo aprendido:**
- Nunca pegar credentials en chat (regla escrita, no volverá a pasar)
- Code a veces propone librerías que hay que validar (word-extractor rechazado correctamente)
- Cambios "simples" pueden tener efectos colaterales (regex de detección de error). Cada cambio requiere re-test E2E.

**Lo pendiente para mañana:**
- QA final en staging
- Push a origin/main
- Deploy a producción 09:00 CLT
- Smoke test + monitoreo 4h
- Sentry + PostHog setup si sobra tiempo

**Humor de Abel al cierre:** Muy entusiasmado, con energía para seguir, pero acepta la regla de descanso. Tiene claro que el fix de confabulación fue importante.

---

**Fin del documento. Versión 1.1 — 23 de abril de 2026, 19:00 CLT.**
