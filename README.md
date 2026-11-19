# InteractiveLayers Player SDK

Este SDK permite a una app de un publisher mostrar publicidad contextual durante la reproducción de HLS. Un **súper** se dibuja sobre el programa. En una **L**, la imagen del programa ocupa el 75 % superior izquierdo y la creatividad aparece en los márgenes derecho e inferior. El audio y la sesión de reproducción continúan.

InteractiveLayers Console conserva la conexión al ad server del proyecto. El backend identifica el tramo que realmente se está emitiendo, consulta esa conexión y entrega al player una creatividad con su horario. El SDK se instala una vez en la aplicación. Un cambio de campaña se administra en el ad server.

| App del publisher | Integración disponible |
| --- | --- |
| Web con Shaka | Interstitials y composición propios de Shaka. [Guía Shaka](web/README.md#shaka) |
| Android TV, Google TV, Fire TV y Android con Media3 | Módulo Android sobre la instancia existente de ExoPlayer. [Guía Android](android/README.md) |
| Apple TV e iOS con AVPlayer | Swift Package con colector HLS y vista de presentación. [Guía Apple](apple/README.md) |
| Roku nativo | Componente SceneGraph para el nodo de video de la app. [Guía Roku](roku/README.md) |
| Samsung Tizen con AVPlay | Adaptador JavaScript que ajusta la ventana nativa y el objeto HTML. [Guía Samsung](web/README.md#samsung-avplay) |
| Video.js en web o LG webOS | Adaptador sobre la instancia Video.js y su tecnología HTML5. [Guía Video.js](web/README.md#videojs) |
| HTML5 en una app de TV | Adaptador para el elemento de video y su contenedor. [Guía HTML5](web/README.md#html5) |

## Señal y reproducción

El backend puede entregar la oportunidad mediante una etiqueta HLS `EXT-X-DATERANGE` o un endpoint JSON de la sesión del espectador. Ambos transportan el mismo ID, horario y recurso. Usá el endpoint por sesión para decisiones personalizadas si el playout entrega un manifiesto compartido. Los tiempos se comparan con el cabezal real de reproducción. Una oportunidad vencida, una gráfica sin entrega o la falta de reloj dejan el programa en pantalla completa. [Contrato de señales](docs/signals.md)

En Teinformas, Eyevinn genera el programa y GAM administra las campañas. En el piloto FAST, MediaTailor es el punto de inserción de los spots de preroll y midroll. Los adaptadores de este repositorio presentan la L y el súper en el dispositivo. [Cómo se conecta Teinformas con GAM](docs/teinformas.md)

## Probar la integración

El generador incluido produce un HLS de 18 segundos y ambas creatividades a partir de un patrón de prueba. Sirve para validar que el gráfico aparece en la ventana prevista, el audio continúa, el video vuelve a su tamaño y no se duplica la impresión. [Prueba reproducible](examples/README.md)

Los ejemplos web se importan como módulos ES. Para plataformas nativas, las guías indican cómo agregar el módulo Gradle, el Swift Package o el componente SceneGraph al proyecto del publisher. La distribución se realiza desde este repositorio privado. Las pruebas de módulos y simulación están documentadas en cada guía. La homologación de cada modelo de TV requiere reproducir el stream en ese dispositivo.

## Qué se verificó

| Plataforma | Evidencia de esta versión |
| --- | --- |
| Shaka 5.3.5 | El paquete real creó y retiró las dos gráficas en un DOM de prueba, aplicó el squeeze y conservó el mismo video. La prueba también ejercitó el parser de la L nativa de Shaka. |
| Android Media3 1.6.0 | ExoPlayer reprodujo HLS en un emulador Android 15. Las pruebas instrumentadas comprobaron geometría, restauración y recepción de la solicitud de impresión por HTTPS local. |
| AVPlayer | AVPlayer reprodujo HLS en macOS, leyó las dos marcas y confirmó su posición después de tres saltos. UIKit se probó en Mac Catalyst. Se compiló para iOS y tvOS. |
| Roku | BrighterScript validó los componentes y el intérprete ejecutó las pruebas de marcas, reloj, cortes y geometría. |
| Video.js, AVPlay y HTML5 | Los adaptadores se probaron con un DOM de prueba y dobles de las APIs de plataforma. Queda por comprobar la salida de video en los televisores objetivo. |
