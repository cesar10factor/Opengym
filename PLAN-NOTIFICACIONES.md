# PLAN — Notificaciones de entrenamiento (PWA, Android + iPhone)

> Documento de trabajo del fork, subordinado a `PLAN.md` (reglas de git, briefs y presupuesto
> son las de allí, no se repiten aquí). El estado vive en `ESTADO.md`, ciclo 3.

## Contexto

El aviso de fin de descanso no llegaba cuando el móvil estaba en otra aplicación, y el pitido
no se oye con cascos puestos. Se pedía además una notificación con barra de descanso, una
notificación fija de "siguiente ejercicio", y la isla de HyperOS 3.

**Decisión del dueño (2026-09-07):** solo PWA. Nada de shell nativa, porque el cambio a iPhone
sigue previsto en pocos meses y el trabajo Android nativo no se amortizaría.

Consecuencia aceptada: **no habrá barra de descanso viva ni isla de HyperOS.** Ninguna de las dos
existe en la plataforma web. No se vuelve sobre ello.

## Hechos verificados

1. **El interruptor de push era el problema.** `Push notifications` en Ajustes
   (`Settings.jsx`, `PushCard`) es un opt-in separado de `Sounds` y estaba apagado. Con él
   apagado, `pushRestTimer()` seguía llamando al servidor, el servidor programaba el timer, y
   `sendPush()` salía sin hacer nada al no encontrar suscripciones — silencio sin ningún error.
   **Confirmado en el móvil por el dueño: activado, en Android funciona y se entera.**
2. **El cronómetro no deriva.** `startRest` usa `endsAt` de reloj de pared y reengancha en
   `visibilitychange`, así que al volver a la app la cuenta ya es correcta. El fallo nunca fue
   de precisión.
3. **Los timers del servidor no sobreviven a un reinicio.** `restTimers` es un `Map` en memoria
   con `setTimeout` (`api/server.js`). Si el contenedor reinicia durante un descanso, el aviso
   se pierde para siempre y nadie se entera.
4. **El ducking de la música no se controla desde la web.** No hay API de audio focus. Se
   obtiene gratis porque el SO baja la música para el tono de notificación. Es decir: la push
   no es el plan B del pitido, es **el** mecanismo para enterarse con cascos.

## Restricciones de iPhone (verificadas, condicionan el diseño)

- Push solo existe si la app está **añadida a la pantalla de inicio**. En pestaña de Safari no
  hay `PushManager`.
- **Toda push recibida debe mostrar una notificación visible.** Safari revoca la suscripción si
  no se hace (reportes de corte tras 3 incumplimientos), y lo hace en silencio. Esto **prohíbe**
  el diseño de notificaciones `silent` que se reemplazan por `tag`, que era la idea inicial para
  la notificación de "siguiente ejercicio".
- Una push por serie completada sería un banner con sonido por serie. Inusable.
- `navigator.vibrate` no existe oficialmente en iOS: el `vibrate(30)` al marcar serie no hará
  nada. Se deja como está, no molesta.
- WebAudio en iOS obedece al **interruptor físico de silencio**. El pitido de primer plano será
  más débil ahí que en Android, por plataforma.
- Sonido de notificación personalizado: no, ni en Android (canal de Chrome) ni en iOS.
- Desde iOS/iPadOS 18.4 existe **Declarative Web Push**: payload con `web_push: 8030`, Safari lo
  pinta sin service worker, y trae `navigate` (URL de destino al tocar). Compatible hacia atrás
  por diseño: un único payload sirve a Safari (declarativo) y a Chrome (service worker).

## Cambio de diseño respecto a lo pedido

En vez de una notificación permanente de "siguiente ejercicio" **más** otra de descanso, se hace
**una sola notificación al terminar el descanso que ya dice qué toca**:

```
Descanso terminado 💪
Press banca — serie 3/4 · 8 reps × 60 kg
```

y al tocarla entra directamente en la pantalla de entreno. Cubre las dos necesidades reales
(saber qué toca sin abrir la app, y volver rápido desde WhatsApp), es una push por descanso en
vez de una por serie, y no incumple ninguna regla de iOS. En Android la notificación además
**permanece en la bandeja** hasta descartarla, que es el atajo de reentrada que se pedía.

## Fases

Secuenciales. Tocan el mismo trío de ficheros (`useUI.js`, `sw.js`, `server.js`) y la regla de
`PLAN.md` es un solo escritor por conjunto de ficheros: paralelizar aquí solo da conflictos.

