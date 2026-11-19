# InteractiveLayers Player SDK

The SDK lets publishers show contextual ads in their apps during HLS playback. A **lower-third overlay** (`super`) appears over the program. For an **L-shaped ad** (`l`), the player scales the video to 75% of its original width and height, anchors it in the upper-left corner, and displays the creative along the right and bottom edges. Audio continues in the same playback session.

InteractiveLayers Console manages the project's ad server connection. The backend identifies the segment on air, requests a creative from the selected ad server, and tells the player when to display it. Publishers integrate the SDK once and manage campaign changes in their ad server.

| Publisher app | Integration |
| --- | --- |
| Web with Shaka Player | Uses Shaka's built-in interstitial support to render overlays and resize the video. [Shaka guide](web/README.md#shaka) |
| Android TV, Google TV, Fire TV, and Android with Media3 | Android module that attaches to the app's existing ExoPlayer instance. [Android guide](android/README.md) |
| Apple TV and iOS with AVPlayer | Swift package with an HLS date range collector and a view that displays the creative. [Apple guide](apple/README.md) |
| Native Roku apps | SceneGraph component that works with the app's existing video node. [Roku guide](roku/README.md) |
| Samsung Tizen with AVPlay | JavaScript adapter that resizes the native video window and its HTML object. [Samsung guide](web/README.md#samsung-avplay) |
| Video.js on the web or LG webOS | Adapter for the existing Video.js player and its HTML5 playback tech. [Video.js guide](web/README.md#videojs) |
| HTML5 TV apps | Adapter for the video element and its container. [HTML5 guide](web/README.md#html5) |

[Compare ad formats by player and integration](docs/formats.md) for linear spots, lower thirds, L-shaped ads and session targeting.

## Ad cues and playback

The backend can deliver a cue through an HLS `EXT-X-DATERANGE` tag or a JSON endpoint for the viewer's session. Both carry the same cue ID, display window, and creative URL. Use the session endpoint for personalized ads when the playout system serves a shared manifest. The SDK compares the display window with the program time at the viewer's playhead. The program stays at full size if the cue has expired, the ad server returns no creative, or the player cannot determine the program time. [Cue specification](docs/signals.md)

For Teinformas, Eyevinn handles channel playout and Google Ad Manager (GAM) manages the campaigns. The FAST pilot uses MediaTailor as the insertion point for pre-roll and mid-roll spots. The player adapters render lower-third and L-shaped ads on the viewer's device. [How Teinformas connects to GAM](docs/teinformas.md)

## Shopify product ads

Publishers can opt in to product offers through the session JSON feed. The SDK displays the product and its variants as a card, an L-shaped ad, or a lower third. On TV, viewers select a variant with the remote and scan a QR code to continue on their phone. Web and mobile viewers open the continuation link directly. iADServer manages the Shopify connection and sales attribution, and Shopify hosts checkout.

[Set up the product offer feed](docs/signals.md#compra-con-shopify).

## Test the integration

The included generator creates an 18-second HLS test stream and both ad creatives. Use it to check that each graphic appears during its scheduled window, audio continues, the video returns to its original size, and each impression is counted once. [Run the playback test](examples/README.md)

Import the web adapters as ES modules. For native apps, follow the platform guide to add the Gradle module, Swift package, or SceneGraph component to the publisher's project. The SDK is distributed through this private repository. Each guide describes its module and simulation tests. To validate a specific TV model, play the stream on that device.

## Verification

| Platform | What was verified in this version |
| --- | --- |
| Shaka 5.3.5 | The Shaka package rendered and removed both graphics in a test DOM. It resized the original video element for the L-shaped ad. The test also exercised Shaka's native HLS parser for that format. |
| Android Media3 1.6.0 | ExoPlayer played HLS on an Android 15 emulator. Instrumented tests verified the layout, restoration of the original video size, and receipt of the impression request by a local HTTPS server. |
| AVPlayer | AVPlayer played HLS on macOS, read both cues, and reported the expected playhead position after three seeks. The UIKit view was tested on Mac Catalyst. The package compiled for iOS and tvOS. |
| Roku | BrighterScript validated the components. The BrightScript interpreter ran tests for cue parsing, playhead timing, ad breaks, and layout. |
| Video.js, AVPlay, and HTML5 | The adapters were tested with a test DOM and platform API test doubles. Video output on the target TVs still needs device testing. |
