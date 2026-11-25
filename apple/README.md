# Overlays en AVPlayer para Apple TV y iOS

El producto SwiftPM `ILAVPlayerOverlay` agrega una superficie UIKit al `AVPlayer` que ya reproduce el canal. Sirve para tvOS 16+ e iOS 16+. La app conserva el control del canal, las pistas, los subtítulos, el audio y los controles de transporte. La superficie compone la gráfica y el video en la misma vista mediante `AVPlayerLayer`. [AVPlayerLayer de Apple](https://developer.apple.com/documentation/avfoundation/avplayerlayer)

## Instalar y montar la superficie

En Xcode, abrí **File → Add Package Dependencies**, elegí **Add Local** y seleccioná la carpeta `apple` de este checkout. Agregá el producto `ILAVPlayerOverlay` al target de la app. Cuando la revisión esté publicada, el manifiesto de la raíz también admite instalar el paquete por la URL del repositorio y fijar una revisión. [Repositorio en GitHub](https://github.com/InteractiveLayerscom/IL-VideoPlayers-SDK)

Invocá la API de la vista en el actor principal. Usá un contenedor del tamaño del área de video. Reemplazá la superficie de video anterior y conservá los controles como vistas hermanas por encima. En un host basado en `AVPlayerViewController`, el formato L necesita una superficie cuyo rectángulo de video controle la app. El siguiente código recibe el reproductor existente.

```swift
import AVFoundation
import ILAVPlayerOverlay
import UIKit

@MainActor
func instalarOverlays(en contenedor: UIView, player: AVPlayer,
                      fuente: ILOverlaySource = .hlsDateRanges) -> ILOverlayPlayerView {
    let superficie = ILOverlayPlayerView(player: player, source: fuente)
    superficie.frame = contenedor.bounds
    superficie.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    contenedor.insertSubview(superficie, at: 0)
    return superficie
}
```

Si la app ya usa un `AVPlayerLayer` independiente, retiralo de su supercapa y pasalo a `ILOverlayPlayerView(adopting: capa, source: .hlsDateRanges)`. Este inicializador devuelve una vista opcional y conserva la identidad de la capa y su reproductor. Las capas de respaldo de una `UIView` pertenecen a esa vista. En ese caso usá el inicializador `player:` y desconectá la superficie anterior del reproductor.

## Elegir la fuente de señales

**HLS por sesión.** El modo predeterminado agrega un `AVPlayerItemMetadataCollector` al ítem actual y filtra la clase `com.interactivelayers.overlay`. El publicador coloca `EXT-X-PROGRAM-DATE-TIME` y las etiquetas de gráfica en la playlist de medios que recibe esa sesión. Por ejemplo, este intervalo empieza un segundo después de la fecha del primer segmento y dura 3,25 segundos. [AVPlayerItemMetadataCollector](https://developer.apple.com/documentation/avfoundation/avplayeritemmetadatacollector)

```m3u8
#EXT-X-PROGRAM-DATE-TIME:2026-01-15T12:00:00.000Z
#EXT-X-DATERANGE:ID="super-1",CLASS="com.interactivelayers.overlay",START-DATE="2026-01-15T12:00:01.000Z",DURATION=3.250,X-IL-FORMAT="super",X-ASSET-URI="https://media.example/s.png",X-ASSET-MIMETYPE="image/png",X-IL-IMPRESSION-URI="https://measure.example/i"
```

El colector entrega `ID` en `group.uniqueID`, `CLASS` en `group.classifyingLabel`, y el intervalo en `startDate` y `endDate`. AVFoundation resuelve la fecha de fin a partir de `END-DATE` o `DURATION`. Si publicás ambos, los dos deben indicar el mismo fin. Los atributos propios llegan como elementos con `keySpace == .hlsDateRange` y claves como `X-ASSET-URI`. En la prueba de reproducción observamos el identificador `lsdr/X-ASSET-URI`. Cada actualización reemplaza la colección de rangos disponible para hacer seek. [AVMetadataGroup](https://developer.apple.com/documentation/avfoundation/avmetadatagroup) · [AVDateRangeMetadataGroup](https://developer.apple.com/documentation/avfoundation/avdaterangemetadatagroup) · [AVMetadataKeySpace.hlsDateRange](https://developer.apple.com/documentation/avfoundation/avmetadatakeyspace/hlsdaterange)

**JSON por sesión.** Si el proveedor entrega las decisiones por otra vía, inicializá la superficie con `.sidecar`. El adaptador del host entrega un arreglo completo de esa sesión, con tiempos Unix en milisegundos y URLs HTTPS. Un arreglo vacío revoca todas las gráficas. Capturá el `AVPlayerItem` al iniciar la consulta y aplicá las respuestas en orden. El SDK rechaza las respuestas para un ítem que ya fue reemplazado.

```json
[{"id":"super-1","format":"super","start":1768478401000,"end":1768478404250,"imageUrl":"https://media.example/s.png","mimeType":"image/png","impressionUrl":"https://measure.example/i"}]
```

```swift
@MainActor
func actualizarAgenda(player: AVPlayer, superficie: ILOverlayPlayerView,
                      obtener: () async throws -> Data) async throws {
    guard let item = player.currentItem else { return }
    let datos = try await obtener()
    try superficie.replaceSidecar(datos, for: item)
}
```

Ambos modos usan `AVPlayerItem.currentDate()` y el intervalo `[start, end)`. El HLS necesita `EXT-X-PROGRAM-DATE-TIME` también cuando la decisión llega por JSON. Si el ítem carece de fecha mapeada, la superficie muestra el video a tamaño completo. La agenda se evalúa en la posición reproducida, incluidos el DVR y los saltos. [AVPlayerItem.currentDate()](https://developer.apple.com/documentation/avfoundation/avplayeritem/currentdate%28%29)

## Presentación y cortes lineales

- **L** ocupa todo el lienzo. El video se ubica arriba a la izquierda, al 75 % del ancho y del alto. La imagen se dibuja detrás del video. Prepará el arte con la relación de aspecto del lienzo.
- **Super** conserva el video a tamaño completo. La caja empieza en `x = 12,5 %`, `y = 70 %` y mide `75 % × 20 %`. La imagen conserva su proporción dentro de esa caja.
- El SDK admite imágenes PNG y JPEG por HTTPS. Puede empezar a cargar la próxima hasta cinco segundos antes. Comprueba el tipo decodificado, el límite de 8 MiB y el máximo de 16.777.216 píxeles. Un fallo de carga deja el video a tamaño completo.
- La app comunica sus cortes SSAI con `superficie.isInLinearAdBreak = true` al entrar y `false` al salir. Los intersticiales nativos de AVPlayer se detectan con `AVPlayerInterstitialEventMonitor`. Pausar o entrar en espera retira el arte. Durante un scrub propio, Picture in Picture o una pantalla que tape el reproductor, activá `isPresentationSuspended` y desactivala al volver. [Estado del reproductor](https://developer.apple.com/documentation/avfoundation/avplayer/timecontrolstatus-swift.property) · [Monitor de intersticiales](https://developer.apple.com/documentation/avfoundation/avplayerinterstitialeventmonitor)
- Con una URL de impresión, la superficie inicia un GET una vez por ID y por sesión de reproducción de un ítem. Primero debe haber dibujado la imagen y llegar a otro ciclo de pantalla con la gráfica visible, el programa reproduciéndose y la ventana activa. Un seek hacia atrás puede volver a mostrar la gráfica. Para comprobar la recepción del GET usá el registro del endpoint de pruebas. [CADisplayLink](https://developer.apple.com/documentation/quartzcore/cadisplaylink)
- Al terminar la integración llamá a `superficie.stop()`. Libera colector, observadores y trabajo pendiente, retira la gráfica y restituye el video al tamaño del contenedor. Para un canal nuevo, una superficie activa sigue los cambios de `player.currentItem` e inicia una sesión con sus propias impresiones.

## Verificación

Desde `apple`, en un Mac con Xcode, Python 3 y FFmpeg con `libx264` en el PATH, ejecutá las pruebas y compilá para ambos SDK. La prueba HLS genera segmentos con video H.264 y audio AAC, sirve la playlist desde loopback y comprueba que AVPlayer de macOS avanza. Después salta a una L, retrocede a un super y sale de ambos intervalos usando el reloj del medio.

```sh
swift test
swift build --triple arm64-apple-tvos16.0 --sdk "$(xcrun --sdk appletvos --show-sdk-path)"
swift build --triple arm64-apple-ios16.0 --sdk "$(xcrun --sdk iphoneos --show-sdk-path)"
xcodebuild -scheme ILAVPlayerOverlay-Package -destination 'platform=macOS,variant=Mac Catalyst' test
xcodebuild -scheme ILAVPlayerOverlay-Package -destination 'platform=iOS Simulator,name=iPhone 17' test
xcodebuild -scheme ILAVPlayerOverlay-Package -destination 'platform=tvOS Simulator,name=Apple TV 4K (3rd generation)' test
```

Para la aceptación en una Apple TV podés generar un HLS con ambos formatos y servir sus dos creatividades por HTTPS desde un origen accesible al equipo. [Fixture del repositorio](../examples/README.md)

Reproducí el HLS de la sesión de pruebas. Observá un super y una L de principio a fin, pausá, cruzá un corte lineal y hacé seek hacia atrás y fuera del intervalo. Confirmá la recuperación de la pantalla completa y un único GET de impresión por ID. La validación local comprende compilación arm64 con los SDK de iOS y tvOS 26.1, metadatos HLS en AVPlayer de macOS y pruebas de UIKit con Mac Catalyst. La reproducción y la composición en una Apple TV física quedan pendientes de esa prueba.

## Compra con Shopify

Usá `ILOverlayPlayerView(player: player, source: .sidecar)` y habilitá `surface.commerceEnabled = true`. Aplicá `ILOverlayPlayerView.commerceFeed(feedURL, locale: "es", country: "AR")` antes de agregar `sid` y `time` desde el cliente de sesión. Seguí pasando la respuesta con `replaceSidecar(_:for:)`.

En tvOS, el control remoto elige variantes y abre el QR. En iOS, la misma acción abre la continuación en el navegador. La app puede asignar `openCheckoutURL` para usar su navegación de compra y llamar a `closeCommercePanel()` para ofrecer primero el cierre de la ficha al gestionar Atrás. [Contrato de compra](../docs/signals.md#compra-con-shopify)

En tvOS, la tienda ocupa un panel lateral. Si las variantes disponibles tienen precios distintos, la portada muestra **Desde** y el precio más bajo. **Elegir opciones** abre el detalle si hay varias variantes disponibles. Con una sola, **Ver detalles** abre la ficha. Un producto sin opciones (la única variante «Default Title» de Shopify) no muestra fila de variantes en tvOS ni en iOS, y el carrito y el QR no repiten la variante. **Agregar al carrito** conserva una unidad de la variante elegida. **Continuar con el QR** solicita el QR de Shopify. En iOS, **Comprar** abre el enlace de compra.

En portada y detalle de tvOS, el botón de fotos abre la foto de la variante elegida a pantalla completa dentro del reproductor. Se llama **Ampliar foto** si el visor tiene una sola foto y **Ver fotos** si tiene varias. Con varias fotos, usá izquierda y derecha en el control remoto. **Atrás** vuelve a la ficha que abrió el visor y devuelve el foco a la foto. La variante elegida se conserva.

### Tienda durante un midroll VAST

Cuando el host empiece a reproducir un spot con tienda, pasá el `Creative@id` y el ID de entrega de su URL de impresión `/events/{id}/impression`. Solicitá el sidecar conservando el mismo tag, `sid` y rango temporal del feed de esa sesión.

```swift
superficie.setLinearAdBreak(true, creativeID: creativeID, deliveryID: deliveryID)
let url = ILOverlayPlayerView.commerceFeed(feedDeLaSesion, locale: "es",
                                           midrollCreativeID: creativeID, midrollDeliveryID: deliveryID)
// La respuesta se aplica con replaceSidecar(_:for:) al ítem que inició la consulta.
// Al finalizar o saltar el spot:
superficie.setLinearAdBreak(false)
```

La superficie muestra **Comprar** durante el intervalo de una entrega cuyo ID y creatividad coinciden con el corte activo. El host sigue reproduciendo el spot y midiendo la impresión VAST. Para los demás cortes seguí usando `isInLinearAdBreak`.

## Plan de anuncios

Para leer el plan de IL y mostrar cortes, gráficas y productos, seguí la [guía de SDK nativos](../docs/native-ad-plan-matrix.md). Indica qué formato falta probar en un dispositivo.

### Pedir el plan desde la app

`ILAdPlanPlayer.load` pide el plan a IL y lo adjunta. Devuelve `nil` cuando no hay anuncios para esta vista; el contenido se reproduce igual.

```swift
let plan = await ILAdPlanPlayer.load(overlay: superficie, player: player, origin: "https://<host de la consola>",
                                     project: proyecto, asset: video, locale: "es",
                                     linearEngine: nil, events: { tipo, formato, id in print(tipo, formato ?? "-", id) })
await plan?.start()
player.play()
```

- La solicitud es `GET <origin>/il-player/app-plan?project=…&asset=…&app=apple:<Bundle.main.bundleIdentifier>`, sólo por HTTPS y sin cookies. Registrá ese bundle id en la Consola: un id no registrado recibe el mismo 404 que un proyecto o video desconocido.
- Sin plan, `load` emite una vez `plan_unavailable`: el `id` es el valor `app=` exacto enviado (o que se habría enviado) y el formato, el motivo:
  - `204`: no hay plan todavía (IL lo prepara en segundo plano) o se alcanzó un límite. Sin reintentos: la próxima vista vuelve a preguntar.
  - `404`: proyecto, video o app desconocidos; revisá primero que ese `app=` esté registrado.
  - `timeout` (más de `ILAdPlanPlayer.planTimeoutSeconds`, 5 s), `network`, `http_<estado>`, `invalid_plan`, `invalid_origin` y `invalid_bundle_id` (un bundle id que el servidor rechazaría: no se envía nada).
- `load` nunca retiene el contenido más de ese plazo. Ningún evento lleva el `grant`, el `renew` ni las URLs de `commerce`.
- El inicializador con `planJSON:` sigue igual.

### Planes versión 2 (aprobación nativa de GAM)

Un plan `version: 2` se acepta sólo con `native_gam.contract == "native-gam-plan-v1"` y un `expires_at` a no más de 120 s, como en `web/ads.mjs`. Al vencer, el lector retira lo que dibujó, descarta respuestas pendientes, no empieza nada nuevo y emite `plan_expired`; el contenido sigue. Con `load`, el SDK lo vuelve a pedir unos 20 s antes del vencimiento con `&renew=<grant de commerce.url>`, que conserva la sesión de compra. Si el host obtiene el plan por su cuenta, pasá el nuevo con `replacePlan(_:)`. Una respuesta versión 1 a una renovación se adopta y deja de renovarse; una versión 2 que reemplaza un plan versión 1 empieza a renovarse. El vencimiento se compara en milisegundos. En ambos casos se reconstruye lo que sale del plan (cortes, ventanas, gráficas dibujadas) y se conservan los cortes jugados, las ventanas intentadas y mostradas, el pacing y la sesión: renovar no repite ni cuenta dos veces.

### Comprar durante un corte

Con `commerceEnabled = true` y un plan con `commerce.break_url`, cuando empieza un anuncio cuyo VAST `Ad@id` es `il-shop-<preroll|midroll>-<entrega de 43 caracteres>` del mismo tipo de corte, el SDK pide la ficha a `break_url` con `cut`, `tag` (del tag de iADServer), `creative` (`Creative@id`), `delivery` y `locale`, y dibuja **Comprar** mientras dure ese anuncio. Sin ese prefijo no hay producto ni pedido. La impresión es la del VAST; el SDK sólo envía `commerce.viewUrl` al abrir la ficha. Sin `break_url`, sigue funcionando el feed de sesión con `setLinearAdBreak(_:creativeID:deliveryID:)`.

### Identidad de la app en Google Ad Manager

El plan de una app no trae `page_url`. En los pedidos a GAM que hace el propio SDK (tags de gráficas, VAST leído para el camino MP4) agrega `msid` (bundle id) y `an` (nombre visible de la app) si el tag no los trae, como recomienda la guía [VAST ad tag URL parameters](https://support.google.com/admanager/answer/10678356) de Google para pedidos desde apps. Nunca agrega `url` ni `description_url`. Los tags que se entregan a IMA no se tocan: IMA agrega la identidad de la app por su cuenta.

### Cortes que reproduce la app (API por corte)

Cuando la app pide cada corte a la API de IL y lo reproduce con su propio reproductor, adjuntá el plan de la reproducción (`GET /v1/vod/playbacks/{id}/plan`, con `cuts: []`) y avisá al SDK. Sirve con el producto `ILAVPlayerOverlay` solo, sin IMA ni GMA.

```swift
plan.setBreaks([58, 178])                 // posiciones de tus cortes, en segundos de contenido
// al empezar tu corte:
plan.breakStarted(at: 58)                 // 0 para un pre-roll
plan.adStarted(tagURL: adTagURL, adID: imaAd.adId, creativeID: imaAd.creativeID)
// o, con el XML del VAST: plan.adStarted(tagURL: adTagURL, vastXML: vast)
plan.adEnded()                            // al completar, saltar o fallar el anuncio
plan.breakEnded()
```

Obligaciones de la app:

- Informar las posiciones de tus cortes con `setBreaks` antes de llegar a ellos. Las ventanas de un plan de reproducción no dejan espacio alrededor de los cortes que reproduce la app: el SDK aplica `scenes.pacing.cut_clearance_seconds` sólo alrededor de los cortes informados (`setBreaks` o `breakStarted`). Sin cortes informados no hay margen.
- La posición de `breakStarted` se redondea al milisegundo más cercano (`at-<ms>`); una negativa o no finita no abre el corte y emite `break_error`.
- Buy durante el corte necesita que la sesión sea `commerce.session` del plan: no pases tu propio `sessionID`. Si lo pasás y el plan trae `break_url`, el SDK lo dice una vez con `break_shop_unavailable`. Un plan sin `break_url` (reproducción creada sin `graphics: true`) simplemente no tiene Comprar.
- Red de seguridad: un corte sin `breakEnded()` se da por terminado a los `ILAdPlanPlayer.hostBreakLimitSeconds` (300 s) con `break_error`, y las gráficas vuelven.
- El SDK no controla tu reproductor durante tu corte: `stop()`, `replacePlan` o un vencimiento sólo limpian el estado y la superficie del SDK, nunca pausan, buscan ni reemplazan tu ítem.

Además, informar **cada** corte con `breakStarted`/`breakEnded` y cada anuncio con `adStarted`/`adEnded`. Mientras un corte está informado, el SDK no dibuja nada salvo Comprar y descarta las respuestas pendientes; el `cut` de la ficha es `at-<ms>` de la posición. El SDK no puede saber que hay un anuncio en pantalla si la app no lo informa: sin avisos, las gráficas siguen el tiempo del contenido y no hay Comprar. En tvOS, Comprar toma el foco al aparecer como en los cortes propios del SDK, y el Overlay 300×250 sigue sin estar disponible.

Ejemplo completo con ambos modos: [examples/apple](../examples/apple/README.md).
