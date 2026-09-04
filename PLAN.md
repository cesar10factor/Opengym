# PLAN — Vinculación de dispositivos + despliegue en casa

> Documento de trabajo del fork. **Este fichero y `ESTADO.md` son la autoridad.**
> Una sesión nueva o un agente nuevo debe poder retomar el trabajo leyendo solo estos dos.

## Contexto

openGym se usará como **PWA autoalojada** en un servidor doméstico, no como APK.
Motivo: el dueño pasa de Android a iPhone en ~4 meses y iOS no permite sideloading.

Hecho verificado en el código: el registro de passkey **siempre crea un usuario nuevo**
(`api/server.js`, `db.users.push(user)` en `/api/register/verify`). No existe forma de añadir
un segundo dispositivo a un perfil existente. Sin eso, el iPhone no podrá entrar en el perfil
del Android — los datos seguirían en el servidor, pero inaccesibles desde el móvil nuevo.

**Objetivo de este plan:** añadir vinculación de dispositivos por código de un solo uso,
más gestión/revocación de dispositivos, y dejar el despliegue doméstico documentado y listo.

## Reglas de trabajo (obligatorias)

### Comunicación con el dueño
- Instrucciones **cortas**. Sin verborrea, sin adjetivos de relleno, sin recapitular lo obvio.
- Formato por paso: qué vas a hacer (1 línea) → lo haces → resultado (1-3 líneas).
- Cuando necesites que él haga algo manual, dilo como lista numerada de acciones concretas.
- Reporta lo que **verificaste** y lo que solo **crees**. No los mezcles.

### Git
- `main` **no se toca** hasta el final del despliegue completo.
- Todo el trabajo sale de `develop`.
- Una rama por tarea, creada **desde `develop`**: `feat/…` o `chore/…`.
- Al terminar una tarea: tests en verde → commit → push de la rama → merge a `develop`
  con `--no-ff` → push de `develop` → borrar la rama.
- `develop` → `main` **solo una vez**, al final, cuando todas las tareas estén en `done`.
- Commits y comentarios de código **en inglés** (el repo es inglés). Este plan, en español.
- Nunca `--force`. Nunca `--no-verify`.

### Agentes
- Antes de lanzar un agente, el brief ya está escrito en este fichero. No se improvisan briefs.
- El agente hace **su propia lectura del código**. No le des números de línea.
- Un solo escritor por conjunto de ficheros a la vez. Paralelo solo si tocan ficheros distintos.
- Cuando el agente reporte: mira el **JSON de checks** y la salida de los tests, no el diff completo.
- Si está mal, se le dice **exactamente** qué está mal al mismo agente y lo corrige él.
- El agente **no hace commit**. Commitea el orquestador, con rutas de fichero explícitas.

### Presupuesto
- No releer ficheros que ya están resumidos aquí.
- No lanzar agentes para tareas de una sola edición trivial: hazla directamente.

## Flujo git exacto por tarea

```powershell
# 1. Partir de develop actualizado
git checkout develop
git pull --ff-only origin develop

# 2. Rama de la tarea
git checkout -b feat/<nombre>

# 3. (trabajo del agente)

# 4. Tests — deben pasar antes de commitear
cd frontend; npm test; cd ..
cd api; npm test; cd ..

# 5. Commit con rutas explícitas (nunca `git add -A`)
git add api/link.js api/link.test.js
git commit -m "<mensaje en inglés>"

# 6. Subir y fusionar
git push -u origin feat/<nombre>
git checkout develop
git merge --no-ff feat/<nombre> -m "merge: <nombre>"
git push origin develop
git branch -d feat/<nombre>
git push origin --delete feat/<nombre>

# 7. Actualizar ESTADO.md con el hash del merge
```

## Formato de brief para agentes

Todo agente recibe exactamente estas secciones:

