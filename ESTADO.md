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
| FA | Aceptación manual (autenticador virtual) | — | abierto | — |
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

## Bloqueantes abiertos

*(ninguno)*

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

## Registro

| Fecha | Qué |
|-------|-----|
| 2026-09-04 | Rama `develop` creada desde `main`. `PLAN.md` y `ESTADO.md` escritos. |