| # | Fase | Ficheros | Cómo |
|---|------|----------|------|
| N0 | Diagnóstico en el móvil | — | **hecho**, ver hecho verificado 1 |
| N1 | Que la notificación sonora sea determinista | `frontend/src/store/useUI.js` | Directo, sin agente |
| N2 | Que no vuelva a fallar en silencio | `api/server.js`, `frontend/src/lib/push.js`, `frontend/src/store/useUI.js` | Agente + tests |
| N3 | Payload dual (habilita iPhone) | `api/server.js`, `frontend/public/sw.js` | Agente |
| N4 | "Qué toca ahora" + salto a la app | `frontend/src/lib/next-up.js` (nuevo), `useUI.js`, `api/server.js`, `sw.js` | Agente + tests |
| N5 | Aceptación manual | — | El dueño |

Prueba en el móvil después de N1, N2 y N4. Si algo no se nota, se para antes de gastar la fase
siguiente.

---

## N1 — Que la notificación sonora sea determinista

**Redefinida el 2026-09-07 tras probar en Android.** El plan original era subir la ganancia y
cambiar la onda del pitido WebAudio. **Ya no hace falta:** el dueño confirma que al terminar el
descanso oye el pitido flojo de la app *y después* el sonido de la notificación push, y que **con
el de la push le basta**. No se toca `sound.js`.

Pero eso destapa un fallo real. Al llegar a 0, el cliente llama a `stopRest()`, y `stopRest()`
llama a `cancelPushRestTimer()`: **el cliente intenta cancelar la push justo cuando el servidor la
está enviando**. Se oye porque el servidor gana la carrera, no porque esté diseñado así. Si algún
día el cancel llega primero (reloj adelantado, red rápida), la push no sale y solo queda el pitido
flojo. Unas veces se oiría y otras no, sin patrón.

Sin agente: es una edición pequeña.

**Intención**
- Distinguir las dos razones por las que se para un descanso: **terminó solo** (no cancelar la
  push: es justamente el aviso que se quiere oír) y **se paró antes** — saltado, `addRest` que deja
  el tiempo en negativo, entreno cerrado, otro descanso que empieza (sí cancelar).
- No introducir un segundo aviso donde hoy hay uno. El comportamiento observable no debe cambiar
  respecto a lo que el dueño ya oye hoy en Android; solo dejar de depender de la carrera.

**Riesgo a vigilar:** si el aviso local en pantalla (`maybeRestNotification`) y la push acabaran
mostrando dos notificaciones a la vez, usar el mismo `tag` para que una reemplace a la otra.
En primer plano no ocurre — `maybeRestNotification` solo actúa con la pestaña oculta.

**Verificación:** `cd frontend; npm test` en verde. A oído: descanso completo → suena la push;
descanso saltado a mano → no suena nada después.

---

## N2 — Que no vuelva a fallar en silencio

**DECISIÓN:** el aviso de fin de descanso dependía de un opt-in que podía estar apagado sin que
nada lo indicara, y de un temporizador en memoria que un reinicio del servidor borraba. Las dos
cosas fallan calladas. Se corrigen para que el aviso sea fiable sin intervención del dueño.

**FICHEROS QUE POSEES:** `api/server.js`, `frontend/src/lib/push.js`,
`frontend/src/store/useUI.js`, y los ficheros de test que necesites junto a ellos.

**INTENCIÓN**
1. **Auto-reparación de la suscripción.** Al iniciar un descanso, si el permiso de notificaciones
   ya está concedido pero no hay suscripción push registrada, suscribir de forma transparente
   (la lógica ya existe en `enablePush()`). No pedir permiso por sorpresa: si el permiso no está
   concedido, no hacer nada. Nunca lanzar hacia la UI: es best-effort.
2. **Timers que sobreviven al reinicio.** Persistir los descansos programados junto al resto del
   estado del servidor (`db` + `saveDb()`, mismo patrón que el resto), y rearmar los pendientes al
   arrancar. Un descanso cuya hora ya pasó estando el servidor caído se dispara una sola vez si el
   retraso es pequeño, y se descarta si es grande — elige el umbral y coméntalo.
3. **Invariante de iOS.** Dejar explícito en el código, con comentario, que toda push enviada debe
   producir una notificación visible. Es la regla que en N4 impide el diseño `silent`.

**REGLAS DURAS:** las de `PLAN.md`. Además: no añadas dependencias; `web-push` ya está.

**VERIFICACIÓN:** `cd api; npm test` y `cd frontend; npm test` en verde. Check JSON:
`{ resubscribes_when_permission_granted, no_prompt_when_permission_default, timers_persisted,
timers_rearmed_on_boot, stale_timer_discarded, tests_green }`.

---

## N3 — Payload dual (la fase que habilita el iPhone)

**DECISIÓN:** hoy el servidor manda `{title, body, tag}` plano y `sw.js` lo lee plano. Ese formato
no lo entiende Safari en modo declarativo. Se pasa al formato dual de Declarative Web Push, que
Safari pinta solo y Chrome sigue leyendo por service worker.

**FICHEROS QUE POSEES:** `api/server.js`, `frontend/public/sw.js`.