```
DECISIÓN: qué se construye y por qué.
FICHEROS QUE POSEES: lista cerrada. No toques nada más.
REGLAS DURAS:
  - No renombres ficheros, funciones ni claves existentes.
  - No hagas commit ni cambies de rama.
  - No añadas dependencias npm.
  - No inventes texto de UI fuera del especificado.
  - Si algo del brief es imposible, PARA y repórtalo. No improvises otra cosa.
INTENCIÓN: comportamiento exacto esperado.
RECON: lee el código, escribe tu plan de ediciones exactas en
  `.agent/<tarea>-plan.md`, y solo entonces edita.
VERIFICACIÓN: comandos a ejecutar y checks que deben dar true.
FORMATO DE REPORTE: el de abajo, literal.
```

### Formato de reporte (fijo para todos los agentes)

```
## RESULTADO
estado: OK | FALLO | PARCIAL
rama: <rama>
ficheros tocados: <lista>

## CHECKS
{ ...json de la tarea, cada clave true/false... }

## COMANDOS
<comando> -> exit <código>, <n> tests, <n> fallos

## NOTAS
- máximo 5 viñetas, solo lo que el orquestador necesita decidir
```

## Verificación con agente Opus

Tras **cada** tarea, antes del commit, lanzar un agente Opus de revisión:

```
subagent_type: general-purpose
model: opus
prompt:
  Revisa los cambios sin commitear en <ruta del repo>, rama <rama>.
  Ejecuta: git diff
  Tarea implementada: <copia la sección DECISIÓN e INTENCIÓN de la tarea>
  Comprueba y responde SOLO con este formato:
  ## VEREDICTO
  correcto | incorrecto | dudoso
  ## FALLOS
  - <fichero:línea> — <qué está mal y por qué>
  ## RIESGOS DE SEGURIDAD
  - <o "ninguno">
  ## FUERA DE ALCANCE
  - <ficheros tocados que no le pertenecían, o "ninguno">
  No arregles nada. Solo informa.
  Presta atención especial a: caducidad y un solo uso de los códigos, límite de
  intentos, que no se filtre información de usuarios a quien no está autenticado,
  y que no se pueda quedar un perfil sin ninguna credencial.
```

Si el veredicto es `incorrecto` o `dudoso`: devolver los fallos **al agente implementador**
(mismo agente, vía SendMessage), no arreglarlo el orquestador.

---

# FASE 0 — Preparación

Ejecuta y confirma antes de nada:

```powershell
cd $env:USERPROFILE\Escritorio\Opengym
git status                      # debe estar limpio, en develop
cd frontend; npm install; cd ..
cd api; npm install; cd ..
cd frontend; npm test; cd ..    # línea base: TODO debe pasar ya
```

Si la línea base falla, **para y avisa**. No se empieza sobre un árbol roto.

Crea `.agent/` y añádelo a `.gitignore` (los planes de los agentes no se commitean).

---

# T1 — Lógica pura de códigos de vinculación

**Rama:** `feat/link-core` · **Depende de:** nada · **Paralelo con:** T6

**DECISIÓN**
Toda la lógica de los códigos de vinculación vive en un módulo puro, sin HTTP ni estado global,
para que sea testeable al 100% con `node --test`. `server.js` no se toca en esta tarea.

**FICHEROS QUE POSEES**
- `api/link.js` (nuevo)
- `api/link.test.js` (nuevo)
- `api/package.json` (solo para añadir el script `test`)

**INTENCIÓN**

`api/link.js` exporta funciones puras que reciben y devuelven datos, sin tocar disco:

- `makeCode()` → cadena de 8 caracteres del alfabeto `ABCDEFGHJKMNPQRSTUVWXYZ23456789`
  (sin `0`,`O`,`1`,`I`,`L` para que no se confundan al teclear), formateada `XXXX-XXXX`.
  Usa `crypto.randomBytes`, no `Math.random`, y sin sesgo de módulo.
- `createLink(uid, now)` → objeto `{ code, uid, exp }` con `exp = now + 15*60*1000`.
- `validateLink(links, code, now)` → `{ ok, uid, reason }`. Normaliza la entrada (mayúsculas,
  quita espacios y guiones) antes de comparar. Razones: `'not-found'`, `'expired'`.
