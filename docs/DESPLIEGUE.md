# Despliegue doméstico — runbook

Este documento cubre el despliegue real de openGym como PWA autoalojada en un servidor
doméstico: primero en el PC de casa, y en aproximadamente un mes trasladado a un mini PC. La
mudanza debe reducirse a copiar `data/` y repuntar el túnel — el dominio no cambia nunca.

**Requisito técnico duro: HTTPS es obligatorio.** El service worker de openGym solo se registra
sobre HTTPS (`frontend/src/main.jsx`) — sin HTTPS no hay modo offline, no hay passkeys (los
navegadores las exigen sobre HTTPS salvo en `localhost`) y no hay notificaciones push. Por eso
este runbook usa un Cloudflare Tunnel y no acceso directo por IP local: una IP de la LAN nunca
es HTTPS, así que el móvil nunca tendría ninguna de las tres cosas.

Sigue el orden exacto. No es una lista de sugerencias: varios pasos son irreversibles o mucho
más caros de deshacer si se hacen en otro orden.

## 1. Comprar el dominio y crear el túnel en Cloudflare

Antes de tocar el `.env` del proyecto. Necesitas el dominio (o subdominio) definitivo y un túnel
de Cloudflare ya creado, con una ruta pública que apunte al contenedor `web` — ver
[`docker-compose.tunnel.yml`](../docker-compose.tunnel.yml) para el cómo exacto y
[`.env.production.example`](../.env.production.example) para dónde va el token.

**Por qué va primero:** todo lo demás depende de saber ya cuál es el hostname final.

## 2. `.env` con `RP_ID`/`ORIGIN` definitivos — antes de crear ningún perfil

Copia `.env.production.example` a `.env` y rellena `RP_ID` y `ORIGIN` con el dominio real (no el
marcador `gym.EJEMPLO.com`), y `TUNNEL_TOKEN` con el token del túnel del paso 1.

**Por qué va antes de crear perfiles, y por qué no se puede corregir después sin coste:** una
passkey queda criptográficamente atada al `RP_ID` con el que se registró. Cambiar `RP_ID` más
tarde no es un ajuste — invalida **todas** las passkeys ya registradas contra el hostname
anterior; cada persona tendría que volver a registrarse desde cero. Decide el dominio ahora,
una sola vez.

## 3. Levantar el stack y comprobar `/api/health`

```bash
docker compose -f docker-compose.yml -f docker-compose.tunnel.yml up -d
```

Comprueba:

```bash
docker compose -f docker-compose.yml -f docker-compose.tunnel.yml ps
curl https://<tu-dominio>/api/health      # {"ok":true,...}
```

Si `curl` falla: revisa que la ruta pública del túnel apunta al puerto interno del contenedor
`web` (`NGINX_PORT`, normalmente 80) y no al puerto publicado en el host (`WEB_PORT`) — son
cosas distintas, ver los comentarios en `docker-compose.tunnel.yml`.

**Por qué va antes de crear el perfil:** de nada sirve registrar una passkey contra una URL que
todavía no responde; y si `/api/health` falla aquí, es mucho más barato depurarlo con la base de
datos vacía que con perfiles ya dentro.

**Nota si ya conectaste Strava (paso 11 de este runbook):** el `state` que protege el flujo de
autorización de Strava se guarda solo en memoria, no en disco — a propósito, porque ese flujo dura
segundos y no tiene sentido que sobreviva a un reinicio. Si reinicias el stack justo entre pulsar
"Conectar con Strava" y volver de la pantalla de consentimiento, la vuelta dará "invalid or expired
state" y no habrá pasado nada más: basta con pulsar "Conectar con Strava" otra vez desde cero. Una
cuenta que ya estaba conectada antes del reinicio no se ve afectada — su token vive en su propio
fichero en `data/`, no en este estado en memoria.

## 4. Crear el perfil desde el Android, hacerte admin

Abre `https://<tu-dominio>` desde el navegador del Android y crea tu perfil con passkey (huella
o cara del teléfono).

Después, hazte admin:

