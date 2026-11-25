# Native SDK fixtures: real IL responses

These are real response bodies from the IL backend (branch `native-app-plan`, commits 6600f7c..HEAD; regenerated after the stable-tag `correlator` was added). They come from its test
environment, not production data. `_generator.py` is the throwaway pytest that produced them. It must be run from inside
the repo's `tests/` folder. `_log.json` holds each call's exact request, status and headers.

## Test environment caveats (read first)

- **The clock is frozen.** "Now" is `1793635200` = `2026-11-02T16:00:00Z`. Every `expires_at` and every grant expiry is
  relative to that, and grants show up as expired against a real clock. SDK tests must inject their own "now". Use
  `2026-11-02T16:00:00Z` for these files.
- **The console origin is `http://localhost:8000`** (the test `public_base_url`). In production it is
  `https://<console host>`. Treat `commerce.url` and `commerce.break_url` as opaque: never rebuild or re-host them.
- The iADServer ads origin is `https://ads.iadserver.com`.
- `project` is `proj_f76ed12b1f1a409589564fbbeade5c21` and `asset` is `asset-a0a377d6c8214c1498674e53c97721d2`. The video
  is 300 s long. Grants are signed with the test secret.
- The iADServer answers behind the product routes are recorded fakes, built with iADServer's own types. The card shapes
  are real IL output.
- `app-plan-v2.json` was produced by marking the linked GAM campaign as having a native-format approval. The real code
  then switches to native matching, which is why mid-1 lost its iADServer request in v2. Don't read that difference as
  part of the contract.

## Files

| File | Request | Status / headers |
|---|---|---|
| `app-plan-v1.json` | `GET /il-player/app-plan?project=<proj>&asset=<asset>&app=android:com.example.tv` | 200; `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Content-Type: application/json`, CSP `default-src 'none'`. **No `Access-Control-*`.** |
| `app-plan-renewed.json` | same + `&renew=<grant>`, where `<grant>` is the `grant` query parameter of `app-plan-v1.json` `commerce.url` | 200, same headers. `commerce.session` = `31fd74b20d30ef0688bb8b51c2e156fc`, the same as v1. It comes with a new grant. |
| `app-plan-v2.json` | same as v1 (a separate view, so it has its own session) | 200. `version: 2`, `native_gam.contract: "native-gam-plan-v1"`, `expires_at` = now + 120 s. |
| `playback-created.json` | `POST /v1/vod/playbacks` with API key (write), body `{"asset_id","channel_id","graphics":true}` | 201. Echoes `"graphics": true` and `"routing": "steps"`. |
| `host-plan.json` | `GET /v1/vod/playbacks/{playback_id}/plan` with API key (read) | 200, `Cache-Control: no-store`. `cuts: []`, `commerce.session` = `a1443784d8c5306265cc64d6ab475db2`, and both URLs carry `host=1`. |
| `break-request-stable.json` | `POST /v1/vod/playbacks/{id}/opportunities/{oid}/request` (write) after preparing `{"cue_seconds":58}` | 200. iADServer step 0 with a tag: `ad_tag_url` is the stable tag with `sid` = the host session. |
| `break-request-gam.json` | same, for `{"cue_seconds":178}` | 200. iADServer contextual step skipped (`no_eligible_campaign`), so GAM step 1 answers. |
| `scene-product-card.json` | `GET <commerce.url of app-plan-v1>&window=p1&locale=es` | 200, same header set as the app plan |
| `break-product-card-page.json` | `GET <break_url of app-plan-v1>&cut=pre&tag=T_pre&creative=cr1&delivery=<43 chars>&locale=es` (page grant, plan cut id) | 200 |
| `break-product-card.json` | `GET <break_url of host-plan>&cut=at-58000&tag=T_mid&creative=cr1&delivery=<43 chars>&locale=es` (host grant) | 200. Same shape as the page-grant card. |

## Rules a client must follow

**`app=`** must be `<platform>:<id>`, and the id must be registered in the console. Patterns (full match, at most 155
characters):

- `android`: `[A-Za-z][A-Za-z0-9_]{0,63}(\.[A-Za-z][A-Za-z0-9_]{0,63}){1,9}` (package name)
- `apple`: `[A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63}){1,9}` (bundle id)
- `roku`: `dev|[0-9]{1,10}(_[0-9a-f]{1,8})?` (channel id; `dev` for a sideloaded channel)
- `tizen`: `[A-Za-z0-9]{10}\.[A-Za-z0-9]{1,52}` (application id)

