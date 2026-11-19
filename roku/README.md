# Roku · SceneGraph

`ILOverlay` agrega Super y L al nodo `Video` que ya reproduce el canal. El publisher le entrega la playlist de medios seleccionada o el JSON de overlays de esa misma sesión. El componente lee el último fotograma renderizado, dibuja las imágenes y emite una impresión por ID y sesión.

## Integración

Copiá [components/ILOverlay](components/ILOverlay) dentro de `components/` de la app, conservando el nombre de la carpeta. Para distribuir solo estas fuentes podés ejecutar `zip -qr ILOverlay-sources.zip components/ILOverlay` desde `roku/`.

```brightscript
' En el componente que contiene el Video. playback.sessionId identifica esta reproducción.
m.ilSession = playback.sessionId
m.il = m.video.getParent().createChild("ILOverlay")
imageAgent = createObject("roHttpAgent")
imageAgent.setCertificatesFile("common:/certs/ca-bundle.crt")
m.il.setHttpAgent(imageAgent)
m.il.observeFieldScoped("impression", "onOverlayImpression")
m.il.callFunc("attach", m.video, m.ilSession)
m.il.linearBreak = inLinearBreak
```

El overlay y el video comparten padre. Colocá los controles del reproductor por encima del overlay si deben seguir visibles. Las imágenes usan HTTPS y el agente del overlay puede configurarse con la confianza que precise el CDN. La sesión de reproducción, los controles y el audio siguen a cargo del reproductor. [Agente HTTP en SceneGraph](https://developer.roku.com/dev/docs/rohttpagent)

## Cues de la sesión

- **Playlist de medios HLS.** Pasá su texto completo con `m.il.callFunc("setManifest", m.ilSession, playlistText)` en cada recarga. El componente lee los `EXT-X-DATERANGE` de clase `com.interactivelayers.overlay`, filtra por formato y acepta los atributos del contrato compartido. Las fechas llevan `Z` u offset como `-03:00`. La duración se expresa en segundos. Una playlist maestra o una actualización delta devuelve `false` y conserva la última lista válida. [Contrato de la gráfica](../docs/signals.md)
- **JSON por sesión.** Pasá el array normalizado con `m.il.callFunc("setTimeline", m.ilSession, cues)`. Cada entrada tiene `id`, `format` (`super` o `l`), `start` y `end` en milisegundos Unix, `imageUrl` HTTPS para PNG/JPEG y, opcionalmente, `mimeType` e `impressionUrl` HTTPS. El intervalo `[1781524800000, 1781524812000)` dura doce segundos. Cada llamada reemplaza la lista. Un array vacío retira la gráfica.

Con ABR, el publisher identifica la variante de medios que usa el reproductor. Puede verificar la correspondencia con la URL y la secuencia del segmento que reporta `Video.streamingSegment`. Si su integración solo conoce la playlist maestra, puede usar el JSON de la sesión. Para DVR, la fuente debe cubrir también la ventana que el espectador puede volver a reproducir. En caso de cues solapados, se elige el primero válido en el orden recibido.

Roku documenta metadatos temporizados seleccionados por clave, pero su referencia pública de `Video.timedMetaData2` no especifica una forma portable de recuperar todos los atributos de este `DATERANGE`. Roku también restringe el acceso a `Video.manifestData`. El adaptador lee las etiquetas del texto entregado por el publisher. [Video](https://developer.roku.com/dev/docs/video) · [Estado de manifestData](https://developer.roku.com/dev/docs/deprecated-apis)

### Leer un endpoint

Si el reproductor ya recibe los cues, puede pasárselos directamente al componente. El `Task` opcional `ILOverlayFeedRequest` hace un GET HTTPS con límite de ocho segundos para apps que necesitan leer el endpoint. Usá la URL de contexto devuelta al abrir la **misma sesión**. También puede leer la URL de la variante activa confirmada por la app.

```brightscript
' Crear una vez en el componente del reproductor.
m.feed = createObject("roSGNode", "ILOverlayFeedRequest")
m.feed.observeFieldScoped("result", "onOverlayFeed")
m.feedRevision = 1

' En cada actualización de contexto del canal, con una sola lectura en curso.
' El Task agrega time y sid a la URL base del endpoint JSON.
mediaTime = m.il.callFunc("getProgramTimeMs")
if mediaTime <> invalid
    m.feed.request = {
        sessionId: m.ilSession, revision: m.feedRevision, programTimeMs: mediaTime
        kind: "json", url: playback.overlayFeedUrl
    }
    m.feed.control = "RUN"
end if

sub onOverlayFeed(event)
    result = event.getData()
    if result.sessionId <> m.ilSession or result.revision <> m.feedRevision then return
    if result.body = invalid then return
    if result.kind = "hls"
        m.il.callFunc("setManifest", m.ilSession, result.body)
    else
        m.il.callFunc("setTimeline", m.ilSession, parseJson(result.body, "d"))
    end if
end sub
```

Para leer la variante seleccionada, asigná a `m.feed.request` los campos `sessionId`, `revision`, `kind: "hls"` y la URL de la variante, y arrancá el Task. La petición HLS puede ejecutarse mientras esperás la primera muestra. Al cambiar de variante, incrementá `m.feedRevision`, vaciá los cues anteriores y actualizá la URL. Las respuestas demoradas conservan la revisión original. El host elige la frecuencia de recarga según su servicio y `EXT-X-TARGETDURATION`. Para un endpoint con cabeceras privadas, usá el cliente HTTP autenticado de la app. La opción `d` de `ParseJson` está disponible desde Roku OS 14.6. En versiones anteriores, preservá los milisegundos Unix como `LongInteger` o `Double` al construir el array, o entregá la playlist HLS como texto. [ParseJson](https://developer.roku.com/dev/docs/global-utility-functions)

## Reloj, cortes y finalización

Con `Video.positionInfo.epoch = 1`, el SDK multiplica `positionInfo.video` por mil para convertir los segundos UTC del último fotograma a milisegundos. Con `epoch = 0`, necesita un punto conocido que una el tiempo de medios con UTC para ese clip. Por ejemplo, una playlist marca el primer fotograma del segmento 381 con `#EXT-X-PROGRAM-DATE-TIME:2023-11-14T22:13:20.000Z`. El publisher ha verificado para ese mismo clip la URL absoluta del segmento y su secuencia. En el callback de segmento del reproductor se puede hacer lo siguiente. [Video.positionInfo y streamingSegment](https://developer.roku.com/dev/docs/video) · [EXT-X-PROGRAM-DATE-TIME](https://www.rfc-editor.org/rfc/rfc8216#section-4.3.2.6)

```brightscript
segment = m.video.streamingSegment
frame = m.video.positionInfo
if segment <> invalid and frame <> invalid
    if (segment.segType = 0 or segment.segType = 2) and frame.epoch = 0
        if segment.segSequence = 381 and segment.segUrl = expectedSegmentUrl and frame.clip_id = expectedClipId
            anchor = { positionSeconds: segment.segStart, programTimeMs: 1700000000000#, clipId: frame.clip_id }
            m.il.callFunc("setClockAnchor", m.ilSession, anchor)
        end if
    end if
end if
```

Así, un fotograma a 4,5 segundos del inicio del segmento corresponde a `1700000004500`. Si falta la relación, el SDK espera. Limpiá el ancla con `setClockAnchor(sessionId, invalid)` al perder la continuidad y entregá una nueva cuando la fuente vuelva a identificar el segmento. El reloj del dispositivo y el instante de descarga no intervienen en la sincronización.

- **Pausa y buffering.** El SDK observa `Video.state`, retira las gráficas al salir de `playing` y reevalúa el fotograma al reanudar. Durante la reproducción revisa el cabezal cada 100 ms.
- **Corte lineal y seek.** Conectá `m.il.linearBreak` a los eventos reales de inicio y fin del corte del reproductor. Antes de un seek de la app, asigná `m.il.seeking = true` y volvé a `false` cuando se renderice el primer fotograma del destino. Roku expone `Video.seek` como campo de escritura. Ocultá el componente con `m.il.visible = false` mientras otra pantalla cubra el reproductor.
- **Impresión.** En `onOverlayImpression(event)`, `event.getData()` contiene `sessionId`, `id`, `format`, `programTimeMs` y la `impressionUrl` si el emisor la entregó. Enviá ese evento o su beacon mediante el transporte del publisher. El SDK publica una sola vez por ID para la sesión de esa instancia después de `Poster.loadStatus = "ready"` y de que SceneGraph reporte render en pantalla. [Poster](https://developer.roku.com/dev/docs/poster) · [Render tracking](https://developer.roku.com/dev/docs/group)
- **Layout.** El Super usa 75 % del ancho por 20 % del alto, con origen en 12,5 % y 70 %. La L reduce el video al 75 % del ancho y del alto y recorta dos bandas del mismo lienzo en sus bordes derecho e inferior. También admite JPEG opaco. Al retirar la L recupera los valores originales de `Video.width` y `height`, incluido el cero que Roku usa para ocupar toda la pantalla.
- **Cerrar.** Llamá a `m.il.callFunc("detach")` antes de retirar el nodo. Si usás el lector de ejemplo, detenelo con `m.feed.control = "STOP"`. Para otro contenido, asigná una clave de sesión nueva y volvé a llamar a `attach`. Las respuestas de otra sesión se descartan.

## Verificación

Ejecutá `sh roku/verify.sh` desde la raíz del repositorio. BrighterScript valida el XML y BrightScript. El intérprete de escritorio ejecuta el componente con nodos SceneGraph y valores controlados para el decodificador y el compositor. La prueba cubre reloj UTC/relativo, parsing HLS, Super/L, carga parcial, visibilidad, impresión única, pausa, corte, seek, cambio de contenido y detach. El intérprete carece del `Task` y del plano de video físico de Roku. La reproducción HLS, la descarga HTTPS y la composición final quedan pendientes de una prueba en dispositivo.

## Compra con Shopify

Habilitá `m.il.commerceEnabled = true`. En el `Task` que consulta el endpoint JSON, incluí `commerce: true`, `locale: "es"` y, si corresponde, `country: "AR"` en `request`. La ficha recibe OK, flechas y Atrás. Si la app controla el foco directamente, configurá `m.il.commerceAutoFocus = false` y reenviá las teclas con `m.il.callFunc("handleCommerceKey", key, press)`. El resultado booleano indica si la ficha usó la tecla.

Observá `productView` y enviá un GET a `viewUrl` con el cliente de medición del host. El `Task` de compra prepara el carrito y la ficha carga el PNG del QR mientras sigue el video. Probá el comportamiento en un equipo Roku del publisher. [Contrato de compra](../docs/signals.md#compra-con-shopify) · [Requisitos de anuncios en Roku](https://developer.roku.com/dev/docs/ad-requirements)
