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
| T12 | Construir el JSON y subirlo | `feat/strava-upload` | **hecho** | `a503317` |
| T13 | Interfaz y subida automática | `feat/strava-ui` | **hecho** | `a80f735` (516 tests front) |
| FX | Arreglo: subir a `/api/v3/uploads`, no a `/uploads` | `fix/strava-upload-url` | **hecho** | `55b17ec` |
| FE | **Prueba real de extremo a extremo** | — | **PASADA 2026-09-07** | actividad subida a Strava y verificada por el dueño |

### Los dos fallos que solo aparecieron usando la app

Ninguno lo detectó ningún test, y los dos por la misma causa de fondo: **el servidor de mentira
estaba escrito para coincidir con nuestro código en lugar de con el contrato real de Strava.**
1. **Formato:** se mandaba un cuerpo JSON; `/uploads` es `multipart/form-data` con el documento
   como parte `file`. Diez tests en verde certificando una petición que Strava rechaza.
2. **Ruta:** se subía a `/uploads`; la API v3 vive en `/api/v3/uploads`. Los endpoints de OAuth sí
   están en la raíz, y por eso conectar funcionaba y subir daba 404.
Ambos tests afirman ahora la forma y la ruta exactas, y el doble **responde 404 a rutas
desconocidas** en vez de aceptar cualquier cosa. Un doble que dice que sí a todo no verifica nada.

### El tercero: sin cobertura en el gimnasio, la subida automática se apagaba para siempre

Detectado el **2026-09-17** con un entrenamiento real que nunca llegó a Strava. La sonda de
`GET /api/strava/status` en `trySyncStrava` apagaba `stravaProbe` ante **cualquier** fallo, y eso
mete en el mismo saco dos cosas que no se parecen:
- **El servidor contestó** (404 sin Strava, 401 sesión caída): un veredicto que no cambia hasta
  recargar o volver a entrar. Apagar está bien, y es justo para lo que existe `stravaProbe`.
- **La petición no llegó a nadie** (modo avión, sin cobertura en el gimnasio, túnel caído): no se
  aprendió nada del perfil. Apagar aquí **desactivaba la subida automática el resto de la sesión**
  — y la sesión de una PWA instalada en el móvil dura días, no minutos. El entreno no subía ni
  cuando volvía la red: solo con el botón manual o cerrando y abriendo la app del todo.

Ahora solo apaga la sonda un error **con `status`**, es decir, una respuesta real del servidor. El
caso sin red vuelve al camino que el diseño ya tenía previsto: el siguiente `pushState`/`pullState`
es la siguiente oportunidad, y siempre hay una.

La lección se parece a la de arriba: **el fallo de red no es un veredicto.** Un `catch` que trata
"no hay respuesta" igual que "la respuesta fue que no" convierte un corte de cobertura en una
decisión permanente.
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
Tres ganchos solo para pruebas, documentados como tales: `STRAVA_API_BASE`, `STRAVA_TIMEOUT_MS` y
`STRAVA_UPLOAD_POLL_DELAY_MS` (este último, T14: la espera antes del único sondeo de
`GET /uploads/{id}` que confirma si un 201 sobrevivió al procesado asíncrono de Strava).

**Silenciado en el feed (`STRAVA_HIDE_FROM_HOME`, activado por defecto):** tras subir, el servidor
hace `PUT /api/v3/activities/{id}` con `{ hide_from_home: true }`, así el entreno sincronizado no
aparece en el feed de tus seguidores. **No es privacidad, y no hay forma de que lo sea:** la API de
Strava no expone la visibilidad de una actividad — `POST /uploads` no tiene parámetro para ello (el
antiguo `private` desapareció en 2018) y `PUT /activities/{id}` solo acepta `name`, `description`,
`type`/`sport_type`, `gear_id`, `commute`, `trainer` y `hide_from_home`. Para que salgan privadas de
verdad hay que ponerlo en la cuenta (Ajustes → Controles de privacidad → Actividades → "Sólo tú").
Tres decisiones que sostienen esto:
- **Es lo último que pasa y nunca puede costar el entrenamiento.** Ocurre después de registrar la
  subida como hecha, así que un silenciado fallido devuelve `200` con `muted: false` en vez de un
  error: fallar aquí haría que el cliente reintentara y **subiera una segunda copia** para arreglar
  algo que solo es cosmético.
- **El silenciado sobrevive a la petición que lo encargó.** Esta es la corrección del fallo con el
  que nació la función: silenciar necesita el `activity_id`, que no existe hasta que Strava termina
  de procesar, y la primera versión solo lo intentaba dentro de la petición, en una ventana de unos
  seis segundos. Strava tarda más a menudo de lo que parece, así que el caso corriente era
  *"no había id todavía → no se silencia → no se vuelve a mirar"*, en silencio y con un `200`
  limpio: los entrenos seguían apareciendo en el feed. Ahora lo que no se resuelve en la petición
  se apunta en `strava-mutes-<uid>.json` y lo reintenta un barrido de fondo (15 s, 30 s, 1 min…
  hasta ocho intentos, y se abandona a la media hora). La respuesta lo dice con `mutePending`.
- **Un duplicado también se silencia.** El id de la actividad viene dentro del texto del error
  (`"... duplicate of activity 21234316"`, con `activity_id: null`), y antes se ignoraba: la única
  subida de la que teníamos certeza de que había creado una actividad era justo la que nunca se
  podía callar.

`STRAVA_MUTE_EXTRA_POLLS` (2) sigue ahí, pero ahora es una optimización, no el mecanismo: ahorra
esperar al barrido cuando Strava va rápido. Con el silenciado apagado no se hace ninguno — el
comportamiento de T14 queda intacto. `STRAVA_MUTE_SWEEP_MS`, `STRAVA_MUTE_RETRY_BASE_MS` y
`STRAVA_MUTE_MAX_AGE_MS` son ganchos solo para pruebas, como `STRAVA_TIMEOUT_MS`.

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

## Limitaciones conocidas, decididas a conciencia (2026-09-07)

- **Un entrenamiento que agote sus 3 intentos no se puede reintentar desde la app.** El contador
  vive en `localStorage` del móvil (`gym_strava_attempts`) y el servidor no lo ve. La única salida
  hoy es una consola de navegador. **Ocurrió dos veces la misma tarde**, las dos por fallos
  transitorios ajenos al entrenamiento (una URL mal, un fichero corrompido a mano).
  Arreglo propuesto y **descartado por ahora a petición del dueño**: una fila en Ajustes → Strava,
  visible solo si hay entrenamientos abandonados, que borre sus contadores. Si vuelve a molestar,
  es lo primero que hay que hacer.
- **Dos dispositivos subiendo el mismo entrenamiento a la vez**: el segundo recibe 409 y gasta un
  intento en lugar de esperar sin coste. Requiere que el móvil entienda una respuesta nueva, así
  que toca frontend y backend a la vez; se dejó fuera para no mezclar capas en una misma tanda.