**`/il-player/app-plan` answers**

- **200**: the plan.
- **204**: no plan right now, or a limit was reached. Play without ads. A first view often gets 204 while IL builds the
  plan in the background; ask again on the next view, never in a tight loop.
- **404**: an unknown project, video or app, all with the identical answer. It is the same 404 an unregistered app gets,
  so check `app=` first.
- The route has no CORS. It is for native HTTP clients only and lives only on the console host.

**Renewal (v2).** Re-request before `expires_at`. In practice that is about 100 s, because the server allows 120 s. Send
`&renew=<grant from the current plan's commerce.url>` to keep the same `commerce.session`. Sessions keep per-session
caps and the Buy-during-break identity across renewals. An invalid or expired renew grant is silently ignored: you get a
new session, not an error.

**Scene product URL.** Take `commerce.url` verbatim and append `&window=<windows[i].id>&locale=<es|en|pt-BR>`. Ask
`lead_ms` before the window's `start_ms`. Pacing (`commerce.pacing`) is the client's job. A `sid` you add is ignored. A
host plan's URL already contains `host=1`: do not strip it.

**Break product URL (Buy during an ad).** Take `commerce.break_url` verbatim and append:

- `cut`:
  - Page or app plan: the `cuts[i].id` of the break being played.
  - Host plan (the app plays its own breaks through the per-break API): `at-<ms>`, where `<ms>` is the integer media
    milliseconds of the break, for example `at-58000` for `cue_seconds` 58. Use `at-0` for the pre-roll. It must be
    below the video duration.
- `tag`: the `tag` query parameter of the iADServer `ad_tag_url` / `tag_url` that produced the ad playing.
- `creative`: the VAST `<Creative id="…">` of the playing linear ad, as IMA exposes it (`creativeId` /
  `getCreativeId()`).
- `delivery`: the delivery id from VAST `<Ad id="il-shop-<preroll|midroll>-<delivery>">`. Take the part after the
  second hyphen; it is exactly 43 characters from `[A-Za-z0-9_-]`. An ad without that `Ad@id` prefix has no product:
  don't call.
- `locale`.

Show the card only while that ad plays, and remove it on complete, skip or error. A page grant cannot use `at-`, and a
host grant cannot use a plan cut id. Both get 204.

**Product route answers (both routes).**

- **200**: a card. `start`/`end` are media ms. A scene card also has `window` and `holdUntil`. Its `impressionUrl` and
  `commerce.viewUrl` are iADServer beacons; the client fires them.
- **204**: no product, for every reason (expired or foreign grant, no stock, iADServer slow, and so on). Don't retry
  that window or break in this playback.
- **429** with `Retry-After`: more than 12 requests per minute in one session, more than 120 per address, or more than
  3000 per project. Treat it like 204.
- **404**: the product feature is off in that environment.

No `Origin` is needed. Requests must not carry credentials.

**Per-break API with graphics.**

- `commerce.break_url` is optional in a host plan. It is present only when the playback was created with
  `graphics: true`, walks the project's ordered steps (`routing: "steps"`), has no AdRouter placement, the product
  feature is on, and the project saved at least one iADServer step with a `tag`. Without it, offer no Buy during
  breaks.
- For a server-insertion project, the app plan is the stitched plan (`cuts: []` plus `timeline`), the same body as
  `/il-player/ad-plan`. Native readers refuse a plan with `timeline` for now and play without IL ads.

- Only a playback created with `"graphics": true` gets stable-tag answers. Read `GET …/plan` once per playback, again
  when it expires, and again for `version: 2`.
- Its `commerce.session` is the `sid` already inside every stable `ad_tag_url`, which also carries a `correlator` (16 digits) IL generated for that break. Fetch the URL exactly as given: don't add, replace or strip `sid` or `correlator`. Fetching it again (a retry, or a prefetch then play) returns the same delivery, so the `Ad@id` you use for the Buy card stays valid.
- When the stable tag returns no ad, call `/next` with `{"after_step": <step>}` exactly as before.
- `GET …/plan` returns 204 when there is nothing to draw: AdRouter on, no analysis, server-side insertion, the playback
  ended, or nothing selected.

**Correlators.** The plan's `tag_url`s carry no `correlator`; the player adds one per attempt. Every `ad_tag_url` from
`/request` (GAM and the stable iADServer tag) already includes one: use it as is.
