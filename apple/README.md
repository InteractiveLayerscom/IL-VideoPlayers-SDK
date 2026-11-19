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
xcodebuild -scheme ILAVPlayerOverlay -destination 'platform=macOS,variant=Mac Catalyst' test
```

Para la aceptación en una Apple TV podés generar un HLS con ambos formatos y servir sus dos creatividades por HTTPS desde un origen accesible al equipo. [Fixture del repositorio](../examples/README.md)

Reproducí el HLS de la sesión de pruebas. Observá un super y una L de principio a fin, pausá, cruzá un corte lineal y hacé seek hacia atrás y fuera del intervalo. Confirmá la recuperación de la pantalla completa y un único GET de impresión por ID. La validación local comprende compilación arm64 con los SDK de iOS y tvOS 26.1, metadatos HLS en AVPlayer de macOS y pruebas de UIKit con Mac Catalyst. La reproducción y la composición en una Apple TV física quedan pendientes de esa prueba.

## Compra con Shopify

Usá `ILOverlayPlayerView(player: player, source: .sidecar)` y habilitá `surface.commerceEnabled = true`. Aplicá `ILOverlayPlayerView.commerceFeed(feedURL, locale: "es", country: "AR")` antes de agregar `sid` y `time` desde el cliente de sesión. Seguí pasando la respuesta con `replaceSidecar(_:for:)`.

En tvOS, el control remoto elige variantes y abre el QR. En iOS, la misma acción abre la continuación en el navegador. La app puede asignar `openCheckoutURL` para usar su navegación de compra y llamar a `closeCommercePanel()` para ofrecer primero el cierre de la ficha al gestionar Atrás. [Contrato de compra](../docs/signals.md#compra-con-shopify)
