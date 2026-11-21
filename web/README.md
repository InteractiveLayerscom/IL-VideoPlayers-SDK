# Integrar la app web o de Smart TV

Copiá el directorio `web/` a la app e importá los módulos relativos, o instalá el paquete desde GitHub con una identidad que tenga acceso al repositorio. Fijá el commit de la versión que homologaste. El paquete distribuye módulos ES y una hoja de estilos. Para motores de TV antiguos incluí el SDK en la compilación que transpila la app y verificá las APIs web en el modelo objetivo.

```sh
npm install git+https://github.com/InteractiveLayerscom/IL-VideoPlayers-SDK.git
```

La escena es un contenedor propio con posición relativa y tamaño de video. Los elementos de reproducción y los contenedores de publicidad se anclan al mismo rectángulo. Para pantalla completa, la app debe usar ese contenedor completo. Un reproductor externo que toma el control de toda la pantalla puede usar un plano de video diferente.

## Shaka

Con Shaka 5.3.5 en web, instalá el adaptador después de asociar el video y antes de cargar el stream. Shaka se encarga de dibujar la L y el súper. Con Shaka UI reutilizá los contenedores publicitarios de los controles. En una app sin Shaka UI agregá estos dos elementos.

```html
<div id="stage" style="position:relative;aspect-ratio:16/9">
  <video id="video" playsinline controls style="position:absolute;inset:0;width:100%;height:100%"></video>
  <div id="client" style="position:absolute;inset:0;pointer-events:none"></div>
  <div id="server" style="position:absolute;inset:0;pointer-events:none"></div>
</div>
```

```js
import { attachShaka } from '@interactivelayers/player-sdk';
import '@interactivelayers/player-sdk/player.css'; // Con un bundler. En HTML usar una etiqueta link.

const player = new shaka.Player();
const video = document.querySelector('#video');
await player.attach(video);
const sdk = attachShaka({
  player,
  clientContainer: document.querySelector('#client'),
  serverContainer: document.querySelector('#server'),
  // eventsUrl: playback.overlayEventsUrl,  // Para la entrega individual por sesión.
  // sessionId: playback.sessionId,
});
await player.load(playback.manifestUrl);
await video.play();

// Al cambiar de canal, descargá primero los interstitials del medio anterior.
await player.unload();
sdk.destroy();
```

Para una señal de IL en el HLS, el adaptador lee las respuestas de manifiesto del propio Shaka, convierte el PDT a segundos del medio y llama a `addCustomInterstitial()`. Para decisiones individuales, pasale `eventsUrl` y la identidad de sesión de tu backend. Si la plataforma usa reproducción HLS nativa y Shaka no observa la variante, usá el endpoint o pasá el texto de la variante a `sdk.updateManifest(text)` y un reloj `programTime` verificado.

