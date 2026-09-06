# ESTADO

Lista viva del trabajo. **Se actualiza tras cada merge, en el mismo commit o justo después.**
Junto con `PLAN.md`, es la autoridad: una sesión nueva retoma el trabajo leyendo estos dos.

Estados: `abierto` (sin empezar) · `en curso` (rama viva) · `acordado` (implementado y revisado,
sin fusionar) · `hecho` (fusionado a `develop`, con hash).

## Tareas

| # | Tarea | Rama | Estado | Commit de merge |
|---|-------|------|--------|-----------------|
| F0 | Preparación: instalar dependencias, línea base verde, crear `.agent/` | — | **hecho** | — (línea base: 346 tests frontend) |
| T1 | Lógica pura de códigos de vinculación | `feat/link-core` | **hecho** | `7d39a5a` (31 tests) |
| T2 | Endpoints de vinculación | `feat/link-api` | **hecho** | `605b7f4` (44 tests) |
| T3 | Listar y revocar dispositivos | `feat/devices-api` | **hecho** | `a4c815a` (55 tests) |
| T4 | Interfaz de vinculación | `feat/link-ui` | **hecho** | `bd3fce1` (354 tests) |
| T5 | Gestión de dispositivos en Ajustes | `feat/devices-ui` | **hecho** | `f60ca56` (361 tests) |
| T6 | Configuración y documentación de despliegue | `chore/deploy-home` | **hecho** | `d881bc1` (con salvedad ↓) |
| FX | Arreglo: `link.js` no viajaba en la imagen del `api` | `fix/api-image-missing-link-module` | **hecho** | `a9aa113` |
| FA | Aceptación manual (autenticador virtual) | — | **listo para empezar** (stack en pie) | — |
| FB | Cierre: `develop` → `main` | — | abierto | — |

## Orden de ejecución

```
Ola 1:  T1  →  T6        (SECUENCIAL, ver nota)
Ola 2:  T2               (necesita T1)
Ola 3:  T3  →  T4        (SECUENCIAL, ver nota)
Ola 4:  T5               (necesita T3 y T4; toca Settings.jsx después de T4)
Ola 5:  Fase A → Fase B
```

> **Nota (2026-09-04):** el paralelismo previsto no es aplicable. Dos agentes no pueden trabajar
> en dos ramas distintas del mismo árbol de trabajo, aunque toquen ficheros disjuntos: la rama es
> estado compartido. Haría falta un worktree por agente, lo que complica el merge de vuelta sin
> ahorrar créditos (solo reloj). Todo va secuencial.

## Ciclo 2 — descanso por ejercicio (código completo)

| # | Tarea | Rama | Estado | Commit de merge |
|---|-------|------|--------|-----------------|
| T7 | Arreglo: el cronómetro no volvía tras desmarcar/remarcar | `fix/rest-timer-recheck` | **hecho** | `569511f` (370 tests) |
| T8 | Descanso por ejercicio: modelo y fontanería | `feat/per-exercise-rest` | **hecho** | `e2127c1` (390 tests) |
| T9 | Interfaz y durabilidad del campo | `feat/per-exercise-rest-ui` | **hecho** | `405aee1` (424 tests) |
| FV | Revisión visual del dueño en pantalla | — | **pendiente** | — |

Decisiones del ciclo 2 (no reabrir):
- Los ±15" del cronómetro son solo para ese descanso; no tocan la rutina.
- En superserie manda el descanso **del ejercicio con el que cierras la ronda**, que es el que
  acabas de marcar. Keyear por "último índice del array" da mal en superseries **desiguales**.
- `rest: 0` es "sin descanso" y **no** arranca cronómetro (`startRest(0)` deja la cuenta atrás
  clavada en 0:00 para siempre: su propio tick sale antes de la rama que la terminaría).
- Ausente, `null`, `''`, booleano, no finito y negativo son **"no definido"** → global. Tope 1800 s.
  `Number(null)` y `Number('')` valen 0 en JavaScript: sin guarda explícita, "sin definir" se
  convierte en "sin descanso".
- Las 5 cadenas nuevas están **solo en español**. Los otros 10 idiomas caen al inglés, coherente
  con lo ya anotado en trabajo futuro.

## Subir los entrenamientos a Strava — SÍ es posible (ciclo 3, por planificar)

> **Corrección.** El 2026-09-05 escribí aquí que la API de Strava no tenía modelo de datos de
> fuerza y que solo cabía una actividad manual con la duración y un texto. **Era falso.** Lo
> desmintieron unas capturas del dueño de entrenos subidos desde Hevy, con sección "Ejercicios"
> estructurada y métricas propias de volumen, series y repeticiones. Verificado después contra la
> documentación: Strava añadió soporte de fuerza el **21 de mayo de 2026**, después de mi corte de
> conocimiento. No des por buena una limitación de una API de terceros sin comprobarla.

