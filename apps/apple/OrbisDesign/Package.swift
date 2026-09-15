// swift-tools-version: 6.2
import PackageDescription

let package = Package(
  name: "OrbisDesign",
  platforms: [.iOS("26.1"), .macOS(.v26)],
  products: [
    .library(name: "OrbisDesign", targets: ["OrbisDesign"])
  ],
  targets: [
    .target(
      name: "OrbisDesign",
      swiftSettings: [.defaultIsolation(MainActor.self)]
    ),
    .testTarget(
      name: "OrbisDesignTests",
      dependencies: ["OrbisDesign"],
      swiftSettings: [.defaultIsolation(MainActor.self)]
    ),
  ]
)