- `recordFailure(fails, now)` → lista nueva con `now` añadido y los anteriores a `FAIL_WINDOW`
  descartados.
- `isThrottled(fails, now)` → `true` cuando hay `MAX_FAILS` o más fallos dentro de `FAIL_WINDOW`.
- `burnLink(links, code)` → devuelve la lista sin ese código.
- `pruneLinks(links, now)` → elimina los caducados.

Constantes exportadas: `MAX_FAILS = 10`, `FAIL_WINDOW = 15 * 60 * 1000`.

Reglas de comportamiento no negociables:
- Un código sirve **una sola vez**. El módulo **no** lo impone: `validateLink` devuelve `ok`
  tantas veces como se le llame, y **el llamador debe invocar `burnLink` al validar con éxito**.
  Documentado en la cabecera del módulo para que T2 no lo pierda.
- Un código caducado nunca valida, aunque sea correcto.
- La comparación de códigos es **insensible a mayúsculas**, tolera guiones/espacios, y se hace
  en **tiempo constante** (`crypto.timingSafeEqual` sobre búferes de igual longitud). El código
  es un secreto de 8 caracteres que abre una cuenta.
- Un código normalizado vacío (`''`, `'   '`, `'----'`, `null`, `undefined`) se rechaza de
  entrada con `'not-found'`, sin buscar nada.
- Nunca hay dos códigos activos idénticos: `createLink` no lo garantiza por sí solo, así que
  documenta que el llamador debe reintentar si colisiona (probabilidad despreciable, pero explícito).

> **Corrección de diseño (2026-09-04, tras revisión Opus).** La primera versión de este brief
> limitaba los intentos **por código** (5 fallos y el código muere). No sirve: quien ataca prueba
> códigos que no existen, así que no hay registro que incrementar y el contador nunca sube. Lo
> único que bloqueaba era al usuario legítimo reenviando su propio código. El límite debe ir
> ligado a **quien intenta**, no al secreto adivinado — de ahí el estrangulador global. Es global
> a propósito y no por IP: vincular ocurre unas pocas veces al año, y una IP se rota.

En `api/package.json` añade: `"test": "node --test"`. **No añadas dependencias.**

**VERIFICACIÓN**

```powershell
cd api; npm test
```

Cobertura mínima obligatoria en `api/link.test.js` (un test por punto):
1. `makeCode` devuelve el formato `XXXX-XXXX` y solo usa el alfabeto permitido.
2. `makeCode` no repite en 1000 llamadas.
3. Código válido dentro de la ventana → `ok: true` con el uid correcto.
4. Frontera de caducidad: en `exp - 1` vale, en `exp` exacto **vale**, en `exp + 1` caduca.
   (Con solo `exp + 1` una regresión a `>=` pasaría inadvertida.)
5. Código inexistente → `reason: 'not-found'`.
6. Minúsculas, con espacios y sin guion → valida igual.
7. Códigos vacíos y basura (`''`, `'   '`, `'----'`, `null`, `undefined`) → `'not-found'`, sin excepción.
8. Dos códigos válidos a la vez: cada uno valida contra su propio uid, y normalizar uno nunca
   casa con el otro.
9. Estrangulador: con `MAX_FAILS - 1` fallos no estrangula; con `MAX_FAILS`, sí.
10. Los fallos anteriores a `FAIL_WINDOW` caen solos y desestrangulan.
11. `burnLink` lo elimina y una segunda validación da `'not-found'`.
12. `pruneLinks` quita los caducados y conserva los vivos.
13. No mutación: tras cada función exportada, la lista de entrada y sus objetos siguen idénticos
    (comparación profunda contra una copia previa).

**CHECKS**
```json
{
  "api_test_script_added": true,
  "no_new_dependencies": true,
  "server_js_untouched": true,
  "tests_pass": true,
  "test_count_min_13": true,
  "uses_crypto_randomBytes": true,
  "ambiguous_chars_excluded": true,
  "constant_time_compare": true,
  "global_throttle_not_per_code": true,
  "empty_code_guarded": true,
  "burn_obligation_documented": true
}
```

---

