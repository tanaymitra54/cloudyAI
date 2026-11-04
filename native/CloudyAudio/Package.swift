// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "CloudyAudio",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "CloudyAudio",
            path: "Sources/CloudyAudio"
        )
    ]
)
