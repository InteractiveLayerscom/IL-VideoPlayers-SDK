// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "ILAVPlayerOverlay",
    platforms: [.iOS(.v16), .tvOS(.v16), .macOS(.v13)],
    products: [.library(name: "ILAVPlayerOverlay", targets: ["ILAVPlayerOverlay"]),
               // Ad SDKs are separate products: an app links only the ones it imports.
               .library(name: "ILAVPlayerOverlayIMA", targets: ["ILAVPlayerOverlayIMA"]),
               // Google Mobile Ads stops an app that has no AdMob application ID.
               .library(name: "ILAVPlayerOverlayGMA", targets: ["ILAVPlayerOverlayGMA"])],
    dependencies: [
        .package(url: "https://github.com/googleads/swift-package-manager-google-mobile-ads.git", from: "13.13.0"),
        .package(url: "https://github.com/googleads/swift-package-manager-google-interactive-media-ads-ios.git", from: "3.34.1"),
        .package(url: "https://github.com/googleads/swift-package-manager-google-interactive-media-ads-tvos.git", from: "4.18.1")
    ],
    targets: [
        .target(name: "ILAVPlayerOverlay"),
        .target(name: "ILAVPlayerOverlayIMA", dependencies: [
            "ILAVPlayerOverlay",
            .product(name: "GoogleInteractiveMediaAds", package: "swift-package-manager-google-interactive-media-ads-ios",
                     condition: .when(platforms: [.iOS])),
            .product(name: "GoogleInteractiveMediaAdsTvOS", package: "swift-package-manager-google-interactive-media-ads-tvos",
                     condition: .when(platforms: [.tvOS]))
        ]),
        .target(name: "ILAVPlayerOverlayGMA", dependencies: [
            "ILAVPlayerOverlay",
            .product(name: "GoogleMobileAds", package: "swift-package-manager-google-mobile-ads", condition: .when(platforms: [.iOS]))
        ]),
        .testTarget(name: "ILAVPlayerOverlayTests", dependencies: ["ILAVPlayerOverlay"],
                    resources: [.copy("Fixtures")])
    ]
)
