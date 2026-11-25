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

### Pedir el plan desde la app (`load`)

```java
AdPlanPlayer plan = AdPlanPlayer.load(overlays, player, "https://<host de la consola>", projectId, assetId,
        null, "es", (type, format, id) -> Log.i("IL", type + " " + id));
plan.start(() -> player.play());
```

El SDK hace `GET <origen>/il-player/app-plan?project=…&asset=…&app=android:<nombre del paquete>` fuera del hilo principal. El valor de `app=` es `android:` más `getPackageName()` (por ejemplo `android:com.example.tv`) y **tiene que estar registrado para el proyecto en la Consola**. `load` nunca devuelve `null`: `start` espera el plan como mucho 5 s y después deja reproducir el contenido.

- **200:** el plan se lee y se conecta como con `attach`.
- **Sin plan:** el contenido sigue sin anuncios y el SDK no reintenta (la próxima vista vuelve a pedirlo). Siempre llega un único evento `plan_unavailable`. Su `format` es el motivo y su `id` es `app=<valor enviado> status=<código HTTP o 0>`. Motivos:
  - `http_204`: IL todavía no tiene plan o se alcanzó un límite.
  - `http_404`: proyecto, video o app desconocidos, con la misma respuesta para los tres. Revisá primero que el `app=` esté registrado; el log también lo dice.
  - `http_<código>`: otra respuesta HTTP.
  - `timeout`: sin respuesta en 5 s.
  - `network`: falla de red.
  - `app_id`: el nombre del paquete no cumple el formato de IL y no se envió nada.
  - `request`: el origen no es un origen HTTPS sin ruta.
  - `stitched`: un plan con `timeline` (proyecto con inserción en el servidor), que los lectores nativos todavía no reproducen.
  - `invalid`: cualquier otro 200 que no se puede leer.

El origen tiene que ser HTTPS, sin ruta. Las URL del producto deben ser del mismo origen. Ningún evento ni línea de log incluye el `grant`, la URL de renovación ni las URL completas de `commerce`.

### Identidad de la app en Google Ad Manager