**Cómo se hace (verificado en developers.strava.com):**
- `POST /uploads` con `data_type=json`. **No** `POST /activities`, que sigue siendo la vía pobre
  (solo nombre, tipo, duración, distancia y descripción).
- Ámbito OAuth: `activity:write`.
- Cuerpo: `{ version, start_time, utc_offset, elapsed_time, sets: [...] }`, y cada serie es
  `{ exercise_type, repetitions, weight, duration, start_time }`. El peso va en kilos.
- Tipos válidos: `WeightTraining`, `HighIntensityIntervalTraining`, `Workout`, `Crossfit`.

### Estado del ciclo 3

| # | Tarea | Rama | Estado | Commit de merge |
|---|-------|------|--------|-----------------|
| T10 | Mapeo de ejercicios a Strava | `feat/strava-exercise-map` | **hecho** | `85f7290` (466 tests) |
| T11 | OAuth y guardado del token | `feat/strava-oauth` | **hecho** | `c766217` (132 tests api) |
| T12 | Construir el JSON y subirlo | `feat/strava-upload` | abierto | — |
| T13 | Interfaz y subida automática | `feat/strava-ui` | abierto | — |

**Resultado de T10:** 671 de 1.324 (51%) resuelven a un identificador específico; el resto al
genérico de su categoría. Costó **5 rondas y 4 revisiones**. El vocabulario se verificó
identificador a identificador contra la web de Strava: los 656 existen, ninguno inventado.

Lecciones que valen para cualquier retoque futuro del mapeo:
- **Un genérico correcto vale más que un específico dudoso.** Un identificador equivocado registra
  en Strava un ejercicio que no hiciste, en silencio y para siempre.
- **El objetivo no es ser estricto, es no equivocarse.** La primera versión exigía coincidencia
  exacta de palabras y solo mapeaba el 7%. Un específico es seguro cuando nada en él contradice al
  ejercicio; es peligroso solo cuando **afirma** algo que el ejercicio no tiene.
- **El nombre dice qué movimiento es; `tg` solo dice qué músculo se enfatiza.** Cuando se
  contradicen al elegir el genérico, gana el nombre — si no, "biceps pull-up" acaba en curl.
- **Cada ensanchado del modelo rompió algo contiguo.** Medir el radio de impacto (reconstruir el
  resolver anterior y diffear los 1.324) es parte del trabajo, no un extra.
- **Los tests de propiedad valen más que los de ejemplo.** "Todos los estiramientos resuelven a la
  misma familia" cazó un fallo que 30 aserciones concretas no vieron.
- `STRAVA_OVERRIDES` es la válvula de escape: si aparece un mapeo malo usándolo de verdad, se
  pincha ese caso en una línea en vez de retocar las reglas.

**Resultado de T11:** las cuatro rutas de OAuth, con el token por perfil en `./data`. Variables
`STRAVA_CLIENT_ID` y `STRAVA_CLIENT_SECRET`; sin ambas, las rutas dan 404 de verdad.
Dos ganchos solo para pruebas, documentados como tales: `STRAVA_API_BASE` y `STRAVA_TIMEOUT_MS`.

Decisiones de T11 que conviene no deshacer:
- **Todas las llamadas salientes llevan timeout (8 s).** Node no pone ninguno por defecto. Que
  Strava falle es fácil de manejar; que **se cuelgue** congelaría la pantalla de Ajustes para
  siempre, porque `/status` refresca el token antes de responder.
- **`/status` refresca y, si el refresco falla, se repliega al token guardado.** Un Strava lento
  nunca debe hacer que un perfil conectado parezca desconectado.
  *Origen honesto de esta decisión: nació de querer que el camino de refresco fuera alcanzable por
  HTTP en los tests, y se justificó como producto después. El agente lo declaró él mismo. Se queda
  porque con timeout y repliegue es defendible por sí sola, pero que conste el orden real.*
- **La URL base de Strava es inyectable.** Gracias a eso el intercambio, el refresco, la forma de
  la petición de revocación y el caso de Strava colgada se prueban **sin red**, contra un servidor
  de mentira local. Un tercero de mentira permite ensayar cosas que la API real no te concede a
  voluntad: un 200 con el cuerpo roto, un 500, una conexión que acepta y no responde nunca.
- Se rechaza la conexión si Strava devuelve 200 sin token usable, o si el consentimiento vuelve
  sin `activity:write`. Marcar como conectado y fallar luego al subir aleja el error de su causa.

