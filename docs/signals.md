# Contrato de la gráfica

La clase HLS de InteractiveLayers es `com.interactivelayers.overlay`. Se publica en la **media playlist** con un `EXT-X-PROGRAM-DATE-TIME` válido. Todas las variantes que puedan elegirse en una misma sesión deben llevar los mismos eventos. Un cue completo tiene ID único en la sesión, comienzo, duración o fin, formato y URL de la imagen. El recurso puede ser PNG o JPEG con URL HTTPS absoluta.

```m3u8
#EXT-X-PROGRAM-DATE-TIME:2026-11-19T12:00:00Z
#EXT-X-DATERANGE:ID="aire-42-ele-1",CLASS="com.interactivelayers.overlay",START-DATE="2026-11-19T12:00:08Z",DURATION=5,X-IL-FORMAT="l",X-ASSET-URI="https://creativos.example/ele.jpg",X-ASSET-MIMETYPE="image/jpeg"
```

| Atributo HLS | Campo JSON | Valor |
| --- | --- | --- |
| `ID` | `id` | Identificador estable de la exhibición. Una repetición editorial usa un ID nuevo. |
| `START-DATE` | `start` | ISO 8601 con zona en HLS. Milisegundos Unix en JSON. |
| `END-DATE` o `DURATION` | `end` | Fin exclusivo. La duración HLS se expresa en segundos. Cuando llegan ambos deben coincidir. |
| `X-IL-FORMAT` | `format` | `super` o `l`. |
| `X-ASSET-URI` | `imageUrl` | URL final de los píxeles de la creatividad. |
| `X-ASSET-MIMETYPE` | `mimeType` | `image/png` o `image/jpeg`. Declaralo en URLs firmadas sin extensión. |
| `X-IL-IMPRESSION-URI` | `impressionUrl` | URL HTTPS opcional de una impresión. Cada integración debe tener un solo responsable de enviar ese evento. |

## Eventos por sesión

El player consulta el endpoint que le entrega el backend de reproducción con `time` en milisegundos Unix del fotograma actual y `sid` de la sesión. Devuelve `[]` si no hay entrega. Una oportunidad individual puede tener este formato.

```json
[{"id":"aire-42-ele-1","format":"l","start":1795089608000,"end":1795089613000,"imageUrl":"https://creativos.example/ele.jpg","mimeType":"image/jpeg"}]
```

En ambos transportes el backend publica como máximo una gráfica a la vez, con el intervalo recortado a contenido elegible y sin solaparla con un spot de esa sesión. El player debe recibir las entradas y salidas de los cortes lineales cuando el SSAI los inserta por espectador. Al entrar al canal, cambiarlo o destruir el player, la app debe iniciar o cerrar también la sesión de gráficos. Cuando el host suministra el reloj, debe invalidar el ancla al cambiar de medio o ante una discontinuidad y recuperarla del segmento reproducido.

El súper usa una caja de 75 % de ancho y 20 % de alto a partir de (12,5 %, 70 %). La L usa un lienzo 16:9 con el arte en la derecha y abajo. El video mantiene su relación de aspecto. El publisher controla títulos, subtítulos, área segura y controles accesibles en el diseño final.

La impresión corresponde a la gráfica presentada. El pedido, la recepción de VAST y la descarga de la imagen son pasos anteriores. El SDK expone el evento o envía el beacon según la plataforma y la configuración. Un ID se contabiliza una vez por sesión, incluso al retroceder. Verificá el recibo en el colector de prueba, y luego la contabilización en el ad server elegido.

