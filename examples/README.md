# Prueba con HLS propio

Con Node.js y FFmpeg, este comando genera un video de prueba de 18 segundos con audio, segmentos HLS, un PNG y un JPEG. La URL debe corresponder al directorio donde vas a servir estos archivos mediante HTTPS.

```sh
node examples/make-hls.mjs /tmp/il-prueba https://tu-origen.example/prueba/
```

Abrí `il.m3u8` en la app con el adaptador instalado. Entre 0:03 y 0:07 aparece una banda turquesa sobre el video. Entre 0:10 y 0:15 el video ocupa el 75 % superior izquierdo y aparece el arte en los dos márgenes. Desde 0:15 el video vuelve al tamaño original. Conservá la misma instancia de reproducción y comprobá la continuidad del audio. El directorio también contiene `base.m3u8`, que permite comparar la salida original.

`shaka-native.m3u8` muestra los mismos anuncios con la extensión de interstitials que interpreta Shaka 5.3.5. Está destinado a Shaka con contenedores de anuncios y lectura del manifiesto habilitadas. Para un mismo espectador elegí un manifiesto y un único camino de decisión. Los recursos del ejemplo se generan localmente y la prueba no tiene trackers ni tags comerciales.

Para comprobar medición en una integración de prueba, agregá `X-IL-IMPRESSION-URI` apuntando a tu propio colector HTTPS. Registrá una impresión después de cargar y presentar la imagen. Un salto que pasa por encima de una ventana debe producir cero impresiones. En recepción de un corte lineal se debe retirar el gráfico. La revisión final incluye la imagen visible y la restauración en cada modelo de TV que vaya a distribuir la app.

La página de referencia `examples/shaka.html` ya conecta el SDK al AdManager. Ejecutá `npm ci`, generá el fixture y serví el checkout como archivos estáticos. Abrí `/examples/shaka.html?src=URL_CODIFICADA_DEL_HLS` y presioná reproducir. Con el fixture en `examples/fixture/` también funciona el valor predeterminado. Si los medios se sirven desde otro origen, habilitá HTTPS y CORS para manifiestos y segmentos.