# T2 — Endpoints de vinculación

**Rama:** `feat/link-api` · **Depende de:** T1 · **Paralelo con:** nada

**DECISIÓN**
Conectar `link.js` a tres endpoints HTTP. Los códigos pendientes se guardan en `db.json`
(campo nuevo `links`) para que sobrevivan a un reinicio del contenedor.

**FICHEROS QUE POSEES**
- `api/server.js`
- `api/link.integration.test.js` (nuevo)

**INTENCIÓN**

Haz recon del enrutado existente (tabla de rutas `'MÉTODO /ruta'`), de `readSession`,
`sessionCookie`, `saveDb`, `audit` y de cómo `/api/register/*` usa challenges. Sigue **exactamente**
esos mismos patrones. Tres rutas nuevas:

1. **`POST /api/link/code`** — requiere sesión (401 si no).
   Genera un código para el usuario de la sesión, lo guarda en `db.links`, poda los caducados,
   `saveDb()`, y responde `{ code, exp }`.
   Si el usuario ya tenía un código vivo, lo reemplaza (solo uno activo por usuario).
   Audita `link.code.created`.

2. **`POST /api/link/options`** — **sin** sesión. Body `{ code }`.
   **Antes de validar nada**, comprueba `isThrottled(db.linkFails, now)`: si estrangula, responde
   `400` con el mismo error genérico y **no** mires el código siquiera.
   Valida el código. Si no vale: `db.linkFails = recordFailure(db.linkFails, now)`, `saveDb()`,
   audita `link.fail` con la razón, y responde `400` con `{ error: 'invalid or expired code' }`.
   **El mensaje de error es el mismo para todas las razones** — no reveles si el código existe,
   ha caducado o está estrangulado.
   `db.linkFails` es un array de marcas de tiempo, aditivo, y por defecto `[]` en un `db.json`
   antiguo. El estrangulador es **global a la instancia**, no por código ni por usuario: quien
   ataca prueba códigos inexistentes, así que un contador ligado al código no cuenta nada.
   Si vale: genera opciones de registro WebAuthn para el **uid existente** (no uno nuevo),
   con `excludeCredentials` conteniendo las credenciales que ya tiene ese usuario, para que un
   dispositivo ya vinculado no se registre dos veces. Guarda el challenge igual que hace
   `/api/register/options`, marcándolo como vinculación (p. ej. `link: true` y el `uid` real).
   Responde `{ cid, options }`.

3. **`POST /api/link/verify`** — **sin** sesión. Body `{ cid, credential }`.
   Toma el challenge, verifica con `verifyRegistrationResponse` exactamente igual que
   `/api/register/verify`. Si verifica:
   - **NO crees usuario nuevo.** Añade solo a `db.creds` una credencial con `userId` = el uid
     del challenge.
   - Quema el código (`burnLink`), `saveDb()`.
   - Audita `link.ok`.
   - Responde con el usuario y **entrega cookie de sesión**, igual que el registro normal.
   Si la credencial ya existía (`db.creds.find(x => x.id === ...)`) → `409`, y el código **no**
   se quema.

Poda `db.links` caducados también al arrancar el servidor.

**REGLAS DURAS ADICIONALES**
- No cambies el comportamiento de ninguna ruta existente.
- No cambies el formato de `db.json` para los campos que ya existen. `links` es aditivo y
  debe tolerar un `db.json` antiguo que no lo tenga (por defecto `[]`).
- `INVITE_ONLY` **no** aplica a la vinculación: vincular no crea perfil.

**VERIFICACIÓN**

```powershell
cd api; npm test
```

`api/link.integration.test.js` arranca el servidor real como subproceso con `DATA_DIR` en una
carpeta temporal y un `PORT` libre, y le habla con `fetch`. Para las rutas que necesitan sesión,
lee el fichero `secret` del `DATA_DIR` y fabrica la cookie con el mismo algoritmo que `sessionCookie`
(haz recon de cómo se firma). Limpia la carpeta temporal al terminar.

