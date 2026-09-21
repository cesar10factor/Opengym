# PLAN — Subir el fork a upstream v1.3.7

> Documento de trabajo del fork, subordinado a `PLAN.md` (reglas de git, formato de brief y
> presupuesto son las de allí, no se repiten aquí). El estado vive en `ESTADO.md`, ciclo 6.

## Contexto

El fork se clonó de upstream en `f8024d3` (v1.2.9+1, 23-ago-2026). Upstream va por **v1.3.7**
(12-sep-2026): **463 commits, 15 releases, 374 ficheros, +75.619 líneas**.

El fork tiene 110 commits propios: **90 ficheros, +13.375 / −128**. Ese −128 es el dato que manda:
**el fork es aditivo**. 53 de los 90 ficheros son nuevos, y de los modificados casi todo son
líneas añadidas (`api/server.js`: +952 / −15, rutas nuevas colgadas del despachador existente).

## La decisión de fondo: no se fusiona, se rebasa

Un `git merge upstream/main` es inviable: los dos lados han reescrito los mismos seis ficheros
(`server.js`, `useStore.js`, `Settings.jsx`, `sheets.jsx`, `useUI.js`, `sw.js`), upstream con
+1.482 líneas sobre ellos. Sería resolver conflictos a ciegas sobre código que nadie de este lado
ha leído.

**Lo que se hace:** upstream v1.3.7 pasa a ser la base, y las funciones propias se **vuelven a
aplicar encima**, una por una, con un brief cada una. Es viable precisamente porque son aditivas:
casi todo vive en ficheros nuevos que upstream no toca, más un puñado de enganches.

Consecuencia aceptada: **se pierde la historia de los commits propios sobre esos ficheros.** El
trabajo se conserva; el historial de cómo se llegó a él, no. `ESTADO.md` ya guarda el porqué de
cada decisión, que es lo que de verdad importaba de ese historial.

## Decisiones del dueño (2026-09-20, no reabrir)

1. **Donde upstream ya lo tiene, gana upstream.** Se descartan las implementaciones propias
   duplicadas (ciclo 2 completo, N6, sustituir ejercicio). Menos código propio que mantener y
   menos fricción en cada actualización futura.
2. **La limpieza de comentarios es solo sobre código propio.** Ni una línea de upstream se
   reescribe por estilo: cada fichero de upstream que se toque por gusto convierte un `git pull`
   futuro en trabajo manual para siempre.
3. **Push: se quita el `web_push: 8030` y se conserva `navigate`.** Ver U2.

## Qué se conserva, qué se tira

| Trabajo propio | Qué pasa | Por qué |
|---|---|---|
| Vinculación de dispositivos (T1–T5) | **se conserva** | El `/api/pair/*` de upstream da un token Bearer para la app Capacitor, vive en memoria y caduca a los 5 min. No registra passkey en un perfil existente: no sirve para el iPhone |
| Gestión de dispositivos (`/api/devices`) | **se conserva** | Upstream no tiene nada equivalente |
| Strava, ciclo 3 entero (T10–T14) | **se conserva** | Upstream no tiene Strava |
| Notificaciones N1, N2, N4 + B3 + B4 | **se conserva, adaptado** | Upstream arregla parte de lo mismo de otra forma. Ver U2 |
| N3 Declarative Web Push | **se conserva a medias** | Se queda `navigate`, se va el `8030`. Ver U2 |
| Despliegue doméstico (túnel, runbook, backup, auto-deploy) | **se conserva** | Es infraestructura propia, upstream no la toca |
| Descanso por ejercicio (ciclo 2: T7, T8, T9) | **se tira** | Upstream lo trae desde v1.2.14 como `restSec`, y además con descanso de calentamiento (`warmupRestSec`), que el propio no tiene |
| Marcador de versión (N6) | **se tira** | Upstream muestra la versión al pie de Ajustes desde v1.2.11 |
| Sustituir ejercicio a mitad de entreno (`44f384e`) | **se tira** | Upstream trae mover y sustituir desde v1.2.14 (!41, !43) |
| Arreglo del buscador (B1) | **recon primero** | Upstream reescribió la búsqueda en v1.2.10 y normaliza ejercicios personalizados. Comprobar si el fallo ya no existe antes de reaplicar nada |

