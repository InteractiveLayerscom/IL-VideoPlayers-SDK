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

Ejecutá `sh roku/verify.sh` desde la raíz del repositorio. BrighterScript valida el XML y BrightScript. `roku/tests/native.brs` cubre la carga del plan, la versión 2, la renovación, la ficha por `break_url` y los cortes del host con los fixtures compartidos de `test/fixtures/native/`, servidos por un doble de red con la hora congelada. El intérprete de escritorio ejecuta el componente con nodos SceneGraph y valores controlados para el decodificador y el compositor. La prueba cubre reloj UTC/relativo, parsing HLS, Super/L, carga parcial, visibilidad, impresión única, pausa, corte, seek, cambio de contenido y detach. El intérprete carece del `Task` y del plano de video físico de Roku. La reproducción HLS, la descarga HTTPS y la composición final quedan pendientes de una prueba en dispositivo.

## Compra con Shopify

Habilitá `m.il.commerceEnabled = true`. En el `Task` que consulta el endpoint JSON, incluí `commerce: true`, `locale: "es"` y, si corresponde, `country: "AR"` en `request`. La ficha recibe OK, flechas y Atrás. Si la app controla el foco directamente, configurá `m.il.commerceAutoFocus = false` y reenviá las teclas con `m.il.callFunc("handleCommerceKey", key, press)`. El resultado booleano indica si la ficha usó la tecla.