Tests obligatorios:
1. `POST /api/link/code` sin cookie → 401.
2. `POST /api/link/code` con cookie válida → 200 y `code` con formato correcto.
3. Pedir dos códigos seguidos → solo queda uno activo para ese usuario en `db.json`.
4. `POST /api/link/options` con código inexistente → 400.
5. `POST /api/link/options` con código válido → 200, y las opciones llevan el `user.id` del
   usuario existente, no uno nuevo.
6. `MAX_FAILS` intentos con código incorrecto → el siguiente da 400 **aunque el código sea el
   legítimo**, y `db.linkFails` tiene las marcas de tiempo.
7. El error de código inválido es **idéntico** en texto para caducado, inexistente y estrangulado.
8. `db.json` de un servidor previo **sin** los campos `links` ni `linkFails` arranca sin error.
9. Un código válido canjeado dos veces: el segundo intento da 400 (`burnLink` se llamó al
   validar con éxito, que es responsabilidad del llamador).

El tramo `/api/link/verify` con criptografía real **no se testea aquí** (requeriría un
autenticador virtual). Queda cubierto por la aceptación manual de la Fase A. Dilo en el reporte.

**CHECKS**
```json
{
  "three_routes_added": true,
  "no_existing_route_changed": true,
  "link_verify_never_creates_user": true,
  "error_message_uniform": true,
  "excludeCredentials_populated": true,
  "old_db_json_compatible": true,
  "invite_only_not_applied_to_link": true,
  "throttle_checked_before_validation": true,
  "burn_called_on_success": true,
  "tests_pass": true,
  "test_count_min_9": true
}
```

---

# T3 — Listar y revocar dispositivos

**Rama:** `feat/devices-api` · **Depende de:** T2 · **Paralelo con:** T4

**DECISIÓN**
Sin poder revocar, vincular es una puerta que no se cierra. Al vender el Android hay que poder
retirar su credencial.

**FICHEROS QUE POSEES**
- `api/server.js`
- `api/devices.integration.test.js` (nuevo)

**INTENCIÓN**

1. **`GET /api/devices`** — requiere sesión. Devuelve las credenciales **del usuario de la sesión**:
   `{ id, created, transports, current }`, donde `current` indica si es la credencial con la que
   se inició la sesión actual (si el dato está disponible; si no, omite el campo y dilo en el reporte).
   Nunca devuelve la clave pública ni datos de otros usuarios.
   Añade `created` al guardar credenciales nuevas (registro y vinculación); las credenciales
   antiguas sin ese campo devuelven `null`, no rompen.

2. **`DELETE /api/devices/<id>`** — requiere sesión. Borra esa credencial **solo si pertenece
   al usuario de la sesión**. Casos:
   - No es suya o no existe → `404` (mismo error en ambos casos, no reveles cuál).
   - Es la **última** credencial del usuario → `409` con
     `{ error: 'cannot remove your only device' }`. Un perfil sin credenciales sería inaccesible
     para siempre.
   - Correcto → `200`, `saveDb()`, audita `device.removed`.

**VERIFICACIÓN**

```powershell
cd api; npm test
```

Tests obligatorios:
1. `GET /api/devices` sin sesión → 401.
2. Devuelve solo las credenciales del usuario de la sesión, nunca las de otro usuario.
3. La respuesta **no contiene** `publicKey` en ningún campo.
4. Borrar una credencial de otro usuario → 404 y sigue existiendo en `db.json`.
5. Borrar la única credencial → 409 y sigue existiendo.
6. Con dos credenciales, borrar una → 200 y en `db.json` queda una.
7. Credencial antigua sin `created` → se lista con `created: null`, sin excepción.

**CHECKS**
```json
{
  "public_key_never_exposed": true,
  "cross_user_delete_blocked": true,
  "last_device_delete_blocked": true,
  "legacy_creds_without_created_ok": true,
  "tests_pass": true,
  "test_count_min_7": true
}
```

---

# T4 — Interfaz de vinculación

**Rama:** `feat/link-ui` · **Depende de:** T2 · **Paralelo con:** T3

