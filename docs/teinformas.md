# Cómo conecta Teinformas FAST su GAM con los players

La demo web de Teinformas tiene una publicación que identifica el proyecto IL y su integración GAM. El publicador comprueba que `/v1/vod/gam-profiles/default` esté habilitado y conectado mediante OAuth, y que coincidan la red y la unidad de inventario. Esa publicación usa `teinformas_demo_testing` para video y `teinformas_contextual_display` para el banner web con GPT.

## Qué viaja por cada conexión

| Momento | Responsable | Entrada y salida |
| --- | --- | --- |
| Al aire | Eyevinn e IL | La variante HLS identifica la nota y el segmento emitido. IL cruza el PDT con el análisis de contexto y Content Safety. |
| Entrada del espectador o corte | Backend del piloto, GAM y MediaTailor | El backend toma el perfil de la emisión. Para Teinformas solicita un VAST al GAM seleccionado con el contexto de entrada o del tramo anterior al corte. MediaTailor puede acondicionar e insertar el spot en el HLS de esa sesión. |
| Súper o L | GAM, backend y SDK | El backend necesita una respuesta gráfica para esa oportunidad. Publica el recurso resuelto, el intervalo y la medición en el endpoint de sesión o en una variante personalizada. El SDK lo presenta y restablece el video al vencer. |
| Impresión | Player y ad server | El player observa la presentación y el responsable de medición envía el beacon. El ad server registra la campaña y creatividad. |

La app recibe el HLS final de reproducción y, si se eligió la vía individual, el endpoint gráfico y el identificador de la sesión. No necesita la API key de Console ni OAuth del ad server. El backend puede crear un identificador de reproducción, pasarlo como `adsParams.il_sid` al iniciar la sesión de MediaTailor y configurar `[player_params.il_sid]` en el tag del ADS. Entrega ese mismo `sid` al SDK. Así se correlacionan spots y gráficas aunque el reloj del vivo esté retrasado en la TV. En la respuesta de inicialización de MediaTailor, `manifestUrl` y `trackingUrl` pertenecen a esa sesión. Fechas, segmentación y creatividades siguen en GAM. [Variables para el ADS](https://docs.aws.amazon.com/mediatailor/latest/ug/variables-player.html) · [Tracking por sesión](https://docs.aws.amazon.com/mediatailor/latest/ug/ad-reporting-client-side.html) [Flujo de MediaTailor](https://docs.aws.amazon.com/mediatailor/latest/ug/what-is-flow.html)

## Reutilización de Console

Para una emisión registrada, el backend puede leer `GET /v1/vod/airings/{airing_id}` y recuperar su `provider` y `ad_profile_id`. Luego verifica `GET /v1/ad-providers/{provider}/profiles/{ad_profile_id}`. La credencial es de lectura y pertenece al proyecto. En la publicación anterior de Teinformas se identifica de forma explícita la integración GAM y se usa el perfil `default` que verificó su publicador. Un perfil desconectado o una unidad diferente dejan la oportunidad sin entrega.

El puente del piloto de Teinformas implementa GAM. En otros proyectos, iADServer también puede devolver un tag según el inventario vinculado. SpringServe expone señales de corte con candidatos para el integrador SSAI. Cada conexión necesita su recorrido de entrega hasta obtener una creatividad. El contrato que recibe la aplicación es el mismo. Un cambio de proveedor en una emisión tiene prioridad y evita utilizar automáticamente el antiguo tag GAM.

## Qué necesita validación comercial y técnica

La unidad GPT sirve un banner en la página web del piloto. Para TV se necesita una respuesta compatible con la app. La primera versión admite un recurso estático PNG/JPEG y una URL de impresión opcional. Una creatividad HTML en un iframe o un VAST lineal de video requieren otro formato de entrega. El prototipo de Teinformas acepta para la gráfica un VAST inline `NonLinearAds` con `StaticResource`. Los tags gráficos dedicados y su elegibilidad deben validarse en el inventario del publisher. Los parámetros CTV `ott_placement=4` para L y `5` para overlay describen el placement. [Parámetros de Google Ad Manager para CTV](https://support.google.com/admanager/answer/15788066)

MediaTailor ofrece además su propio flujo de overlays para vivo con un marcador SCTE-35 de tipo `0x38`, una respuesta VAST no lineal y tracking del lado del cliente. Si se adopta ese flujo, el backend y la app deben mapear la oportunidad al tracking de la misma sesión y elegir un solo responsable del render y del beacon. Un `CUE-OUT` de preroll o midroll representa otro tipo de oportunidad. La variante por sesión evita enviar una decisión personalizada a todos los que miran el origen común. [Overlays en AWS MediaTailor](https://docs.aws.amazon.com/mediatailor/latest/ug/overlay-ads.html)

Para aceptar la demo en vivo, abrí el canal en Turismo y dejá la misma sesión hasta Ciclismo. Identificá el preroll y el midroll en la respuesta de GAM y el HLS de sesión, y verificá la L y el súper en pantalla con sus impresiones. El generador incluido permite hacer primero la prueba de gráficos sin contactar al ad server. [Prueba de gráficos local](../examples/README.md)