## Reglas duras de todo este plan

Las de `PLAN.md`, más estas cuatro, que son propias de un rebase:

- **No se toca ningún fichero de upstream salvo para enganchar una función propia.** Nada de
  reordenar, renombrar ni reformatear. Un enganche es una línea de importación, una ruta añadida
  a la tabla, una fila en una pantalla. Si un agente cree que necesita reescribir algo de
  upstream, **para y lo reporta**.
- **El comportamiento de upstream manda en los empates.** Si la función propia y la de upstream
  se pisan, se adapta la propia.
- **Nada se da por bueno de memoria.** Cada brief empieza leyendo el código de upstream v1.3.7:
  los nombres, las firmas y los patrones han cambiado en 463 commits.
- **Los datos reales no se tocan hasta U5**, y solo sobre una copia. El perfil bueno tiene 271
  entrenamientos.

---

# U0 — Preparación y red de seguridad

**Rama:** `rebase/v1.3.7` · **Depende de:** nada · **Modelo:** ninguno, lo hace el orquestador

Sin agente: son comandos, y equivocarse aquí cuesta los datos.

1. **Copia de seguridad de `data/` fuera del repositorio**, con fecha. `scripts/backup.sh` ya lo
   hace; se ejecuta y se comprueba que el archivo existe y abre.
2. Etiquetar el estado actual: `git tag -a v1.2.9-fork-final -m "fork sobre upstream v1.2.9,
   antes del rebase a v1.3.7"` y subir la etiqueta. Es el punto de retorno si esto sale mal.
3. Añadir el remoto: `git remote add upstream https://github.com/DuarteSantos8/openGym.git`,
   `git fetch upstream --tags`.
4. Crear la rama de trabajo **desde upstream**: `git checkout -b rebase/v1.3.7 upstream/main`.
5. **Línea base verde de upstream, sin nada propio encima**: `cd frontend; npm install; npm test`
   y `cd api; npm install; npm test`. Anotar los números en `ESTADO.md`. Si upstream no está
   verde en esta máquina, **se para y se avisa**: no se construye sobre un árbol roto, y todo lo
   que venga después se mide contra esta cifra.
6. Levantar upstream limpio con Docker y abrirlo una vez, sin datos propios. Es la comprobación de
   que la base funciona antes de empezar a colgarle cosas.

**CHECKS**
```json
{ "data_backed_up": true, "fork_tagged": true, "upstream_remote_added": true,
  "branch_from_upstream_main": true, "upstream_baseline_green": true, "baseline_counts_recorded": true }
```

---

# U1 — Vinculación y gestión de dispositivos

**Rama:** `rebase/u1-linking` · **Depende de:** U0 · **Modelo: Sonnet** + revisión Opus

Es la función más sensible del fork: abre una cuenta con un código de 8 caracteres. Por eso lleva
revisión Opus, como ya la llevó la primera vez.

**DECISIÓN**
Volver a aplicar T1–T5 sobre upstream v1.3.7: `api/link.js` con su lógica pura, las tres rutas de
vinculación, `GET`/`DELETE /api/devices`, y la interfaz en `Login.jsx` y `Settings.jsx`. El código
propio existe y funciona; lo que cambia es dónde se engancha.

**FICHEROS QUE POSEES**
- `api/link.js`, `api/link.test.js`, `api/link.integration.test.js`, `api/devices.integration.test.js`
  (se traen del fork tal cual)
- `api/server.js` (**solo para añadir**: rutas nuevas y el podado de `db.links` al arrancar)
- `frontend/src/lib/link.js`, `link.test.js`, `devices.js`, `devices.test.js` (tal cual)
- `frontend/src/lib/api.js`, `views/Login.jsx`, `views/Settings.jsx`, `lib/i18n.js` o el pack
  español (**solo para añadir**)

