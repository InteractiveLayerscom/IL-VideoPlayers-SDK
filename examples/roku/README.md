# Canal de ejemplo Roku: plan de anuncios de IL

> **No se ejecutó en un equipo Roku.** Este canal sólo pasó la validación estática de BrighterScript y el
> empaquetado (`build.sh`). La lógica del componente está probada en el intérprete de escritorio con dobles del
> nodo `Video`, de RAF y de la red (`sh roku/verify.sh`). RAF real, la reproducción y la composición en pantalla
> quedan sin verificar.

El canal más chico que muestra los dos modos de `ILAdPlanPlayer`:

1. **`load`**: el componente pide el plan a la consola (`GET /il-player/app-plan`), reproduce sus cortes con RAF y
   dibuja Súper, L, producto y **Comprar** durante el corte.
2. **`host`**: el canal reproduce sus propios cortes. Pide el plan y cada corte a un relay
   (`examples/api-relay.mjs`: `POST /playback`, `POST /break`, `POST /break/next`), reproduce el `ad_tag_url` con su
   propio RAF y le informa al componente `breakStarted`, `adStarted`, `adEnded` y `breakEnded`.

La clave de API vive sólo en el entorno del relay. El canal no lleva credenciales.

## Compilar

Desde la raíz del repositorio, con Node:

```sh
IL_MODE=load IL_CONSOLE_ORIGIN=https://<consola> IL_PROJECT=proj_… IL_ASSET=asset-… \
IL_CONTENT_URL=https://<cdn>/master.m3u8 sh examples/roku/build.sh

IL_MODE=host IL_RELAY_URL=http://<ip de la Mac>:8787 IL_CONSOLE_ORIGIN=https://<consola> IL_ASSET=asset-… \
IL_CONTENT_URL=https://<cdn>/master.m3u8 IL_BREAKS='[58,178]' sh examples/roku/build.sh
```

`build.sh` copia `roku/components/ILOverlay`, escribe `source/config.json` con esos valores, valida con
BrighterScript y deja `examples/roku/out/il-plan-example.zip`. Los mismos parámetros (`mode`, `consoleOrigin`,
`relayUrl`, `project`, `asset`, `contentUrl`, `breaks`) también se aceptan al lanzar el canal por deep link o ECP y
reemplazan los del paquete.

## Ejecutar

Instalá el zip en un Roku en modo desarrollador desde `http://<ip del Roku>`. Un canal instalado así envía
`app=roku:dev`: registrá `dev` como app Roku del proyecto en la Console antes de probar el modo `load`. Un canal
publicado envía `roku:<id del canal>`.

El modo `host` con `node examples/api-relay.mjs --fixtures` responde con los archivos de `test/fixtures/native/`.
Esas respuestas traen URLs `http://localhost:8000` de la consola de prueba: el SDK sólo acepta productos HTTPS del
mismo origen que el plan, así que con fixtures verás cortes y gráficas pero no productos.

## Qué mirar

- La etiqueta de arriba muestra el último evento del componente. `plan_unavailable` trae `status` y el `app=`
  enviado: un 404 casi siempre es un `app=` no registrado.
- Durante un anuncio de iADServer con `Ad@id` `il-shop-…`, aparece **Comprar** abajo a la derecha y se va al
  terminar ese anuncio.
- En modo `host`, nada de IL se dibuja sobre el corte salvo **Comprar**, y las gráficas vuelven después de
  `breakEnded`.