1. Busca tu id en `./data/db.json`, bajo `users[].id`.
2. Ponlo en `ADMIN_UIDS` en `.env`.
3. Reinicia: `docker compose -f docker-compose.yml -f docker-compose.tunnel.yml up -d`.

**Por qué va después de levantar el stack y antes de todo lo demás:** no puedes saber tu propio
uid hasta que el perfil existe, y quieres el panel de admin disponible antes de mover datos
reales al servidor, por si hace falta depurar algo desde ahí.

## 5. Exportar el JSON desde el APK, importarlo en el perfil del servidor

Desde la app Android standalone (la APK), exporta tu historial como JSON (backup nativo). En el
perfil recién creado en el servidor, importa ese mismo fichero desde Ajustes.

**Por qué va después de tener el perfil ya en el servidor:** importar añade sobre lo que ya
existe; hacerlo contra un perfil vacío recién creado es el caso simple y evita mezclar datos de
prueba con el historial real.

## 6. Instalar la PWA en Android, desinstalar la APK

Desde el navegador, "Añadir a pantalla de inicio". Una vez confirmado que la PWA funciona y
tiene el historial importado, desinstala la APK — a partir de aquí el servidor es la fuente de
verdad, no el teléfono.

**Por qué va después de la importación y no antes:** desinstalar la APK antes de exportar sus
datos los pierde sin remedio — no hay una segunda copia en ningún sitio.

## 7. Verificar el modo offline

1. Activa el modo avión en el teléfono.
2. Abre la PWA (ya instalada, no la pestaña del navegador).
3. Registra una serie de cualquier ejercicio.
4. Vuelve a activar la red.
5. Confirma que la serie registrada en modo avión aparece sincronizada en el servidor (o, si
   tienes otro dispositivo con sesión, que se ve reflejada allí).

**Por qué es su propio paso y no se da por hecho:** el modo offline depende de que el service
worker haya podido registrarse e instalar su caché al menos una vez con red — es la primera
comprobación real de que el requisito de HTTPS del principio de este documento se cumplió de
extremo a extremo, no solo que `/api/health` respondiera.

## 8. Mudanza al mini PC — dominio intacto

Cuando llegue el mini PC (aprox. un mes después):

1. En el PC de casa: `docker compose -f docker-compose.yml -f docker-compose.tunnel.yml down`.
2. Copia la carpeta `data/` completa al mini PC (mismo `docker-compose.yml`, mismo `.env` —
   especialmente mismo `RP_ID`/`ORIGIN`, no cambian).
3. En el mini PC: `docker compose -f docker-compose.yml -f docker-compose.tunnel.yml up -d`.
4. Repunta la ruta pública del túnel de Cloudflare a la IP del mini PC (o crea el túnel de nuevo
   ahí y actualiza `TUNNEL_TOKEN` si usas un conector nuevo) — el dominio en sí no cambia.

**Por qué el dominio no cambia:** es exactamente lo que evita repetir el paso 2 de este runbook.
Mientras `RP_ID` sea el mismo, todas las passkeys ya registradas siguen siendo válidas en la
máquina nueva sin que nadie tenga que volver a registrarse.

## 9. Día del iPhone

> **Esto depende de la vinculación de dispositivos (tareas T1–T5 del plan del fork), que a
> fecha de este documento aún no está desplegada.** No lo des por hecho hasta que esas tareas
> estén en `done` y hayan pasado la aceptación manual de la Fase A. Cuando lo estén, el flujo
> previsto es:

1. En el Android (ya con la PWA y el historial dentro): Ajustes → "Link another device" → se
   genera un código de un solo uso con cuenta atrás.
2. En el iPhone, en Safari, abre la PWA → "Link this device" → introduce el código.
3. Face ID confirma y vincula el iPhone al mismo perfil (no crea uno nuevo).
4. Añade la PWA a la pantalla de inicio del iPhone.

**Por qué no antes:** sin vinculación de dispositivos, registrar una passkey desde el iPhone
hoy crearía un perfil nuevo y vacío — el historial se quedaría atrapado en el perfil del
Android, inaccesible desde el iPhone.

