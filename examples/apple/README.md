# Ejemplo para iOS y tvOS (AVPlayer)

Una app UIKit mínima, un solo target para iPhone, iPad y Apple TV, que enlaza sólo `ILAVPlayerOverlay` (sin IMA ni GMA) y muestra los dos modos del plan de anuncios:

- `load`: el SDK pide el plan con `ILAdPlanPlayer.load` y programa productos y gráficas.
- `host`: la app reproduce sus propios cortes con la API por corte, a través del relay del cliente (`examples/api-relay.mjs`: `POST /playback`, `POST /break`), y se los informa al SDK con `breakStarted`, `adStarted(tagURL:vastXML:)`, `adEnded` y `breakEnded`.

La app no tiene hosts ni claves: todo llega por argumentos de lanzamiento. La clave de la API vive sólo en el entorno del relay.

## Compilar y abrir en el simulador

```sh
cd examples/apple
xcodebuild -project ILExample.xcodeproj -scheme ILExample -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath build CODE_SIGNING_ALLOWED=NO build
xcrun simctl install booted build/Build/Products/Debug-iphonesimulator/ILExample.app
# tvOS: -destination 'generic/platform=tvOS Simulator' y Debug-appletvsimulator/ILExample.app
```

El SDK sólo acepta planes y productos por HTTPS. Para un relay local, servilo detrás de un origen HTTPS con un certificado de una CA propia y confiá esa CA en el simulador (`xcrun simctl keychain booted add-root-cert ca.pem`). No hace falta una excepción de ATS.

```sh
# modo load
xcrun simctl launch booted com.interactivelayers.examples.avplayer -ILMode load \
  -ILOrigin https://<consola> -ILProject <proyecto> -ILAsset <video> -ILVideo https://<contenido>.mp4
# modo host
xcrun simctl launch booted com.interactivelayers.examples.avplayer -ILMode host \
  -ILRelay https://<relay> -ILOrigin https://<consola> -ILAsset <video> -ILVideo https://<contenido>.mp4 \
  -ILStartAt 50 -ILBreakAt 58
```

`-ILAdServer <origen>` reemplaza el host del tag de anuncios por uno local, sólo para pruebas sin servidor de anuncios real. El bundle id `com.interactivelayers.examples.avplayer` debe estar registrado en la Consola para que `load` reciba un plan (`app=apple:com.interactivelayers.examples.avplayer`).

## Qué mirar

- La línea de estado arriba a la izquierda y los eventos `[ILExample] event …` en el log (`xcrun simctl spawn booted log stream --predicate 'process == "ILExample"'`).
- `load`: el pedido `GET /il-player/app-plan?…&app=apple:…` y, en la ventana `p1`, la tarjeta de producto con **Ver producto**.
- `host`: al llegar a 58 s, `POST /break`, el anuncio y el pedido `…/il-player/break-product?…&cut=at-58000&tag=…&creative=…&delivery=…&locale=es`. Durante el corte sólo aparece **Comprar**; al terminar vuelven el contenido y las gráficas.