**INTENCIÓN**
1. Traer los ficheros nuevos del fork sin tocarlos: `git checkout v1.2.9-fork-final -- <rutas>`.
2. **Recon obligatorio antes de editar `server.js`.** Upstream ha cambiado: sesiones con token
   Bearer además de cookie, `readSession`, el guardado de credenciales, `audit`, y ha añadido
   `/api/pair/*`. Leer cómo lo hace hoy y seguir **ese** patrón, no el del fork.
3. `POST /api/link/verify` debe emitir sesión **como lo hace upstream hoy** (mira qué devuelve
   `/api/pair/redeem` y qué `/api/register/verify`), no como lo hacía en v1.2.9.
4. La vinculación **convive** con `/api/pair/*`: son cosas distintas y ninguna sustituye a la otra.
   No se toca el pairing de upstream.
5. En la interfaz: **añadir filas, no reorganizar**. `Settings.jsx` de upstream ha crecido +390
   líneas y tiene secciones nuevas; se busca dónde encaja y se mete ahí.

**REGLAS DURAS ADICIONALES**
- El límite de intentos sigue siendo **global a la instancia**, no por código. Está razonado en
  `PLAN.md` T1: quien ataca prueba códigos inexistentes y un contador por código nunca sube.
- El mensaje de error es **idéntico** para código inexistente, caducado y estrangulado.
- `link/verify` **nunca** crea un usuario nuevo.
- No se puede borrar la última credencial de un perfil.

**VERIFICACIÓN**
`cd api; npm test` y `cd frontend; npm test`, ambos **por encima de la línea base de U0**.
Los tests del fork vienen incluidos y deben pasar sin relajar ninguna aserción. Si uno falla por
un cambio legítimo de upstream, se arregla el test explicándolo en el reporte; **no se borra**.

**CHECKS**
```json
{ "link_files_restored": true, "routes_follow_upstream_patterns": true, "pairing_untouched": true,
  "link_verify_never_creates_user": true, "error_message_uniform": true, "global_throttle_kept": true,
  "last_device_delete_blocked": true, "upstream_files_only_added_to": true, "tests_above_baseline": true }
```

**Revisión Opus** con el guion de `PLAN.md`, atención especial a: caducidad y un solo uso de los
códigos, límite de intentos, que no se filtren datos de otros usuarios, y que no pueda quedar un
perfil sin credenciales.

---

# U2 — Notificaciones

**Rama:** `rebase/u2-push` · **Depende de:** U1 · **Modelo: Sonnet**

**DECISIÓN**
Upstream ha arreglado parte de lo mismo por su cuenta y tiene cosas que el fork no tiene (timer de
descanso por dispositivo, recordatorio con ventana de 15 min, auto-reparación de la suscripción,
`pushsubscriptionchange`, poda del 403). **Se parte de lo de upstream** y se le añade solo lo que
el fork tiene de más.

**Lo que aporta el fork y upstream no tiene:**
- **TTL por tipo de aviso** (B3). Upstream sigue con el defecto de `web-push`: cuatro semanas, con
  el mismo comentario viejo que justificaba dejarlo. Es el fallo de los avisos en bloque.
- **Cabecera `Topic`** para que un aviso encolado reemplace al anterior.
- **`next-up.js`**: el cuerpo de la notificación dice qué ejercicio y qué serie tocan.
- **`navigate`**: tocar la notificación abre `/#/workout`.
- **Cierre de notificaciones de otra etiqueta** (B4). Upstream solo cierra las de la misma.

**Lo que se tira del fork:** el número mágico `web_push: 8030`.

> **El porqué, que es el punto entero de esta fase.** Lo único que impide que Safari ejecute el
> service worker es ese `8030`: con él, iOS pinta la notificación en nativo y el service worker no
> corre, así que nada de lo que upstream haga ahí —ni el cierre de notificaciones, ni lo que venga
> después— llega al iPhone. El campo `navigate` **no** depende del sobre declarativo: `sw.js` ya lo
> lee del payload plano. Quitando solo el número mágico se conservan las dos cosas.

**FICHEROS QUE POSEES**
- `api/server.js` (zona de push), `frontend/public/sw.js`, `frontend/src/store/useUI.js`,
  `frontend/src/lib/push.js`
