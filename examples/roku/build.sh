#!/bin/sh
# Packages the example channel with the SDK component. Base URLs are build-time parameters:
#   IL_MODE=load|host IL_CONSOLE_ORIGIN=https://… IL_RELAY_URL=http://<mac ip>:8787 IL_PROJECT=… IL_ASSET=…
#   IL_CONTENT_URL=https://…/master.m3u8 IL_BREAKS='[58,178]' sh examples/roku/build.sh
set -eu
here=$(cd "$(dirname "$0")" && pwd)
out="$here/out"
stage="$out/stage"
rm -rf "$stage"
mkdir -p "$stage/components"
cp "$here/manifest" "$stage/"
cp -R "$here/source" "$stage/"
cp "$here/components/"* "$stage/components/"
cp -R "$here/../../roku/components/ILOverlay" "$stage/components/"
node -e '
const c = { mode: process.env.IL_MODE || "load", consoleOrigin: process.env.IL_CONSOLE_ORIGIN || "",
  relayUrl: process.env.IL_RELAY_URL || "", project: process.env.IL_PROJECT || "", asset: process.env.IL_ASSET || "",
  contentUrl: process.env.IL_CONTENT_URL || "", breaks: JSON.parse(process.env.IL_BREAKS || "[]") };
process.stdout.write(JSON.stringify(c));' > "$stage/source/config.json"
npm exec --yes --package=brighterscript@0.73.8 -- bsc --no-project --root-dir "$stage" \
    --files 'manifest' 'source/**/*' 'components/**/*' --create-package false --copy-to-staging false
(cd "$stage" && rm -f "$out/il-plan-example.zip" && zip -qr "$out/il-plan-example.zip" .)
printf 'Paquete: %s\n' "$out/il-plan-example.zip"