Shaka también interpreta su perfil nativo con `CLASS="com.apple.hls.interstitial"`, `X-OVERLAY-ID` y geometría. Usá esa variante únicamente en reproductores que conozcan esas extensiones. Son distintas de las marcas lineales SCTE-35. [Sintaxis HLS de fechas](https://www.rfc-editor.org/rfc/rfc8216#section-4.3.2.7) · [Parser de Shaka](https://shaka-project.github.io/shaka-player-release/docs/api/lib_ads_hls_interstitial_parser.js.html)

## Compra con Shopify

Los reproductores que habilitan la oferta comercial agregan `commerce=1` y `locale` al endpoint JSON por sesión. Pueden enviar `country` con el código ISO 3166-1 alfa-2 del mercado. Los idiomas de los controles son `es`, `en` y `pt-BR`. El servicio provee el contenido del producto en el idioma y la moneda disponibles para ese mercado.

Un cue comercial puede acompañar una gráfica `l`, `super` u `overlay`, o un spot vinculado con formato `midroll`. La tarjeta `overlay` usa el 30 % del ancho y el 32 % de la altura a partir del 64 % hacia la derecha y el 10 % hacia abajo. El manifiesto HLS puede entregar las gráficas convencionales por su contrato habitual. El catálogo, las variantes y el acceso al carrito se entregan al reproductor en la respuesta de su sesión.

```json
{
  "id": "offer-1",
  "format": "overlay",
  "start": 1795089608000,
  "end": 1795089638000,
  "imageUrl": "https://media.example/producto.jpg",
  "impressionUrl": "https://ads.example/events/delivery/impression",
  "commerce": {
    "title": "Botines",
    "price": "89.00",
    "currency": "USD",
    "locale": "es",
    "description": "Botines de cuero",
    "images": ["https://media.example/frente.jpg", "https://media.example/perfil.jpg"],
    "variants": [
      {"id": "42", "label": "Talle 42", "price": "89.00", "availableForSale": true, "selectedOptions": [{"name":"Talle","value":"42"}]},
      {"id": "43", "label": "Talle 43", "price": "89.00", "availableForSale": false, "selectedOptions": [{"name":"Talle","value":"43"}]}
    ],
    "handoffUrl": "https://ads.example/commerce/offer/delivery",
    "viewUrl": "https://ads.example/events/delivery/creativeView"
  }
}
```

El SDK hace un GET a `viewUrl` una vez por cue al abrir la ficha. En Roku, el host lo envía a partir del campo `productView`. La impresión sigue el evento de presentación de la gráfica. Cuando el espectador pulsa el botón de compra, el SDK hace un POST JSON a `handoffUrl` con `{"variantId":"42"}`. La respuesta incluye `continueUrl` y `qrImageUrl`, ambas HTTPS. Los reproductores TV muestran el PNG del QR. Navegadores y apps móviles abren el enlace de continuación con la variante elegida. El servicio de anuncios administra la duración y vinculación del enlace. Configurá una ventana de exhibición que permita navegar con el control y escanear el QR.

El endpoint web debe permitir los orígenes habilitados mediante CORS, incluido el preflight de POST con `Content-Type: application/json`. Publicá la respuesta de sesión y los enlaces de compra por HTTPS. Las integraciones del SDK solo usan el contrato de anuncios. La sesión de checkout y las credenciales corresponden al backend.

La portada de TV puede mostrar `vendor`, `description`, las opciones disponibles y el precio inicial del catálogo. La galería usa `images`. Las fotos de la ficha, el resumen y el pago siguen `variants[].imageUrl`, con la portada del producto como alternativa. Cada combinación conserva su ID de Shopify, opciones, precio y disponibilidad. `variants[].previousPrice` indica el precio anterior de ese SKU en la moneda del mercado. Las ofertas anteriores que solo incluyen `label` se muestran como una lista de variantes. La identidad visual de la tienda se entrega en `cue.brand` con `accent`, `background`, `foreground` y `logoUrl`. En Smart TV, las acciones principales de compra tienen fondo blanco y texto oscuro. El visor de fotos ocupa la pantalla del reproductor y conserva la variante al volver.

### Tienda vinculada a un midroll

Activá la tienda en la escena de video del editor, publicá esa versión y vinculá el producto Shopify de la campaña con formato `midroll`. Para esa entrega el VAST incluye `<Extension type="iADServerShop"><Shop deliveryId="…" creativeId="…"/></Extension>`. El host inicia y termina la interacción según el spot que se está reproduciendo.

El feed JSON de la misma sesión recibe `scene=1`, `commerce=1`, `shop_midroll=1`, `midroll_creative_id` y `midroll_delivery_id` además de los parámetros habituales del tag. El cue de respuesta tiene `format: "midroll"`, `id` igual a la entrega VAST y `linearCreativeId` igual a la creatividad. El SDK verifica ambas identidades y muestra la entrada a la tienda sobre el video del host. La impresión pertenece a VAST. Al terminar o cambiar el spot, el SDK retira su tienda y descarta respuestas pendientes.

## Escenas de creatividades

El SDK agrega `scene=1` al endpoint JSON de sesión para recibir escenas. La negociación de escenas es independiente de `commerce=1`. Web y Media3 la incluyen en sus clientes de sesión, y el Task JSON de Roku hace lo mismo. En AVPlayer, aplicá `ILOverlayPlayerView.scenesFeed` o `commerceFeed` al endpoint antes de agregar el reloj y la sesión. Los clientes que leen HLS mantienen el contrato de imagen de la playlist.

Los clientes actualizados envían `scene_features` con capacidades separadas por comas. `video` indica que el host admite un segundo decodificador, `audio` autoriza el sonido cuando el inventario lo permite, `media-mask` anuncia máscaras rectangulares, redondeadas y elípticas, `media-crop` anuncia encuadre de medios, y `rich-style` indica compatibilidad con efectos y tipografía del compositor web. Los hosts con capacidades de composición limitadas pueden recibir recursos de decoración alternativos. Los datos y las acciones de cada producto conservan su identidad.

Un cue de escena conserva su ID, formato y ventana, y agrega `scene` con `format`, `width`, `height`, `durationMs` y `layers`. Puede incluir `imageUrl` y `mimeType` como alternativa estática. Las capas llegan en orden de composición desde el fondo, con coordenadas absolutas en píxeles de la escena. El SDK evalúa sus intervalos y sus fotogramas clave con el reloj del contenido. El formato `l` se recorta a las bandas derecha e inferior. `layout: "overlay"` mantiene el tamaño del programa. `layout: "squeeze_back"` aplica la reducción de la L y restaura el rectángulo de video al retirar el cue.

Las capas de imagen y video pueden incluir `mask` (`rect`, `rounded` o `ellipse`) y `mediaCrop`. La máscara redondeada toma `radius` en píxeles de autoría, con 12 como valor por defecto. `mediaCrop` escala el medio centrado después de aplicar `fit`. El zoom va de 1 a 4. Cada coordenada de desplazamiento va de −1 a 1 y multiplica la mitad del exceso de tamaño causado por el zoom en su eje. El póster y el video usan el mismo encuadre.

El servidor expande las tarjetas repetibles y entrega una lista `products` con ID, foto, precio, variantes y enlaces propios de cada oferta. Una capa con `action: "product"` abre `products[productIndex]`. La ficha usa la foto, el enlace de vista y el destino del producto seleccionado. El POST al carrito conserva el cuerpo `{"variantId":"..."}` y se dirige al `handoffUrl` de esa oferta. El SDK mide una apertura por producto y conserva una impresión por cue. `brand` admite `logoUrl`, `accent`, `background` y `foreground` para la ficha. Roku expone los enlaces de marca validados mediante el campo `sceneLink` para que la aplicación maneje su destino.

Un video secundario sigue el tiempo de la escena y se inicia silenciado por defecto. El SDK solo reproduce audio si el cue incluye `audio: true` y el host lo habilita. Si el navegador bloquea la reproducción audible, el clip se vuelve a intentar sin sonido. El póster conserva el encuadre, la animación y las áreas de interacción durante la carga y ante un error de decodificación.

| Host | Configuración del video secundario y del audio |
| --- | --- |
| HTML5, Video.js y Shaka | Video habilitado por defecto. Usá `secondaryVideo: false` si el dispositivo debe preservar su único decodificador y `secondaryVideoAudio: true` para permitir audio. |
| AVPlay | Presenta el póster por defecto. Habilitá `secondaryVideo: true` en equipos que acepten un segundo video HTML sobre el plano nativo. |
| Media3 | Habilitá `setSceneSecondaryVideoEnabled(true)`. Para permitir audio, llamá además a `setSceneSecondaryVideoAudioEnabled(true)`. |
| AVPlayer | Configurá `allowsSecondaryVideo` y `allowsSecondaryVideoAudio` en la vista y usá los mismos valores en los argumentos `secondaryVideo` y `audio` de `scenesFeed` o `commerceFeed`. El host sigue siendo dueño de la sesión y las peticiones al feed. |
| Roku | Presenta el póster aprobado y aplica el encuadre dentro de un recorte rectangular. |

Android y Apple pueden mostrar el primer fotograma de un GIF usado como recurso de escena. Las alternativas de imagen del cue admiten PNG y JPEG.

La disponibilidad de fuentes y efectos gráficos depende de la plataforma. Roku usa fuentes de sistema y muestra relleno sólido en equipos sin el nodo Effect. La rotación del arte en Roku depende de las capacidades gráficas del equipo. [SceneGraph Group](https://developer.roku.com/dev/docs/group) · [SceneGraph Effect](https://developer.roku.com/dev/docs/effect)

### Verificación del SDK

| Integración | Verificación |
| --- | --- |
| HTML5 | Pruebas de sesión y compra con DOM simulado. Chrome reprodujo dos MP4 locales y mostró la máscara elíptica con el mismo encuadre en el video y el póster, a tiempos fijos de la escena. |
| Video.js y webOS, AVPlay, Shaka | Pruebas de la escena compartida con adaptadores simulados. Shaka también tiene una prueba del AdManager real para imágenes heredadas. |
| Media3 | Pruebas unitarias y de la app en Android API 35. Se comprobó el póster con el segundo decodificador habilitado, el recorte, la pausa y el carrito para la segunda tarjeta. |
| AVPlayer | Pruebas de contrato en macOS y compilación para los targets de simulador iOS y tvOS. |
| SceneGraph | Compilación de BrighterScript y ejecución de la escena de referencia, incluido el encuadre del póster, en el intérprete BrightScript. |

Las pruebas forman parte de `npm test`, `gradle -p android testDebugUnitTest connectedDebugAndroidTest`, `swift test` y `./roku/verify.sh`. Queda pendiente verificar la reproducción y el control remoto en televisores físicos y en dispositivos iOS o tvOS.