## Aviso para quien edite los ficheros de `data/` a mano

**No uses `Set-Content -Encoding utf8` de Windows PowerShell: añade un BOM invisible** y
`JSON.parse` lo rechaza. Pasó el 2026-09-07 al desmarcar un entrenamiento: el fichero de subidas
quedó ilegible y el servidor **se negó a subir nada** durante un rato — correctamente, porque la
guarda prefiere no subir antes que arriesgar un duplicado que no podría registrar. Usa Node, o
`[System.IO.File]::WriteAllText` con `UTF8Encoding($false)`.
Mismo error tumbó `api/server.js` antes en la sesión. Es un tropiezo de la herramienta, no del
código.

## Lo que NO está verificado (probado contra un doble, nunca contra Strava de verdad)

Se subió **un** entrenamiento real, de dos ejercicios. Eso demuestra el camino completo, no todo
lo que hay en él:
- ~~Los nombres de los ejercicios en Strava~~ — **verificado el 2026-09-07**: un entrenamiento de
  **6 ejercicios** subió y el dueño confirmó que salen bien. El mapeo funciona con datos reales.
  Si alguno sale mal en el futuro, se pincha ese caso en `STRAVA_OVERRIDES`, una línea.
- **El refresco del token.** Los de Strava duran ~6 h; el primer refresco real ocurrirá pasado ese
  tiempo. La decisión de refrescar está testeada, el intercambio real no.
- **La revocación al desconectar**, contra un token válido.
- **Un entrenamiento que agote los 3 intentos.** No hay forma de reintentarlo desde la app: el
  contador vive en el `localStorage` del móvil y el servidor no puede tocarlo. Si aparece el caso,
  la solución es un botón en Ajustes, no que el dueño abra una consola.

## Al mudar el servidor (mini PC o dominio propio)

- `RP_ID` **no puede cambiar** o mueren todas las passkeys.
- El **dominio de callback de la app de Strava** hay que actualizarlo en `strava.com/settings/api`,
  o dejará de poder conectarse.
- El `client_secret` vive solo en `.env`, que está en `.gitignore`. Nunca se ha commiteado.

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

## Ciclo 4 — notificaciones de entrenamiento (plan: `PLAN-NOTIFICACIONES.md`)

| # | Tarea | Rama | Estado | Commit de merge |
|---|-------|------|--------|-----------------|
| N0 | Diagnóstico en el móvil | — | **hecho** | — (sin código, ver decisiones ↓) |
| N1 | No cancelar la push cuando el descanso termina solo | `fix/rest-push-race` | **hecho** | `5b9db8f` (521 tests) |
| N2 | Que no vuelva a fallar en silencio: auto-suscripción + timers persistidos | `fix/push-reliability` | **hecho** | `950f750` (539 front + 165 api) |
| N3 | Payload dual (Declarative Web Push) — habilita iPhone | `feat/declarative-web-push` | **hecho** | `0df4b35` (539 front + 169 api) |
| N4 | "Qué toca ahora" en la notificación + salto a la app | `feat/next-up-notification` | **hecho** | `63898cd` (564 front + 179 api) |
| N5 | Aceptación manual (Android ahora, iPhone al cambiar) | — | **hecho en Android** — validado contra `49967c7` ya desplegado. iPhone pendiente del cambio de móvil | — |
| ND | Desplegar: `develop` → `main` | — | **hecho** | `49967c7` en `main`, sirviéndose desde el 2026-09-07 23:25 |
| N6 | Marcador de versión (hash + fecha) en `/api/health` y al pie de Ajustes | `feat/version-marker` | **hecho** | `93a067e` (574 front + 183 api) |
| NX | Limpieza: borrar `api/n4-baseline/` y `frontend/src/n4-baseline/` | — | **abierto — lo tiene que hacer el dueño**, ver nota ↓ | — |

Decisiones del ciclo 4 (no reabrir):
- **Solo PWA.** Nada de shell nativa: el cambio a iPhone sigue previsto en pocos meses y el
  trabajo Android nativo no se amortizaría. Se acepta que **no habrá barra de descanso viva ni
  isla de HyperOS 3**: ninguna de las dos existe en la plataforma web.
- **La causa del "no me entero" era el opt-in apagado**, no un fallo de entrega. `Push
  notifications` en Ajustes es un interruptor separado de `Sounds`; con él apagado, `sendPush()`
  no encuentra suscripciones y sale sin error ni traza. Activado, en Android funciona.
- **El ducking de la música no se programa.** No hay API de audio focus en la web. Lo hace el SO
  al reproducir el tono de notificación. Por eso la push no es el plan B del pitido: es **el**
  mecanismo para enterarse con cascos puestos.
- **Prohibido el patrón de notificación `silent` reemplazada por `tag`**, que era el diseño
  inicial para "siguiente ejercicio". Safari revoca la suscripción si una push no muestra
  notificación visible (reportes de corte tras 3), y lo hace en silencio.
- Por lo anterior, "siguiente ejercicio" y "fin de descanso" se funden en **una sola notificación
  por descanso**, no una por serie marcada.
- **El texto de la notificación lo compone el cliente**, no el servidor: el servidor no conoce ni
  el idioma ni el estado del entreno.
- El cronómetro **no derivaba**: `startRest` ya usa `endsAt` de reloj de pared y reengancha en
  `visibilitychange`. No se toca.
- `navigator.vibrate` no existe en iOS: el `vibrate(30)` al marcar serie no hará nada allí. Se
  deja, no molesta.
- **No se toca `sound.js`.** Probado en Android: el sonido de la notificación push ya se oye bien
  con cascos, y al dueño le basta. Subir la ganancia del pitido WebAudio era innecesario.
- **Desplegar exige pasar por `main`.** `auto-deploy.ps1` vigila `origin/main`, no `develop`: mientras
  el trabajo viva solo en `develop` no se publica nada, y no hay ningún aviso de ello. Fue lo que
  pasó el 2026-09-07: el ciclo entero estaba fusionado en `develop` y el servidor seguía sirviendo
  `76f89fc`, anterior a N1, durante horas — incluida una prueba de aceptación que se dio por buena
  y hubo que repetir.
- **El script se salta el despliegue si `git status --porcelain` devuelve algo**, ficheros sin
  seguir incluidos, y solo lo dice en `.git/auto-deploy/deploy.log`. Un despliegue que "no hizo
  nada" es indistinguible de uno que no se lanzó salvo mirando ese log. Con `n4-baseline/` presente
  (tarea NX) esto ocurre en **cada** ejecución.
- **`ARG` es de ámbito de etapa.** En `web/Dockerfile` los `ARG` estaban en la etapa `nginx`, así
  que la etapa `build` (donde corre `npm run build`) no los veía: hay que declararlos otra vez
  allí, y después de `COPY frontend/ ./` para no invalidar la capa de `npm ci` en cada commit.
- **El marcador de versión se valida, no se recorta.** Los defaults de los `ARG` existentes son
  `dev`/`unknown`, así que un test hexadecimal los rechaza y una construcción sin parametrizar no
  muestra versión en vez de inventarse una.
