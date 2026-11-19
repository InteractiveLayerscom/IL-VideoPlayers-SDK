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
