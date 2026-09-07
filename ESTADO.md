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

## Registro

| Fecha | Qué |
|-------|-----|
| 2026-09-04 | Rama `develop` creada desde `main`. `PLAN.md` y `ESTADO.md` escritos. |
| 2026-09-07 | Ciclo 4 planificado: `PLAN-NOTIFICACIONES.md`. N0 cerrado en el móvil. N1 fusionado. |