## 10. Antes de vender el Android

1. Exporta el JSON desde la PWA (por si acaso, aunque el servidor ya sea la fuente de verdad).
2. En Ajustes → Devices (una vez desplegada T3/T5), revoca la credencial de ese Android.

**Por qué va antes de deshacerte del teléfono y no después:** una vez vendido, ya no tienes
manera físicamente cómoda de comprobar cuál era su credencial exacta entre varias — hazlo con
el teléfono todavía en la mano.

## 11. Conectar Strava (opcional)

> Solo sube el entrenamiento a Strava; no sustituye a nada del historial de openGym, que sigue
> viviendo en `data/state-<uid>.json` como siempre. Salta este paso si no lo necesitas — sin
> `STRAVA_CLIENT_ID`/`STRAVA_CLIENT_SECRET` en `.env`, las rutas `/api/strava/*` ni existen (404).

1. Crea una aplicación en [strava.com/settings/api](https://www.strava.com/settings/api). El
   "Authorization Callback Domain" que pide el formulario es el hostname de tu `ORIGIN` (el mismo
   dominio ya definitivo del paso 2 — la URL de callback real es `<ORIGIN>/api/strava/callback`).
2. Copia `Client ID` y `Client Secret` a `STRAVA_CLIENT_ID` / `STRAVA_CLIENT_SECRET` en `.env`
   (ver `.env.production.example` para el bloque completo comentado).
3. Reinicia: `docker compose -f docker-compose.yml -f docker-compose.tunnel.yml up -d`.
4. Desde el perfil, en Ajustes, conecta la cuenta de Strava (autoriza el ámbito `activity:write`
   cuando Strava lo pida) — la subida en sí de un entrenamiento es una tarea aparte del plan.

**Por qué es opcional y va al final:** no depende de nada de lo anterior salvo tener ya `ORIGIN`
fijado (paso 2) y el stack respondiendo (paso 3) — el callback de Strava tiene que apuntar a una
URL real. El `client_secret` no sale nunca del servidor, igual que el fichero `data/secret` que
firma las cookies de sesión: ni la app cliente ni ninguna respuesta HTTP lo ven jamás.

## 12. Desplegar cambios nuevos (después de un merge a `main`)

Un `git push` a `main` no llega solo al servidor — este es un despliegue por Docker Compose
construido en la propia máquina (ver paso 3), así que hay que decirle explícitamente que baje lo
nuevo y reconstruya:

```powershell
powershell -File scripts\auto-deploy.ps1
```

Este script hace exactamente eso, a mano: `git fetch`, comprueba que `origin/main` tiene algo
nuevo y que el árbol de trabajo está limpio, hace `git checkout main` + `git merge --ff-only`,
reconstruye con `docker compose up -d --build` y vuelve a la rama en la que estabas. Si no hay
nada nuevo que desplegar, no hace nada. El progreso queda en `.git/auto-deploy/deploy.log`.

### Procedimiento completo, en orden

El script **solo mira `origin/main`**. Trabajar en `develop` y dar por hecho que eso despliega es
el error que cuesta horas, así que la secuencia entera es:

```powershell
# 1. El árbol tiene que estar LIMPIO — ficheros sin seguir incluidos
git status --porcelain            # no debe imprimir NADA

# 2. Llevar el trabajo a main (el script no mira develop)
git checkout main
git merge --no-ff develop -m "merge: <qué entra>"
git push origin main

# 3. Desplegar
powershell -File scripts\auto-deploy.ps1
```

### Las dos formas de que "no pase nada" sin enterarte

1. **El trabajo sigue en `develop`.** Fusionado, con los tests en verde, subido — y sin desplegar.
   El script no lo mira siquiera. No hay aviso: simplemente sigues usando la versión anterior.
2. **El árbol está sucio.** El script comprueba `git status --porcelain`, y eso **incluye ficheros
   sin seguir** (un directorio temporal olvidado basta). En ese caso se salta el despliegue y lo
   dice solo en `.git/auto-deploy/deploy.log`. Un despliegue que no hizo nada es indistinguible
   de uno que no lanzaste salvo mirando ese fichero.

Por eso el paso de verificación no es opcional.

### Verificar que se desplegó de verdad

```powershell
Get-Content .git\auto-deploy\deploy.log -Tail 3       # ¿"deploy OK" o "skipping"?
(Invoke-RestMethod http://localhost:8080/api/health).version
```

`version` devuelve `{ref, date}` con el commit que está sirviendo el servidor. Si `ref` no coincide
con `git rev-parse --short origin/main`, no se desplegó.

**Desde el móvil**, sin tocar el PC: al final del todo de Ajustes aparece el hash y la fecha.

- **Una línea** → bundle y servidor coinciden, estás al día.
- **Dos líneas** (`App` / `Servidor`) → el service worker te está sirviendo un bundle viejo contra
  un servidor ya actualizado. Cierra la app y vuelve a abrirla; no hace falta reinstalar la PWA.
- **Ninguna línea** → la imagen se construyó sin los build args de versión (un `docker compose up
  --build` a pelo, en vez del script). Se muestra nada antes que un valor inventado.

### Si hay que desplegar con el árbol sucio

Solo cuando sepas exactamente qué está sucio y por qué. Salta la comprobación del script haciendo
a mano lo que él haría, con los mismos build args:

```powershell
$sha = (git rev-parse origin/main).Trim()
$env:VCS_REF = $sha.Substring(0,7)
$env:BUILD_DATE = ((git show -s --format=%cI $sha) | Out-String).Trim()
docker compose -f docker-compose.yml -f docker-compose.tunnel.yml up -d --build
```

Si lo haces así, actualiza también `.git/auto-deploy/last-sha` con ese `$sha`, o la siguiente
ejecución del script creerá que hay algo pendiente que en realidad ya está servido.

**Por qué es manual por ahora:** el script está pensado para correr desde el Programador de
tareas de Windows sin vigilancia (cada pocos minutos), pero en un PC de uso diario eso abre una
ventana de consola de fondo constantemente, lo cual molesta. En el mini PC del paso 8, que no se
usa de forma interactiva, no hay ese problema — ahí sí merece la pena registrar la tarea
programada (`schtasks /create /tn "OpenGym AutoDeploy" /tr "powershell -NoProfile
-ExecutionPolicy Bypass -WindowStyle Hidden -File <ruta>\scripts\auto-deploy.ps1" /sc minute /mo
5`) para que cada merge a `main` se refleje solo, sin tocar nada a mano.

---

## Limitaciones conocidas

- **La sincronización es "el último gana" sobre el estado completo** — `PUT /api/data` reemplaza
  todo el estado del usuario de una vez, no fusiona por campo. Regla práctica: **el móvil es el
  único que escribe**. Si necesitas analizar los datos desde otro sitio, lee
  `data/state-<uid>.json` directamente en disco — se escribe de forma atómica, así que nunca lo
  encontrarás a medio escribir — en vez de escribir ahí y esperar que se fusione con lo que
  suba el teléfono.
- **Los GIFs de los ejercicios solo están disponibles sin conexión si ya se vieron con red
  antes** — la caché del service worker para media es *cache-first*, no los precarga todos.
  Abre la rutina del día en casa (con red) antes de ir al gimnasio si esperas entrenar sin
  cobertura allí.
- **La PWA no tiene el espejo en fichero nativo que sí tiene la APK.** La APK guarda todo en el
  teléfono, sin servidor; la PWA depende del servidor como única copia — de ahí que
  `scripts/backup.sh` y el paso 10 (exportar antes de vender el teléfono) no sean opcionales.
- **El modo offline requiere HTTPS.** Por IP local (LAN) no funciona — es la razón de ser de
  todo este documento y del túnel de Cloudflare: sin dominio y sin HTTPS, el service worker
  nunca se registra y no hay offline, passkeys ni notificaciones, sin excepción.