- `frontend/src/lib/next-up.js` + su test (del fork, tal cual)
- Los tests de push del fork: `push-payload.integration.test.js`, `rest-timer.integration.test.js`,
  `rest-body.integration.test.js`, `useUI.rest-push.test.js`, `useUI.next-up.test.js`,
  `useUI.push-repair.test.js`, `useUI.rest-notification.test.js`, `sw.test.js`

**INTENCIÓN**
1. **Recon primero:** leer entero el camino de push de upstream. Tiene token por dispositivo en el
   timer de descanso; el `next-up` del fork tiene que entrar en **ese** modelo, no reponer el de
   un timer por usuario.
2. TTL por emisor: descanso = `REST_TIMER_MAX_LATE_MS / 1000`, recordatorio = 3 h, por defecto 60 s.
   Cabecera `Topic` = el `tag`, validada contra `[A-Za-z0-9\-_]{1,32}` porque `web-push` **lanza
   excepción** con un topic inválido y eso costaría la notificación entera.
3. El aviso local (`maybeRestNotification`) lleva el mismo `tag` que la push y el mismo texto, sin
   `renotify`.
4. `sw.js`: cerrar las notificaciones de **otra** etiqueta antes de pintar; las de la misma se
   dejan para que `showNotification` las reemplace sola. Leer `navigate` de las dos formas de
   payload. `showNotification` siempre se alcanza y siempre dentro de `waitUntil`.
5. **Invariante que no se negocia:** toda push entregada pinta una notificación visible. iOS revoca
   la suscripción si no, en silencio.

**VERIFICACIÓN**
Ambas suites por encima de la línea base. Los tests de entrega del fork (TTL, urgencia, topic)
tienen que seguir fijando los mismos números.

**CHECKS**
```json
{ "upstream_push_improvements_kept": true, "per_emitter_ttl": true, "topic_header_set": true,
  "topic_validated": true, "next_up_body_on_upstream_timer_model": true, "declarative_magic_removed": true,
  "navigate_still_works": true, "cross_tag_close": true, "local_alert_tagged": true,
  "visible_notification_invariant_held": true, "tests_above_baseline": true }
```

---

# U3 — Strava

**Rama:** `rebase/u3-strava` · **Depende de:** U2 · **Modelo: Sonnet** + revisión Opus

**DECISIÓN**
El ciclo 3 entero vuelve tal cual: es la parte más aislada del fork. `api/strava.js`, las rutas de
OAuth y subida, el mapeo de 1.324 ejercicios, la construcción del payload y la subida automática.
Upstream no tiene nada de esto, así que no hay nada que conciliar salvo los enganches.

**FICHEROS QUE POSEES**
Todos los `strava-*` del fork (9 ficheros entre `api/` y `frontend/src/lib/`, con sus tests),
más `api/server.js`, `frontend/src/lib/api.js`, `frontend/src/store/useStore.js` y
`frontend/src/views/Settings.jsx` **solo para añadir**.

**INTENCIÓN**
1. Traer los ficheros nuevos sin tocarlos. `strava-exercises.js` es el vocabulario verificado
   identificador a identificador contra la web de Strava: **no se regenera, no se revisa, no se
   toca**. Costó 5 rondas y 4 revisiones.
2. **Recon de `useStore.js`, que es lo que más ha cambiado** (+469 líneas): la sincronización ya no
   es "el último gana", ahora hay `_rev`, fusión de copias y sondeo. El enganche de la subida
   automática al terminar un entrenamiento tiene que entrar en el flujo nuevo.
3. **Atención al antiduplicados.** Los ids de entrenamientos ya subidos viven **en el servidor**,
   no en el estado del cliente, precisamente porque el estado era "el último gana". Con la fusión
   nueva de upstream la razón sigue valiendo: se queda en el servidor.
4. Los tokens no salen nunca del servidor en ninguna respuesta. El `state` del OAuth sigue siendo
   firmado, caducado y de un solo uso.
5. Mantener los tres ganchos de prueba (`STRAVA_API_BASE`, `STRAVA_TIMEOUT_MS`,
   `STRAVA_UPLOAD_POLL_DELAY_MS`) y el silenciado en el feed (`STRAVA_HIDE_FROM_HOME`).