- **Dos líneas en Ajustes significan bundle y servidor desparejados**, que en una PWA es el service
  worker sirviendo un bundle viejo contra un servidor nuevo. Es la señal útil, no un fallo.
- **NX lo tiene que ejecutar el dueño a mano.** Los cinco intentos de borrarlos desde la sesión
  (`rm -rf`, `Remove-Item` y `git clean -fd`) los denegó la capa de permisos del entorno. No es
  falta de intención: ningún borrado de ficheros pasa. El comando es
  `Remove-Item -Recurse -Force api\n4-baseline, frontend\src\n4-baseline`.
- **Pendiente NX: sobran `api/n4-baseline/` y `frontend/src/n4-baseline/`.** Son copias que un agente
  dejó al verificar "esto falla sin mi cambio". Están sin seguir por git, pero **los dos ejecutores
  de tests las recogen**: con ellas presentes salen 3 fallos en frontend y 1 en api que son falsos
  positivos (contienen el código viejo a propósito). Para una tanda limpia mientras sigan ahí:
  `npx vitest run --exclude "**/n4-baseline/**"` y `node --test *.test.js`.
- **Lo que queda por comprobar en iPhone (N5).** Si las notificaciones de PWA en iOS llegan mudas,
  es limitación de plataforma y no hay arreglo por vía PWA: las fuentes se contradicen y la
  documentación de WebKit no menciona sonido. Requisito no negociable: la app **añadida a la
  pantalla de inicio**; en pestaña de Safari no existe `PushManager`.
- **La app usa `HashRouter`: el destino es `/#/workout`, no `/workout`.** Equivocarse aquí falla en
  silencio — abre la app en la pantalla de inicio y parece que "casi funciona".
- **`nextUp()` no lee el puntero `active.cur`.** `Workout.jsx` marca la serie y **luego** arranca el
  descanso, avanzando `cur` después: una respuesta basada en el cursor anunciaría la serie que
  acaba de terminar. Camina las series en el orden real de ejecución (round-robin en superserie) y
  numera los calentamientos dentro de su propia fase, para que el número coincida con la fila que
  se ve en pantalla.
- **El cuerpo de la notificación es contenido de usuario** (el nombre del ejercicio lo puede haber
  escrito el dueño). El servidor lo valida y recorta **dos veces**: al entrar y al rearmar desde
  disco, porque `db.json` es un fichero editable.
- **`web-push` no necesita nada especial para el modo declarativo.** Ya cifra en `aes128gcm`
  (RFC 8291) y WebKit solo mira el JSON descifrado: basta con que lleve `web_push: 8030`. No hay
  content-type ni encoding que conmutar. Comprobado contra la fuente de la librería.
- **`navigate` es obligatorio y absoluto, y va dentro del payload.** Bajo el pintado declarativo de
  Safari no se ejecuta el service worker, así que no queda código que decida el destino en el
  momento del clic. `pushNavigate()` exige mismo origen y repliega a la raíz: una notificación
  nunca puede convertirse en un redirect a otro sitio.
- **`sw.js` lee las dos formas, en ambos sentidos.** Un service worker ya instalado puede ser más
  viejo que el servidor que le envía, o más nuevo que uno sin redesplegar. El caso "SW viejo +
  servidor nuevo" se degrada a "openGym" con cuerpo vacío: peor, pero **visible**, así que el
  invariante de iOS se respeta y Chrome actualiza el SW en la primera navegación.
- **El opt-out de push vive en `localStorage` (`gym.push.optout`), no en `S`.** Una suscripción Web
  Push pertenece a **un navegador en un dispositivo**, así que el "lo he apagado a propósito" tiene
  que tener el mismo ámbito. En `S` viajaría al servidor y a todos los dispositivos vinculados:
  apagarlo en el móvil lo apagaría en el portátil, y dos dispositivos con el interruptor en
  posiciones distintas se pisarían por la regla "último gana" de la sincronización.
- **La auto-reparación no puede revertir una decisión del usuario.** Desuscribirse **no** revoca el
  permiso del navegador: sin la marca de opt-out, `Notification.permission` sigue en `granted` tras
  `disablePush()` y el siguiente descanso volvía a suscribir a quien acababa de apagarlo. El
  interruptor quedaba imposible de apagar. `disablePush()` registra el opt-out lo primero y sin
  condiciones, antes de cualquier `await`.
- **Umbral `REST_TIMER_MAX_LATE_MS` = 2 min** para un aviso caducado tras un reinicio del servidor.
  Un reinicio del contenedor tarda segundos; los descansos duran 60-180 s. Más tarde de eso ya
  estás en la serie siguiente y el aviso es ruido.
- **El aviso audible depende hoy de una carrera.** `stopRest()` cancela la push del servidor
  también cuando el descanso termina solo, así que suena únicamente porque el servidor envía antes
  de que llegue el cancel. N1 lo convierte en garantía: solo se cancela si el descanso se para
  antes de tiempo.

## Ciclo 5 — fallos encontrados entrenando (2026-09-08)

| # | Tarea | Rama | Estado | Commit de merge |
|---|-------|------|--------|-----------------|
| B1 | El buscador de ejercicios tumbaba la pantalla | `fix/search-crash-custom-exercises` | **hecho** | `9d46ea3` (588 tests), desplegado en `cfa61fd` |
| B2 | Strava: no sube y "conectar" da error | — | **abierto** — falta el mensaje de error exacto | — |
| B3 | Las push no llegaban con la app cerrada y entraban en bloque al abrirla | `fix/push-ttl` | **hecho** | `2f0b699` (193 api + 611 front), desplegado en `1454d8f` |
| B4 | Las notificaciones se apilaban en la bandeja hasta borrarlas a mano | `fix/notification-stacking` | **hecho** | `3366408` (193 api + 623 front) |
| M1 | Mejora futura: añadir ejercicios a rutinas | — | **abierto, sin especificar** — el dueño dirá qué quiere | — |

Hallazgos del ciclo 5 (no reabrir):

- **B3, causa raíz: el TTL por defecto de `web-push` son cuatro semanas.** Una push que no se puede
  entregar (móvil en Doze, sin cobertura, Chrome congelado por la optimización de batería) **no se
  pierde: se encola**, y la cola se vacía entera en cuanto el dispositivo vuelve a ser alcanzable —
  en la práctica, al abrir la app. Ese es el síntoma exacto, y no era un fallo de entrega.
- **La urgencia ya era `high` y no era el problema.** `urgency` acelera el intento; **solo el TTL
  decide cuándo un aviso deja de merecer entrega**. Confundir las dos cosas es lo que dejó el
  comentario anterior de `sendPush` justificando el TTL largo como una virtud.
- **Contradicción interna que lo delataba:** el servidor descarta un aviso de descanso con más de
  `REST_TIMER_MAX_LATE_MS` (2 min) de retraso al rearmar tras un reinicio, y a la vez se lo
  entregaba a FCM con cuatro semanas de margen. Ahora el aviso de descanso usa **esa misma
  constante** como TTL: las dos vías se rinden en el mismo instante.
