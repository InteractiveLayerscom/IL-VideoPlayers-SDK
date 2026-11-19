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
