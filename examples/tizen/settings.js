// Build-time settings of the example (no hosts are hard-coded in the app code). Never put an API key here:
// the key lives only in the relay's environment.
window.IL_EXAMPLE = {
  mode: 'load',                         // 'load' (the SDK requests the plan) or 'host' (the app plays its own breaks)
  consoleOrigin: 'https://console.example',
  relayUrl: 'https://relay.example',    // mode 'host': examples/api-relay.mjs (or your backend with the same routes)
  project: 'proj_...',
  asset: 'asset-...',
  contentUrl: 'https://media.example/video.mp4',
};
