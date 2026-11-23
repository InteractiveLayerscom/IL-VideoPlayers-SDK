# Plan de anuncios en SDK nativos

Cada plataforma lee el plan de IL con las reglas de `web/ads.mjs`: pedidos ordenados por corte, pacing, ventanas, una impresión y nada dibujado sobre un anuncio. Un plan vencido, de otra versión o con línea de tiempo `stitched` (anuncios insertados en el servidor) no muestra anuncios y el contenido sigue.

**Nada de esto corrió todavía en un dispositivo físico ni contra IMA, Google Mobile Ads (GMA) o RAF reales.** Todo lo que dice "lógica probada" corre en pruebas de escritorio con dobles del reproductor, del SDK de anuncios y de la red. Las pruebas del reproductor de Apple corren en Mac Catalyst. El video, el foco del control remoto, la composición en pantalla y la respuesta real de cada SDK de anuncios siguen sin verificar.

## Estado

| Formato | Android (teléfono y tablet) | Android TV, Fire TV | iOS | tvOS | Roku | Samsung Tizen |
| --- | --- | --- | --- | --- | --- | --- |
| Pre-roll y mid-roll | Implementado, lógica probada | Implementado, lógica probada | Implementado, lógica probada | Implementado, lógica probada | Implementado, lógica probada | Implementado, lógica probada |
| Súper y L | Implementado, lógica probada | Implementado, lógica probada | Implementado, lógica probada | Implementado, lógica probada | Implementado, lógica probada (ver ADS 1.1) | Implementado, lógica probada |
| Overlay 300x250 de GAM | Implementado, lógica probada con un doble; `AdPlanGma` sólo compilado | **No compatible** | Implementado, lógica probada con un doble; `ILAdPlanGMA` sólo verificado en tipos | **No compatible** | **No compatible** | Usa GPT de `web/ads.mjs`, sin probar en TV |
| Producto de escena con Comprar (tarjeta simple) | Implementado, lógica probada | Implementado, lógica probada | Implementado, lógica probada | Implementado, lógica probada | Implementado, lógica probada (ver ADS 1.1) | Implementado, lógica probada |
| Banner de producto diseñado (`scene=1`) | No implementado | No implementado | No implementado | No implementado | No implementado | Implementado, heredado de `web/ads.mjs` |
| Comprar durante un corte | Implementado, lógica probada | Implementado, lógica probada | Implementado, lógica probada | Implementado, lógica probada | Implementado, lógica probada | Implementado, lógica probada |
| QR en TV | No aplica | Sin probar | No aplica | Sin probar | Sin probar | Sin probar |

Fire TV figura junto a Android TV por inferencia: corre Android, el código lo trata como un dispositivo de TV y no se probó nada específico de Fire TV.

## Qué se acepta del plan

Los lectores nativos usan los mismos nombres de campo que `web/ads.mjs` y rechazan lo mismo:

- `version` distinto de 1, `expires_at` vencido o ilegible, o un `timeline` presente: no hay anuncios. Roku lee fechas con `Z` o con desplazamiento (`+03:00`).
- `scenes` presente pero sin `formats`, `windows` o `pacing` válidos anula todo el plan, como en la web. Sin `scenes`, el plan necesita `cuts` o un `commerce` válido.
- `start_ms`, `end_ms`, `lead_ms` y `max_per_video` deben ser enteros. Un valor fraccionario descarta la ventana, el producto o el plan, en lugar de redondearse.
- Pedidos de corte: sólo `gam` con origen `https://pubads.g.doubleclick.net` e `iadserver` con origen `https://ads.iadserver.com`, en la ruta `/gampad/ads`, hasta tres por corte. Como un navegador, se aceptan el host en mayúsculas y `:443`, y la URL se reescribe a la forma canónica. Android e iOS también resuelven `.` y `..` en la ruta. Roku los rechaza porque BrightScript no trae un parser de URL.
- `commerce` de tipo `scene_product` con `url` HTTPS del mismo origen que el plan, `lead_ms`, `pacing` y `windows`. Sin `planOrigin` HTTPS el producto se ignora.
- La ficha del producto debe traer `commerce`, se recorta a su ventana y se rechaza si es `midroll`. Ningún nativo pide `scene=1`, así que IL responde la tarjeta simple, que no se retiene pasado su fin.

### Sesión (`sid`)

El orden es el de la web: primero el identificador de vista del host (`sessionId`/`sessionID`), luego `commerce.session` del plan y, si no hay ninguno, un identificador aleatorio para esa reproducción. Todo pedido a iADServer lleva ese `sid`. Comprar durante un corte sólo se habilita cuando el `sid` es `commerce.session`, porque el permiso de IL nombra esa sesión. Un host con su propio identificador recibe el anuncio sin la tarjeta.