El plan de una app no trae `page_url`, así que el SDK nunca agrega `url` ni `description_url`. En los pedidos a Google Ad Manager que el SDK hace por su cuenta (etiquetas de gráficas y la caída a MP4 de un corte de GAM), agrega `msid` (nombre del paquete) y `an` (nombre visible de la app) si la etiqueta no los trae. Así lo pide Google para las llamadas VAST directas desde apps ([parámetros de etiquetas VAST](https://support.google.com/admanager/answer/10678356)). Los pedidos que hace IMA llevan esos datos por cuenta del propio IMA.

### Ciclo de vida

Llamá a `plan.close()` en `onDestroy()` (en un fragmento, en `onDestroyView()`), antes de liberar el reproductor. Es obligatorio. Como respaldo, si se destruye la `Activity` que contiene el `PlayerView` sin `close()`, el SDK se cierra solo y deja de registrarse, para no mantener viva esa `Activity`. En ese caso emite `plan_closed`, con `format` igual a `configuration_change` si fue un cambio de configuración (por ejemplo una rotación sin `configChanges`) o `activity_destroyed` si no. Si el cierre llega en medio de un corte del SDK, el contenido vuelve a su posición en pausa, sin iniciarse, igual que con `close()`. **Después de un cambio de configuración, la app tiene que volver a llamar a `load` o `attach` con el `PlayerView` nuevo**, aunque conserve su `ExoPlayer` (por ejemplo en un `ViewModel`); si no, no hay anuncios ni Comprar. Ese respaldo no cubre un fragmento que se destruye dentro de una `Activity` que sigue viva. Con la app en segundo plano, el SDK deja de despertar al hilo principal. Al volver, lo primero que hace es comprobar si el plan venció, antes de pedir o dibujar algo.

### Plan versión 2 y renovación

Un plan `version: 2` (aprobación de formato nativo de Google Ad Manager) se acepta como en `web/ads.mjs`: sólo con `native_gam.contract` igual a `native-gam-plan-v1` y `expires_at` a no más de 120 s. Al vencer, el SDK deja de usarlo en el próximo tick o salto, emite `plan_expired`, quita sus gráficas y devuelve el contenido si estaba en un corte. Con `load`, el SDK lo vuelve a pedir 20 s antes de `expires_at` con `&renew=<grant>` (el `grant` de `commerce.url`) y lo reemplaza sin perder la vista: lo ya mostrado, intentado y resuelto, el pacing y la sesión de comercio siguen. Cortes y ventanas se rearman con el plan nuevo. Emite `plan_renewed` (`format` = versión nueva) o `plan_renew_failed` (`format` = motivo, como arriba). Si un intento falla (204, error, red o tiempo agotado), el SDK reintenta a `expires_at` − 12 s y − 5 s, nunca con dos pedidos a la vez, y se detiene en el primero que funciona. `plan_renew_failed` llega una sola vez, después del último intento o si la respuesta llega cuando el plan ya venció, con el último motivo. Una respuesta que llega después del vencimiento o de `close()` no se usa. Mientras tanto, el plan actual se sigue usando hasta su `expires_at`. Una respuesta versión 1 se adopta y corta las renovaciones. Si tu app obtiene el plan por su cuenta, llamá a `plan.replacePlan(json)` con la versión nueva: hace lo mismo y devuelve `false`, sin tocar el plan actual, si el JSON no sirve.

### Comprar durante un corte con `commerce.break_url`

Si el plan trae `commerce.break_url` y el `sid` es `commerce.session`, el SDK pide la ficha del anuncio en curso a esa URL, sin cambiarla, agregando `cut`, `tag`, `creative`, `delivery` y `locale`, como la web. `delivery` sale del `Ad@id` `il-shop-<preroll|midroll>-<43 caracteres>`. Un anuncio sin ese prefijo no pide nada. La ficha se dibuja con el mismo botón Comprar y las mismas reglas de foco y cierre de la sección anterior. Se quita al terminar, saltar o fallar el anuncio, salvo el panel que el espectador abrió. La impresión es la del VAST: el SDK sólo envía `commerce.viewUrl` cuando se abre la ficha. Sin `break_url` sigue el camino del feed de sesión de `setLinearAdActive`.

### Cortes de la app (modo host)

Cuando tu app pide cada corte con la API por corte de IL y lo reproduce con su propio reproductor de anuncios, conectá un plan de host (`cuts: []`, de `GET /v1/vod/playbacks/{id}/plan`) con `attach` y avisá al SDK lo que pasa:

```java
AdPlanPlayer plan = AdPlanPlayer.attach(overlays, player, planJson, "https://<host de la consola>", null, "es", events);
plan.setBreaks(new long[] {0, 58000});           // posiciones de tus cortes, en ms de contenido
plan.start(() -> player.play());

plan.breakStarted(58000);                        // tu corte empieza (0 para el pre-roll)
plan.adStarted(adTagUrl, ad.getAdId(), ad.getCreativeId());  // IMA: Ad.getAdId() y Ad.getCreativeId()
// o, con el VAST crudo: plan.adStarted(adTagUrl, vastXml);
plan.adEnded();                                  // completo, salto o error
plan.breakEnded();                               // vuelve el contenido
```

Las ventanas de un plan de host vienen separadas de los cortes que IL pondría, no de los tuyos. Por eso el SDK aplica `scenes.pacing.cut_clearance_seconds` alrededor de cada posición que informás con `setBreaks` o `breakStarted`. Si no informás nada, no hay distancia a ningún corte. Una posición negativa no inicia nada y emite `break_refused` (`format` = `position`). Los avisos de corte son para un plan de host (`cuts: []`): con un plan que trae sus propios cortes, `breakStarted` se rechaza con `break_refused` (`format` = `plan_has_cuts`), para no mezclar dos formas de manejar los cortes. Un plan versión 2 vence a su hora aunque el contenido esté en pausa o haya un corte de la app: se quitan las gráficas y el botón Comprar y llega `plan_expired`.

Con un plan de host el SDK no pide ni reproduce ningún anuncio de video. Durante el corte informado no dibuja nada de IL salvo el botón Comprar, descarta las respuestas de gráficas que lleguen tarde y no cambia el pacing ni las impresiones. Para Comprar pide la ficha con `cut=at-<ms>` (`at-0` en el pre-roll) y el `tag` de la `adTagUrl` de iADServer. La app no necesita IMA ni Google Mobile Ads para este modo.

Comprar durante el corte necesita `commerce.break_url` en el plan de host: sólo viene si el playback se creó con `graphics: true` y recorre pasos ordenados. Sin `break_url` no hay Comprar y no se avisa nada. Si conectaste el plan con un `sessionId` propio y el plan trae `break_url`, el SDK emite una vez `buy_unavailable` (`format` = `session`): para Comprar, pasá `null` y se usa `commerce.session`.

Un `adStarted` que llega antes de que el plan esté conectado se guarda, como `breakStarted`, y se aplica cuando el plan llega si ese anuncio sigue en pantalla: un `adEnded` o `breakEnded` anterior lo descarta. Un `adStarted` sin un corte abierto emite `break_refused` (`format` = `no_break`). `replacePlan` con un plan que trae cortes, mientras la app maneja sus propios cortes, devuelve `false`, conserva el plan actual y emite `break_refused` (`format` = `plan_has_cuts`).

**En TV, el control de tu `PlayerView` durante Comprar.** Es lo único de la interfaz de la app que el SDK toca durante un corte de la app. Cuando aparece Comprar, o hay un panel de producto abierto, el SDK guarda la vista que tenía el foco y llama a `setUseController(false)` en tu `PlayerView`, para que el control remoto llegue al botón. Cuando ya no hay nada para elegir, vuelve a llamar a `setUseController(true)` si antes estaba activado y la app no lo cambió mientras tanto. Si la app lo cambió, gana el valor de la app. El foco vuelve a la vista guardada sólo si quedó en ninguna vista o en una vista del SDK. Si la app maneja la visibilidad de sus controles por su cuenta, va a ver esos dos cambios y su `ControllerVisibilityListener` va a recibir que los controles se ocultan; los controles propios (por ejemplo los de Leanback) tienen que dejar de tomar el foco mientras haya algo para elegir.

Red de seguridad: si un corte informado no recibe ningún aviso durante 180 s de primer plano (por ejemplo, porque el reproductor de anuncios de la app falló y nunca llegó `breakEnded`), el SDK lo da por terminado, emite `break_error` y vuelve a mostrar gráficas. Durante un corte de la app el SDK nunca toca su reproductor: `close()`, `replacePlan` o el vencimiento del plan sólo limpian el estado y la capa del SDK.

**Obligaciones de la app en este modo:** informar cada corte (`breakStarted`/`breakEnded`) y cada anuncio (`adStarted`/`adEnded`). Si no informa nada, el SDK no tiene forma de saber que hay un anuncio en pantalla: las gráficas siguen sólo por tiempo de contenido y no hay Comprar. `setBreaks` sirve para que las gráficas respeten la distancia a los cortes. El anuncio tiene que verse en el mismo `PlayerView` o debajo de él, porque el botón se dibuja sobre el `PlayerView`.

Hay una app de ejemplo con los dos modos en [examples/android](../examples/android/README.md).

Cada lector guarda su propio consentimiento e identidad de app: dos reproductores en el mismo proceso no se pisan.

### Verificación

- Pruebas unitarias en la JVM, con dobles del reproductor, de la red y del reloj, y con las respuestas de IL de `test/fixtures/native`.
- Pruebas instrumentadas en un emulador de teléfono con Android 15 (API 35) y en un emulador de Android TV 14 (API 34), con ExoPlayer real y un servidor HTTPS local dentro del emulador.
- La app de ejemplo en los dos modos y en ambos emuladores, contra fixtures servidos desde la Mac. En el modo de cortes de la app, el anuncio está simulado.
- No se probó con anuncios reales de Google Ad Manager, IMA ni iADServer en esta ronda.
- Nada corrió en un dispositivo físico.
- Fire TV no se probó: se trata como Android TV por inferencia.

## Tipografía de la tienda

Los paneles de producto de TV y de móvil usan Montserrat, la primera fuente que nombra la tienda web, con sus pesos: 500 para el texto, 600 para los botones, 650 para los encabezados y 700 para títulos y precios. En Android, la biblioteca incluye la fuente y la app no tiene que agregar nada. El paquete web también la incluye (`web/fonts/`) y la carga con `player.css` o `fonts.css`; ver [Tipografía de los paneles](../web/README.md#tipografía-de-los-paneles). Desde Android 8.0 (API 26) se usa la fuente incluida. En versiones anteriores, o si la fuente no se puede usar, los paneles usan la fuente del sistema. Una capa de escena cuyo `fontFamily` empieza por Montserrat también recibe la fuente incluida; las demás familias se resuelven como antes.

## Avisos de terceros

**Montserrat** (Copyright 2024 The Montserrat.Git Project Authors) se distribuye bajo la SIL Open Font License 1.1, sin nombre de fuente reservado. El archivo `src/main/assets/interactivelayers/fonts/Montserrat[wght].ttf` es la fuente variable sin modificar del repositorio `google/fonts` (`ofl/montserrat/`, commit `06bfe0d62a98375cb09c942fa18e68bd32cff057`), SHA-256 `0f7b311b2f3279e4eef9b2f968bcdbab6e28f4daeb1f049f4f278a902bcd82f7`. La licencia completa está al lado, en `OFL.txt`, y viaja en el AAR con la fuente.
