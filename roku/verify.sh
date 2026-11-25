#!/bin/sh
set -eu
cd "$(dirname "$0")"
npm exec --yes --package=brighterscript@0.73.8 -- bsc --no-project \
    --root-dir . --files 'components/**/*' --create-package false --copy-to-staging false
test_root=$(mktemp -d)
trap 'rm -rf "$test_root"' EXIT HUP INT TERM
cp -R components tests "$test_root/"
# The desktop interpreter has no Task thread. Stand in for the HTTPS boundary.
cp tests/CartRequest.xml "$test_root/components/ILOverlay/ILOverlayFeedRequest.xml"
cp ../test/fixtures/creative-scene.json "$test_root/tests/"
cp -R ../test/fixtures/native "$test_root/tests/native"
cp tests/EventLog.xml "$test_root/components/"
cd "$test_root"
report=$(npm exec --yes --package=@rokucommunity/brs@0.47.6 -- brs --no-color --root . tests/overlay.brs 2>&1) || {
    printf '%s\n' "$report" >&2
    exit 1
}
printf '%s\n' "$report"
# The interpreter can return exit code zero after a BrightScript runtime error.
printf '%s\n' "$report" | grep -Eq '^ROKU_OK [1-9][0-9]*$'
feed_report=$(npm exec --yes --package=@rokucommunity/brs@0.47.6 -- brs --no-color --root . components/ILOverlay/ILOverlayFeedRequest.brs tests/feed.brs 2>&1) || {
    printf '%s\n' "$feed_report" >&2
    exit 1
}
printf '%s\n' "$feed_report"
printf '%s\n' "$feed_report" | grep -Eq '^ROKU_FEED_OK 3$'
plan_report=$(npm exec --yes --package=@rokucommunity/brs@0.47.6 -- brs --no-color --root . components/ILOverlay/ILAdPlan.brs tests/adplan.brs 2>&1) || {
    printf '%s\n' "$plan_report" >&2
    exit 1
}
printf '%s\n' "$plan_report"
printf '%s\n' "$plan_report" | grep -Eq '^ROKU_ADPLAN_OK [1-9][0-9]*$'
native_report=$(npm exec --yes --package=@rokucommunity/brs@0.47.6 -- brs --no-color --root . components/ILOverlay/ILAdPlan.brs tests/native.brs 2>&1) || {
    printf '%s\n' "$native_report" >&2
    exit 1
}
printf '%s\n' "$native_report"
printf '%s\n' "$native_report" | grep -Eq '^ROKU_NATIVE_OK [1-9][0-9]*$'
