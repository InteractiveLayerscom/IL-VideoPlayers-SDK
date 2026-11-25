# Ejemplo nativo de Android: plan de IL

La app más chica que muestra las dos formas de usar el plan de anuncios de IL en Android. Una sola app trae una entrada para el lanzador del teléfono y otra para el de Android TV.

- **`load`:** el SDK pide el plan a la consola (`GET /il-player/app-plan … app=android:com.interactivelayers.example`).
- **`host`:** la app juega sus propios cortes. Un relay (`examples/api-relay.mjs`) hace de backend del cliente: `POST /playback` devuelve `{playback_id, plan}` y `POST /break` devuelve la respuesta del corte (`ad_tag_url`). El anuncio está **simulado**: el contenido se pausa `adSeconds` y la app informa `breakStarted`, `adStarted(adTagUrl, adId, creative)`, `adEnded` y `breakEnded`. Una app real informa lo que dice su SDK de anuncios (IMA: `Ad.getAdId()` y `Ad.getCreativeId()`).

La app no tiene credenciales: la clave de API vive sólo en el entorno del relay. Todas las direcciones son extras del intent, ninguna está en el código.

## Compilar

Necesitás JDK 17, Gradle 9 y el Android SDK 35 (`ANDROID_HOME`).

```sh
cd examples/android
gradle assembleDebug
```

Para probar contra un servidor HTTPS local con un certificado propio, pasá su CA. Sólo la build debug confía en ella y sólo para ese host (por defecto `10.0.2.2`, la Mac vista desde el emulador). La regla HTTPS del SDK no cambia.

```sh
gradle assembleDebug -PilDevCa=/ruta/ca.pem -PilDevHost=10.0.2.2
```

Registrá `android:com.interactivelayers.example` como app del proyecto en la Consola, o `load` va a recibir 404.

## Correr

```sh
adb install -r build/outputs/apk/debug/ILNativePlanExample-debug.apk

# (1) load
adb shell am start -n com.interactivelayers.example/.MainActivity --es mode load \
  --es origin https://<consola> --es project <proj> --es asset <asset> --es video https://<contenido>.mp4

# (2) cortes de la app
adb shell am start -n com.interactivelayers.example/.MainActivity --es mode host \
  --es origin https://<consola> --es relay https://<relay> --es asset <asset> --es video https://<contenido>.mp4 \
  --es breaks 58 --es start 52 --es adSeconds 12 --es adId <Ad@id del anuncio> --es creative <Creative@id>
```

`breaks` son segundos de contenido separados por coma, `start` la posición inicial y `adSeconds` la duración del anuncio simulado.

## Qué mirar

- `adb logcat -s ILExample AdPlanPlayer`: los eventos del SDK (`request`/`fill`/`impression` de cada ventana, `plan_unavailable`, `plan_not_found app=…`, `plan_error`, `host_break_start`, `break_product`, `host_break_end`).
- En `load`: las tarjetas de producto aparecen en sus ventanas.
- En `host`: durante el corte («Corte de la app (anuncio simulado)») desaparece todo lo de IL salvo **Comprar**. En TV, Comprar toma el foco: OK abre el producto y Atrás vuelve paso a paso. Al terminar el corte vuelven las gráficas.