Observá `productView` y enviá un GET a `viewUrl` con el cliente de medición del host. El `Task` de compra prepara el carrito y la ficha carga el PNG del QR mientras sigue el video. Probá el comportamiento en un equipo Roku del publisher. [Contrato de compra](../docs/signals.md#compra-con-shopify) · [Requisitos de anuncios en Roku](https://developer.roku.com/dev/docs/ad-requirements)

### Ficha, galería y carrito de TV

Desde la portada y los detalles, **Ver galería de fotos** abre la imagen de la variante elegida o la portada del producto. También podés ampliar una única foto. El visor ocupa toda el área de video, con fondo oscuro y la imagen completa en su proporción original. Cuando hay varias fotos, las flechas izquierda y derecha permiten recorrerlas. **Atrás** devuelve el foco al botón que abrió el visor y conserva la variante elegida.

**Elegir opciones** abre los detalles. Con una sola opción disponible aparece **Ver detalles**. Las flechas verticales recorren los controles y las horizontales recorren los valores de una opción. OK confirma una combinación disponible del catálogo. Los botones principales, como **Agregar al carrito**, tienen fondo blanco y texto oscuro, también cuando la campaña especifica un color de marca.

El carrito muestra el artículo, su variante y el total. Solo **Continuar con el QR** solicita el QR a Shopify a través del endpoint de iADServer. La petición contiene el ID de la variante confirmada. Atrás cierra el QR y cancela una solicitud pendiente.

La ficha lee `commerce.imageUrl`, `images` (URLs HTTPS), `description` y `previousPrice`. Cada variante puede incluir `selectedOptions: [{ name, value }]`, `imageUrl` y `availableForSale`. Acepta hasta 2048 variantes. Cuando la ficha recibe un catálogo sin opciones estructuradas o con combinaciones ambiguas, muestra las variantes individuales con sus etiquetas originales.

### Compra durante un spot VAST

En el callback de inicio del **spot que se está presentando**, obtené `creativeId` y `deliveryId` de su elemento VAST `Extension[type="iADServerShop"]/Shop`. También podés usar el `Creative@id` reproducido y la ID de entrega de la URL de impresión de ese mismo anuncio (`/events/{deliveryId}/impression`). Pasá ambas claves al componente y al lector del mismo tag y sesión de reproducción.

```brightscript
spot = { creativeId: creativeID, deliveryId: deliveryID }
m.il.callFunc("setLinearAd", true, spot)
m.feedRevision += 1
m.feed.request = {
    kind: "json", url: playback.overlayFeedUrl, sessionId: m.ilSession, revision: m.feedRevision,
    programTimeMs: m.il.callFunc("getProgramTimeMs"), commerce: true, locale: "es", linearSpot: spot
}
m.feed.control = "run"
```

En cada cambio de spot repetí la vinculación con la identidad del nuevo anuncio. Al cargar el resultado comprobá la sesión y la revisión como en el ejemplo de lectura del endpoint. Conservá el reloj de programa de esa sesión mediante `setClockAnchor` cuando corresponda. El lector agrega `scene=1`, `commerce=1`, `shop_midroll=1` y las dos claves. Un cue `midroll` presenta **Comprar** únicamente durante la entrega vinculada y dentro de su intervalo. El reproductor conserva la reproducción del spot y la medición de VAST.

Al finalizar el corte, incrementá la revisión del lector y llamá a `m.il.callFunc("setLinearAd", false, invalid)`. Para un spot sin identidad de compra podés pasar `true, invalid`: el corte conserva la supresión de gráficas de programa.

## Plan de anuncios

Para leer el plan de IL y mostrar cortes, gráficas y productos, seguí la [guía de SDK nativos](../docs/native-ad-plan-matrix.md). Indica qué formato falta probar en un dispositivo.

### Pedir el plan desde el canal

`loadPlan` pide `GET <origen>/il-player/app-plan?project=…&asset=…&app=roku:<id>` en un `Task` HTTPS (el mismo `ILOverlayFeedRequest`, con el certificado `common:/certs/ca-bundle.crt` y un límite de 5 segundos), lo adjunta y lo arranca. Iniciá el contenido cuando `contentReady` sea verdadero. El campo `planUrl` guarda la URL del primer pedido, que no lleva grant. Ningún evento ni campo publica `grant`, `renew`, `commerce.url` ni `commerce.break_url`.

```brightscript
m.il.callFunc("attach", m.video, m.viewId)
m.plan = m.video.getParent().createChild("ILAdPlanPlayer")
m.plan.observeFieldScoped("contentReady", "onContentReady") ' m.video.control = "play"
m.plan.observeFieldScoped("event", "onPlanEvent")
m.plan.callFunc("loadPlan", m.il, m.video, m.viewId, "https://<consola>", projectId, assetId, "es", consent)
```

- **`app=`.** Un canal instalado en modo desarrollador envía `roku:dev`. Uno publicado envía `roku:<id del canal>` de `roAppInfo.GetID()`. Registrá ese valor como app Roku del proyecto en la Console.
- **204.** No hay plan por ahora (o se alcanzó un límite): el contenido arranca sin anuncios y el componente no reintenta. La próxima vista vuelve a pedir.
- **404, error de red o tiempo agotado.** El contenido arranca sin anuncios. El evento `{ type: "plan_unavailable", status, app, reason }` trae el `app=` que se envió o se habría enviado (`reason` siempre es texto: `"app_id"` si el id del canal no tiene un formato que IL registre, `"request"` si el pedido se rechazó localmente, `"timeout"`, `"network"`, `"http_<código>"` (por ejemplo `"http_404"`), `"stitched"` para un 200 con el plan de un proyecto con inserción en servidor (trae `timeline`, que los lectores nativos todavía rechazan) o `"invalid"` para cualquier otro 200 ilegible; `status` es el número, 0 sin respuesta): un 404 es la misma respuesta para proyecto, video o app desconocidos, así que revisá primero el registro de la app. `status` es 0 cuando no hubo respuesta.
- **Sesión.** Con `loadPlan` el `sid` de iADServer es `commerce.session` del plan, y `m.viewId` sólo identifica la vista en el overlay.
- **Versión 2.** Un plan `version: 2` (aprobación de formato nativo de Google Ad Manager) se acepta sólo con `native_gam.contract = "native-gam-plan-v1"` y `expires_at` a no más de 120 000 ms (120,5 s se rechaza). Antes de vencer, el componente vuelve a pedir (hasta tres intentos: a `expires_at` − 20 s, − 12 s y − 5 s, hasta el primero que funcione; un intento atrasado sale enseguida si todavía falta para `expires_at`, y si ya no queda tiempo no se envía y cuenta como el último fallo) con `&renew=<grant>` (el parámetro `grant` de `commerce.url`) y reemplaza el plan sin perder lo ya mostrado, intentado y cerrado, los contadores de pacing ni la sesión de compra. Las ventanas y cortes salen del plan nuevo, y se retira la gráfica en pantalla cuya ventana ya no está. El evento es `{ type: "plan_renewed", version }`. Si la respuesta es `version: 1`, la aprobación terminó: se adopta y no se programan más renovaciones. Una respuesta `version: 2` a un plan v1 sí programa la siguiente. El vencimiento se compara en milisegundos. Si fallan los tres intentos, emite una sola vez `{ type: "plan_renew_failed", status, reason }` con el motivo del último, y al llegar a `expires_at` el plan deja de usarse, emite `{ type: "plan_expired" }` y el contenido sigue (un corte en curso devuelve el contenido).
- **`replacePlan(plan)`.** Un host que obtiene el plan por su cuenta lo renueva con `m.plan.callFunc("replacePlan", planNuevo)`, con el mismo efecto. Devuelve `false` si el plan no es válido y conserva el actual.

### Comprar durante un corte con `commerce.break_url`

Si el plan trae `commerce.break_url` (HTTPS, mismo origen que `commerce.url`) y el `sid` es la sesión del plan, el componente pide la ficha él mismo cuando empieza un anuncio con `Ad@id` `il-shop-<preroll|midroll>-<entrega>` de la posición del corte, `Creative@id` y un tag de iADServer. Agrega `cut`, `tag`, `creative`, `delivery` y `locale` a la URL tal cual. Sin ese prefijo no hay producto ni llamada. **Comprar** se dibuja durante ese anuncio y se retira al completarse, saltearse, cerrarse o fallar. La impresión es la del VAST; `commerce.viewUrl` sale por `productView` cuando el espectador abre la ficha, como en las demás fichas. El campo `linearSpot` sigue publicándose para los hosts que leen el feed de la sesión; con `break_url` no hace falta leerlo. El `Ad@id` se lee del campo opcional `adId` de la [estructura de anuncio de RAF](https://developer.roku.com/docs/developer-program/advertising/integrating-roku-advertising-framework.md), que también lista `creativeId` y `creativeAdId`. Roku no dice explícitamente que `adId` sea el `Ad@id` del VAST. Si el anuncio no trae un `adId` `il-shop-…`, el componente toma la entrega de la URL de impresión de iADServer (`https://ads.iadserver.com/events/{entrega}/impression`, 43 caracteres), el `creativeId` de RAF y la posición del corte, y pide la ficha igual: IL responde 204 a todo lo que no sea una entrega con compra de esa sesión y ese tag. Los anuncios de otros servidores no generan llamadas. En un equipo real se espera cualquiera de las dos ramas; ninguna se ejecutó en un Roku.

### Cortes del host (API nativa)

> **Para que haya Comprar, adjuntá con `plan.commerce.session` como `sessionId`** (en `attach` del overlay y en `attachPlan`). Es el `sid` de cada `ad_tag_url` estable y la sesión que nombra el grant de `break_url`. Con otra clave el componente emite una vez `{ type: "buy_unavailable", reason: "session" }` y no muestra Comprar durante los cortes.

Cuando el canal reproduce sus propios cortes con el API por corte de IL (playback creado con `"graphics": true`), el plan del host trae `cuts: []` y el componente no pide ni reproduce anuncios. El canal tiene que informar:

```brightscript
' El plan del host: GET /v1/vod/playbacks/{id}/plan, desde tu backend. Su commerce.session es el sid de cada
' ad_tag_url estable: usalo como clave de la vista para que haya Comprar.
key = plan.commerce.session
m.il.callFunc("attach", m.video, key)
m.plan.callFunc("attachPlan", m.il, m.video, key, plan, "https://<consola>", "es", consent)
m.plan.callFunc("setBreaks", [58000, 178000])      ' posiciones de contenido en ms
m.plan.callFunc("startPlan")

' Al empezar el corte en 58 s (0 para el pre-roll):
m.plan.callFunc("breakStarted", 58000)
' En el callback de seguimiento de tu RAF, evento "Impression":
m.plan.callFunc("adStarted", adTagUrl, ctx.ad)     ' adTagUrl = el ad_tag_url que pediste
' En "Complete", "Skip", "Close" o "Error":
m.plan.callFunc("adEnded")
' Al volver al contenido:
m.plan.callFunc("breakEnded")
```

**Separación alrededor de tus cortes.** Las ventanas del plan del host sólo están separadas de los cortes que IL ubicaría, no de los que reproduce el canal. El componente aplica `scenes.pacing.cut_clearance_seconds` (y la del producto) alrededor de cada posición informada con `setBreaks` o, si faltó, con `breakStarted`. Sin cortes informados no hay separación: informarlos antes de que lleguen es obligación del canal.

**Sin `break_url`.** Un plan del host trae `commerce.break_url` sólo si el playback se creó con `"graphics": true` y recorre pasos ordenados. Sin ella no hay Comprar durante los cortes ni ninguna llamada; el resto funciona igual.

**Identidad de la app en Google Ad Manager.** El plan de una app no trae `page_url`, y el componente nunca agrega `url` ni `description_url` para un canal. Tampoco agrega `msid` ni `an`: Google los recomienda para CTV pero no define el formato para Roku, y no se pudo confirmar en la documentación de RAF qué macros de identidad del canal expande. Si tu acuerdo con Google los pide, deben venir ya en los tags del proyecto.

Mientras el corte está activo no se dibuja nada de IL salvo **Comprar**, y las respuestas pendientes de gráficas se descartan, igual que en los cortes propios del componente. La ficha se pide con `cut=at-<ms>` (redondeado al milisegundo). Una posición negativa, NaN o infinita emite `{ type: "break_refused", reason: "position" }` y no hace nada más. Durante un corte del host el componente nunca toca la visibilidad ni la reproducción del `Video`, tampoco en `stopPlan` o en un nuevo `loadPlan`.

**Red de seguridad.** Si el canal no llama a `breakEnded`, a los 130 segundos (el mismo límite que los cortes propios) el componente da el corte por terminado, emite `break_error` con el `cut` y vuelve a dibujar gráficas. No te apoyes en esto: avisá siempre el fin del corte. **Obligación del canal:** si no informa los cortes, el componente no puede saber que hay un anuncio en pantalla. Dibuja las gráficas sólo por el tiempo de contenido, sin Comprar, y puede dibujarlas encima de un corte que el canal no avisó.

`setClock(segundos)` fija la hora del componente y existe para las pruebas.
