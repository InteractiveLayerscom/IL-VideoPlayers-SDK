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
`app=roku:dev`: registrá `dev` como app Roku del proyecto en la Console antes de probar el modo `load` contra una
consola real. Un canal publicado envía `roku:<id del canal>`.

### Con el relay de ejemplo

`examples/api-relay.mjs` hace de backend del cliente. **Es un ejemplo: nunca lo despliegues.** Escucha en
`127.0.0.1`, que un Roku no alcanza. Para que el equipo llegue hay que abrirlo a la red local con
`--host <IP de la Mac en la LAN>`, y eso lo expone a **toda** esa red. En modo real expone además todo el poder de
`IL_API_KEY`. En modo fixtures no hace falta clave:

```sh
node examples/api-relay.mjs --host 192.168.1.20 --fixtures test/fixtures/native
IL_MODE=host IL_RELAY_URL=http://192.168.1.20:8787 IL_CONSOLE_ORIGIN=http://192.168.1.20:8787 \
IL_ASSET=asset-40edc822d6f24974a9af51695a88184b IL_CONTENT_URL=https://<cdn>/master.m3u8 \
IL_BREAKS='[58,178]' sh examples/roku/build.sh
```

El relay reescribe el origen de `commerce.url` y `commerce.break_url` a `--public-base` (por defecto, el esquema y
el `Host` con que se lo llamó) y sirve HTTPS con `--cert`/`--key`. Con HTTP, como en el ejemplo, verás cortes y
gráficas pero **no productos ni Comprar**, y el modo `load` no pide el plan: el SDK sólo usa HTTPS para el plan y
para productos del mismo origen que el plan.

**Certificado en un Roku.** Las peticiones HTTPS del SDK (`ILOverlayFeedRequest`) confían sólo en
`common:/certs/ca-bundle.crt`, el paquete de autoridades públicas de Roku. Un certificado autofirmado o de una CA
local (por ejemplo mkcert) **no funciona en un equipo real**: el plan y las fichas fallan como error de red, y el SDK
no tiene una opción para agregar otra CA. Para ver productos en un Roku, el relay tiene que responder en un nombre
de host con un certificado de una CA pública (por ejemplo Let's Encrypt) que resuelva a la Mac en la LAN, y
`IL_CONSOLE_ORIGIN` y `--public-base` tienen que ser ese origen HTTPS. Esto no se probó en un equipo.

## Qué mirar

- La etiqueta de arriba muestra el último evento del componente. `plan_unavailable` trae `status` y el `app=`
  enviado: un 404 casi siempre es un `app=` no registrado.
- Durante un anuncio de iADServer con `Ad@id` `il-shop-…`, aparece **Comprar** abajo a la derecha y se va al
  terminar ese anuncio.
- En modo `host`, nada de IL se dibuja sobre el corte salvo **Comprar**, y las gráficas vuelven después de
  `breakEnded`.