### Consentimiento

Cada pedido que el SDK hace a GAM o a iADServer (cortes, gráficas, prelecturas) lleva los parámetros estándar `gdpr`, `gdpr_consent`, `us_privacy`, `gpp` y `gpp_sid` cuando hay consentimiento guardado.

- **Android** lee `IABTCF_gdprApplies`, `IABTCF_TCString`, `IABUSPrivacy_String`, `IABGPP_HDR_GppString` e `IABGPP_GppSID` de las `SharedPreferences` predeterminadas de la app, donde las escribe una CMP.
- **iOS y tvOS** leen las mismas claves de `UserDefaults.standard`.
- **Roku** no tiene un almacén estándar: pasá `{ gdpr, gdpr_consent, us_privacy, gpp, gpp_sid }` como último argumento de `attachPlan`.
- **Samsung** pasa por la CMP web de la app: dale los mismos valores en `consent` a `attachAvPlayAds`. Las gráficas de Samsung salen de `web/ads.mjs` y no llevan estos parámetros.

### Diferencias con la web

- **Comprar durante un corte.** La web identifica el anuncio por `Ad@id` (`il-shop-<posición>-<entrega>`) y pide la ficha a `commerce.break_url`. Los nativos leen la misma identidad de la extensión VAST `iADServerShop` que iADServer emite en el mismo anuncio, y piden la ficha por el feed de la sesión con `shop_midroll`. Ignoran `break_url`. Roku toma la entrega de la URL de impresión de iADServer, sólo en `https://ads.iadserver.com/events/{entrega}/impression`.
- **Volumen del anuncio.** La web hace que IMA siga el silencio y el volumen del video. En Android, IMA de Media3 reproduce el anuncio en el mismo `ExoPlayer`, que conserva su volumen. En iOS y tvOS, IMA reproduce en su propio reproductor y este SDK no le pasa el silencio ni el volumen de `AVPlayer`. En Samsung y Roku el anuncio usa el reproductor del contenido y el volumen del sistema.

## Cortes

- **Espera.** Un corte retiene el contenido hasta 8 segundos esperando que empiece un anuncio. En Apple, cada descarga de VAST tiene un límite total de 5 segundos (`timeoutIntervalForResource`), la lectura de iADServer compite con ese plazo y, pasado el plazo, no se pide nada más. En Android, IMA tiene 4 segundos para cargar un VAST, así que queda tiempo para el pedido siguiente.
- **Un solo pedido por anuncio de iADServer.** El SDK lee el VAST de iADServer para conocer la identidad de Comprar y se lo entrega a IMA como respuesta (`adsResponse` en Apple, URI `data:` en Media3). Si IMA no puede reproducirlo, el MP4 sale de esa misma respuesta. En el código de iADServer de esta máquina (`stable_tags.go`, `storeStableOpportunity`), un mismo `correlator` reutiliza la oportunidad y la identidad de entrega guardadas, así que repetir el pedido tampoco reservaba dos veces.
- **Watchdog.** Una vez empezado, un anuncio puede durar lo que dice su VAST más 30 segundos (120 segundos si no informa duración), y nunca más de 180 segundos, aunque el VAST declare horas. Sólo cuenta el tiempo con la app en primer plano: una app en segundo plano no reanuda el contenido por su cuenta.
- **MP4 sin primer cuadro.** En Apple, un MP4 que no muestra su primer cuadro antes del plazo de espera libera el corte, y nada empieza después de ese plazo. En Samsung, un MP4 que no se prepara en 8 segundos termina el corte.
- **Anuncio adelantado.** Si los controles de la app adelantan un MP4 más rápido que el reloj real, no se envía `complete` ni los cuartiles siguientes y el corte termina como `break_error`. Un bloqueo del hilo principal no cuenta como adelanto. El SDK no bloquea la barra de la app.
- **Cierre a mitad de un anuncio.** `stop()` (Apple) y `close()` (Android) devuelven el contenido a su posición, en pausa, sin iniciarlo. `destroy()` en Samsung cierra AVPlay para que el host abra su contenido.
- **Roku.** `getAds()` y `showAds()` de RAF no se pueden interrumpir desde la tarea. Un temporizador en el hilo de render devuelve el contenido si no empieza ningún anuncio en 10 segundos o si el corte supera los 130 segundos, y marca la tarea como cancelada. La tarea revisa esa marca antes de cada `setAdUrl` y antes de `showAds`, así que un `getAds()` que responde tarde no dibuja un anuncio sobre el contenido ni envía impresiones. Salir de los anuncios con Atrás se informa como `break_error`, no `break_end`, y reanuda el contenido. Falta confirmar ese comportamiento en la revisión de Roku.
- **Samsung.** Si `reopenContent` del host no termina en 15 segundos, el SDK emite `resume_blocked` y deja el contenido al host.