**REGLAS DURAS ADICIONALES**
- La subida va a `/api/v3/uploads` como **multipart/form-data**, no JSON a `/uploads`. Los dos
  fallos que solo aparecieron usando la app de verdad; están documentados en `ESTADO.md`.
- Toda llamada saliente lleva timeout de 8 s. Node no pone ninguno.

**CHECKS**
```json
{ "strava_files_restored": true, "vocabulary_untouched": true, "all_1324_resolve": true,
  "upload_is_multipart_v3": true, "dedupe_stays_server_side": true, "autoupload_hooked_into_new_sync": true,
  "tokens_never_in_responses": true, "outbound_timeouts_present": true, "tests_above_baseline": true }
```

**Revisión Opus:** manejo del token, el `state` del OAuth y que no se pueda subir dos veces.

---

# U4 — Despliegue doméstico

**Rama:** `rebase/u4-deploy` · **Depende de:** U3 · **Modelo: Haiku**

Mecánico: son ficheros propios que upstream no tiene y que casi no dependen del código. Haiku basta.

**FICHEROS QUE POSEES**
`docker-compose.tunnel.yml`, `scripts/auto-deploy.ps1`, `scripts/backup.sh`,
`.env.production.example`, `docs/DESPLIEGUE.md`, `.gitignore`, `api/Dockerfile`,
`docker-compose.yml`, `web/Dockerfile`.

**INTENCIÓN**
1. Restaurar los cinco primeros tal cual del fork.
2. **`api/Dockerfile` es el peligro real de esta fase.** Lista los módulos de runtime uno a uno en
   el `COPY`. Todo módulo nuevo de `api/` hay que añadirlo, **y ningún test lo detecta**: los tests
   importan del árbol de trabajo, donde el fichero sí está. Ya tumbó la API una vez con
   `ERR_MODULE_NOT_FOUND` mientras 55 tests seguían verdes. Comprobar que están `link.js` y
   `strava.js`, y cualquier módulo que upstream haya añadido por su cuenta.
3. Conciliar `docker-compose.yml` y `web/Dockerfile` con los de upstream: upstream también los ha
   tocado. **Gana upstream**; solo se le añade lo propio que falte.
4. `docs/DESPLIEGUE.md`: actualizar lo que haya dejado de ser cierto con v1.3.7 — como mínimo la
   sección de limitaciones conocidas, porque la sincronización ya **no** es "el último gana".

**VERIFICACIÓN**
`docker compose -f docker-compose.yml -f docker-compose.tunnel.yml config` válido,
`bash -n scripts/backup.sh`, y **levantar la pila de verdad** y pedir `/api/health`. Esta fase no
se da por buena con tests: se da por buena con un contenedor en pie.

**CHECKS**
```json
{ "deploy_files_restored": true, "dockerfile_lists_every_api_module": true,
  "compose_reconciled_with_upstream": true, "compose_config_valid": true, "stack_boots": true,
  "health_answers": true, "runbook_updated_for_v137": true }
```

---

# U5 — Migración de datos

**Rama:** `rebase/u5-data` · **Depende de:** U4 · **Modelo: Sonnet**

**DECISIÓN**
El perfil bueno tiene **271 entrenamientos** y lleva campos que solo existen en el fork. Upstream
v1.3.7 espera otra forma en dos sitios. Se migra una copia, se comprueba, y solo entonces toca los
datos buenos — y eso lo hace el dueño, no un agente.

**Lo que hay que migrar, confirmado:**
- **`rest` → `restSec`** en los ejercicios de las rutinas. El fork guardó el descanso por ejercicio
  como `rest`; upstream lo llama `restSec`. Sin migrar, cada rutina pierde su descanso en silencio
  y vuelve al global.
- **`rest: 0`** significaba "sin descanso" en el fork. Hay que comprobar qué hace upstream con
  `restSec: 0` y, si no coincide, decidir caso por caso. Está en `ESTADO.md` como decisión
  explícita del ciclo 2.