**DECISIÓN**
Dos puntos de entrada: generar el código desde el dispositivo viejo (Ajustes) y canjearlo desde
el nuevo (pantalla de entrada).

**FICHEROS QUE POSEES**
- `frontend/src/lib/api.js`
- `frontend/src/views/Login.jsx`
- `frontend/src/views/Settings.jsx`
- `frontend/src/lib/i18n.js` (solo para añadir claves nuevas)
- `frontend/src/lib/link.js` + `frontend/src/lib/link.test.js` (nuevos, para la lógica pura)

**INTENCIÓN**

En `lib/api.js`, siguiendo el patrón exacto de `passkeyRegister`:
- `linkCode()` → `POST /api/link/code`, devuelve `{ code, exp }`.
- `linkDevice(code)` → `POST /api/link/options`, `navigator.credentials.create(...)`,
  `POST /api/link/verify`, devuelve el usuario.

En `lib/link.js` (puro, testeable):
- `normalizeCode(raw)` → mayúsculas, sin espacios ni guiones, máximo 8 caracteres.
- `formatCode(raw)` → inserta el guion para mostrar.
- `remaining(exp, now)` → `{ minutes, seconds, expired }` para la cuenta atrás.

En `Login.jsx`: cuarto botón bajo "Create new profile", texto **"Link this device"**, icono
existente del set (elige uno coherente; no añadas iconos nuevos). Abre una hoja con un campo
de texto para el código y un botón de confirmar. Al confirmar llama a `linkDevice`, y en éxito
`setUser` + `pullState` + toast "Device linked". Errores: muestra el mensaje del servidor;
si el usuario cancela el diálogo de passkey (`NotAllowedError`/`AbortError`) no muestres nada,
igual que hace `signIn`.

En `Settings.jsx`: fila **"Link another device"**, visible solo con sesión iniciada (no invitado).
Al pulsar, llama a `linkCode()` y abre una hoja mostrando el código en grande y monoespaciado,
con cuenta atrás de caducidad y un aviso corto: el código sirve una vez y caduca en 15 minutos.

Textos de UI: añade las claves nuevas al pack **inglés**. Haz recon de cómo `t()` resuelve una
clave ausente en otros idiomas; si no hay repliegue automático al inglés, **dilo en el reporte y
no toques los otros 11 packs** — se decidirá aparte.

**REGLAS DURAS ADICIONALES**
- No rediseñes la pantalla de entrada ni Ajustes. Añade, no reorganices.
- Usa los componentes existentes (`Button`, `Row`, `TextField`, `openSheet`). No CSS nuevo salvo
  lo mínimo para el código en monoespaciado.
- La suite de Vitest existente debe seguir **entera en verde**.

**VERIFICACIÓN**

```powershell
cd frontend; npm test
```

Tests obligatorios en `link.test.js`:
1. `normalizeCode` con minúsculas, espacios y guiones → forma canónica.
2. `normalizeCode` recorta a 8 caracteres.
3. `formatCode` produce `XXXX-XXXX`.
4. `remaining` con `exp` pasado → `expired: true`.
5. `remaining` a 90 s → `{ minutes: 1, seconds: 30 }`.

**CHECKS**
```json
{
  "login_has_link_button": true,
  "settings_has_generate_code": true,
  "settings_row_hidden_for_guest": true,
  "no_new_npm_deps": true,
  "no_new_icons": true,
  "existing_vitest_suite_green": true,
  "link_tests_pass": true,
  "i18n_fallback_reported": true
}
```

---

# T5 — Gestión de dispositivos en Ajustes

**Rama:** `feat/devices-ui` · **Depende de:** T3 y T4 · **Paralelo con:** nada

**DECISIÓN**
Interfaz para ver y revocar dispositivos. Va después de T4 porque toca el mismo `Settings.jsx`.

**FICHEROS QUE POSEES**
- `frontend/src/views/Settings.jsx`
- `frontend/src/lib/api.js`
- `frontend/src/lib/i18n.js` (solo claves nuevas)

**AVISO:** el árbol ya trae los cambios de T4 en estos ficheros. Constrúyelo **encima**, no los
deshagas.