### Lo que el SDK hace con el contenido de la app en Android

- Al terminar cada corte, el SDK vuelve a cargar la lista que tenía la app al empezar el corte. Cualquier cambio que la app haya hecho en su lista durante el anuncio se pierde.
- Después de un corte de IMA el contenido se vuelve a preparar: hay una nueva solicitud de licencia DRM y un rebuffer.
- En un stream en vivo, la posición guardada al empezar el corte puede haber quedado fuera de la ventana disponible al volver.

## Límites de plataforma

- **Overlay en Roku: No compatible.** Google no ofrece GPT ni GMA para Roku, y GPT necesita un navegador que SceneGraph no tiene. RAF reproduce los anuncios que recibe de una URL de anuncios, y el plan sólo trae una unidad de display. Fuente: [requisito ADS 1.1](https://developer.roku.com/dev/docs/ad-requirements) y [API de RAF](https://developer.roku.com/dev/docs/raf-api).
- **Súper, L y producto en Roku.** El requisito ADS 1.1 alcanza a los sistemas externos que insertan banners que no son de Roku. Antes de publicar, declará este SDK a Roku. Roku puede rechazarlo.
- **Overlay en tvOS: No compatible.** El paquete oficial de GMA declara sólo iOS, y tvOS no incluye WebKit, que GPT necesitaría. Fuente: [manifiesto de GMA](https://github.com/googleads/swift-package-manager-google-mobile-ads/blob/13.13.0/Package.swift).
- **Overlay en Android TV y Fire TV: No compatible.** Google indica que GMA no admite Android TV, y `AdPlanGma` no se pide en un dispositivo de TV. Fire TV queda en la misma regla por inferencia. Fuente: [GMA para Android](https://developers.google.com/ad-manager/mobile-ads-sdk/android/sdk).
- **GMA necesita un App ID de AdMob.** Sin `APPLICATION_ID` (Android) o `GADApplicationIdentifier` (iOS) la app se cierra al iniciar GMA.
- **Línea de tiempo `stitched`.** Falta un reloj de contenido nativo. No es un límite de plataforma.

## Motores de anuncios lineales

- **Android.** IMA corre sobre un `ExoPlayer` cuando la app incluye `androidx.media3:media3-exoplayer-ima`. El SDK la declara `compileOnly`: agregala a tu app con la misma versión que tus otros módulos de Media3 (el SDK compila contra 1.6.0). Sin ella, el SDK lo informa en el log y los cortes usan MP4 progresivo en tu reproductor. La biblioteca trae reglas de R8 (`consumer-rules.pro`) para que una app que minifica sin IMA ni Google Mobile Ads compile igual. Si IMA no puede reproducir una respuesta, pasa a MP4. Una respuesta vacía pasa al pedido siguiente.
- **Contenido con cabeceras o DRM en Android.** El `attach` simple crea IMA con un `DefaultMediaSourceFactory` sin tus cabeceras ni tu DRM, que sólo se usa mientras IMA reproduce. Para ese contenido, creá `AdPlanIma(context, playerView, factory)` con tu factory y pasalo al otro `attach`. Al terminar cada corte, el SDK vuelve a cargar tu lista completa, en el ítem y la posición donde estaba, con la factory de tu reproductor.
- **iOS y tvOS.** El producto `ILAVPlayerOverlayIMA` usa IMA desde 3.34.1 (iOS) y 4.18.1 (tvOS), y GMA desde 13.13.0, hasta la próxima versión mayor de cada uno. Una app que fija otra versión menor de esos paquetes resuelve sin conflicto. Pasá `linearEngine: ILAdPlanIMA(overlay: overlay)`, con la misma caída a MP4. Una app que sólo enlaza `ILAVPlayerOverlay` no enlaza ningún SDK de anuncios, aunque SwiftPM igual resuelve esos paquetes. Sin motor, los cortes usan MP4.
- **Roku.** RAF. La identidad para Comprar sale del anuncio que RAF informa en su callback: `creativeId` y la entrega de la URL de impresión de iADServer.
- **Samsung.** MP4 progresivo en AVPlay, con wrappers VAST. La impresión y `start` salen con el primer `oncurrentplaytime`. Un MP4 que no se prepara en 8 segundos termina el corte.

## Integración

- **Android.** `AdPlanPlayer.attach(overlay, player, planJson, planOrigin, sessionId, locale, events)` y luego `start(() -> player.play())`. Para el Overlay, agregá `com.google.android.gms:play-services-ads:23.6.0`, el `APPLICATION_ID` en el manifiesto, y usá la variante con `ima` y `new AdPlanGma(playerView)`. Devuelve `null` si el plan no sirve. Cerrá con `close()`.
- **Apple.** `ILAdPlanPlayer(overlay:player:planJSON:planOrigin:sessionID:locale:linearEngine:events:)`, luego `await plan.start()` y `player.play()`. Para el Overlay en iOS, agregá el producto `ILAVPlayerOverlayGMA`, `GADApplicationIdentifier` en `Info.plist`, y pasá `displaySlot: ILAdPlanGMA(container:rootViewController:)`. Cerrá con `stop()`. Un motor propio implementa `playAd(tagURL:adsResponse:deadline:onStart:)`.
- **Roku.** Creá `ILAdPlanPlayer` junto al `Video`, llamá a `attachPlan(overlay, video, sessionId, plan, origin, locale, consent)` y a `startPlan`. Iniciá el contenido cuando `contentReady` sea verdadero. Al cambiar `linearSpot`, leé el feed de la sesión con esa identidad para traer la ficha del corte. Cerrá con `stopPlan`. El canal necesita `bs_libs_required=roku_ads_lib` en el manifiesto.
- **Samsung.** Importá `attachAvPlayAds` de `@interactivelayers/player-sdk/avplay-ads`, pasale `{ avplay, session, plan, contentUrl, listener, getDisplayRect, stage }` y llamá a `await ads.start()` antes de abrir el contenido. Si tu contenido usa DRM, propiedades de streaming o subtítulos, pasá `reopenContent(resumeAtMs)`: el SDK la llama después de cada anuncio para que abras, prepares y busques tu contenido. Sin ella, reabre `contentUrl`. Pasá `consent` con los valores de tu CMP. Avisá el final con `contentEnded()` y cerrá con `destroy()`.

`planOrigin` es el origen HTTPS del que vino el plan. Sin él, el producto de escena se ignora.

## Qué falta probar en un dispositivo

- **Todas las plataformas.**
  - Un primer pedido que no responde: el corte debe liberar el contenido a los 8 segundos y, en Roku, a los 10.
  - Contenido con DRM antes y después de un corte.
  - Una app con lista de reproducción: después del corte vuelve el mismo ítem y la misma posición.
  - Más de 2 minutos en segundo plano durante un anuncio: el contenido no debe reanudarse solo.
  - Cerrar el plan a mitad de un anuncio.
  - Una CMP real que escriba TCF, US Privacy y GPP: los parámetros deben llegar a GAM e iADServer.
- **Android teléfono.**
  - Pre-roll y mid-roll con IMA real sobre ExoPlayer, y caída a MP4.
  - Una app sin `media3-exoplayer-ima`, y otra con una versión de Media3 distinta de 1.6.0.
  - Una build de release minificada, instalada y reproduciendo un corte.
  - Un stream en vivo con un corte largo: la posición de vuelta debe seguir dentro de la ventana.
  - IMA con la respuesta `data:` de iADServer.
  - Overlay con GMA y un App ID de AdMob de prueba.
  - Tarjeta de producto, Comprar y Comprar durante un corte con iADServer.
  - Volumen del anuncio con el contenido silenciado.
- **Android TV y Fire TV.**
  - Lo mismo que en teléfono, sin Overlay.
  - Foco del control remoto, QR y Atrás en el panel de producto.
  - Confirmar que Fire TV se detecta como TV.
- **iOS.**
  - IMA real (3.34.1 y una versión menor posterior) con `adsResponse`, y caída a MP4.
  - Overlay con GMA y App ID.
  - Una app que fija otra versión menor de GMA o IMA.
  - Tarjeta y Comprar, rotación y área segura.
  - Volumen del anuncio con el contenido silenciado.
- **tvOS.**
  - IMA 4.18.1 real.
  - Foco del control, QR, tarjeta y Comprar durante un corte.
- **Roku.**
  - RAF real con tags de GAM e iADServer.
  - Un servidor de anuncios que nunca responde: el temporizador debe devolver el contenido, aunque la tarea de RAF siga bloqueada.
  - Atrás durante los anuncios: el contenido debe reanudarse.
  - Un `getAds()` que responde después del temporizador: no debe dibujar nada.
  - Súper, L y tarjeta en pantalla, y QR.
  - Consentimiento pasado por el host.
  - La revisión de Roku por ADS 1.1 antes de publicar.
- **Samsung Tizen.**
  - AVPlay con MP4 y wrappers, y la impresión en el primer cuadro.
  - `reopenContent` con DRM y subtítulos.
  - Un MP4 que no se prepara.
  - `destroy()` a mitad de un anuncio.
  - Overlay con GPT en la TV.
  - Tarjeta y Comprar durante un corte, QR y el control remoto.
