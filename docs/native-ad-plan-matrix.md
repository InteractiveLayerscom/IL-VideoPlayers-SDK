# Plan de anuncios en SDK nativos

Cada plataforma lee el plan de IL con las reglas de `web/ads.mjs`: pedidos ordenados por corte, pacing, ventanas, una impresión y nada dibujado sobre un anuncio. Un plan vencido, de una versión que no acepta o con línea de tiempo `stitched` (anuncios insertados en el servidor) no muestra anuncios y el contenido sigue.

Además del plan que entrega el host, cada lector puede pedir su propio plan a IL (ruta de apps), acepta el plan versión 2 con su vencimiento y su renovación, pide la ficha de Comprar durante un corte a `commerce.break_url` y dibuja junto a los cortes que reproduce la propia app (API por corte).

**Nada de esto corrió todavía en un dispositivo físico.** Todo lo que dice "lógica probada" corre en pruebas de escritorio con dobles del reproductor, del SDK de anuncios y de la red. Qué corrió dónde:

- **Roku:** sólo el intérprete de BrightScript de escritorio, con dobles del nodo `Video`, de RAF y de la red (`sh roku/verify.sh`), y los fixtures compartidos con la hora congelada. El canal de ejemplo sólo pasó la validación estática de BrighterScript y el empaquetado; no se ejecutó en un Roku.
- **Apple:** las pruebas del paquete corren en Mac Catalyst y en los simuladores de iPhone 17 (iOS 26.1) y Apple TV 4K (tvOS 26.1); `swift test` en macOS corre sólo las que no usan UIKit. La app de ejemplo corrió en los dos simuladores contra un servidor HTTPS local que respondía con los fixtures compartidos, con un clip local como anuncio (según la PR #41). No intervino ningún anuncio real de Google Ad Manager, IMA ni iADServer.
- **Samsung Tizen:** sólo Node, con dobles de AVPlay (`test/avplay-ads.test.mjs`, `test/avplay-native.test.mjs`). Nada corrió en un televisor ni en un emulador de TV, y la app de ejemplo `examples/tizen` nunca se ejecutó. No está confirmado que una app empaquetada pueda leer la respuesta de la ruta de apps, que no manda CORS.

**Android teléfono se probó en un emulador** (Android 15, API 35, imagen `google_apis` arm64, Pixel 7 apaisado) con ExoPlayer de Media3 1.6.0, IMA real y Google Mobile Ads real, en una app de demostración:

- Pruebas instrumentadas del SDK: pasan.
- Mid-roll con IMA y la etiqueta de ejemplo pública de Google: se reproduce y el contenido vuelve a su posición.
- Orden de pedidos: un primer pedido que no responde pasa al segundo, que se reproduce dentro de la espera de 8 s.
- Etiqueta de prueba real de iADServer: el VAST leído por el SDK se entrega a IMA y se reproduce. Comprar aparece durante el corte y abre el producto. El feed de la sesión recibió el `sid` del host y la identidad del anuncio.
- Build de release minificada sin IMA ni GMA: corre y reproduce el corte en MP4.
- Súper, L y tarjeta de producto: aparecen en sus ventanas, nunca durante el anuncio, y respetan el pacing.
- Overlay de GMA con el App ID y la unidad de prueba de Google: se muestra en su ventana.
- Robustez: segundo plano por más de 2 minutos, anuncio adelantado, bloqueo del hilo principal, `close()` durante un corte, lista de dos ítems y un anuncio cuyo medio nunca carga.

**Android TV se probó en un emulador** (Android 14, API 34, imagen `android-tv` arm64, perfil `tv_1080p`), sólo con el control remoto:

- Entrada en el lanzador de TV y pruebas instrumentadas: pasan.
- Súper, L y tarjeta de producto: aparecen en sus ventanas y nunca durante el anuncio.
- El Overlay de GMA no se ofrece en TV: `supported()` es falso y no se pide nada.
- El panel de producto se recorre con el D-pad hasta el QR, y Atrás vuelve paso a paso hasta cerrarlo sin salir de la app.
- Comprar durante el corte real de iADServer se abre con el control.
- El foco ya no sale del panel abierto hacia los controles del reproductor de la app.
- Con los controles de Media3 activos, el control remoto llega a las tarjetas y al botón de compra del midroll: mientras el anuncio está en pantalla el SDK deja los controles de lado y devuelve el valor de la app al terminar. Probado en Android TV 14, Android 15 y Android 9.
- El panel abierto queda después de que el súper termina, hasta que el espectador lo cierra ([reglas](../android/README.md#compra-con-shopify)).
- Comprar durante un corte toma el foco solo al aparecer: no hace falta una tecla para llegar a él.

Lo que el emulador no prueba: el decodificador de video de un teléfono o una TV reales, el rendimiento, Fire TV y un control remoto físico. En el emulador, después de un anuncio de IMA en 1280x720 el contenido de 640x360 se dibujó en un cuarto de la pantalla sobre el último cuadro del anuncio. Pasó igual sin la recarga de contenido del SDK y con `TextureView`, con el decodificador `c2.goldfish.h264.decoder` del emulador. Falta confirmar en un teléfono que no pasa.

## Estado

| Formato | Android (teléfono y tablet) | Android TV, Fire TV | iOS | tvOS | Roku | Samsung Tizen |
| --- | --- | --- | --- | --- | --- | --- |
| Pre-roll y mid-roll | Implementado, lógica probada | Implementado, lógica probada | Implementado, lógica probada | Implementado, lógica probada | Implementado, lógica probada | Implementado, lógica probada |
| Súper y L | Implementado, lógica probada | Implementado, lógica probada | Implementado, lógica probada | Implementado, lógica probada | Implementado, lógica probada (ver ADS 1.1) | Implementado, lógica probada |
| Overlay 300x250 de GAM | Implementado, lógica probada con un doble; `AdPlanGma` sólo compilado | **No compatible** | Implementado, lógica probada con un doble; `ILAdPlanGMA` sólo verificado en tipos | **No compatible** | **No compatible** | Usa GPT de `web/ads.mjs`, sin probar en TV |
| Producto de escena con Comprar (tarjeta simple) | Implementado, lógica probada | Implementado, lógica probada | Implementado, lógica probada | Implementado, lógica probada | Implementado, lógica probada (ver ADS 1.1) | Implementado, lógica probada |
| Banner de producto diseñado (`scene=1`) | No implementado | No implementado | No implementado | No implementado | No implementado | Implementado, heredado de `web/ads.mjs` |
| Comprar durante un corte (feed de sesión) | Implementado, lógica probada | Implementado, lógica probada | Implementado, lógica probada | Implementado, lógica probada | Implementado, lógica probada | Implementado, lógica probada |
| Comprar durante un corte con `commerce.break_url` | Todavía no en main | Todavía no en main | Implementado, lógica probada (Catalyst y simulador) | Implementado, lógica probada (Catalyst y simulador) | Implementado, lógica probada en el intérprete | Implementado, lógica probada en Node |
| La app pide su plan (ruta de apps) | Todavía no en main | Todavía no en main | `ILAdPlanPlayer.load`, lógica probada (Catalyst y simulador) | `ILAdPlanPlayer.load`, lógica probada (Catalyst y simulador) | `loadPlan`, lógica probada en el intérprete | `attachAvPlayAppAds`, lógica probada en Node; lectura sin CORS sin confirmar |
| Plan versión 2: vencimiento y renovación (20, 12 y 5 s antes) | Todavía no en main | Todavía no en main | Implementado, lógica probada (Catalyst y simulador) | Implementado, lógica probada (Catalyst y simulador) | Implementado, lógica probada en el intérprete | Implementado, lógica probada en Node |
| Cortes que reproduce la app (API por corte) | Todavía no en main | Todavía no en main | Implementado, lógica probada (Catalyst y simulador; app de ejemplo en ambos simuladores) | Implementado, lógica probada (Catalyst y simulador; app de ejemplo en ambos simuladores) | Implementado, lógica probada en el intérprete | Implementado, lógica probada en Node |
| QR en TV | No aplica | Sin probar | No aplica | Sin probar | Sin probar | Sin probar |

Fire TV figura junto a Android TV por inferencia: corre Android, el código lo trata como un dispositivo de TV y no se probó nada específico de Fire TV.

## Qué se acepta del plan

Los lectores nativos usan los mismos nombres de campo que `web/ads.mjs` y rechazan lo mismo:

- `version` 1, o `version` 2 sólo con `native_gam.contract` igual a `native-gam-plan-v1` y `expires_at` a no más de 120 s (comparado en milisegundos). Otra versión, un `expires_at` vencido o ilegible: no hay anuncios. Roku lee fechas con `Z` o con desplazamiento (`+03:00`).
- Un plan con `timeline` (proyecto con inserción en el servidor) se sigue rechazando: no hay reloj de contenido nativo. Cargado por la ruta de apps, se informa `plan_unavailable` con motivo `stitched`.
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

- **Comprar durante un corte.** Como la web, Apple, Roku y Samsung identifican el anuncio por `Ad@id` (`il-shop-<preroll|midroll>-<entrega>`, de la misma posición que el corte) y `Creative@id`, y piden la ficha a `commerce.break_url` con `cut`, `tag`, `creative`, `delivery` y `locale`. Sin ese prefijo no hay producto ni pedido. Samsung lee los dos valores del VAST que descargó (no hay IMA). Roku lee el `adId` del anuncio de RAF y, si falta o no es `il-shop-…`, toma la entrega de la URL de impresión de iADServer (`https://ads.iadserver.com/events/{entrega}/impression`); Roku no documenta que `adId` sea el `Ad@id` del VAST. Cuando el plan no trae `break_url`, sigue el camino anterior: la identidad de la extensión VAST `iADServerShop` y la ficha por el feed de la sesión con `shop_midroll`.
- **Panel de Comprar al terminar el anuncio.** En iOS y tvOS la ficha de Comprar se cierra cuando termina el anuncio, aunque el espectador la haya abierto. La web y Android la mantienen abierta hasta que el espectador la cierra.
- **Volumen del anuncio.** La web hace que IMA siga el silencio y el volumen del video. En Android, IMA de Media3 reproduce el anuncio en el mismo `ExoPlayer`, que conserva su volumen. En iOS y tvOS, IMA reproduce en su propio reproductor y este SDK no le pasa el silencio ni el volumen de `AVPlayer`. En Samsung y Roku el anuncio usa el reproductor del contenido y el volumen del sistema.

## Cortes

- **Espera.** Un corte retiene el contenido hasta 8 segundos esperando que empiece un anuncio. En Apple, cada descarga de VAST tiene un límite total de 5 segundos (`timeoutIntervalForResource`), la lectura de iADServer compite con ese plazo y, pasado el plazo, no se pide nada más. En Android, IMA tiene 4 segundos para cargar un VAST, así que queda tiempo para el pedido siguiente.
- **Sin respuesta, pedido siguiente.** Si IMA vence esperando el VAST, no puede pedirlo, o recibe uno vacío o con demasiados redireccionamientos, el corte pasa al pedido siguiente. No se vuelve a pedir la misma URL para MP4, porque eso gastaba la espera entera, como se vio en el emulador. El camino MP4 queda para un VAST que llegó pero IMA no pudo reproducir. Esto aplica a Android y a Apple; en Apple sólo está verificado en tipos.
- **Un anuncio que IMA ya cargó no se corta por la espera.** En Android y en Apple, cuando IMA informa `LOADED`, la espera de 8 s ya no termina el corte. Desde ahí, el SDK le da a IMA 5 s para que empiece el video del anuncio (`setMediaLoadTimeoutMs` en Android, `loadVideoTimeout` en Apple). Si el video no empieza, el corte termina. Si IMA no responde, el corte también tiene un límite propio:

- **Android:** el watchdog del corte, de 120 s de tiempo en primer plano, sigue activo después de `LOADED`.
- **Apple:** si el anuncio no empezó a los 10 s de pasada la espera (los 5 s de IMA más 5 s de margen), el SDK cancela el motor y el corte termina, aunque IMA no informe nada. El reproductor aplica este límite a cualquier motor. Pasada la espera no empieza nada nuevo: ni un MP4, ni otro pedido de la misma URL, ni el pedido siguiente. Un MP4 propio sigue liberándose a los 8 s si no muestra su primer cuadro. En el emulador, la respuesta real de iADServer más el arranque de IMA tardó 7,7 s y 8,1 s. En Apple esta regla sólo está verificada en tipos y en una prueba con un motor simulado.
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
- **Roku.** RAF. La identidad para Comprar sale del anuncio que RAF informa en su callback: el `adId` `il-shop-…` y `creativeId` o, si falta ese `adId`, la entrega de la URL de impresión de iADServer.
- **Samsung.** MP4 progresivo en AVPlay, con wrappers VAST. La impresión y `start` salen con el primer `oncurrentplaytime`. Un MP4 que no se prepara en 8 segundos termina el corte.

## Integración

- **Android.** `AdPlanPlayer.attach(overlay, player, planJson, planOrigin, sessionId, locale, events)` y luego `start(() -> player.play())`. Para el Overlay, agregá `com.google.android.gms:play-services-ads:23.6.0`, el `APPLICATION_ID` en el manifiesto, y usá la variante con `ima` y `new AdPlanGma(playerView)`. Devuelve `null` si el plan no sirve. Cerrá con `close()`.
- **Apple.** `ILAdPlanPlayer(overlay:player:planJSON:planOrigin:sessionID:locale:linearEngine:events:)`, luego `await plan.start()` y `player.play()`. Para el Overlay en iOS, agregá el producto `ILAVPlayerOverlayGMA`, `GADApplicationIdentifier` en `Info.plist`, y pasá `displaySlot: ILAdPlanGMA(container:rootViewController:)`. Cerrá con `stop()`. Un motor propio implementa `playAd(tagURL:adsResponse:deadline:onStart:)`.
- **Roku.** Creá `ILAdPlanPlayer` junto al `Video`, llamá a `attachPlan(overlay, video, sessionId, plan, origin, locale, consent)` y a `startPlan`. Iniciá el contenido cuando `contentReady` sea verdadero. Con un plan que trae `commerce.break_url`, el componente pide la ficha del corte él mismo; sin ella, al cambiar `linearSpot` leé el feed de la sesión con esa identidad para traer la ficha. Cerrá con `stopPlan`. El canal necesita `bs_libs_required=roku_ads_lib` en el manifiesto.
- **Samsung.** Importá `attachAvPlayAds` de `@interactivelayers/player-sdk/avplay-ads`, pasale `{ avplay, session, plan, contentUrl, listener, getDisplayRect, stage }` y llamá a `await ads.start()` antes de abrir el contenido. Si tu contenido usa DRM, propiedades de streaming o subtítulos, pasá `reopenContent(resumeAtMs)`: el SDK la llama después de cada anuncio para que abras, prepares y busques tu contenido. Sin ella, reabre `contentUrl`. Pasá `consent` con los valores de tu CMP. Avisá el final con `contentEnded()` y cerrá con `destroy()`.

`planOrigin` es el origen HTTPS del que vino el plan. Sin él, el producto de escena se ignora.

### La app pide su plan

Cada lector puede pedir `GET <consola>/il-player/app-plan?project=…&asset=…&app=<plataforma>:<id>` por HTTPS, sin cookies, y adjuntarlo. El valor de `app=` **tiene que estar registrado en la Console** del proyecto: un id no registrado recibe el mismo 404 que un proyecto o video desconocido.

- **Apple:** `ILAdPlanPlayer.load(overlay:player:origin:project:asset:locale:linearEngine:events:)`, `app=apple:<bundle id>`, límite de 5 s. Devuelve `nil` sin plan.
- **Roku:** `loadPlan(overlay, video, viewId, origen, proyecto, video, locale, consent)`, `app=roku:dev` en modo desarrollador o `roku:<id del canal>` publicado, límite de 5 s. Iniciá el contenido con `contentReady`.
- **Samsung:** `attachAvPlayAppAds({ origin, project, asset, ... })` de `@interactivelayers/player-sdk/avplay-ads`, `app=tizen:<id de aplicación>` (de `tizen.application.getCurrentApplication().appInfo.id`), límite de 4 s. Resuelve `null` sin plan. En la web, `attachAppAds` y `loadAppPlan` de `@interactivelayers/player-sdk/ads`. En `config.xml`, `<access origin>` y el privilegio `internet`; si un televisor rechaza la lectura sin CORS, el backend pide el plan y el host lo pasa con `attachAvPlayAds({ plan, planOrigin })`.

Un 204 (no hay plan todavía o se alcanzó un límite) no se reintenta: la próxima vista vuelve a preguntar. El contenido nunca espera más que el límite. La entrada en la que el host pasa el plan sigue igual en todas las plataformas.

Con un plan versión 2, el lector vuelve a pedirlo con `&renew=<grant de commerce.url>` hasta tres veces, a 20, 12 y 5 s del vencimiento, de a un pedido, y se detiene en el primer éxito. La renovación conserva la sesión de compra y el estado de la vista (lo mostrado, intentado y cerrado, el pacing); lo que sale del plan se reconstruye. Una respuesta versión 1 se adopta y termina las renovaciones; una versión 2 que reemplaza un plan versión 1 las empieza. Un host que obtiene el plan por su cuenta usa `replacePlan`. Al vencer sin renovación, el lector deja de usar el plan, emite `plan_expired` y el contenido sigue.

### Cortes que reproduce la app (API por corte)

Cuando el backend del cliente pide cada corte a la API por corte de IL (playback creado con `"graphics": true`) y la app lo reproduce con su propio reproductor, el plan de la reproducción (`GET /v1/vod/playbacks/{id}/plan`) trae `cuts: []` y el lector no pide ni reproduce anuncios. La app avisa:

- **Apple:** `setBreaks([segundos])`, `breakStarted(at:)`, `adStarted(tagURL:adID:creativeID:)` o `adStarted(tagURL:vastXML:)`, `adEnded()`, `breakEnded()`.
- **Roku:** `setBreaks([ms])`, `breakStarted(ms)`, `adStarted(adTagUrl, ad)` con el anuncio de RAF, `adEnded()`, `breakEnded()`.
- **Samsung y web:** `setBreaks([segundos])`, `breakStarted(at)`, `setBreakAd({ tagUrl, adId, creativeId })` o `setBreakAd({ tagUrl, vastXml })` (el VAST inline del anuncio que suena), `clearBreakAd()`, `breakEnded()`.

Obligaciones de la app:

- **Informar los cortes.** Las ventanas de un plan de reproducción sólo están separadas de los cortes que IL ubicaría. El lector aplica `cut_clearance_seconds` alrededor de las posiciones informadas con `setBreaks` o `breakStarted`; sin cortes informados no hay separación. Sin `breakStarted`, el lector no puede saber que hay un anuncio en pantalla: dibuja por tiempo de contenido y no hay Comprar.
- **Adjuntar con `commerce.session` del plan** como sesión. Es el `sid` de cada `ad_tag_url` estable y la sesión que nombra el grant de `break_url`. Con otra, el lector emite una vez `buy_unavailable` (motivo `session`) y no hay Comprar durante los cortes.
- **Pedir el `ad_tag_url` de cada corte exactamente como llega**, con el `correlator` que ya trae; no agregar ni cambiar `sid`.

Mientras dura un corte informado no se dibuja nada de IL salvo Comprar. La ficha se pide con `cut=at-<ms>`, la posición redondeada al milisegundo; una posición negativa o no finita emite `break_refused` (motivo `position`). Un plan sin `break_url` (playback creado sin `"graphics": true` o sin pasos ordenados) no tiene Comprar durante los cortes, sin evento. Durante un corte de la app, `destroy()`/`stop()`/`stopPlan`, el vencimiento o un reemplazo del plan sólo limpian el estado del lector: nunca tocan el reproductor de la app. Como red de seguridad, un corte sin `breakEnded` se da por terminado con `break_error`.

### Eventos

| Evento | Cuándo |
| --- | --- |
| `plan_unavailable` | Un pedido por la ruta de apps terminó sin plan. Lleva el `app` enviado (o que se habría enviado) y un motivo de texto: `http_<estado>` (`http_204`, `http_404`, …), `timeout`, `network`, `request` (la URL no se puede armar), `app_id` (id rechazado localmente, sin pedido), `stitched` (un 200 con `timeline`) o `invalid` (otro 200 ilegible). |
| `plan_renewed` | Se adoptó una renovación; lleva la versión nueva. |
| `plan_renew_failed` | Fallaron los intentos de renovación; una vez, con el último motivo. |
| `plan_expired` | El plan versión 2 venció; sin más datos. |
| `break_error` | Un corte terminó de forma anormal, también la red de seguridad de un corte de la app. |
| `break_refused` | Una posición de corte informada que no se acepta (motivo `position`). |
| `buy_unavailable` | Hay `break_url` pero la sesión no es `commerce.session` (motivo `session`). |

Ningún evento ni campo público lleva el `grant`, el valor de `renew` ni las URLs de `commerce`.

### Identidad de la app en Google Ad Manager

El plan de una app no trae `page_url`, así que los pedidos a GAM no llevan página.

- **Apple:** el SDK agrega `msid` (bundle id) y `an` (nombre visible) a los pedidos a GAM que hace él mismo, si el tag no los trae; los tags que se entregan a IMA no se tocan.
- **Roku:** no agrega `msid` ni `an` (el formato para Roku no está definido); si hacen falta, tienen que venir en los tags del proyecto.
- **Samsung:** agrega `msid` y `an` sólo si el host los pasa en `appParams` a `attachAvPlayAppAds`, y sólo a planes cargados por la ruta de apps; no los deduce del id de aplicación.

### Ejemplos

`examples/api-relay.mjs` hace de backend del cliente para la API por corte en las apps de ejemplo (`examples/apple`, `examples/roku`, `examples/tizen`), con un modo `--fixtures` sin backend. **Es sólo un ejemplo: nunca lo despliegues.** En modo real le da el poder de `IL_API_KEY` a quien lo alcance.

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
  - `load` con un bundle id registrado, renovación, Comprar con `break_url` con un anuncio real de iADServer y cortes de la app con IMA.
  - IMA real (3.34.1 y una versión menor posterior) con `adsResponse`, y caída a MP4.
  - Overlay con GMA y App ID.
  - Una app que fija otra versión menor de GMA o IMA.
  - Tarjeta y Comprar, rotación y área segura.
  - Volumen del anuncio con el contenido silenciado.
- **tvOS.**
  - `load`, renovación, Comprar con `break_url` y cortes de la app en una Apple TV.
  - IMA 4.18.1 real.
  - Foco del control, QR, tarjeta y Comprar durante un corte.
- **Roku.**
  - `loadPlan` con `roku:dev` y con el id de un canal publicado registrado, y la renovación de un plan versión 2.
  - Comprar con `break_url`: cuál de las dos ramas (`adId` de RAF o URL de impresión) se da en un equipo real.
  - Cortes de la app con su propio RAF y el canal de ejemplo en modo `host`.
  - RAF real con tags de GAM e iADServer.
  - Un servidor de anuncios que nunca responde: el temporizador debe devolver el contenido, aunque la tarea de RAF siga bloqueada.
  - Atrás durante los anuncios: el contenido debe reanudarse.
  - Un `getAds()` que responde después del temporizador: no debe dibujar nada.
  - Súper, L y tarjeta en pantalla, y QR.
  - Consentimiento pasado por el host.
  - La revisión de Roku por ADS 1.1 antes de publicar.
- **Samsung Tizen.**
  - Que la app empaquetada pueda leer la ruta de apps sin CORS con `<access origin>` en `config.xml`, y el modo `host` de `examples/tizen`.
  - `attachAvPlayAppAds` con un `app=tizen:` registrado, y la renovación de un plan versión 2.
  - Comprar durante un corte con `break_url`, en un corte del plan y en uno de la app.
  - AVPlay con MP4 y wrappers, y la impresión en el primer cuadro.
  - `reopenContent` con DRM y subtítulos.
  - Un MP4 que no se prepara.
  - `destroy()` a mitad de un anuncio.
  - Overlay con GPT en la TV.
  - Tarjeta y Comprar durante un corte, QR y el control remoto.