También podés reproducir el archivo generado `shaka-native.m3u8` con el soporte nativo de Shaka. La configuración de contenedores y los interstitials HLS deben estar activos. En esa ruta el propio parser entiende `X-OVERLAY-ID`, `X-DEPTH` y `X-SQUEEZECURRENT`. En esa vía, Shaka administra el ciclo de vida y la medición que se haya señalizado. Las reglas de impresión del SDK se aplican a sus propias oportunidades de IL. Verificá que el origen acepte los parámetros de sesión que Shaka agrega al URL del recurso. [Guía oficial de anuncios con Shaka](https://shaka-project.github.io/shaka-player-release/docs/api/tutorial-ad_monetization.html) · [Código del parser](https://shaka-project.github.io/shaka-player-release/docs/api/lib_ads_hls_interstitial_parser.js.html)

## Video.js

```js
import { attachVideoJs } from '@interactivelayers/player-sdk';
const sdk = attachVideoJs({
  player: videojsPlayer,
  stage: document.querySelector('#stage'), // Padre externo de videojsPlayer.el().
  playlistUrl: playback.selectedMediaPlaylistUrl,
});
```

Integralo después de `player.ready()` con la tecnología HTML5 inicializada. El adaptador usa el reloj de VHS cuando está disponible mediante `convertToProgramTime`, o el PDT del elemento nativo. En una versión que no exponga esos datos, la app debe proveer `programTime()` con el instante UTC que está reproduciendo. En LG webOS probá la combinación concreta de versión de Video.js, modo de video y modelo de televisor. [Reloj de Video.js HTTP Streaming](https://github.com/videojs/http-streaming/blob/main/docs/program-time-from-player-time.md) · [Streaming en webOS](https://webostv.developer.lge.com/develop/specifications/streaming-protocol-drm)

## HTML5

```js
import { attachHtmlVideo } from '@interactivelayers/player-sdk';
const sdk = attachHtmlVideo({ video, stage, eventsUrl: playback.overlayEventsUrl,
  sessionId: playback.sessionId, programTime: readVideoProgramTime });
```

`readVideoProgramTime()` devuelve milisegundos Unix del video que se está mostrando o `null`. En un motor que exponga un `video.getStartDate()` válido se puede omitir el callback. Para leer el HLS en el cliente, pasá `playlistUrl` con la variante de la sesión o llamá a `sdk.updateManifest(text)` en el loader que ya usa el publisher.

## Cues desde JavaScript

Si la app ya tiene el cue, pasalo directamente. `sdk.addCue(cue, hooks)` devuelve `true` si el cue es válido y lo reemplaza si ya existe uno con ese `id`. `sdk.removeCue(id)` lo quita y lo oculta si está en pantalla. Estos cues sobreviven a las actualizaciones de `eventsUrl` y del manifiesto, funcionan sin ninguna de esas fuentes y tienen prioridad cuando coinciden con otro cue. Siguen las mismas reglas de presentación y de cortes.

```js
const sdk = attachHtmlVideo({ video, stage, timeline: 'media' });
sdk.addCue(
  { id: 'promo-1', format: 'super', start: 5000, end: 15000,
    imageUrl: 'https://cdn.example/promo.png', clickUrl: 'https://brand.example/' },
  { onVisible: cue => report(cue), onHidden: cue => {}, onClick: cue => {} },
);
sdk.removeCue('promo-1');
```

`onVisible(cue)` se llama una sola vez por `id` y, cuando está presente, reemplaza al `onVisible` de la sesión y a la solicitud automática de `impressionUrl` para ese cue. `onHidden(cue)` se llama cada vez que el cue deja de presentarse. Con `timeline: 'media'` en `attachHtmlVideo` o `attachVideoJs`, el reloj es la posición del video en milisegundos y `start`/`end` se cuentan desde su inicio; un `programTime` explícito sigue teniendo prioridad.

## Anuncios desde un plan

El backend de Interactive Layers calcula un plan de anuncios por video. Con ese plan, el módulo opcional `@interactivelayers/player-sdk/ads` pide los gráficos de escena a Google Ad Manager desde el navegador y los dibuja con `addCue`. La entrada principal del SDK no lo importa: sin plan no se carga ni se ejecuta código de servidor de anuncios.

```js
import { attachHtmlVideo } from '@interactivelayers/player-sdk';
import { attachAds } from '@interactivelayers/player-sdk/ads';

const session = attachHtmlVideo({ video, stage, timeline: 'media' });
const ads = attachAds({ session, video, plan, pageUrl, fetchImpl, onEvent });
// Al cerrar el reproductor:
ads.destroy();
```

Para video bajo demanda la sesión debe usar `timeline: 'media'`, porque las ventanas del plan se cuentan en milisegundos desde el inicio del video. `pageUrl` reemplaza a `plan.page_url`; `fetchImpl` es `globalThis.fetch` por defecto. `onEvent({ type, format, window })` es opcional y recibe `request`, `fill`, `no_fill`, `error`, `impression` y `click` para diagnóstico. Un plan ausente, inválido o vencido (`expires_at`) deja el módulo inactivo sin lanzar errores.

Qué hace:

- Sirve el súper (`super`) y la L (`l_shape`, que se dibuja con el formato `l`) cuando `plan.scenes.graphics` tiene un tag de `https://pubads.g.doubleclick.net/gampad/ads` para ese formato, y alterna los formatos que puede servir según los gráficos ya mostrados.
- Decide en cada momento, a partir de la posición del video, si una ventana es utilizable: la acorta a `max_seconds`, la aleja `cut_clearance_seconds` de cada corte, la descarta si queda por debajo de `min_seconds`, deja 30 segundos entre inicios y `gap_after_seconds` tras el gráfico anterior, y respeta `max_per_video`. Cada ventana se intenta una sola vez por sesión, aunque el espectador vuelva atrás.
- No pide nada al servidor de anuncios (gráficos ni overlay) antes de que el espectador empiece la reproducción; después, una pausa no corta una solicitud en curso y buscar en pausa puede preparar la ventana siguiente. Un video que ya se reprodujo (`video.played` no está vacío) cuenta como iniciado al llamar a `attachAds`; una posición de reanudación sin reproducción no cuenta, y un anuncio que IMA reproduce en el mismo `<video>` tampoco.
- Pide el tag unos 4 segundos antes de la ventana (o en el acto si el espectador entra en ella con tiempo suficiente), con la segmentación de la ventana en `cust_params`, un `correlator` nuevo y `url`/`description_url`. Hace una sola solicitud por ventana, sin cookies, sin redirecciones y con 4 segundos de límite.
- Acepta sólo un anuncio InLine con una imagen PNG o JPEG estática por HTTPS cuya proporción coincida con el formato (20:3 o 16:9). Rechaza wrappers, anuncios lineales y recursos HTML o iframe.
- Envía las URL de `Impression` y `creativeView` una vez cuando el gráfico es visible y las de seguimiento de clic al hacer clic. Quita el cue al terminar la ventana o con `destroy()`.

- Acepta un plan con cortes y sin `scenes` (sólo cortes de video).

### Cortes de video

`ads.cuts` es la lista de cortes del plan en orden, `[{ id, at, position, tagUrl, requests: [{ provider, tagUrl }] }]`. `requests` son las solicitudes del corte en el orden en que se piden (hasta 3): `provider` es `gam` (tags de `https://pubads.g.doubleclick.net/gampad/ads`) o `iadserver` (tags de `https://ads.iadserver.com/gampad/ads`); el módulo descarta cualquier otro proveedor u host, y un corte sin solicitudes válidas. `tagUrl` es siempre el de la primera solicitud, así que ya no es necesariamente de Google Ad Manager. Los tags de GAM llevan `url` y `description_url` con la URL de la página; los de iADServer llevan `sid`, el identificador de la vista. Ninguno lleva `correlator`. Un plan anterior, sin `requests`, da una sola solicitud `gam` por corte. Los gráficos de escena siguen aceptando sólo tags de GAM.

`ads.vmap()` devuelve un VMAP 1.0 con un `AdBreak` lineal por corte (`timeOffset="start"` para el segundo 0) y un `correlator` nuevo en cada llamada. Usa sólo la primera solicitud de cada corte: **no tiene respaldo** si esa solicitud vuelve vacía. Sin cortes, o con un plan inválido, `cuts` es `[]` y `vmap()` es un VMAP vacío válido.

`sessionId` (opcional) es el identificador de la vista que se manda a iADServer como `sid`. Si no lo pasás, el módulo genera uno al azar en cada `attachAds` y lo guarda sólo en memoria. Si no lo pasás y el plan trae `commerce.session`, el módulo usa ese valor en lugar de uno al azar ([Producto con botón Comprar en la escena](#producto-con-botón-comprar-en-la-escena)). Un `sessionId` del host siempre se respeta.

Hay tres maneras de usarlos:

1. **Tu propio reproductor de anuncios**: programá los cortes con `ads.cuts` y recorré las `requests` de cada uno como se explica en [Players de terceros](#players-de-terceros).
2. **Tu propio IMA**: pasá `ads.vmap()` como `adsResponse` de tu `AdsRequest` (sólo la primera solicitud de cada corte).
3. **El reproductor del módulo**: con `linear: 'ima'` y un `adContainer` (el elemento sobre el video donde IMA dibuja), el módulo carga `ima3.js` una sola vez, pide el VMAP y deja que IMA programe los cortes. Llamá a `ads.start()` dentro del gesto de reproducción del espectador. Durante un corte pausa el video y llama `session.setLinearAd(true)`; al terminar, o ante un error o un corte vacío, vuelve a `false` y reanuda el contenido. `onEvent({ type, cut })` recibe `break_start`, `break_end` y `break_error`.

Cuando algún corte tiene más de una solicitud, el módulo programa él mismo los cortes en lugar de usar el VMAP: no pide nada antes de `start()`, pide el preroll en `start()` y cada midroll unos 8 segundos antes. Pregunta a la primera solicitud y, si vuelve vacía, falla o no responde en 5 segundos, pasa a la siguiente; el contenido se reanuda cuando un anuncio se reproduce o cuando se acaba la lista. Cada corte emite `break_start` una sola vez y después `break_end` o `break_error`; `break_error` significa que fallaron todas las solicitudes. Si todas vuelven vacías antes del corte, el contenido nunca se pausa: `break_error` puede llegar sin `break_start` y antes del momento del corte, igual que con una sola solicitud cuando el corte vuelve vacío mientras se prepara. Mientras se piden las solicitudes del preroll, el módulo retiene el contenido él mismo: si el video ya se está reproduciendo, o empieza a reproducirse (por ejemplo con `ads.start(); video.play();`), lo pausa y lo reanuda cuando el preroll termina o falla; si nunca lo reprodujiste, o el espectador lo pausó mientras tanto, no lo reanuda. Si `destroy()` llega durante esa retención, devuelve el contenido reanudándolo, sin eventos. Un anuncio que IMA ya está empezando conserva sus 5 segundos aunque se cumplan los 8 de retención. Como esa reanudación ocurre fuera del gesto del espectador, si el navegador rechaza `play()` el módulo emite `{ type: 'resume_blocked', cut }`: mostrá tu control de reproducción. Al entrar con el video ya avanzado, los cortes que quedaron atrás no se piden; un corte que el espectador cruza buscando durante la reproducción sí (sólo el último cruzado). Si un corte no empieza tras 2 segundos de contenido después de su momento, o el contenido queda pausado 8 segundos sin anuncio, se emite `break_error` y el contenido sigue. Para diagnóstico, `onEvent` recibe además `{ type: 'break_request', cut, provider, attempt }` por cada intento y `{ type: 'break_no_fill', cut, provider, attempt }` cuando uno vuelve vacío o falla (`attempt` empieza en 1).

```js
const ads = attachAds({ session, video, plan, linear: 'ima', adContainer });
playButton.addEventListener('click', () => { ads.start(); video.play(); });
```

La página que aloja el reproductor debe servirse por https: IMA pide sus propios marcos con el esquema de la página. Con reglas de anuncios (VMAP), un corte que IMA no puede pedir o que vuelve vacío (`AD_BREAK_FETCH_ERROR`, o un `LOG` con `adError`) emite `break_error` con su corte una sola vez. Si el evento no trae el anuncio, el corte es el preroll mientras el contenido no empezó; si no, el último corte ya vencido, o el próximo, entre los posteriores al último corte que empezó o falló (IMA pide cada corte unos segundos antes).

Llamá a `attachAds` antes del gesto de reproducción del espectador, para que `start()` pueda inicializar IMA dentro de ese gesto. Si IMA llega cuando el video ya pasó su primer segundo, se salta el preroll (los midrolls se mantienen); si `ima3.js` no cargó 8 segundos después de `start()`, el módulo renuncia a IMA en esa reproducción (`break_error`) y el contenido sigue. Un corte que no termina en 120 segundos se trata como error y el contenido se reanuda.

Sin `linear: 'ima'` no se carga nada de IMA y `start()` no hace nada. Si programás tus propios cortes, `ads.setBreaks([segundos])` le dice al módulo dónde están: desde ese momento esas posiciones reemplazan a `plan.cuts` para `cut_clearance_seconds`. Mientras tu reproductor de anuncios pasa un corte, llamá a `ads.setBreakActive(true)` (y `false` al terminar): el overlay se oculta y no empieza ninguna solicitud de gráficos, igual que durante un corte de IMA.

### Overlay de display de 300×250

Cuando `plan.scenes.formats` incluye `overlay_300x250` y el plan trae `scenes.overlay.ad_unit` (una ruta de GAM que empieza con `/` y el código numérico de la red), el overlay entra en la misma rotación y pacing que el súper y la L. **Necesita `stage`**: el módulo crea dentro un contenedor de 300×250 sobre el video, a la derecha y por encima de los controles (12 px del borde derecho, 58 px del inferior). Sin `stage`, o con uno menor de 640×360, no se sirve.

```js
const ads = attachAds({ session, video, plan, stage });
```

Carga `gpt.js` una sola vez (sólo en este caso) y hace todas las llamadas a GPT por `googletag.cmd`. Si la página todavía no activó GPT, el módulo usa `googletag.setConfig({ disableInitialLoad: true })` (o `disableInitialLoad()` en un GPT sin `setConfig`), fija `page_url` y activa los servicios; si la página ya lo había activado (`googletag.pubadsReady`), no toca esa configuración global. Define un slot de 300×250 con `slot.setConfig({ targeting })` y la segmentación de la ventana más `il_format=overlay_300x250` y lo pide una sola vez unos 4 segundos antes de la ventana. Muestra el contenedor sólo cuando `slotRenderEnded` indica que no está vacío y sólo durante la parte utilizable de la ventana; un slot vacío cuenta como sin relleno. Al terminar la ventana, o con `destroy()`, lo oculta y destruye el slot. Nunca se ve durante un corte de video (de `linear: 'ima'` o señalado con `setBreakActive(true)`). El tamaño de `stage` se mide cuando toca pedir la ventana. `onEvent` recibe `request`, `fill`, `no_fill`, `error` e `impression` (`impressionViewable` de GPT) con `format: 'overlay_300x250'`. Mientras el overlay ocupa su ventana no se pide otro formato.

### Players de terceros

Un player propio del publisher no recibe el plan dentro de la página: lo pide al backend de Interactive Layers.

```js
import { loadPlan, planUrl } from '@interactivelayers/player-sdk/ads';

const plan = await loadPlan(planUrl({ origin: 'https://console.interactivelayers.com', project, asset }));
```

`planUrl` arma `<origin>/il-player/ad-plan?project=…&asset=…` (el origen debe ser `https:`; si no, lanza `TypeError`, igual que con un `project` o `asset` vacío). `loadPlan` nunca lanza: acepta una URL absoluta `https:` o una relativa, que resuelve contra la página (sin página, una relativa devuelve `null`); hace un solo `GET` sin cookies ni redirecciones y devuelve el plan, o `null`. El endpoint sólo responde a los dominios verificados del proyecto. `null` significa «reproducí sin anuncios esta vez»: sin plan todavía (el backend lo prepara en segundo plano), error de red o respuesta inválida. El navegador puede cachear la respuesta unos minutos. `loadPlan(url, { fetchImpl, signal })` acepta un `AbortSignal`.

**HTML5 `<video>`.** El SDK reproduce los gráficos y el módulo pide los cortes a IMA.

```js
const session = attachHtmlVideo({ video, stage, timeline: 'media' });
const ads = attachAds({ session, video, stage, plan, linear: 'ima', adContainer });
playButton.addEventListener('click', () => { ads.start(); video.play(); });
```

Llamá a `ads.start()` dentro del gesto de reproducción del espectador. Con `plan` en `null`, `attachAds` queda inactivo y el video se reproduce sin anuncios.

**Un player con su propia integración de anuncios** (el ad manager de Shaka Player, o Video.js con un plugin de IMA). El player dibuja y mide sus cortes; el SDK sólo agrega los gráficos y el overlay. Adjuntá el adaptador del SDK con `timeline: 'media'` y llamá a `attachAds` sin `linear`, para que el módulo no cargue IMA. Entregale al player sus cortes: `ads.vmap()` es el VMAP que su IMA toma como respuesta de anuncios, o recorré `ads.cuts` y programá cada `tagUrl` con la API de anuncios del propio player. Cuando un corte empieza y cuando termina, llamá a `ads.setBreakActive(true)` y `ads.setBreakActive(false)` desde los eventos de esa API, para que los gráficos y el overlay no aparezcan durante el corte.

```js
// Shaka Player con su ad manager: el SDK dibuja sobre el mismo <video> con el adaptador HTML5.
const session = attachHtmlVideo({ video, stage, timeline: 'media' });
const ads = attachAds({ session, video, stage, plan });
const vmap = ads.vmap(); // Pasalo a la API de anuncios del ad manager de Shaka.
// En los eventos de inicio y fin de corte de esa API:
//   ads.setBreakActive(true);  ...  ads.setBreakActive(false);
```

```js
// Video.js con un plugin de IMA.
const session = attachVideoJs({ player: videojsPlayer, stage, timeline: 'media' });
const ads = attachAds({ session, video: videojsPlayer.el().querySelector('video'), stage, plan });
const vmap = ads.vmap(); // Pasalo como respuesta de anuncios (adsResponse) de la solicitud de IMA.
// En los eventos de inicio y fin de corte del plugin:
//   ads.setBreakActive(true);  ...  ads.setBreakActive(false);
```

Cada llamada a `ads.vmap()` trae un `correlator` nuevo: pedilo una vez por reproducción. El VMAP lleva sólo la primera solicitud de cada corte y no tiene respaldo. Al cerrar el player, `ads.destroy()`.

**Un player que programa sus propios cortes** con `ads.cuts` recorre las `requests` de cada corte en orden:

1. Agregá un `correlator` nuevo al `tagUrl` en cada intento (también al repetir una solicitud) y esperá hasta 5 segundos.
2. Un VAST vacío, un error o el vencimiento del plazo pasan a la solicitud siguiente.
3. Pará en la primera que empieza a reproducirse; si se acaba la lista, seguí con el contenido.

Usá el mismo `sid` de iADServer durante toda la vista (pasá `sessionId` a `attachAds` si ya tenés un identificador propio). Retené la primera reproducción hasta que el preroll empiece o falle (`break_start` o `break_error` con el reproductor del módulo, que además retiene el contenido por su cuenta). `break_error` puede llegar sin `break_start` y antes del momento del corte.

Google Ad Manager aplica reglas a nivel de stream entre los cortes de una misma reproducción (topes de frecuencia, exclusiones): no reinicies el stream entre cortes. Llamá a `contentComplete` sólo al final real del contenido; el módulo hace lo mismo.

### Producto con botón Comprar en la escena

Cuando el plan trae `commerce` (`kind: "scene_product"`), el módulo pide a IL el producto de cada ventana y lo muestra con la misma ficha de compra que el feed de sesión ([Compra con Shopify](#compra-con-shopify)). Para activarlo, el host hace dos cosas:

```js
const session = attachHtmlVideo({ video, stage, timeline: 'media', commerce: { locale: 'es' } });
const ads = attachAds({ session, video, stage, plan, planOrigin: 'https://console.interactivelayers.com' });
```

- `commerce` en el adaptador (`attachHtmlVideo`, `attachVideoJs`, `attachShaka`): las mismas opciones de [Compra con Shopify](#compra-con-shopify) (`locale`, `tv`, `navigate`). Sin ellas la sesión no dibuja la ficha y el módulo no pide productos.
- `planOrigin` en `attachAds`: el origen del que el host obtuvo el plan, cuando no lo cargó con `loadPlan`. `commerce.url` tiene que estar en el origen del plan: el que usó `loadPlan` (el módulo lo recuerda), o bien el de la propia página o `planOrigin`. Si no, el módulo ignora `commerce` y sigue con el resto del plan. Un plan cargado con `loadPlan` no acepta otro origen aunque se pase `planOrigin`.
- `sessionId` no hace falta para el producto: la sesión viene en el permiso de `commerce.url`. Para los cortes, un `sessionId` del host sigue siendo el `sid` de los pedidos de iADServer, como siempre (sus topes de frecuencia por espectador). Sin él, el módulo usa `commerce.session` del plan en lugar de uno al azar, así iADServer cuenta cortes y productos en la misma sesión. Una `session` que no cumple `[A-Za-z0-9_.:-]{1,128}` no se usa.

Sin `plan.commerce`, o con un `kind` desconocido, nada cambia. Un plan sólo con `commerce` (sin `scenes` ni `cuts`) es válido.

Qué hace:

- Calcula las ventanas usables con `commerce.pacing` (igual que las de gráficos) y pide `commerce.url` con `window` y `locale` agregados `lead_ms` antes de cada una, o en el acto si un salto cae dentro de la ventana. `commerce.url` es opaca: ya trae el proyecto, el asset y un permiso firmado de corta duración que nombra la sesión, y el módulo sólo le agrega esas dos claves (con `?` o `&` según tenga o no consulta) sin leerla ni reescribirla. `locale` sale de `commerce.locale` del adaptador o del idioma del navegador (`es`, `en` o `pt-BR`). Sin cookies, sin redirecciones, `no-store` y con 6 segundos de límite. Un solo pedido por ventana y reproducción, sin reintentos, y uno a la vez.
- `200` es la tarjeta: el módulo la recorta a la ventana y la agrega con `session.addCue`. `204`, `429`, cualquier otro estado, una tarjeta inválida (sin `commerce`, de otra ventana) o el vencimiento del plazo no muestran nada y no vuelven a pedir esa ventana.
- `gap_after_seconds`, `max_per_video` y los 30 segundos entre inicios cuentan productos y gráficos juntos, incluidos los que se están pidiendo.
- En una ventana que también está en `scenes.windows`, el Súper o la L esperan la respuesta del producto: con `200` gana el producto y no se pide el gráfico; con `204`, `429` o un error la ventana queda libre para el gráfico. El overlay de 300×250 sigue sus propias reglas.
- La tarjeta se oculta durante cualquier corte (de IMA o `setBreakActive(true)`), cuando el contenido termina (`ended`) y al llegar a su `end`; vuelve, cerrada, si el corte termina antes. En pausa sigue en pantalla, cerrada o con el detalle abierto, y si el espectador tiene el detalle abierto cuando llega su `end`, queda hasta que lo cierre (o empiece un corte): ver [Compra con Shopify](#compra-con-shopify). Con un reloj de contenido (inserción en servidor) sigue las mismas reglas que los gráficos: nunca sobre un anuncio y con la revisión por cuadro mientras está en pantalla.
- Mediciones: `impressionUrl` una sola vez, la primera vez que la tarjeta queda visible (aunque vuelva tras un corte, y aunque la página vuelva a llamar a `attachAds` y reciba la misma entrega: el módulo recuerda en la página los `id` ya medidos); `viewUrl` una vez al abrir el detalle (lo envía la ficha); el `POST` a `handoffUrl` con `{ variantId }` al tocar **Comprar** es la intención de compra. `onEvent` recibe `request`, `fill`, `no_fill`, `error`, `impression` y `click` con `format: 'scene_product'`.

**Comprar desde un player embebido.** En web, **Comprar** hace el `POST` y muestra **Continuar a Shopify**, un enlace que abre `continueUrl` en una pestaña nueva con el clic del espectador (los bloqueadores de ventanas emergentes no frenan un enlace que el espectador toca). Si la página corre dentro de un iframe, la ficha agrega además el QR de esa misma compra (`qrImageUrl`), porque un iframe con `sandbox` sin `allow-popups` no abre el enlace: el espectador termina la compra desde el celular. Para que el enlace funcione, el iframe del publisher debe permitir `allow-popups` y `allow-popups-to-escape-sandbox`. Con `commerce.navigate(url)` la app decide cómo abrir el destino. `continueUrl` y `qrImageUrl` se usan sólo si son HTTPS sin usuario ni contraseña: otro `continueUrl` muestra el aviso de error de la ficha y no abre nada, y otro `qrImageUrl` no se dibuja. En TV (`commerce: { tv: true }`) la compra es la de siempre: el QR. La página necesita `connect-src` para la ruta de IL y para `https://ads.iadserver.com`, e `img-src https:` para la tarjeta y el QR.

### Anuncios insertados en el stream (MediaTailor)

Con la entrega por inserción en el servidor, AWS Elemental MediaTailor cose los anuncios de video dentro del HLS y el player del publisher sólo dibuja los gráficos de escena con el SDK. En ese stream `video.currentTime` es tiempo de stream (contenido más anuncios), así que el módulo programa las escenas con un **reloj de contenido**: en cada momento responde los segundos de contenido que se están viendo, o `null` cuando hay un anuncio en pantalla o no se puede saber la posición.

El plan de un stream así llega con este campo y sin cortes:

```json
{
  "timeline": { "kind": "stitched", "pdt_origin": "2000-01-01T00:00:00.000Z", "breaks": [0, 312.5] },
  "cuts": []
}
```

- `kind`: `"stitched"`. Un `timeline` con otro valor deja el módulo inactivo, para no dibujar sobre anuncios que no sabe ubicar.
- `pdt_origin`: instante ISO 8601 del segundo 0 del contenido. El origen escribe `#EXT-X-PROGRAM-DATE-TIME` en **cada segmento de contenido** con `pdt_origin` más el inicio del segmento en el contenido (el segundo 12,5 es `2000-01-01T00:00:12.500Z`). MediaTailor conserva esas líneas en los segmentos de contenido de todas las variantes y no escribe ninguna en los de anuncio.
- `breaks` (opcional): segundos de contenido donde MediaTailor inserta cada corte (el preroll es `0`). Sólo se usan para `cut_clearance_seconds`; el módulo no pide nada con ellos. Sin `breaks`, la distancia a los cortes depende sólo de la detección del anuncio en pantalla: el gráfico se oculta al empezar el anuncio, pero puede verse hasta el último segundo de contenido antes del corte.

Con un plan `stitched` el módulo nunca pide ni programa cortes de video: `ads.cuts` es `[]`, `ads.vmap()` es un VMAP vacío y no se carga IMA aunque el host pase `linear: 'ima'` o el plan traiga `cuts` por error. Sin `clock`, ese plan deja el módulo inactivo, porque la posición del video no es tiempo de contenido. La sesión tiene que dibujar con el mismo reloj (`programTime: clock.programTime`): si se creó con otro (por ejemplo con `timeline: 'media'`), el módulo no dibuja nada y emite una sola vez `onEvent({ type: 'clock_mismatch' })`.

```js
import Hls from 'hls.js';
import { attachHtmlVideo } from '@interactivelayers/player-sdk';
import { attachAds, hlsContentClock } from '@interactivelayers/player-sdk/ads';

const hls = new Hls();
hls.attachMedia(video);
hls.loadSource(playback.mediaTailorUrl);
const clock = hlsContentClock({ hls, video, plan });
// La sesión usa el mismo reloj: sus cues se cuentan en milisegundos de contenido y no se ven durante un anuncio.
const session = attachHtmlVideo({ video, stage, programTime: clock.programTime });
const ads = attachAds({ session, video, stage, plan, clock });
// Al cerrar: ads.destroy(); session.destroy(); clock.destroy(); hls.destroy();
```

`hlsContentClock({ hls, video, plan })` lee el fragmento de hls.js que contiene `video.currentTime` en la lista de la variante actual (o la última recibida con `LEVEL_LOADED`/`LEVEL_UPDATED`), y calcula `rawProgramDateTime − pdt_origin + (currentTime − frag.start)`. Un fragmento sin `rawProgramDateTime` es un anuncio. No usa `frag.programDateTime` ni `hls.playingDate`, porque hls.js los extrapola a través de los anuncios. Como lee la posición en el momento, funciona en los primeros cuadros, después de buscar hacia adelante o hacia atrás y en pausa; `FRAG_CHANGED` sólo hace que el módulo vuelva a revisar en el acto. Después de un anuncio, los primeros 0,25 segundos de contenido cuentan como anuncio, porque el inicio del fragmento en hls.js puede diferir unos 0,1 segundos de la imagen; antes de un anuncio el margen es de 0,5 segundos. Ambos márgenes se multiplican por `video.playbackRate` cuando es mayor que 1, para que equivalgan al mismo tiempo real. Lanza `TypeError` sin `hls`, `video` o un plan `stitched` con `pdt_origin` válido.

Durante un anuncio no empieza ningún gráfico ni ninguna solicitud, y el que está en pantalla se quita de la sesión en el acto (el overlay se oculta). Mientras el módulo tiene algo en pantalla revisa el reloj en cada cuadro (`requestVideoFrameCallback` cuando el navegador lo ofrece y el video se reproduce, si no `requestAnimationFrame`), no sólo con los eventos del video; en esa misma revisión también termina a tiempo la ventana que llegó a su fin. Sin reloj de contenido (el camino de siempre, ILPlayer incluido) el fin de la ventana sigue dependiendo de los eventos del video y del intervalo de la sesión, y puede pasarse unos 0,25 s. Como el reloj de contenido no avanza durante el anuncio, el gráfico no suma ese tiempo: al volver el contenido reaparece si su ventana sigue abierta y termina en el mismo segundo de contenido que antes. La impresión se envía una sola vez por gráfico y el pacing usa las ventanas en tiempo de contenido. Un gráfico que llega mientras pasa un anuncio espera al contenido.

Otro reloj se puede pasar como `clock`: un objeto con `time()` (segundos de contenido o `null`) y, opcionalmente, `onChange(listener)` que devuelve la función para dejar de escuchar. Sin `clock` el módulo usa `videoClock(video)`, que es `video.currentTime` sin anuncios: las integraciones existentes y ILPlayer no cambian.

Qué players cubre:

| Player | Estado |
| --- | --- |
| HTML5 `<video>` con hls.js | Cubierto con `hlsContentClock`. Probado en un navegador: sólo el reloj, en Chrome con hls.js 1.5.17 a velocidad 1× y 2× sobre un stream real de MediaTailor (`null` en todos los cuadros de anuncio, tiempo de contenido correcto en el contenido y después de buscar). El módulo de anuncios (8b66bd6) también se probó en Chrome con hls.js 1.5.17 sobre un stream real de MediaTailor, muestreando cada cuadro: en cuatro cargas (velocidad 2 con tres cortes, 1,5, 1 y la sesión con otro reloj), ninguno de 3.980 cuadros de anuncio tuvo un gráfico del SDK visible; un Súper que cruza un corte se vio a ambos lados y se ocultó durante el corte; el overlay de 300×250 (unidad pública de prueba de GPT, con relleno real) se ocultó 0,8 s antes del corte a 1,5; una impresión por ventana; con `timeline: 'media'` no se dibujó nada y llegó un solo `clock_mismatch`. No se probó: una respuesta no lineal real de GAM (el Súper y la L usaron un VAST provisto por `fetchImpl`), ni otros navegadores. El fin de la ventana en su cuadro con reloj de contenido se agregó después de esa prueba y sólo lo verifican las pruebas automáticas. |
| Safari con HLS nativo | No cubierto. Necesita un reloj que lea el PDT del segmento visible (`video.getStartDate()` sólo da el primero) y que distinga los segmentos de anuncio, por ejemplo con los eventos de seguimiento de MediaTailor. |
| Shaka Player | No cubierto. Necesita un reloj desde su línea de tiempo de segmentos (referencias con su PDT) y los límites de los períodos de anuncio. |
| Video.js (VHS) | No cubierto. Necesita un reloj desde los segmentos de VHS con su `dateTimeObject`, sin la extrapolación de `convertToProgramTime`. |
| Adaptadores nativos (Android, Apple, Roku, AVPlay) | No cubiertos. Cada uno necesita el PDT del segmento en reproducción y la marca de anuncio desde su propio motor. |

## Samsung AVPlay

```js
import { attachAvPlay } from '@interactivelayers/player-sdk';
const sdk = attachAvPlay({
  avplay: webapis.avplay,
  stage: document.querySelector('#stage'),
  surface: document.querySelector('object[type="application/avplayer"]'),
  getDisplayRect: () => appVideoRect,
  programTime: () => currentSegment
    ? Math.round(currentSegment.pdtMs + webapis.avplay.getCurrentTime() - currentSegment.playerStartMs)
    : null,
  playlistUrl: playback.selectedMediaPlaylistUrl,
});
```

`appVideoRect` es el rectángulo completo actual de la app en coordenadas AVPlay (`x, y, width, height`). Samsung usa una base de 1920 × 1080 para `setDisplayRect()`. `currentSegment` debe corresponder al segmento efectivamente reproducido. La integración ajusta el objeto HTML y el rectángulo de AVPlay, y recorta el lienzo gráfico en dos bandas. Al preparar un medio nuevo, la app aplica su rectángulo completo habitual. [Guía oficial de Samsung](https://developer.samsung.com/smarttv/develop/guides/multimedia/media-playback/using-avplay.html)

## Cortes y medición

Usá `sdk.setLinearAd(true)` al comenzar un spot confirmado de esa sesión y `sdk.setLinearAd(false)` cuando vuelve el contenido. Con Shaka, un ad lineal activo que conoce su AdManager también suspende la capa. En SSAI el host puede recibir esos límites desde la integración de tracking de la sesión. El backend coordina esa misma ventana con el contexto del programa.

Al pasar `onVisible(cue)`, la aplicación asume el envío de la impresión. Sin callback, el adaptador web intenta una sola solicitud al `impressionUrl` una vez presentada la gráfica. Al cerrar la reproducción llamá a `sdk.destroy()`. Para Shaka descargá el asset antes de destruir el adaptador. Los SDK no instalan un selector de proveedor en el player.

## Compra con Shopify

Agregá `commerce: { locale: 'es', country: 'AR', tv: true }` a la configuración de cualquier adaptador conectado a un `eventsUrl`.

Una tarjeta con **Comprar**, del feed de sesión o del plan, queda en pantalla mientras el video está en pausa, cerrada o con el detalle abierto, mientras la posición siga dentro de su intervalo; las gráficas sin compra (Súper, L, overlay) siguen ocultándose en pausa como siempre. Con el detalle abierto, la tarjeta no se va al terminar su intervalo: queda hasta que el espectador la cierra (si el intervalo ya terminó, entonces se va), o hasta que pasan 60 segundos de contenido desde lo último entre el fin del intervalo y la última acción del espectador en la tarjeta (un clic o una tecla en ella, o la aparición del resultado de **Comprar**). El tiempo en pausa no cuenta: en pausa la tarjeta queda todo lo que el espectador quiera. Mientras una tarjeta se retiene así no se pide ningún gráfico, que no podría verse. Si la página queda oculta (otra pestaña), la tarjeta no se descarta: al volver está igual, con el detalle y la elección; mientras está oculta no cuenta como vista. Un corte, un anuncio de la inserción en servidor o el final del contenido la quitan siempre; al volver del corte aparece cerrada si su intervalo sigue abierto. La impresión se cuenta una vez, la primera vez que la tarjeta es visible, en pausa o no. Si el espectador tarda tanto que iADServer ya venció la entrega (unos minutos después de servirla), **Comprar** muestra «Esta oferta ya no está disponible.» en lugar del aviso de reintento.

Con `commerce: { pauseOnOpen: true }` (sólo `attachHtmlVideo` y `attachVideoJs`), abrir el detalle pausa el video, así ningún corte empieza mientras el espectador elige. Cerrarlo reanuda sólo si la pausa fue del SDK y nadie reprodujo ni pausó en el medio; después de **Continuar a Shopify** (o del QR en TV) el video queda en pausa. Sin la opción, abrir el detalle no toca la reproducción. Los cortes del módulo de anuncios no empiezan con el contenido en pausa: se disparan por la posición del contenido, que no avanza. Usá `tv: true` para el navegador de TV, incluido Video.js en webOS. AVPlay usa el modo TV al habilitar comercio. Cargá `player.css` y colocá los contenedores del reproductor dentro de un ancestro con posición relativa que también incluya la ficha.

En web y móvil, **Comprar** prepara el carrito y **Continuar a Shopify** abre el enlace. Si tu app abre el destino en un navegador externo, pasá `navigate(url)` dentro de `commerce`.

En Smart TV, la portada presenta la foto, el precio y los datos disponibles en el catálogo. Al seleccionar la imagen o **Ver fotos**, se abre un visor de pantalla completa, incluso si el producto tiene una sola foto. Las flechas izquierda y derecha recorren las fotos. Atrás devuelve el foco al control que abrió el visor y conserva la variante. **Elegir opciones** abre la ficha de variantes. Si hay una sola opción, la acción se llama **Ver detalles**. Al elegir una variante, la ficha muestra su foto y su precio. **Agregar al carrito** abre el resumen de esa selección y **Continuar con el QR** muestra el código para completar la compra en Shopify. Las etapas de compra comparten el mismo panel lateral. Usá las flechas para mover el foco, OK para activar y Atrás para volver. [Contrato de compra](../docs/signals.md#compra-con-shopify)

Para mostrar **Comprar** durante un midroll vinculado, leé `creativeId` y `deliveryId` del nodo `Shop` en la extensión VAST `iADServerShop`. Al empezar ese anuncio, pasá ambos a `sdk.setLinearAd(true, {creativeId, deliveryId})`. Usá el endpoint de eventos y la sesión de esa entrega. Llamá a `sdk.setLinearAd(false)` al terminar y a `sdk.setLinearAd(true)` si empieza un spot sin tienda. El reproductor de anuncios sigue manejando el video y la impresión VAST.