**Lo único que queda sin cubrir** es si la API real de Strava se comporta como dice su
documentación. Eso solo se comprueba a mano, con credenciales reales.

**El trabajo de verdad estaba en el mapeo, no en la subida.** `exercise_type` no es texto libre:
sale de un vocabulario cerrado del FIT SDK (~200 identificadores tipo `BARBELL_BENCH_PRESS`,
`PLANK_GENERIC`). openGym tiene **1.324 ejercicios** más los que el usuario se invente. Así que
hay que decidir qué pasa con lo que no mapea, y un mapeo mal hecho registra en Strava un ejercicio
equivocado para siempre, en silencio.

## Bloqueantes abiertos

- **Revisión visual pendiente (ciclo 2).** La fila de descanso en la hoja de configuración de
  ejercicio no la ha visto nadie en pantalla. Los checks en verde no dicen si se ve bien.
- **Fase A pendiente (ciclo 1).** Sigue faltando el paso 4: canjear el código desde un
  autenticador **realmente distinto**. Ver el aviso del guion: una ventana de incógnito **no**
  vale, comparte el almacén de passkeys del sistema.

`main` sigue sin tocarse. No se fusiona hasta que ambas cosas estén hechas.

## Bloqueantes resueltos

- ~~Docker no instalado~~ — **resuelto 2026-09-04**, lo instaló el dueño. Consecuencias cerradas:
  1. `docker compose -f docker-compose.yml -f docker-compose.tunnel.yml config` ejecutado y
     **válido**: devuelve los 4 servicios (`api`, `media`, `web`, `cloudflared`), exit 0. El check
     `compose_override_validates` de T6, que se fusionó en rojo, queda en verde.
     Requiere un `.env` presente (creado desde `.env.example`, ignorado por git) y `TUNNEL_TOKEN`
     definido — el overlay usa `${TUNNEL_TOKEN:?}` y falla a propósito si falta.
  2. La Fase A ya es posible.
  Nota: `docker` está en el PATH de máquina pero una shell abierta antes de la instalación no lo
  ve; hay que invocarlo por ruta completa o abrir una shell nueva.

## Decisiones tomadas (no reabrir sin motivo nuevo)

- **PWA autoalojada, no APK.** El dueño pasa a iPhone en ~4 meses y iOS no permite sideloading.
- **HTTPS obligatorio.** El service worker solo se registra sobre HTTPS
  (`frontend/src/main.jsx`): sin él no hay offline, ni passkeys, ni notificaciones. Descarta
  el acceso por IP local. Solución: Cloudflare Tunnel.
- **Vinculación por código de un solo uso**, no gestor de contraseñas multiplataforma.
  Descartado explícitamente por el dueño.
- **El dominio se fija antes de crear ningún perfil.** `RP_ID` ata las passkeys al hostname;
  cambiarlo después las invalida todas.
- **El móvil es el único que escribe.** La sincronización es *el último gana* sobre el estado
  completo. Los análisis leen `data/state-<uid>.json` en disco.
- **Tests del backend con `node --test`**, sin dependencias nuevas. Node 24 ya lo trae.
- **El tramo criptográfico de WebAuthn no se testea automáticamente.** Se cubre en la Fase A con
  el autenticador virtual de Chrome DevTools.
- **Red de seguridad permanente:** exportar el JSON antes de soltar el Android.
- **La lista de dispositivos no marca "este dispositivo"** (hallazgo de T3). La cookie de sesión
  es `uid:caducidad:versión` y no guarda con qué credencial se firmó, así que el servidor no
  puede saberlo. Se omitió el campo en vez de inventarlo. T5 compensa con un aviso explícito en
  la confirmación de borrado. Cambiarlo exigiría tocar el formato de cookie y los tres puntos de
  minteo: queda en trabajo futuro.
- **La API de dispositivos usa `?id=`**, no un parámetro de ruta: el dispatcher solo hace match
  exacto de `MÉTODO ruta`. Mismo patrón que `GET /api/admin/user?id=`.
- **`api/Dockerfile` lista los módulos de runtime uno a uno.** Al añadir `link.js` la API entró en
  bucle de reinicio con `ERR_MODULE_NOT_FOUND` mientras los 55 tests seguían en verde: los tests
  importan del árbol de trabajo, donde el fichero sí está. **Todo módulo nuevo en `api/` hay que
  añadirlo al `COPY`**, y ningún test lo detectará. Es la razón por la que la Fase A no es
  opcional: fue lo primero que encontró, antes incluso del primer clic.

## Registro

| Fecha | Qué |
|-------|-----|
| 2026-09-04 | Rama `develop` creada desde `main`. `PLAN.md` y `ESTADO.md` escritos. |