- TTL por emisor: descanso 120 s · recordatorio del día 3 h (sobrevive a una mañana sin cobertura y
  nunca aparece de madrugada ni al día siguiente) · por defecto 60 s (notificación de prueba y lo
  que se añada después).
- **Cabecera `Topic` = el `tag`.** Un aviso sin entregar es **reemplazado** en la cola por el
  siguiente en vez de apilarse: la misma regla que el `tag` ya aplica en pantalla. `web-push`
  **lanza excepción** con un topic fuera de `[A-Za-z0-9-_]{1,32}`, y una excepción ahí costaría la
  notificación entera, así que un tag que no cumpla viaja sin topic.
- **Las opciones de entrega no viajan en el payload**, así que ningún test de los que había las
  veía: una regresión al valor por defecto habría sido invisible hasta la siguiente tarde sin
  cobertura. El gancho de captura de `push-payload.integration.test.js` graba ahora también las
  opciones, y hay tres tests que las fijan.
- **B4, causa raíz: el aviso local de fin de descanso no llevaba `tag`.** `maybeRestNotification`
  (`useUI.js`) mostraba la notificación **sin etiqueta**, y una notificación sin etiqueta no
  reemplaza a nada: cada descanso dejaba su propia entrada permanente. Y como la push del servidor
  **sí** lleva `tag`, cada descanso producía **dos** notificaciones para un solo evento. Ahora usa
  el mismo `rest-timer` y el mismo texto de "qué toca" que la push, así que las dos se funden en una
  y el descanso siguiente la reemplaza. Era exactamente el riesgo que anotó N1 en
  `PLAN-NOTIFICACIONES.md`; se dio por descartado porque el aviso local solo actúa con la pestaña
  oculta, que es justo cuando la push también llega.
- **Sin `renotify` en el aviso local, a propósito.** El pitido y la vibración de ese descanso acaban
  de sonar en la línea de arriba; reemplazar una push ya entregada tiene que ser silencioso o el
  arreglo cambia dos notificaciones por dos sonidos.
- **El `tag` solo colapsa avisos del mismo tipo.** Un "hoy toca entrenar" sin descartar seguía ahí
  cuando empezaban a llegar los descansos. `sw.js` cierra ahora los de **otra** etiqueta antes de
  pintar el nuevo: todo lo que manda esta app es sobre el momento, así que un aviso viejo no merece
  quedarse en cuanto existe uno nuevo. Los del mismo `tag` se dejan estar: los reemplaza
  `showNotification` sola, sin parpadeo y conservando el sentido de `renotify`.
- **Nada de esto puede costar la notificación.** `getNotifications()` va envuelto y
  `showNotification` se alcanza igual y sigue dentro de `waitUntil`: una push entregada que no pinta
  nada es lo que revoca la suscripción en iOS, en silencio.
- **En iPhone esto no se ejecuta.** Safari pinta la push declarativa sin arrancar el service worker,
  así que allí el `tag` es todo el mecanismo. Limitación de plataforma, no algo que rodear.
- **`public/sw.js` no tenía ni un test**, que es el peor sitio donde no tenerlos: es la pieza que
  corre con la app cerrada. Ahora se carga como fuente contra un `self` de mentira
  (`frontend/src/sw.test.js`).

