# Formats by player and integration

A preroll plays before the program. A midroll occupies a break. A lower third appears over full-size video. An L-shaped ad scales both video dimensions to 75%, places the picture at the upper left and displays artwork on the right and bottom. Program audio continues during both graphics.

| Player or integration | Without the IL SDK | What the IL SDK adds |
| --- | --- | --- |
| MediaTailor · SSAI | A compatible HLS player can play prerolls and midrolls stitched into its session stream when an eligible spot is available. | Graphics can run during the program. The app passes each spot’s start and end to the graphics layer. |
| CSAI · IMA / VAST | An ad integration in the player requests and plays scheduled prerolls or midrolls. Nonlinear format support depends on that integration and device. | The IL SDK can show lower thirds and L-shaped ads between spots using IL graphic cues. |
| Shaka Player 5.3.5 | Can render both formats with HLS interstitials enabled, ad containers and Shaka geometry in the media playlist. | Translates IL HLS or JSON cues into interstitials. Shaka draws the lower third and resizes the video for the L-shaped ad. |
| Media3 / ExoPlayer · Android TV, Google TV, Fire TV | Plays SSAI spots. To show a lower third or an L-shaped ad from an IL cue, the app must interpret the cue and render the graphic. | Attaches the graphics layer to the app’s PlayerView. |
| AVPlayer · iOS, tvOS | Plays SSAI spots. To show a lower third or an L-shaped ad from an IL cue, the app must interpret the cue and render the graphic. | Integrates a graphics view with AVPlayer and HLS dates. |
| SceneGraph · Roku | Plays SSAI spots. To show a lower third or an L-shaped ad from an IL cue, the app must interpret the cue and render the graphic. | Resizes the Video node and displays artwork in a SceneGraph component. |
| AVPlay · Samsung Tizen | Plays SSAI spots. To show a lower third or an L-shaped ad from an IL cue, the app must interpret the cue and render the graphic. | Adjusts the native AVPlay display rectangle and its HTML object. |
| Video.js · Web / LG webOS | Plays SSAI spots. To show a lower third or an L-shaped ad from an IL cue, the app must interpret the cue and render the graphic. | Resizes the player and displays the image on its HTML5 surface. |
| HTML5 · Web / TV | Plays SSAI spots. To show a lower third or an L-shaped ad from an IL cue, the app must interpret the cue and render the graphic. | Resizes the video element and renders the artwork in the app’s container. |

## Targeting and measurement

The backend maps the segment on air to its editorial context. The ad server selects the creative using inventory, context and campaign rules. A cue in a shared HLS playlist delivers the same artwork to that audience. Use a personalized playlist or session events endpoint for individual decisions. Record the impression when the graphic appears and assign one sender for that beacon.

## Live MediaTailor overlays

MediaTailor’s live overlay workflow requires a type 0x38 SCTE-35 marker and a nonlinear VAST response. The app reads session tracking, matches the opportunity to its playhead and displays the creative. To use the IL SDK on this path, the integration must map that data to an IL cue. Artwork composited into the video at playout is visible in any compatible player and is shared by everyone receiving that feed.

## Native Shaka signaling

Use an EXT-X-DATERANGE of class com.apple.hls.interstitial with X-OVERLAY-ID and X-ASSET-URI. Supply position and size for the lower third. For the L-shaped layout use X-DEPTH=-1 and X-SQUEEZECURRENT=0.75. The alternative IL contract uses com.interactivelayers.overlay or session JSON and supports PNG/JPEG artwork.

[Platform test coverage](../README.md#verification) · [AWS Elemental MediaTailor](https://docs.aws.amazon.com/mediatailor/latest/ug/overlay-ads.html) · [Shaka Player](https://shaka-project.github.io/shaka-player-release/docs/api/lib_ads_hls_interstitial_parser.js.html) · [Google IMA](https://developers.google.com/interactive-media-ads/docs/sdks/html5/client-side/get-started)