**INTENCIÓN**
Sección "Devices" en Ajustes, con sesión iniciada: lista los dispositivos de `GET /api/devices`
con su fecha de alta, marcando el actual. Cada uno con acción de eliminar, que pide confirmación
con `confirmSheet` (ya existe) antes de llamar al `DELETE`. El dispositivo actual y el último
dispositivo no se pueden eliminar: deshabilita la acción y explica por qué en una línea.
Tras eliminar, refresca la lista.

**VERIFICACIÓN**
```powershell
cd frontend; npm test
```
La suite existente sigue verde. Añade test de la lógica pura que extraigas (p. ej. la función
que decide si una fila es eliminable): con un solo dispositivo → no eliminable; con dos →
el no-actual es eliminable; el actual nunca.

**CHECKS**
```json
{
  "devices_section_added": true,
  "t4_changes_preserved": true,
  "confirm_before_delete": true,
  "last_device_not_deletable_in_ui": true,
  "current_device_not_deletable_in_ui": true,
  "existing_vitest_suite_green": true
}
```

---

# T6 — Configuración y documentación de despliegue

**Rama:** `chore/deploy-home` · **Depende de:** nada · **Paralelo con:** T1

**DECISIÓN**
El servidor vive primero en el PC de casa y en ~1 mes se muda a un mini PC. La mudanza debe ser
copiar `data/` y repuntar el túnel, sin tocar el dominio. Requisito técnico duro: **HTTPS
obligatorio** — el service worker solo se registra sobre HTTPS (`frontend/src/main.jsx`), así que
sin HTTPS no hay modo offline ni passkeys ni notificaciones. Por eso Cloudflare Tunnel y no
acceso por IP local.

**FICHEROS QUE POSEES**
- `docs/DESPLIEGUE.md` (nuevo, en español)
- `.env.production.example` (nuevo)
- `docker-compose.tunnel.yml` (nuevo, fichero de superposición)
- `scripts/backup.sh` (nuevo)

**INTENCIÓN**

`.env.production.example`: copia comentada de `.env.example` con los valores de producción
doméstica — `RP_ID` y `ORIGIN` con el dominio real (marcador `gym.EJEMPLO.com`), `SESSION_DAYS=365`,
`ALLOW_GUEST=0`, `AUDIT_LOG=1`, y `ADMIN_UIDS` explicado. Aviso destacado arriba: **cambiar
`RP_ID` después invalida todas las passkeys registradas.**

`docker-compose.tunnel.yml`: superposición que añade un servicio `cloudflared` con la imagen
oficial, leyendo el token de la variable `TUNNEL_TOKEN` del `.env`, apuntando al servicio `web`
por la red interna de compose. Uso documentado:
`docker compose -f docker-compose.yml -f docker-compose.tunnel.yml up -d`.
No modifiques `docker-compose.yml`.

`scripts/backup.sh`: script POSIX que empaqueta `data/` con fecha en el nombre, conserva los
últimos 14 y borra los más viejos. Que falle con mensaje claro si `data/` no existe.
Comentario arriba avisando de que el archivo contiene todos los perfiles y el `audit.log`.

`docs/DESPLIEGUE.md`: el runbook en español, con el orden exacto y **por qué el orden importa**:
1. Comprar dominio y crear el túnel en Cloudflare.
2. `.env` con `RP_ID`/`ORIGIN` **definitivos** — antes de crear ningún perfil.
3. Levantar y comprobar `https://<dominio>/api/health`.
4. Crear el perfil desde el Android. Poner el uid en `ADMIN_UIDS`, reiniciar.
5. Exportar el JSON desde el APK e importarlo en el perfil del servidor.
6. Instalar la PWA en Android, desinstalar el APK.
7. Verificar el modo offline: activar modo avión, abrir la app, registrar una serie, volver a
   tener red, comprobar que sube.
8. Mudanza al mini PC: parar, copiar `data/`, levantar, repuntar el túnel. Dominio intacto.
9. Día del iPhone: generar código en Android → "Link this device" en el iPhone → Face ID →
   añadir a pantalla de inicio.