**Lo que hay que comprobar antes de migrar nada** (recon, y se reporta antes de tocar):
- `_rev`: upstream lo añade al documento. Un estado del fork no lo tiene. ¿Arranca igual?
- La forma de `db.json`: `links`, `linkFails`, `restTimers` y los campos de Strava son aditivos del
  fork y upstream no los conoce. Deben sobrevivir y no molestar.
- Los ejercicios personalizados del perfil `ZOI4Pp…`, que ya estuvieron dañados una vez.

**INTENCIÓN**
Un script en `scripts/migrate-to-v137.mjs`, **idempotente** (ejecutarlo dos veces da lo mismo que
una), que escribe a fichero nuevo y nunca sobre el original, y un test con un estado de ejemplo que
cubra: rutina con `rest`, rutina con `rest: 0`, rutina sin el campo, y superserie.

**REGLA DURA**
Nada de `Set-Content -Encoding utf8` de PowerShell sobre ficheros de `data/`: **añade un BOM
invisible** y `JSON.parse` lo rechaza. Ya dejó el servidor sin subir nada durante un rato. Node, o
`[System.IO.File]::WriteAllText` con `UTF8Encoding($false)`.

**VERIFICACIÓN**
Sobre una **copia** del perfil real: migrar, arrancar la pila, abrir la app y comprobar que los
271 entrenamientos están, que las rutinas conservan su descanso y que el historial se ve.

**CHECKS**
```json
{ "migration_idempotent": true, "never_writes_over_original": true, "rest_to_restSec": true,
  "zero_rest_decided_and_documented": true, "fork_db_fields_survive": true, "no_bom_written": true,
  "real_profile_copy_opens_with_271_workouts": true }
```

---

# U6 — Limpieza de comentarios

**Rama:** `rebase/u6-comments` · **Depende de:** U5 · **Modelo: Haiku**

**DECISIÓN**
Los comentarios del código propio son largos de más: bloques de 10-15 líneas explicando una
decisión que se cuenta en dos. Se resumen. **Solo en ficheros escritos por el fork.**

**FICHEROS QUE POSEES**
Solo ficheros **creados** por el fork. La lista cerrada sale de
`git diff --name-status v1.2.9-fork-final f8024d3 --diff-filter=A`. Ningún fichero de upstream,
**ni siquiera uno con un enganche propio dentro**.

> Esto es lo que hace que un `git pull` de la próxima versión de upstream siga siendo un `git pull`.
> Un comentario reescrito en un fichero de upstream es un conflicto garantizado, para siempre, a
> cambio de nada.

**INTENCIÓN**
- Un comentario de más de 8 líneas se resume a **3 como mucho**.
- **Se conserva siempre el "por qué", se tira el "qué".** Un comentario que repite lo que hace la
  línea siguiente sobra entero. Uno que explica por qué esa línea es así y no de la forma obvia se
  queda, aunque ocupe.
- Se conservan, recortados pero reconocibles: el invariante de iOS en `sendPush`, la obligación de
  llamar a `burnLink`, el aviso del BOM, y la razón por la que el estrangulador es global. Son
  cosas que alguien volvería a romper sin ellas.
- **Cero cambios de comportamiento.** Esta fase no toca una sola línea de código ejecutable.

**VERIFICACIÓN**
`git diff --stat` muestra solo líneas de comentario. Las dos suites siguen exactamente en el mismo
número que al terminar U5 — ni uno más ni uno menos. Y, como red:
`git diff -w --ignore-blank-lines` sobre el código sin comentarios debe salir vacío.

**CHECKS**
```json
{ "only_fork_authored_files": true, "no_upstream_file_touched": true, "no_executable_line_changed": true,
  "why_comments_kept": true, "test_counts_identical_to_u5": true }
```

---

# U7 — Aceptación manual y despliegue

**Depende de:** U6 · **Lo hace el dueño**, guiado por el orquestador

Nada se fusiona a `main` sin esto. Las dos suites en verde no dicen nada de lo que más falla:
`api/Dockerfile` tumbó la API una vez con 55 tests en verde, y los dos fallos de Strava solo
aparecieron usando la app.

