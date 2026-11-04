// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "CloudyEar",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(url: "https://github.com/FluidInference/FluidAudio.git", from: "0.18.0")
    ],
    targets: [
        .executableTarget(
            name: "CloudyEar",
            dependencies: [.product(name: "FluidAudio", package: "FluidAudio")]
        )
    ]
)
