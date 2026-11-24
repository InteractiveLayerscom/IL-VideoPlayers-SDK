# Overlays para Media3 en Android TV y Fire TV

La biblioteca muestra el súper y la L sobre el `PlayerView` que ya reproduce tu canal. Necesitás Android API 23 o posterior y Media3 1.6.0 con soporte HLS. El layout estándar de Media3 incluye el contenedor de video `exo_content_frame`. Si usás un layout propio, conservá ese contenedor dentro de un `FrameLayout`.

## Integrar en una app

1. Cloná `IL-VideoPlayers-SDK` y agregá su módulo Android al `settings.gradle` de tu app. Ajustá la ruta a tu copia.

   ```groovy
   includeBuild('../IL-VideoPlayers-SDK/android')
   ```

2. Agregá la dependencia al `build.gradle` del módulo de la app. Gradle toma la biblioteca de la copia local.

   ```groovy
   dependencies {
       implementation 'com.interactivelayers:media3-overlays:0.1.0'
   }
   ```

3. Después de vincular tu reproductor a la vista, conectá los gráficos en el hilo principal.

   ```java
   import com.interactivelayers.overlay.OverlayController;

   // Guardá esta referencia junto con tu PlayerView.
   playerView.setPlayer(player);
   OverlayController overlays = OverlayController.attach(playerView);
   ```

Llamá a `overlays.stop()` en `onStop()`, a `overlays.start()` en `onStart()` y a `overlays.close()` antes de liberar el reproductor o cambiar de `PlayerView`. En un fragmento, cerrá el controlador en `onDestroyView()`. La app sigue controlando la reproducción, el audio, los subtítulos y el mando.

## Señal del canal

Por defecto, el SDK lee las marcas del manifiesto HLS que Media3 ya recibió. La variante de medios debe incluir `EXT-X-PROGRAM-DATE-TIME` y la marca gráfica. Este ejemplo muestra un súper de cinco segundos.

```m3u8
#EXT-X-PROGRAM-DATE-TIME:2026-11-19T12:00:00Z
#EXT-X-DATERANGE:ID="super-7",CLASS="com.interactivelayers.overlay",START-DATE="2026-11-19T12:00:03Z",DURATION=5,X-IL-FORMAT="super",X-ASSET-URI="https://media.example/creativos/super.png",X-ASSET-MIMETYPE="image/png"
```

La hora de presentación es el inicio UTC de la ventana más la posición de contenido del player. Funciona en vivo, durante una búsqueda dentro de la ventana disponible y en VOD con fecha de programa. Una imagen está activa desde `START-DATE` inclusive hasta el final exclusivo. Podés indicar el final con `END-DATE` o `DURATION` en segundos. Si aparecen ambos, deben coincidir.

Para una L, usá `X-IL-FORMAT="l"` y un lienzo completo, con el arte en el lateral derecho y la franja inferior. El video ocupa el 75 % del ancho y del alto en la esquina superior izquierda. Al salir, la vista recupera sus parámetros de layout originales. El súper se dibuja al 12,5 % desde la izquierda y al 70 % desde arriba, con 75 % de ancho y 20 % de alto. Se admiten PNG y JPEG por HTTPS de hasta 4 MiB, con un máximo de 4096 píxeles por lado y 8.847.360 píxeles en total.

Si tu sesión entrega una agenda JSON, pasá su URL y tu identificador de sesión al conectar el SDK.

```java
OverlayController overlays = OverlayController.attach(playerView, urlAgendaHttps, idSesion);
```

Esta modalidad consulta una sola agenda y conserva la sesión HLS del reproductor. El SDK hace un GET con `time` en milisegundos Unix y `sid` con el ID que pasaste. Si el ID es `null`, genera un UUID. La agenda devuelve un arreglo con los campos `id`, `format`, `start`, `end`, `imageUrl` y el opcional `impressionUrl`. `start` y `end` son enteros en milisegundos Unix. Una respuesta vacía retira el gráfico.

Las pausas, el buffering, la pérdida de foco de la ventana y los anuncios que Media3 identifica con `isPlayingAd()` suspenden los gráficos. Para un corte integrado al stream por tu proveedor SSAI, conectá los eventos de inicio y fin.

```java
overlays.setLinearAdActive(true);  // Inicio del spot.
overlays.setLinearAdActive(false); // Regreso al programa.
```

Si tu app ya tiene un calendario de cortes, también puede consultarlo con `setLinearAdDetector(programTimeMs -> miAgenda.enCorte(programTimeMs))`. La impresión opcional (`X-IL-IMPRESSION-URI` o `impressionUrl`) se envía por HTTPS cuando Android dibuja el arte visible dentro de la ventana. Cada ID genera como máximo una impresión durante la sesión del controlador.

## Compilar y probar

Para generar la biblioteca desde `IL-VideoPlayers-SDK/android`, configurá `ANDROID_HOME` e instalá JDK 17, Gradle 9.0 y Android SDK 35.

