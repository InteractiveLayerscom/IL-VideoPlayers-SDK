# Ejemplo: Samsung Tizen con AVPlay

App web empaquetada mínima que muestra las dos formas de usar el plan de IL en un televisor Samsung con AVPlay
(`attachAvPlayAds`). **No se pudo ejecutar acá**: no hay televisor ni imagen de emulador de TV en esta máquina. El código
sigue la API probada con dobles en `test/avplay-native.test.mjs`, pero la app en sí no corrió nunca.

## Modos

- **`load`** (el SDK pide el plan): `attachAvPlayAppAds` pide `GET <consola>/il-player/app-plan?project=…&asset=…&app=tizen:<id de aplicación>`, reproduce los cortes del plan en AVPlay y dibuja gráficos y **Comprar**. Un plan `version: 2` se renueva solo con `renew=<grant>`.
- **`host`** (API por corte): la app llama al relay (`examples/api-relay.mjs`, que hace de backend del cliente) con `POST /playback` y recibe el plan de host (`cuts: []`); en cada corte pide `POST /break`, descarga el VAST, reproduce el anuncio ella misma y avisa al SDK con `breakStarted(at)`, `setBreakAd({ tagUrl, adId, creativeId })`, `clearBreakAd()` y `breakEnded()`. El SDK pide la tarjeta con `cut=at-<ms>` y dibuja **Comprar**. La clave de la API queda sólo en el entorno del relay.

> **El relay (`examples/api-relay.mjs`) es sólo un ejemplo: nunca lo despliegues.** En modo real le da el poder de `IL_API_KEY` a cualquiera que lo alcance (CORS `*`). Escucha en `127.0.0.1`; para que un televisor de tu red lo alcance tenés que pasar `--host <ip de tu Mac>`, y eso expone la clave a toda esa red: usalo así sólo con `--fixtures`.

## Configuración

Todo se fija al compilar, en `settings.js`: `mode`, `consoleOrigin`, `relayUrl`, `project`, `asset` y `contentUrl`. Ningún host está en el código de la app. En `config.xml`:

1. Reemplazá `AbCdEfGhIj.ILDemo` por el id de aplicación que genera Tizen Studio y **registrá `tizen:<ese id>` en la consola de IL** para el proyecto. Sin registro, la ruta responde 404 (idéntico a un proyecto o video desconocido) y el SDK informa `plan_unavailable` con el `app` que mandó.
2. Declará cada origen que la app llama con `<access origin="…" subdomains="true"/>` y mantené el privilegio `http://tizen.org/privilege/internet` ([FAQ de red de Samsung, pregunta 2](https://developer.samsung.com/smarttv/develop/faq/networking-and-connectivity.html)).

**Sin confirmar**: la ruta de apps no manda encabezados CORS. La documentación de Samsung consultada no dice si `<access>` alcanza para leer una respuesta de otro origen sin CORS, y no se pudo probar en un televisor. Si el televisor la rechaza, el modo `load` termina sin plan (`plan_unavailable`, `reason: 'network'`) y el contenido se reproduce sin anuncios; la alternativa es el modo `host` (el plan llega desde tu backend) o pasar el plan con `attachAvPlayAds({ plan, planOrigin })`. El relay sí manda CORS permisivo.

## Compilar y ejecutar

1. Copiá el SDK dentro de la app: `cp -R ../../web sdk` (desde esta carpeta). La app importa `./sdk/index.mjs` y `./sdk/avplay-ads.mjs`. Para motores de TV antiguos pasá `sdk/` por el transpilador de tu app.
2. Abrí la carpeta en Tizen Studio como proyecto web de TV (o `tizen package -t wgt -s <perfil de certificado>` desde `~/tizen-studio/tools/ide/bin`), firmá con tu certificado de Samsung e instalá en un televisor en modo desarrollador (`sdb connect <ip>`, `tizen install -n ILDemo.wgt`).
3. Para el modo `host` sin backend: `node examples/api-relay.mjs --host <ip de tu Mac> --fixtures test/fixtures/native --cert cert.pem --key key.pem --public-base https://<ip de tu Mac>:8787` con un certificado de confianza local (las URL de producto tienen que ser HTTPS y del origen del plan; nunca uses un túnel público). En ese modo el relay sirve los planes con `expires_at` vigente y las URL de producto apuntando a sí mismo; las concesiones de los fixtures están vencidas, pero el relay contesta las rutas de producto sin verificarlas. Poné `consoleOrigin` y `relayUrl` en ese mismo origen. Con backend real: `IL_API_BASE=https://console.example IL_API_KEY=… node examples/api-relay.mjs`.

## Qué mirar

- En pantalla, la última línea de eventos: `plan_unavailable` (con el `app` enviado), `break_start`/`break_end` y los `request`/`fill` de gráficos.
- En el log del relay, una línea por pedido: `POST /playback`, `POST /break` en 58 y 178, y las tarjetas `GET /il-player/break-product?…&cut=at-58000…` en modo fixtures.
- Durante un anuncio de iADServer con `Ad@id` `il-shop-…`, el botón **Comprar**; durante el corte no aparece ningún gráfico de IL.