1. Pila levantada con el perfil **migrado de verdad**: los 271 entrenamientos están.
2. Entrenar una sesión completa: marcar series, descanso, push con el móvil en otra app, tocarla y
   que entre en la pantalla de entreno.
3. Dos descansos seguidos: **una sola entrada** en la bandeja.
4. Terminar el entrenamiento: sube a Strava y sale bien en la actividad.
5. Generar código en Ajustes y vincular desde un autenticador **realmente distinto** — una ventana
   de incógnito no vale, comparte el almacén de passkeys del sistema. Sigue siendo el paso
   pendiente desde la Fase A del ciclo 1.
6. Modo avión: la app abre, se registra una serie, vuelve la red y sincroniza.
7. Lo nuevo de upstream que conviene mirar con datos reales: la **fusión** de dos dispositivos, y
   que el móvil y el escritorio dejen de pisarse.

Después: `rebase/v1.3.7` → `develop` → `main` → `auto-deploy.ps1`, y `ESTADO.md` cerrado.

---

# U8 — Entrenador IA (opcional, decide el dueño)

**Depende de:** U7 · **Modelo: Haiku** (es configuración, no código)

No condiciona nada de lo anterior: viene apagado y se enciende desde Ajustes → Admin.

Tres caminos, en orden de coste:
- **Ollama en local**, coste cero. Upstream mide una revisión en ~1 min con `qwen2.5:3b` en una VM
  de 4 núcleos sin GPU, con la caché de prefijo caliente.
- **`claude setup-token` con la suscripción Pro**. Necesita la imagen `coach`, más pesada y que
  lanza un proceso hijo en el contenedor. El gasto sale de los mismos límites que Claude Code.
- **Clave de API medida** de Anthropic, OpenAI o Gemini. Funciona con la imagen `api` por defecto,
  sin proceso hijo: es el camino más simple de operar.

---

## Orden y reparto de modelos

```
U0 (orquestador)  →  U1 (Sonnet + Opus)  →  U2 (Sonnet)  →  U3 (Sonnet + Opus)
                  →  U4 (Haiku)  →  U5 (Sonnet)  →  U6 (Haiku)  →  U7 (el dueño)  →  U8 (opcional)
```

**Todo secuencial.** Está anotado en `ESTADO.md` desde el 2026-09-04: dos agentes no pueden
trabajar en dos ramas del mismo árbol aunque toquen ficheros distintos, y un worktree por agente
complica el merge sin ahorrar créditos, solo reloj. Además aquí U2, U3 y U4 tocan `server.js`.

**Por qué cada modelo:**
- **Haiku** en U4, U6 y U8: restaurar ficheros, conciliar configuración y recortar comentarios. Son
  tareas con criterio de aceptación mecánico y comprobable — no hay que decidir nada.
- **Sonnet** en U1, U2, U3 y U5: hay que leer código ajeno que ha cambiado mucho y decidir dónde
  encaja lo propio.
- **Opus** solo para revisar U1 y U3, las dos que manejan credenciales.
- El orquestador escribe los briefs, lee los checks y los tests, decide y commitea. Los agentes no
  hacen commit.

## Riesgos

| Riesgo | Mitigación |
|---|---|
| `api/Dockerfile` deja fuera un módulo y la API entra en bucle de reinicio con los tests verdes | U4 lo comprueba explícitamente y U7 levanta la pila de verdad |
| La migración de datos estropea el perfil de 271 entrenamientos | Copia en U0, migración sobre copia en U5, y el original solo lo toca el dueño |
| Un agente "mejora" un fichero de upstream y envenena las actualizaciones futuras | Regla dura en cada brief; el check `upstream_files_only_added_to` y el diff lo cazan |
| Los tests del fork chocan con cambios legítimos de upstream | Se arreglan explicándolo, nunca se borran ni se relajan |
| En iPhone el service worker no se comporta como se espera | Solo se comprueba con un iPhone en la mano, en octubre. El resto del plan no depende de ello |
| Se pierde algo del fork sin que nadie lo note | El inventario de U0 es la lista contra la que se comprueba en U7 |
