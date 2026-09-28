import SwiftUI
import Testing

@testable import OrbisDesign

@Suite struct ArtworkFieldTests {
  @Test func `grey artwork takes the brand field`() {
    let greys = (0..<100).map { index in
      let v = Double(index) / 99
      return (r: v, g: v, b: v)
    }
    #expect(ArtworkField.from(pixels: greys) == .brand)
  }

  @Test func `no pixels take the brand field`() {
    #expect(ArtworkField.from(pixels: []) == .brand)
  }

  @Test func `a saturated colour keeps its hue and has its chroma capped`() {
    let field = ArtworkField.from(pixels: Array(repeating: (r: 0.1, g: 0.8, b: 0.2), count: 20))
    #expect(field.chroma == ArtworkField.maxChroma)
    #expect(abs(field.hue - 145) < 10)
  }

  @Test func `a hue near the tint moves off it so Play stays the one orange thing`() {
    let field = ArtworkField.from(averageLab: (l: 0.7, a: 0.12, b: 0.13))
    #expect(ArtworkField.angularDistance(field.hue, ArtworkField.tintHue) >= ArtworkField.tintClearance)
  }

  @Test func `a hue well away from the tint is left alone`() {
    let field = ArtworkField.from(averageLab: (l: 0.5, a: 0.0, b: -0.08))
    #expect(abs(field.hue - 270) < 0.001)
    #expect(abs(field.chroma - 0.08) < 0.0001)
  }

  @Test func `letterbox bars do not decide the colour`() {
    let bars = Array(repeating: (r: 0.0, g: 0.0, b: 0.0), count: 10)
    let picture = Array(repeating: (r: 0.15, g: 0.3, b: 0.8), count: 80)
    let glare = Array(repeating: (r: 1.0, g: 1.0, b: 1.0), count: 10)
    let field = ArtworkField.from(pixels: bars + picture + glare)
    let pure = ArtworkField.from(pixels: picture)
    #expect(abs(field.hue - pure.hue) < 1)
  }

  @Test func `a vivid accent outweighs a grey background`() {
    let grey = Array(repeating: (r: 0.35, g: 0.35, b: 0.38), count: 85)
    let accent = Array(repeating: (r: 0.9, g: 0.1, b: 0.3), count: 15)
    let field = ArtworkField.from(pixels: grey + accent)
    #expect(field != .brand)
    #expect(field.chroma > 0.06)
  }

  @Test func `the dark field is dark and the light field is light`() {
    var light = EnvironmentValues()
    light.colorScheme = .light
    let field = ArtworkField(hue: 300, chroma: 0.09)
    let dark = field.color(dark: true).resolve(in: light)
    let pale = field.color(dark: false).resolve(in: light)
    #expect(luma(dark) < 0.15)
    #expect(luma(pale) > 0.75)
  }

  @Test func `white text clears 4.5 to 1 on every dark field`() {
    var environment = EnvironmentValues()
    environment.colorScheme = .dark
    for hue in stride(from: 0.0, to: 360, by: 15) {
      let field = ArtworkField(hue: hue, chroma: ArtworkField.maxChroma)
      let background = luma(field.color(dark: true).resolve(in: environment))
      #expect((1.0 + 0.05) / (background + 0.05) >= 4.5, "hue \(hue)")
    }
  }

  @Test func `a real image yields a field`() throws {
    let data = try #require(Self.solidPNG(red: 40, green: 60, blue: 160))
    let field = try #require(ArtworkField.from(imageData: data))
    #expect(field != .brand)
    #expect(ArtworkField.from(imageData: Data("not an image".utf8)) == nil)
  }

  private func luma(_ color: Color.Resolved) -> Double {
    0.2126 * Double(color.linearRed) + 0.7152 * Double(color.linearGreen)
      + 0.0722 * Double(color.linearBlue)
  }

  private static func solidPNG(red: UInt8, green: UInt8, blue: UInt8) -> Data? {
    let width = 8
    let height = 8
    var bytes = [UInt8]()
    for _ in 0..<(width * height) { bytes += [red, green, blue, 255] }
    guard
      let provider = CGDataProvider(data: Data(bytes) as CFData),
      let image = CGImage(
        width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32,
        bytesPerRow: width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
        provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)
    else { return nil }
    let output = NSMutableData()
    guard
      let destination = CGImageDestinationCreateWithData(
        output, "public.png" as CFString, 1, nil)
    else { return nil }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else { return nil }
    return output as Data
  }
}
