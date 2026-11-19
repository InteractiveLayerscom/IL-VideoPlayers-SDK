// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "ILAVPlayerOverlay",
    platforms: [.iOS(.v16), .tvOS(.v16), .macOS(.v13)],
    products: [.library(name: "ILAVPlayerOverlay", targets: ["ILAVPlayerOverlay"])],
    targets: [
        .target(name: "ILAVPlayerOverlay"),
        .testTarget(name: "ILAVPlayerOverlayTests", dependencies: ["ILAVPlayerOverlay"],
                    resources: [.copy("Fixtures")])
    ]
)