- **B1, causa raíz: `mergePlan` escribía ejercicios personalizados incompletos.** Solo ponía
  `id`/`n`/`bp`/`desc`, dejando `tg` y `eq` en `undefined`, mientras que el formulario de creación
  siempre escribió la forma completa. Los dos buscadores (biblioteca y selector de "añadir a
  rutina") compartían por copia la expresión `e.tg.includes(ql) || e.eq.includes(ql)`, con solo
  `desc` protegido — así que importar un plan envenenaba el catálogo y la siguiente tecla lanzaba
  `TypeError` al *error boundary*. **Confirmado en datos reales:** el perfil `ZOI4Pp…` tenía dos
  filas así (`Dorsiflexión de tobillo en pared`, `Dominadas excéntricas`).
- **`allExercises` normaliza al leer**, así que los perfiles ya dañados se reparan solos sin
  migración ni tocar el estado sincronizado.
- **Faltaba también `custom: true`** en las filas importadas: sin esa marca la hoja de detalle
  oculta "Editar o borrar", así que un ejercicio importado tampoco se podía eliminar.
- **La expresión vieja comparaba `tg` y `eq` en crudo** contra una consulta ya pasada a minúsculas:
  esos dos campos eran, en la práctica, no buscables. `matchesQuery` los normaliza.
- **B2 no es un fallo de Strava, son dos perfiles distintos.** `zRC-V…` (creado el 4 sept, 5
  entrenos, perfil de pruebas) tiene Strava conectado; `ZOI4Pp…` (creado el 7 sept, **271
  entrenos**, el que se usa de verdad) no. Por eso Ajustes dice que no está conectado y no se subió
  nada. Los "dos dispositivos" son las 2 passkeys del perfil, y eso sí es normal.

## Ciclo 6 — subir el fork a upstream v1.3.7 (plan: `PLAN-UPSTREAM.md`)

**Estado: U0 hecho. U1 es el siguiente.**
`main` = `develop` = `b010e0b`, árbol limpio, desplegado y sirviendo. `rebase/v1.3.7` es rama
aparte, arrancada desde upstream, sin fusionar a nada todavía.

| # | Tarea | Rama | Estado | Modelo |
|---|-------|------|--------|--------|
| U0 | Copia de seguridad, etiqueta de retorno, rama desde upstream, línea base | `rebase/v1.3.7` | **hecho** (`6f17fe4`, sin fusionar) | orquestador |
| U1 | Vinculación y gestión de dispositivos | `rebase/u1-linking` | **hecho** (`739d845` en `rebase/v1.3.7`) | Sonnet + revisión Opus |
| U2 | Notificaciones | `rebase/u2-push` | **hecho** (`a06e258`) | Sonnet |
| U3 | Strava | `rebase/u3-strava` | **hecho** (`ade2d73`) | Sonnet + revisión Opus |
| U4 | Despliegue doméstico | `rebase/u4-deploy` | **hecho** (`47c0288`) | Haiku |
| U5 | Migración de datos | `rebase/u5-data` | **hecho** (`c71e2cc`) | Sonnet |
| U6 | Limpieza de comentarios | `rebase/u6-comments` | **hecho** (`3c87d3a`) | Haiku |
| U7 | Aceptación manual | — | **pendiente** — se desplegó antes de hacerla, a petición del dueño | el dueño |
| UD | Despliegue a `main` | — | **hecho** | `ecc726c`, sirviendo desde 2026-09-21 18:27 |
| U8 | Entrenador IA | — | abierto, **opcional** | Haiku |

Decisiones del ciclo 6 (tomadas el 2026-09-20, no reabrir):

- **No se fusiona, se rebasa.** Upstream v1.3.7 pasa a ser la base y las funciones propias se
  vuelven a aplicar encima, una por brief. Un `git merge` es inviable: los dos lados han reescrito
  los mismos seis ficheros y upstream les ha metido +1.482 líneas. Es posible porque el fork es
  aditivo: +13.375 / **−128**, y 53 de sus 90 ficheros son nuevos.
- **Precio aceptado:** se pierde el historial de los commits propios sobre esos ficheros. El
  trabajo se conserva; el porqué de cada decisión ya vive en este fichero.
- **Donde upstream ya lo tiene, gana upstream.** Se tiran: el ciclo 2 entero (upstream trae
  `restSec` por ejercicio desde v1.2.14, y además `warmupRestSec`), N6 (versión al pie de Ajustes
  desde v1.2.11) y el commit de sustituir ejercicio (v1.2.14, !41/!43).
- **La vinculación de dispositivos SE QUEDA.** El `/api/pair/*` de upstream **no** la sustituye:
  da un token Bearer para la app Capacitor, vive en memoria y caduca a los 5 minutos. No registra
  passkey en un perfil existente, que es lo que hace falta para el iPhone.
- **Upstream sigue con el TTL de cuatro semanas en las push**, con el mismo comentario viejo que
  este fork tenía. B3 y B4 son mejoras propias que upstream no tiene: no se pierden.
- **Se quita el `web_push: 8030` y se conserva `navigate`.** Lo único que impide que Safari ejecute
  el service worker es ese número mágico; `navigate` no depende de él, `sw.js` ya lo lee del
  payload plano. Quitándolo se tienen las dos cosas: service worker vivo en iPhone y salto a
  `/#/workout`. **Esto revisa la decisión de N3**, con motivo nuevo.
- **La limpieza de comentarios es solo sobre ficheros creados por el fork**, ni siquiera los de
  upstream que lleven un enganche propio dentro. Es lo que mantiene que la próxima actualización
  siga siendo un `git pull`.
- **Hay migración de datos obligatoria:** el campo `rest` de los ejercicios de las rutinas se llama
  `restSec` en upstream. Sin migrar, cada rutina pierde su descanso en silencio. U5, sobre copia.
- **`api/Dockerfile` es el riesgo más serio.** Lista los módulos de `api/` uno a uno y ningún test
  lo detecta. Se valida levantando la pila, no con tests.

### U0 (2026-09-20/21) — hallazgos

- **Upstream ya iba por v1.3.8** cuando se ejecutó U0, un release por delante de la v1.3.7 sobre la
  que está escrito `PLAN-UPSTREAM.md`. Decisión del dueño: usar `upstream/main` (v1.3.8) tal cual,
  no fijar el tag v1.3.7. La regla de cada brief ("nada se da por bueno de memoria, cada brief lee
  el código de upstream de cero") ya cubre el salto de versión sin cambiar nada del plan.
  Rama `rebase/v1.3.7` creada desde `upstream/main` en `f91cde1`.
- **Copia de seguridad** en `~/opengym-backups/opengym-backup-2026-09-20_234801.tar.gz`, fuera del
  repo, verificada (contiene el perfil real `ZOI4PpUB_3gEoV8b`, `db.json`, `secret`, `vapid.json`,
  datos de Strava). Etiqueta de retorno `v1.2.9-fork-final` creada y subida a `origin`.
- **Línea base de upstream, frontend: 1584 tests, verde.**
- **Línea base de upstream, api: 176/193 verde.** Las 17 fallas son todas del entrenador IA (U8,
  opcional, apagado por defecto) y **no son un fallo de upstream**: dependen de comportamiento
  exclusivo de Linux que este equipo no tiene fuera de Docker —
  - `credential.test.js`: exige permisos POSIX `0o600` en un fichero; Windows no tiene ese modelo
    de permisos y `fs.statSync(...).mode` no los aplica igual.
  - `jobs.test.js`, `coach-limits.test.js`, `routes.test.js`: dependen de lanzar
    `coach/fixture-cli.mjs` como proceso hijo a partir de `new URL(...).pathname`, que en Windows
    da una ruta con barra inicial delante de la letra de unidad (`/C:/Users/...`) y no resuelve.
  - Se verificó **antes** de aceptar esto: `prompts.test.js` sí era un CRLF real (ver debajo) y con
    el arreglo pasó a verde; los otros 17 no cambiaron con el mismo arreglo, así que la causa es
    distinta y está diagnosticada arriba, no es la misma familia de fallo.
  - No se toca código de upstream por esto: la función solo corre de verdad en el contenedor Linux,
    que es donde de hecho se verificó (ver más abajo).
- **Trampa de CRLF de Windows, para cualquier tarea futura del ciclo 6.** `core.autocrlf` estaba en
  `true` a nivel global y el repo no trae `.gitattributes`. Consecuencia real, no hipotética:
  `api/coach/prompts/*.md` se bajaron con CRLF y `prompts.test.js` (que compara ese `.md` contra el
  `.js` generado, byte a byte) fallaba por eso, no por ningún bug. Se puso `core.autocrlf=false`
  **solo en este repo** (`git config core.autocrlf false`, sin tocar la config global) y se
  re-hizo `git checkout` de los ficheros afectados. **Un primer intento de arreglo se equivocó**:
  un `git checkout -- .` inmediatamente después de cambiar `core.autocrlf` no reescribió nada por
  una cache de índice obsoleta ("racy git"); hizo falta un segundo `git checkout` para que surtiera
  efecto — compruébese con `git hash-object <fichero>` contra `git rev-parse HEAD:<fichero>`, no
  fiarse de que el primer intento haya bastado.
  **Consecuencia que hay que vigilar en cada tarea de aquí en adelante:** el primer `Edit` sobre
  `.gitignore` en esta sesión heredó CRLF del checkout viejo (hecho antes de tocar `core.autocrlf`)
  y generó un commit que reformateaba el fichero entero (24 líneas tocadas por 1 línea real de
  cambio) — exactamente lo que la regla dura de U6 prohíbe hacerle a un fichero de upstream. Se
  corrigió con un commit de arreglo aparte (`6f17fe4`) que devuelve LF y dejando el diff en una
  sola línea contra `upstream/main`. **Para cualquier fichero de upstream que se edite en este
  ciclo: comprobar `file <fichero>` antes y después de tocarlo, y el diff contra `upstream/main`
  antes de commitear** — un editor que preserva el estilo de línea ya presente en disco no protege
  si ese estilo en disco ya estaba mal por el checkout.
- **Docker Desktop no estaba arrancado** al empezar el paso 6 de U0 — es decir, **producción no se
  estaba sirviendo** en ese momento. Al abrirlo, los tres contenedores de producción
  (`opengym-web-1`, `opengym-api-1`, `opengym-cloudflared-1`) se reiniciaron solos por su política
  `restart: unless-stopped`, usando la imagen ya desplegada (`registry.gitlab.com/duartesantos8/...`,
  no la de `ghcr.io` que trae ya `docker-compose.yml` en esta rama). Verificado que siguen sirviendo
  en `localhost:8080` tras la comprobación de abajo; **queda pendiente que el dueño confirme desde
  fuera** (el dominio real, no localhost) que el túnel de Cloudflare reconectó bien.
- **Upstream v1.3.8 levanta limpio, aislado de producción.** Se usó un proyecto Docker separado
  (`docker compose -p opengym-u0-test`, ver `.agent/u0-isolated-override.yml`, no commiteado) con
  `DATA_DIR` en una carpeta vacía y el puerto de `web` remapeado a 8099 en vez de 8080 — **nunca se
  tocaron los contenedores de producción ni `./data`**. `GET /api/health` → `{"ok":true,"users":0}`,
  la SPA carga en `http://localhost:8099/`. Stack de prueba parado y borrado (`down`) al terminar.
  **Nota de Compose para el futuro:** el override de `ports` no reemplaza el mapeo del compose base
  por defecto — los concatena, y arrancar con los dos intenta ocupar también el puerto real y
  falla. Hace falta la etiqueta `!override` de la especificación de Compose (`ports: !override`)
  para reemplazar la lista entera; `volumes` sí se reemplaza por servicio sin necesitar la etiqueta.
- `.gitignore` de esta rama recibe `.agent/` (ficheros de planes de agentes, igual que en el fork
  original) — commit `6f17fe4` en `rebase/v1.3.7`, un fichero, no fusionado a `develop`.

### Trabajo aparecido después de U0: el silenciado de Strava (2026-09-21)

El dueño avisó de que había trabajo de otra sesión en la rama `claude/strava-hidden-workouts-la63cn`
(un commit, `be89ea8`), **que no estaba en `main`, ni en `develop`, ni en la etiqueta
`v1.2.9-fork-final`**. Eso convertía la etiqueta de retorno en un punto de retorno incompleto y, peor,
**U3 lo habría perdido en silencio**: su brief dice sacar los ficheros de Strava de esa etiqueta.
Es exactamente el riesgo "se pierde algo del fork sin que nadie lo note" de la tabla de
`PLAN-UPSTREAM.md`, y solo se evitó porque el dueño lo mencionó. **Lección de proceso: antes de cada
tarea del ciclo 6, `git fetch origin --prune` y mirar si hay ramas que la etiqueta no contenga.**

Qué arregla (resumen; el detalle está arriba, en la sección de `STRAVA_HIDE_FROM_HOME`): el
silenciado solo se intentaba dentro de la petición de subida, y como necesita el `activity_id` —que
no existe hasta que Strava termina de procesar— el caso **normal** era no silenciar nunca, devolviendo
un `200` limpio que ningún cliente lee. Ahora lo pendiente se persiste en `strava-mutes-<uid>.json` y
lo reintenta un barrido de fondo (15 s de base, 8 intentos, abandono a los 30 min), que sobrevive a un
reinicio. Un duplicado también se silencia ahora: su id vive dentro del texto del error.

Consecuencias para el resto del ciclo 6, ya comprobadas:
- **U3:** los ficheros de Strava se traen de `v1.2.9-fork-strava` (etiqueta nueva, ver abajo), **no**
  de `v1.2.9-fork-final`. Añade tres ganchos de prueba a los tres que ya había:
  `STRAVA_MUTE_SWEEP_MS`, `STRAVA_MUTE_RETRY_BASE_MS` y `STRAVA_MUTE_MAX_AGE_MS`.
- **U4:** **no añade ningún módulo nuevo a `api/`**, así que el riesgo del `COPY` uno a uno del
  `api/Dockerfile` no cambia. Sí toca `.env.production.example`, que U4 posee.

> **Forma exacta del riesgo del `api/Dockerfile`, comprobada el 2026-09-21** (hasta ahora estaba
> descrito de memoria y a medias). Los dos lados no hacen lo mismo:
> - **El fork** ya lo resolvió: `COPY *.js ./` seguido de `RUN rm -f *.test.js`. Con comodín no se
>   puede dejar fuera un módulo — es el arreglo de la tarea FX (`a9aa113`).
> - **Upstream v1.3.8 los enumera**: `COPY server.js push-messages.js verify-error.js ./` más
>   `COPY coach ./coach`.
>
> Como el rebase **parte de upstream**, se parte de la versión enumerada: `link.js` y `strava.js`
> se quedarían fuera de la imagen y la API entraría en bucle de reinicio con `ERR_MODULE_NOT_FOUND`,
> con las dos suites en verde. U4 tiene que decidir explícitamente entre enumerar también los
> módulos propios o adoptar el comodín del fork, y dejar dicho cuál eligió.
- **U5:** aparece un fichero de runtime por perfil, `strava-mutes-<uid>.json`, que el recon de U5
  debe incluir en la lista de "campos y ficheros aditivos del fork que tienen que sobrevivir".
  `scripts/backup.sh` ya lo cubre: empaqueta `data/` entero.

**Etiqueta `v1.2.9-fork-strava`**: el estado completo del fork, este arreglo incluido. Es la que usan
U1–U6 para restaurar ficheros propios. `v1.2.9-fork-final` se conserva como punto de retorno de `main`
anterior a este despliegue, pero **está incompleta**: no la uses para restaurar nada.

### U1 (2026-09-21) — hallazgos

Cifras: **api 256 tests / 239 pasan** (los 17 fallos siguen siendo los del entrenador IA de
upstream, intactos) y **frontend 1599 / todos pasan**. La línea base era 193/176 y 1584.

- **Los tests propios del fork NO se estaban ejecutando, y nadie lo habría notado.** Upstream movió
  su suite a `api/test/` y `npm test` solo corre `test/*.test.js`; los ficheros de test propios
  venían de la raíz de `api/`, donde el comando ya no mira. Se movieron a `api/test/` y se adaptaron
  sus rutas al patrón de `test/server-pairing.test.js`. **Sin esto habríamos tenido 55 tests de
  seguridad fantasma dando cobertura falsa.** Cualquier tarea que traiga tests del fork
  (U2 y U3 traen muchos) tiene que comprobar que acaban en `api/test/` y que **el conteo total sube**.
- **Dos agujeros que el fork tenía desde v1.2.9 y que la revisión Opus destapó.** No son regresiones
  del rebase: estaban en producción.
  1. **Un challenge de vinculación se podía canjear en `/api/register/verify`.** Ese challenge lleva
     un `uid` real, así que la guarda `!c.uid` de upstream lo dejaba pasar: habría creado un usuario
     duplicado y **sin quemar el código**. Arreglado con `|| c.link`.
  2. **Carrera en el "un solo uso".** Entre validar el código y quemarlo había un
     `await verifyRegistrationResponse`, así que dos canjes simultáneos del mismo código pasaban los
     dos y plantaban dos credenciales. Ahora `redeemLink()` funde revalidar+quemar en una sola
     llamada síncrona, invocada **después** del `await` y sin nada asíncrono hasta `db.creds.push`.
- **Esa invariante está vigilada por una aserción sobre la forma del código**
  (`link/verify keeps redeem and credential-insert in one synchronous run`), no por un test de
  comportamiento: llegar a esa rama por HTTP exige una ceremonia WebAuthn real, así que un `await`
  introducido ahí mañana dejaría las 256 pruebas en verde y la carrera volvería en silencio. Si
  alguien reordena esa ruta, el test dirá exactamente por qué se queja.
- **`user.disabled` no se comprobaba** en `link/options` ni `link/verify`, mientras todas las rutas
  hermanas sí. Un código vivo de una cuenta recién deshabilitada plantaba una passkey **permanente**:
  la sesión era inerte, pero al rehabilitar la cuenta el dispositivo entraba. Ahora se comprueba, con
  el **mismo error genérico** para no distinguirlo de un código incorrecto.
- **`logout/all` no revocaba los códigos de vinculación.** Upstream sí borra allí los de pairing, y
  uno de vinculación es más potente (da credencial permanente, no un token). Es justo el botón que
  se pulsa cuando crees que te han visto el código. Ya los borra, y un test comprueba que **no** toca
  los de otros usuarios.
- **El límite de intentos global tiene un coste que el comentario negaba.** Cualquiera sin sesión
  puede mandar 10 cuerpos basura a `/api/link/options` y dejar la vinculación apagada 15 minutos,
  repetible indefinidamente. **El diseño global se mantiene** (uno por código no contaría nada: quien
  ataca prueba códigos inexistentes), pero el comentario de `api/link.js` ya no dice que salga gratis.
- **`MOBILE` es un flag de compilación (`VITE_MOBILE`), no "el usuario va en un móvil".** Marca la
  build de Capacitor. La sección de dispositivos se oculta con `!MOBILE && !DEMO`, lo cual **sí** la
  muestra en la PWA del dueño. No confundir estas dos cosas al revisar UI en U2/U3.
- La vinculación **convive** con `/api/pair/*` de upstream, que quedó intacto (verificado: las únicas
  líneas tocadas en su vecindad son una coma de lista y las dos rutas nuevas en `CSRF_EXEMPT`).

### U2–U6 (2026-09-21) — hallazgos

Estado al cerrar U6: **api 414 tests / 397 pasan**, **frontend 1734 / todos pasan**. Los 17 fallos
de api son siempre los mismos de upstream (entrenador IA que asume Linux) y **no aumentaron ni una
vez** en todo el ciclo. Línea base de partida: 193/176 y 1584.

**U2 — notificaciones (`a06e258`)**
- Se partió de lo de upstream y se le añadió lo propio, no al revés. Conservado de upstream: timer
  por dispositivo, el arreglo #239 (el aviso saltaba con las notificaciones apagadas), la ventana
  del recordatorio, `pushsubscriptionchange` y la poda del 403.
- **Quitado el `web_push: 8030`**, que era el objetivo de la fase: ese número hace que Safari pinte
  la push en nativo **sin ejecutar el service worker**, lo que dejaría fuera del iPhone todo lo que
  se haga en `sw.js` — lo de upstream incluido. `navigate` no dependía de él y se conserva.
- **El opt-out de push del fork NO se trajo, y está comprobado que no hace falta.** El fork lo
  necesitaba porque su auto-reparación **suscribía desde cero**, así que reactivaba a quien acababa
  de apagarlo. La de upstream (`syncPushSubscription`) **sale antes si no hay suscripción**: solo
  repara una existente, nunca crea una. Verificado leyendo `disablePush()`, que sí desuscribe de
  verdad. Apagar el interruptor se queda apagado.
- Se reaplicó el arreglo N1: `stopRest()` cancelaba la push programada también cuando el descanso
  terminaba solo, y ese aviso es el que de verdad se oye con cascos.

**U3 — Strava (`ade2d73`)**
- Enganchado al flujo **nuevo** de sincronización: ya no es "el último gana", hay `_rev` y fusión,
  así que la subida automática lee la lista ya fusionada como cualquier otro lector.
- La revisión Opus encontró tres cosas, todas arregladas:
  1. **`recordStravaUpload` escribía sin protección.** Si esa escritura fallaba, el entrenamiento
     ya estaba en Strava pero sin registrar → 500 → el cliente reintentaba → **segunda subida real**.
  2. **`queueStravaMute` igual**, convirtiendo un fallo cosmético en un error que gastaba uno de los
     3 intentos de un entrenamiento ya subido.
  3. **El log de auditoría se podía vaciar desde fuera:** `/api/strava/callback` no pide sesión y
     escribía una entrada por intento; con el tope de 5000, un bucle de `curl` expulsa las entradas
     viejas y borra el rastro de un incidente. Ahora los fallos **anteriores** a validar el `state`
     van a `console.warn`, que es el criterio que el propio fichero ya usaba en `csrfOk`.

**U4 — despliegue (`47c0288`)**
- **El riesgo del `api/Dockerfile` era real y estaba activo.** Upstream enumera los módulos uno a
  uno, así que `link.js` y `strava.js` **no habrían entrado en la imagen**: la API en bucle de
  reinicio con `ERR_MODULE_NOT_FOUND` y las dos suites en verde. Se pasó a comodín
  (`COPY *.js ./` + `rm -f *.test.js`), y **se verificó construyendo la imagen y listando su
  contenido**, no leyendo el Dockerfile.
- `docker-compose.yml` solo recibe los `args` de versión, y es legítimo: **upstream ya declara esos
  `ARG`** para sus etiquetas OCI y `auto-deploy.ps1` los exporta esperando que compose los reenvíe.
- El runbook decía que la sincronización es "el último gana", **que ya es falso**. Corregido contra
  el código (`_rev`, 409 sobre documento obsoleto, fusión por `_ts` más reciente).

**U5 — migración de datos (`c71e2cc`)**
- **`rest: 0` NO significa lo mismo en los dos lados, y esto era una pérdida silenciosa.** Upstream
  hace `own > 0 ? own : global`, así que un 0 lo lee como "no configurado"; en el fork significaba
  "sin descanso, no arranques cronómetro". El perfil real tenía **10 ejercicios así**.
  **Decisión del dueño (2026-09-21): que caigan al global de 90 s**, en vez de tocar la función de
  upstream. Por eso el migrador **elimina el campo** en lugar de escribir un 0 que se leería al revés.
- Cifras reales verificadas sobre copia: **277 entrenamientos** (no 271, el perfil creció), 4 rutinas,
  **26 ejercicios convertidos**, 10 descartados, y todo lo que está fuera de `routines` idéntico.
- El script es idempotente, se niega a pisar el destino, tolera un BOM de entrada y nunca escribe uno.

**U6 — comentarios (`3c87d3a`)**
- 194 líneas de comentario fuera, **cero líneas de código**. Verificado mecánicamente: quitando
  comentarios y espacios a las dos versiones, los 6 ficheros salen **byte a byte idénticos**. Un
  vistazo al diff no habría demostrado eso.
- Solo ficheros **creados** por el fork. Ni uno de upstream, ni siquiera los que llevan un enganche
  propio dentro.

### Verificación final de integración (2026-09-21)

Lo que ningún test alcanza, hecho antes de entregar U7: **pila completa levantada con el perfil real
migrado**, en un proyecto Docker aparte (`-p opengym-u7-check`, puerto 8098, datos en `.agent/`),
**sin tocar producción ni `data/`**. Resultado:
- La API arranca y **no** entra en bucle de reinicio; **cero `ERR_MODULE_NOT_FOUND`** en los logs.
- `/api/health` responde con el perfil cargado y la SPA sirve 200.
- Las rutas propias están registradas de verdad (`/api/link/code`, `/api/devices`,
  `/api/strava/status` responden **401**, no 404 — prueba de que `link.js` y `strava.js` cargaron).
- Un código de vinculación inválido devuelve el error genérico esperado.
- Comprobado después: producción intacta y `data/` sin un byte modificado.

### Inestabilidad conocida, no es nuestra

`frontend/src/lib/pt-br-instructions.test.js` es **de upstream** (sin tocar) y tarda ~5,5 s contra el
límite por defecto de 5 s de vitest. **Falla de forma intermitente cuando la máquina va cargada**,
de forma reproducible si se lanza justo después de la suite de API. Si aparece, relanzar la suite de
frontend a solas. No hay timeout configurado en el proyecto, así que rige el defecto.

### Despliegue del ciclo 6 (2026-09-21 18:27)

**`main` = `develop` = `ecc726c`**, desplegado y sirviendo.

- **`develop` y `main` NO se fusionaron de la forma normal, y esto hay que saberlo.** Un merge de tres
  vías intentaba recombinar el fork viejo (base v1.2.9) con los 463 commits de upstream sobre los
  mismos ficheros: **34 ficheros en conflicto**, y habría revivido el código que el ciclo 6 tiró a
  propósito. Es el mismo merge que `PLAN-UPSTREAM.md` declaró inviable. Se hizo en su lugar
  `git merge --no-commit -s ours <rama>` + `git read-tree -m -u <rama>` + commit: un commit de fusión
  con **los dos padres** cuyo árbol es **exactamente** el de la rama del rebase (verificado con
  `git diff <rama> HEAD` vacío). El fork anterior sigue alcanzable por el primer padre y por las
  etiquetas `v1.2.9-fork-final` y `v1.2.9-fork-strava`.
- **Efecto colateral que hubo que reparar:** al tomar el árbol entero, desaparecieron del tip los
  ficheros que upstream nunca tuvo — **`ESTADO.md`, `PLAN.md`, `PLAN-UPSTREAM.md`,
  `PLAN-NOTIFICACIONES.md` y `plans/ppl-banca-100kg.json`** (el plan exportado del dueño). Restaurados
  desde `82313ae`. **Si se repite esta maniobra, restaurarlos explícitamente después.**
- **Lo demás que desapareció, desapareció bien:** los tests del descanso por ejercicio del ciclo 2,
  los del marcador de versión (N6) y el de sustituir ejercicio — las tres funciones que el plan decidió
  tirar porque upstream ya las trae. Los tests de push de `api/` no se perdieron: **se movieron** a
  `api/test/`, que es donde `npm test` mira. `frontend/src/lib/session-entry.js` quedó fuera y
  **no lo referencia nadie** en el árbol actual.
- **B1 verificado y cerrado sin reaplicar nada.** El plan pedía comprobar si el fallo del buscador
  (un ejercicio personalizado incompleto tumbaba la pantalla) seguía existiendo en upstream. **No
  existe:** `searchScore` normaliza el objeto de entrada y pasa cada campo por `searchableText`, que
  devuelve `''` ante `null`/`undefined`, y el bucle salta los vacíos. El arreglo propio sobraba.
- **Migración de los datos reales, con la API parada** (`docker compose stop api`) para que el móvil
  no escribiera a la vez. Cifras del momento: **278 entrenamientos** (habían crecido desde los 277 de
  la mañana), **27 descansos convertidos**, 9 descartados por valer 0. Antes de sustituir el fichero
  se guardó copia aparte en `~/opengym-backups/state-pre-migration-<fecha>.json`, además del backup
  completo del directorio.
- **Comprobado tras desplegar:** `deploy OK` en el log, contenedores arriba, `/api/health` respondiendo,
  SPA en 200, **cero `ERR_MODULE_NOT_FOUND`**, y las tres familias de rutas propias vivas
  (`/api/link/code`, `/api/devices`, `/api/strava/status` → 401, no 404).
- **U7 sigue pendiente a propósito.** El dueño pidió desplegar sin hacer antes la aceptación manual.
  Queda por comprobar usando la app de verdad: una sesión completa con notificación de descanso con el
  móvil en otra app, la subida a Strava, y **vincular desde un dispositivo realmente distinto** (una
  ventana de incógnito no vale: comparte el almacén de passkeys del sistema). Ese paso lleva pendiente
  desde la Fase A del ciclo 1.
- **Vuelta atrás:** `git checkout v1.2.9-fork-final`, restaurar `data/` del backup del 2026-09-21 y
  relanzar `scripts/auto-deploy.ps1`.

## Registro

| Fecha | Qué |
|-------|-----|
| 2026-09-04 | Rama `develop` creada desde `main`. `PLAN.md` y `ESTADO.md` escritos. |
| 2026-09-07 | Ciclo 4 planificado: `PLAN-NOTIFICACIONES.md`. N0 cerrado en el móvil. N1 fusionado. |
| 2026-09-21 | Ciclo 6, U0 hecho: rama `rebase/v1.3.7` desde upstream v1.3.8, backup y etiqueta de retorno, línea base medida (1584 front / 176 de 193 api), stack de upstream verificado en Docker aislado sin tocar producción. |
| 2026-09-21 | Ciclo 6 **desplegado** (`ecc726c`): upstream v1.3.8 de base con las funciones propias encima y los datos reales migrados (278 entrenamientos). U7 (aceptación manual) pendiente. |
| 2026-09-21 | U2–U6 hechos: notificaciones, Strava, despliegue, migración de datos y limpieza de comentarios. Ciclo 6 con todo el código dentro (`3c87d3a`). api 414/397, frontend 1734. Pila levantada con el perfil real migrado, sin tocar producción. Queda U7 (aceptación manual del dueño). |
| 2026-09-21 | U1 hecho: vinculación y gestión de dispositivos sobre upstream v1.3.8 (`739d845`). Dos agujeros de seguridad del fork original destapados y cerrados. api 256/239, frontend 1599. |
| 2026-09-21 | Arreglo del silenciado de Strava (`be89ea8`) rescatado de una rama suelta, fusionado a `develop` y desplegado a `main`. Etiqueta `v1.2.9-fork-strava` creada como el estado completo del fork para U1–U6. |
