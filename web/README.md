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
- Pide el tag unos 4 segundos antes de la ventana (o en el acto si el espectador entra en ella con tiempo suficiente), con la segmentación de la ventana en `cust_params`, un `correlator` nuevo y `url`/`description_url`. Hace una sola solicitud por ventana, sin cookies, sin redirecciones y con 4 segundos de límite.
- Acepta sólo un anuncio InLine con una imagen PNG o JPEG estática por HTTPS cuya proporción coincida con el formato (20:3 o 16:9). Rechaza wrappers, anuncios lineales y recursos HTML o iframe.
- Envía las URL de `Impression` y `creativeView` una vez cuando el gráfico es visible y las de seguimiento de clic al hacer clic. Quita el cue al terminar la ventana o con `destroy()`.

- Acepta un plan con cortes y sin `scenes` (sólo cortes de video).

### Cortes de video

`ads.cuts` es la lista de cortes del plan en orden, `[{ id, at, position, tagUrl }]`: sólo tags de `https://pubads.g.doubleclick.net/gampad/ads`, con `url` y `description_url` puestos a la URL de la página y sin `correlator`. `ads.vmap()` devuelve un VMAP 1.0 con un `AdBreak` lineal por corte (`timeOffset="start"` para el segundo 0) y un `correlator` nuevo en cada llamada. Sin cortes, o con un plan inválido, `cuts` es `[]` y `vmap()` es un VMAP vacío válido.

Hay tres maneras de usarlos:

1. **Tu propio reproductor de anuncios**: programá los cortes con `ads.cuts` y pedí cada `tagUrl` (agregando tu `correlator`).
2. **Tu propio IMA**: pasá `ads.vmap()` como `adsResponse` de tu `AdsRequest`.
3. **El reproductor del módulo**: con `linear: 'ima'` y un `adContainer` (el elemento sobre el video donde IMA dibuja), el módulo carga `ima3.js` una sola vez, pide el VMAP y deja que IMA programe los cortes. Llamá a `ads.start()` dentro del gesto de reproducción del espectador. Durante un corte pausa el video y llama `session.setLinearAd(true)`; al terminar, o ante un error o un corte vacío, vuelve a `false` y reanuda el contenido. `onEvent({ type, cut })` recibe `break_start`, `break_end` y `break_error`.

```js
const ads = attachAds({ session, video, plan, linear: 'ima', adContainer });
playButton.addEventListener('click', () => { ads.start(); video.play(); });
```

Llamá a `attachAds` antes del gesto de reproducción del espectador, para que `start()` pueda inicializar IMA dentro de ese gesto. Si IMA llega cuando el video ya pasó su primer segundo, se salta el preroll (los midrolls se mantienen); si `ima3.js` no cargó 8 segundos después de `start()`, el módulo renuncia a IMA en esa reproducción (`break_error`) y el contenido sigue. Un corte que no termina en 120 segundos se trata como error y el contenido se reanuda.

Sin `linear: 'ima'` no se carga nada de IMA y `start()` no hace nada. Si programás tus propios cortes, `ads.setBreaks([segundos])` le dice al módulo dónde están: desde ese momento esas posiciones reemplazan a `plan.cuts` para `cut_clearance_seconds`. Mientras tu reproductor de anuncios pasa un corte, llamá a `ads.setBreakActive(true)` (y `false` al terminar): el overlay se oculta y no empieza ninguna solicitud de gráficos, igual que durante un corte de IMA.

### Overlay de display de 300×250

Cuando `plan.scenes.formats` incluye `overlay_300x250` y el plan trae `scenes.overlay.ad_unit` (una ruta de GAM que empieza con `/` y el código numérico de la red), el overlay entra en la misma rotación y pacing que el súper y la L. **Necesita `stage`**: el módulo crea dentro un contenedor de 300×250 sobre el video, a la derecha y por encima de los controles (12 px del borde derecho, 58 px del inferior). Sin `stage`, o con uno menor de 640×360, no se sirve.

```js
const ads = attachAds({ session, video, plan, stage });
```

Carga `gpt.js` una sola vez (sólo en este caso) y hace todas las llamadas a GPT por `googletag.cmd`. Si la página todavía no activó GPT, el módulo usa `disableInitialLoad`, fija `page_url` y activa los servicios; si la página ya lo había activado (`googletag.pubadsReady`), no toca esa configuración global. Define un slot de 300×250 con la segmentación de la ventana más `il_format=overlay_300x250` y lo pide una sola vez unos 4 segundos antes de la ventana. Muestra el contenedor sólo cuando `slotRenderEnded` indica que no está vacío y sólo durante la parte utilizable de la ventana; un slot vacío cuenta como sin relleno. Al terminar la ventana, o con `destroy()`, lo oculta y destruye el slot. Nunca se ve durante un corte de video (de `linear: 'ima'` o señalado con `setBreakActive(true)`). El tamaño de `stage` se mide cuando toca pedir la ventana. `onEvent` recibe `request`, `fill`, `no_fill`, `error` e `impression` (`impressionViewable` de GPT) con `format: 'overlay_300x250'`. Mientras el overlay ocupa su ventana no se pide otro formato.

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

Agregá `commerce: { locale: 'es', country: 'AR', tv: true }` a la configuración de cualquier adaptador conectado a un `eventsUrl`. Usá `tv: true` para el navegador de TV, incluido Video.js en webOS. AVPlay usa el modo TV al habilitar comercio. Cargá `player.css` y colocá los contenedores del reproductor dentro de un ancestro con posición relativa que también incluya la ficha.

En web y móvil, **Comprar** prepara el carrito y **Continuar a Shopify** abre el enlace. Si tu app abre el destino en un navegador externo, pasá `navigate(url)` dentro de `commerce`.

En Smart TV, la portada presenta la foto, el precio y los datos disponibles en el catálogo. Al seleccionar la imagen o **Ver fotos**, se abre un visor de pantalla completa, incluso si el producto tiene una sola foto. Las flechas izquierda y derecha recorren las fotos. Atrás devuelve el foco al control que abrió el visor y conserva la variante. **Elegir opciones** abre la ficha de variantes. Si hay una sola opción, la acción se llama **Ver detalles**. Al elegir una variante, la ficha muestra su foto y su precio. **Agregar al carrito** abre el resumen de esa selección y **Continuar con el QR** muestra el código para completar la compra en Shopify. Las etapas de compra comparten el mismo panel lateral. Usá las flechas para mover el foco, OK para activar y Atrás para volver. [Contrato de compra](../docs/signals.md#compra-con-shopify)

Para mostrar **Comprar** durante un midroll vinculado, leé `creativeId` y `deliveryId` del nodo `Shop` en la extensión VAST `iADServerShop`. Al empezar ese anuncio, pasá ambos a `sdk.setLinearAd(true, {creativeId, deliveryId})`. Usá el endpoint de eventos y la sesión de esa entrega. Llamá a `sdk.setLinearAd(false)` al terminar y a `sdk.setLinearAd(true)` si empieza un spot sin tienda. El reproductor de anuncios sigue manejando el video y la impresión VAST.