```sh
gradle assembleRelease testDebugUnitTest
```

El AAR queda en `build/outputs/aar/media3-overlays-release.aar`. Para correr las pruebas en un Android conectado o en un emulador, instalá FFmpeg en el equipo de desarrollo.

```sh
gradle connectedDebugAndroidTest
```

Las pruebas instrumentadas generan un segmento de video sintético y levantan un servidor HTTPS dentro del dispositivo. ExoPlayer reproduce ese HLS, descarga el arte y envía la impresión al servidor de prueba. El fixture comprueba las posiciones de dibujo, la restitución del video, las búsquedas, los cambios de ciclo de vida y la modalidad de agenda. Para reproducir la muestra común en tu TV, consultá la [guía de señales de ejemplo](../examples/README.md).

Las capturas muestran el área 16:9 del reproductor (1676 × 943 píxeles) en el emulador Android 15, API 35. El verde corresponde al video HLS decodificado y el rojo a la imagen descargada desde el servidor de prueba. Ambas capturas se generan durante `connectedDebugAndroidTest`.

| Súper | L |
| --- | --- |
| [![Video verde con súper rojo en la franja inferior](evidence/super.png)](evidence/super.png) | [![Video verde reducido a la esquina superior izquierda y creatividad roja en L](evidence/l.png)](evidence/l.png) |

## Demo de Te Informás TV

La app de `IL-Context-Engine/demos/teinformas-tv/android-tv` busca el SDK en una copia hermana de `IL-Context-Engine`. Para usar otra ubicación, pasá `-PilVideoPlayersSdkAndroid=/ruta/IL-VideoPlayers-SDK/android` a Gradle. Desde el directorio de la app, `gradle installDebug` instala el piloto en el dispositivo conectado.

Para un HLS que contiene las marcas, lanzá la app con el extra `source`. Si el backend entrega una agenda por espectador, agregá `schedule` y el mismo `sid` que el backend usó en `adsParams.il_sid` para crear esa sesión de reproducción.

```sh
adb shell 'am start -n com.teinformas.pilot/.MainActivity --es source "https://canal.example/sesion/master.m3u8" --es schedule "https://canal.example/piloto/overlays" --es sid "prueba-tv-01"'
```

El proxy del piloto admite de 1 a 64 caracteres en `sid`, con letras ASCII, números, punto, guion y guion bajo. En una vista previa podés omitirlo para generar un UUID local. Con agenda, la demo reserva los primeros 15 segundos del playhead como convención de preroll. Para sincronizar una emisión real, el integrador SSAI comunica los límites efectivos de cada spot mediante `setLinearAdActive`.

## Compra con Shopify

Con un endpoint JSON por sesión, instalá el controlador de comercio después de asignar el player al `PlayerView`.

```java
OverlayController overlays = OverlayController.attachCommerce(
        playerView, playback.overlayFeedUrl, playback.sessionId, "es", "AR", null);
```