10. Antes de vender el Android: exportar JSON y revocar su dispositivo.

Incluye una sección de **Limitaciones conocidas**, con esto exactamente:
- La sincronización es *el último gana* sobre el estado completo (`PUT /api/data` reemplaza todo).
  Regla: **el móvil es el único que escribe**; para análisis se lee `data/state-<uid>.json` en
  disco, que se escribe de forma atómica.
- Los GIFs solo están disponibles sin conexión si ya se vieron con red antes (caché
  *cache-first* del service worker). Abrir la rutina en casa antes de ir al gimnasio.
- La PWA no tiene el espejo en fichero nativo que sí tiene el APK: el servidor es el respaldo.
- El modo offline requiere HTTPS. Por IP local no funciona.

**VERIFICACIÓN**
```powershell
docker compose -f docker-compose.yml -f docker-compose.tunnel.yml config
```
Debe validar sin errores. Comprueba también que `docker-compose.yml` no aparece modificado en
`git diff`, y que `scripts/backup.sh` pasa `bash -n` (comprobación de sintaxis).

**CHECKS**
```json
{
  "compose_override_validates": true,
  "base_compose_untouched": true,
  "backup_script_syntax_ok": true,
  "backup_keeps_14": true,
  "rp_id_warning_present": true,
  "known_limitations_section_present": true,
  "doc_in_spanish": true
}
```

---

# FASE A — Aceptación manual (la hace el dueño, la guía el ejecutor)

Nada se fusiona a `main` sin esto. Cubre el tramo criptográfico que los tests no alcanzan.

**Preparación**
```powershell
cd $env:USERPROFILE\Escritorio\Opengym
copy .env.example .env
docker compose up -d --build
```
Abrir `http://localhost:8080` en **Chrome**.

**Autenticador virtual** (simula dos dispositivos sin hardware):
F12 → tres puntos → More tools → **WebAuthn** → *Enable virtual authenticator environment* →
Add → protocolo `ctap2`, transporte `internal`, **Resident keys: on**, **User verification: on**.

**Guion de aceptación**
1. Crear perfil "Cesar". Aparece una credencial en la lista del autenticador virtual. ✔
2. Registrar una serie de cualquier ejercicio. ✔
3. Ajustes → "Link another device" → sale un código `XXXX-XXXX` con cuenta atrás. ✔
4. En el panel WebAuthn, **borrar** la credencial existente y añadir un autenticador nuevo
   (simula el iPhone). Recargar en ventana de incógnito.
5. "Link this device" → meter el código → completar la passkey. ✔
6. **Entra en el perfil "Cesar" con la serie del paso 2 visible.** No en uno vacío. ← *la prueba clave*
7. Reutilizar el mismo código otra vez → rechazado. ✔
8. Código inventado, seis veces → siempre el mismo mensaje de error. ✔
9. Ajustes → "Devices" → aparecen dos. Eliminar el que no es el actual → queda uno. ✔
10. Intentar eliminar el último → bloqueado. ✔
11. Modo avión del navegador (DevTools → Network → Offline): la app abre, se puede registrar
    una serie, y al volver la red se sincroniza. ✔

Cada punto se responde ✔ o se reporta el fallo exacto. **Si el 6 falla, todo el plan falla.**

---

# FASE B — Cierre

Solo cuando T1-T6 estén en `done` y la Fase A completa:

```powershell
git checkout main
git pull --ff-only origin main
git merge --no-ff develop -m "feat: device linking, device management and home deployment"
git push origin main
git tag -a v1.2.9-link -m "device linking"
git push origin --tags
```

`develop` **se mantiene**: es la rama base de todo el trabajo futuro.

---

# Trabajo futuro (no en este ciclo)

- Proponer la vinculación de dispositivos como merge request upstream en GitLab. Es una carencia
  real del proyecto, no específica de este fork.
- Traducir las claves nuevas a los otros 11 idiomas.
- Revisar si la sincronización *último gana* merece un merge por marca de tiempo por entidad.