**INTENCIÓN**
- `sendPush()` emite:
  ```json
  { "web_push": 8030,
    "notification": { "title": "...", "body": "...", "navigate": "<url absoluta>", "tag": "..." } }
  ```
  `navigate` debe ser absoluta y apuntar al origen configurado.
- `sw.js` acepta **ambos** formatos: `const n = data.notification || data`. No rompas las push ya
  existentes (recordatorio de entreno planificado, notificación de prueba).
- Mantener `event.waitUntil()` envolviendo la promesa de `showNotification` — ya está bien, no lo
  toques, pero no lo rompas.
- `notificationclick` debe abrir/enfocar la URL de `navigate` en vez de siempre la raíz.
- **Comprueba tú mismo** si `web-push` necesita algo especial de content-type para el modo
  declarativo. Si lo necesita y no está, PARA y repórtalo.

**VERIFICACIÓN:** `cd api; npm test` en verde. Check JSON:
`{ dual_payload_emitted, sw_reads_both_shapes, existing_pushes_unbroken, click_uses_navigate,
waituntil_intact }`.

---

## N4 — "Qué toca ahora" + salto a la app

**DECISIÓN:** la notificación de fin de descanso dice solo "Time for your next set". Debe decir
qué ejercicio, qué serie y qué objetivo, para no tener que abrir la app para saberlo, y llevar
directamente a la pantalla de entreno al tocarla.

**FICHEROS QUE POSEES:** `frontend/src/lib/next-up.js` (nuevo) y su test,
`frontend/src/store/useUI.js`, `api/server.js`.

**INTENCIÓN**
1. **Helper puro `next-up.js` con tests.** Dado el entreno activo, devuelve qué toca a
   continuación: nombre del ejercicio, índice y total de serie, y objetivo (reps × peso, o
   duración en series por tiempo, o la métrica de cardio). Devuelve `null` si no queda nada.
   Es lógica de entreno: `CONTRIBUTING.md` exige helper puro en `src/lib` con test al lado.
   Cubre en tests al menos: series normales, superseries, ejercicio a peso corporal, series por
   tiempo, y última serie del entreno.
2. **El texto lo compone el cliente, no el servidor.** El servidor no conoce el idioma ni el
   estado del entreno; el cliente ya tiene ambos (`t()` e i18n). `POST /api/push/rest-timer` pasa
   a aceptar un campo de texto ya formateado, que el servidor guarda con el timer y usa como
   cuerpo de la notificación. Si no viene, se usa el texto genérico de hoy.
3. `navigate` apunta a la vista de entreno.
4. **Una sola notificación por descanso.** No emitas nada al marcar cada serie: rompería iOS.

**REGLAS DURAS:** las de `PLAN.md`. Además: el texto que viaja al servidor es contenido de
usuario — no lo interpoles en HTML en ningún sitio, y limita su longitud en el servidor.

**VERIFICACIÓN:** `cd frontend; npm test` y `cd api; npm test` en verde. Check JSON:
`{ next_up_pure_and_tested, supersets_covered, bodyweight_covered, timed_covered,
last_set_returns_null, body_localized_by_client, one_push_per_rest, navigate_to_workout }`.

---

## N5 — Aceptación manual (el dueño)

En Android, hoy:

1. Empieza un entreno con Spotify sonando y cascos puestos.
2. Marca una serie → ¿se oye el pitido por encima de la música?
3. Sal a WhatsApp durante el descanso → ¿llega la notificación, baja la música, y **dice qué
   ejercicio toca**?
4. Tócala → ¿entra directo a la pantalla de entreno?
5. Reinicia el contenedor del `api` a mitad de un descanso → ¿llega igualmente el aviso?

En iPhone, cuando llegue:

6. Añadir la app a la **pantalla de inicio** (sin esto no hay push, no es opcional).
7. Activar el interruptor de push y mandar la notificación de prueba.
8. Repetir 3 y 4.
9. **Pregunta abierta:** ¿suena la notificación o llega muda? Las fuentes se contradicen y la
   documentación de WebKit no menciona sonido. Si llega muda, es limitación de la plataforma y
   no hay arreglo por vía PWA — se documenta y se cierra.

## Riesgos

| Riesgo | Mitigación |
|---|---|
| Las notificaciones de PWA en iOS podrían ser siempre mudas | Se comprueba en N5. Sin arreglo posible si se confirma; el resto del plan sigue valiendo |
| Safari revoca la suscripción por una push sin notificación visible | Invariante fijada en N2 y respetada por diseño en N4 |
| Subir la ganancia distorsiona en algunos altavoces | Prueba a oído en N1 antes de seguir |
| El texto de "qué toca" queda largo y lo trunca el SO | Poner lo importante primero: ejercicio, luego serie, luego objetivo |