El último argumento permite seleccionar el modo TV. Usá `null` para detectar Android TV, Google TV y Fire TV desde el dispositivo. El modo TV muestra el QR y el modo móvil abre la continuación en el navegador. Si la app intercepta Atrás, consultá `overlays.closeCommercePanel()` antes de ejecutar su navegación. [Contrato de compra](../docs/signals.md#compra-con-shopify)

En TV, la portada, los detalles, el carrito y el QR comparten un panel lateral. Si las variantes disponibles tienen precios distintos, la portada muestra «Desde» y el precio más bajo. «Elegir opciones» abre la selección de variantes y «Ver detalles» aparece cuando hay una sola opción disponible. Un producto sin opciones (la única variante «Default Title» de Shopify) no muestra fila de variantes: el detalle enfoca «Agregar al carrito» y el carrito no repite la variante. El botón de fotos abre la imagen del SKU o la portada del producto sobre todo el reproductor: se llama «Ampliar foto» si el visor tiene una sola foto y «Ver fotos» si tiene varias. Con varias fotos, las flechas izquierda y derecha recorren la galería. Atrás devuelve el foco a ese botón en la pantalla de origen. «Agregar al carrito» muestra la variante, una unidad y su total. «Continuar con el QR» prepara el carrito de Shopify. Atrás vuelve a la etapa anterior. En móvil, «Comprar» abre la continuación HTTPS de Shopify.

En TV, mientras está en pantalla un anuncio con algo para elegir (tarjetas de producto, un botón de compra o el panel abierto), el control remoto es del anuncio. El anuncio toma el foco en su primera tarjeta. Las flechas pasan de una tarjeta a otra sin salir del anuncio, y OK o Enter abren el producto. Atrás o Escape retroceden en el panel y, al cerrarlo, el foco vuelve a la tarjeta, o a la primera tarjeta del anuncio si esa ya no está. Si tampoco hay anuncio, el foco vuelve a donde estaba antes de que el anuncio lo tomara. Lo mismo pasa cuando el anuncio termina con una tarjeta enfocada y sin panel abierto. Atrás sobre una tarjeta, sin panel abierto, sigue siendo de la app.

**Cambio visible para la app: los controles de Media3 en TV.** El `PlayerView` recibe las teclas antes que el anuncio, así que con sus controles en uso una flecha solo los mostraría. Por eso, mientras dura un anuncio con algo para elegir, el SDK pone `setUseController(false)`, y al terminar devuelve el valor que tenía la app. Si la app los activa mientras tanto, gana la app. Si los desactiva mientras tanto, al terminar el anuncio vuelven activados, porque el SDK no puede distinguir ese cambio del suyo. Al dejarlos de lado, el `ControllerVisibilityListener` de la app recibe que se ocultan (`GONE`). El espectador ve que los controles se van mientras el anuncio está en pantalla, aunque estuvieran visibles, y vuelven después. Mientras tanto, las teclas multimedia (reproducir/pausa, reproducir, pausa, avanzar, retroceder, siguiente, anterior) siguen actuando sobre el reproductor como lo harían los controles de Media3. Si en ese momento el foco está en el propio `PlayerView` o en una vista de la app dentro de él, la tecla multimedia no llega ni al SDK ni a los controles: atendela en la app (por ejemplo con una `MediaSession`). En el móvil no cambia nada. La app no tiene que agregar código.

Si la app usa controles propios en lugar de los de `PlayerView` (por ejemplo, los controles de transporte de Leanback), debe ocultarlos o dejar de tomar el foco mientras haya un anuncio con algo para elegir, para que el foco pueda llegar al anuncio. Al aparecer, el anuncio toma el foco una vez, y lo recupera si el foco queda sin dueño.

El súper dura exactamente su ventana. El panel que abrió el espectador queda abierto, aunque el anuncio termine y el contenido siga, hasta que el espectador lo cierre. También se cierra si empieza un corte publicitario nuevo (en un corte con varios anuncios, cada anuncio nuevo cierra el producto abierto del anterior), si el espectador abre otro producto, si cambia el contenido, si la app llama a `stop()` o `close()`, o si el `PlayerView` sale de la ventana. No se cierra por un salto adelante o atrás, una pausa, una carga, otro anuncio que aparece detrás ni los controles de la app. La impresión del anuncio y la visita del producto se cuentan una sola vez.

Para vincular la tienda a un midroll, usá el mismo endpoint y sesión con los que se sirvió el spot. Cuando el host empiece a reproducir el anuncio, pasá los atributos `creativeId` y `deliveryId` del nodo `Shop` de la extensión VAST `iADServerShop`. Al finalizar, avisá al controlador.

```java
overlays.setLinearAdActive(true, vastCreativeId, deliveryId);
overlays.setLinearAdActive(false);
```

El SDK muestra el acceso de compra si el feed devuelve el mismo creativo y entrega dentro de su ventana. El host controla el video del spot, el salto y la medición VAST. Para cortes convencionales, `setLinearAdActive(true)` continúa suspendiendo las gráficas.

## Plan de anuncios

Para leer el plan de IL y mostrar cortes, gráficas y productos, seguí la [guía de SDK nativos](../docs/native-ad-plan-matrix.md). Indica qué formato falta probar en un dispositivo.

## Tipografía de la tienda

Los paneles de producto de TV y de móvil usan Montserrat, la primera fuente que nombra la tienda web, con sus pesos: 500 para el texto, 600 para los botones, 650 para los encabezados y 700 para títulos y precios. En Android, la biblioteca incluye la fuente y la app no tiene que agregar nada. El paquete web también la incluye (`web/fonts/`) y la carga con `player.css` o `fonts.css`; ver [Tipografía de los paneles](../web/README.md#tipografía-de-los-paneles). Desde Android 8.0 (API 26) se usa la fuente incluida. En versiones anteriores, o si la fuente no se puede usar, los paneles usan la fuente del sistema. Una capa de escena cuyo `fontFamily` empieza por Montserrat también recibe la fuente incluida; las demás familias se resuelven como antes.

## Avisos de terceros

**Montserrat** (Copyright 2024 The Montserrat.Git Project Authors) se distribuye bajo la SIL Open Font License 1.1, sin nombre de fuente reservado. El archivo `src/main/assets/interactivelayers/fonts/Montserrat[wght].ttf` es la fuente variable sin modificar del repositorio `google/fonts` (`ofl/montserrat/`, commit `06bfe0d62a98375cb09c942fa18e68bd32cff057`), SHA-256 `0f7b311b2f3279e4eef9b2f968bcdbab6e28f4daeb1f049f4f278a902bcd82f7`. La licencia completa está al lado, en `OFL.txt`, y viaja en el AAR con la fuente.
