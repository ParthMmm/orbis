import ImageIO
import SwiftUI

public struct ArtworkField: Equatable, Sendable {
  public let hue: Double
  public let chroma: Double

  public static let brand = ArtworkField(hue: 300, chroma: 0.09)

  static let greyChroma = 0.02
  static let maxChroma = 0.10
  static let tintHue = 48.0
  static let tintClearance = 25.0

  public init(hue: Double, chroma: Double) {
    self.hue = hue
    self.chroma = chroma
  }

  public static func from(averageLab lab: (l: Double, a: Double, b: Double)) -> ArtworkField {
    let chroma = (lab.a * lab.a + lab.b * lab.b).squareRoot()
    guard chroma >= greyChroma else { return brand }
    var hue = atan2(lab.b, lab.a) * 180 / .pi
    if hue < 0 { hue += 360 }
    let distance = angularDistance(hue, tintHue)
    if distance < tintClearance {
      hue = (tintHue - tintClearance + 360).truncatingRemainder(dividingBy: 360)
    }
    return ArtworkField(hue: hue, chroma: min(chroma, maxChroma))
  }

  public static func from(pixels: [(r: Double, g: Double, b: Double)]) -> ArtworkField {
    guard !pixels.isEmpty else { return brand }
    let labs = pixels.map { OKLab.from(srgb: $0) }.sorted { $0.l < $1.l }
    let trim = labs.count / 10
    let kept = labs.count > 2 * trim ? Array(labs[trim..<(labs.count - trim)]) : labs
    let weights = kept.map { $0.a * $0.a + $0.b * $0.b }
    let total = weights.reduce(0, +)
    guard total > 1e-6 else { return brand }
    var a = 0.0
    var b = 0.0
    var l = 0.0
    var chroma = 0.0
    for (lab, weight) in zip(kept, weights) {
      a += lab.a * weight
      b += lab.b * weight
      l += lab.l * weight
      chroma += weight.squareRoot() * weight
    }
    let hue = atan2(b, a)
    let strength = chroma / total
    return from(averageLab: (l: l / total, a: strength * cos(hue), b: strength * sin(hue)))
  }

  static func lightness(dark: Bool) -> Double { dark ? 0.34 : 0.93 }

  public func color(dark: Bool) -> Color {
    let c = dark ? chroma : chroma * 0.45
    let radians = hue * .pi / 180
    let rgb = OKLab.srgb(l: Self.lightness(dark: dark), a: c * cos(radians), b: c * sin(radians))
    return Color(.sRGB, red: rgb.r, green: rgb.g, blue: rgb.b)
  }

  static func angularDistance(_ a: Double, _ b: Double) -> Double {
    let d = abs(a - b).truncatingRemainder(dividingBy: 360)
    return min(d, 360 - d)
  }
}

extension ArtworkField {
  public static func from(cgImage image: CGImage) -> ArtworkField {
    let width = 16
    let height = 9
    var bytes = [UInt8](repeating: 0, count: width * height * 4)
    let drawn = bytes.withUnsafeMutableBytes { buffer -> Bool in
      guard
        let context = CGContext(
          data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8,
          bytesPerRow: width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
      else { return false }
      context.interpolationQuality = .medium
      context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
      return true
    }
    guard drawn else { return brand }
    let pixels: [(r: Double, g: Double, b: Double)] = stride(
      from: 0, to: bytes.count, by: 4
    ).map { index in
      let red = Double(bytes[index]) / 255
      let green = Double(bytes[index + 1]) / 255
      let blue = Double(bytes[index + 2]) / 255
      return (r: red, g: green, b: blue)
    }
    return from(pixels: pixels)
  }

  public static func from(imageData data: Data) -> ArtworkField? {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
    else { return nil }
    return from(cgImage: image)
  }
}

enum OKLab {
  static func from(srgb: (r: Double, g: Double, b: Double)) -> (l: Double, a: Double, b: Double) {
    let r = linear(srgb.r)
    let g = linear(srgb.g)
    let b = linear(srgb.b)
    let l = cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
    let m = cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
    let s = cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
    return (
      l: 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
      a: 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
      b: 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
    )
  }

  static func srgb(l lightness: Double, a: Double, b: Double) -> (r: Double, g: Double, b: Double) {
    let l = pow(lightness + 0.3963377774 * a + 0.2158037573 * b, 3)
    let m = pow(lightness - 0.1055613458 * a - 0.0638541728 * b, 3)
    let s = pow(lightness - 0.0894841775 * a - 1.2914855480 * b, 3)
    return (
      r: gamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
      g: gamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
      b: gamma(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s)
    )
  }

  private static func linear(_ c: Double) -> Double {
    c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4)
  }

  private static func gamma(_ c: Double) -> Double {
    let clamped = min(max(c, 0), 1)
    return clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * pow(clamped, 1 / 2.4) - 0.055
  }
}

@MainActor
final class ArtworkFieldCache {
  static let shared = ArtworkFieldCache()
  private var fields: [URL: ArtworkField] = [:]

  func field(for url: URL) -> ArtworkField? { fields[url] }

  func load(_ url: URL) async -> ArtworkField {
    if let known = fields[url] { return known }
    let data = try? await URLSession.shared.data(from: url).0
    let field = data.flatMap(ArtworkField.from(imageData:)) ?? .brand
    fields[url] = field
    return field
  }
}

public struct ArtworkBackdrop: View {
  public enum Style: Sendable {
    case page
    case card
  }

  public let url: URL?
  public let style: Style
  @State private var field: ArtworkField?
  @Environment(\.colorScheme) private var colorScheme

  public init(url: URL?, style: Style = .page) {
    self.url = url
    self.style = style
  }

  public var body: some View {
    let known = field ?? url.flatMap(ArtworkFieldCache.shared.field(for:))
    let tone = known.map { $0.color(dark: colorScheme == .dark) } ?? Color.orbis.paper
    surface(tone)
      .orbisAnimation(.pageTinted, value: known)
      .task(id: url) {
        guard let url else {
          field = .brand
          return
        }
        field = await ArtworkFieldCache.shared.load(url)
      }
      .accessibilityHidden(true)
  }

  @ViewBuilder private func surface(_ tone: Color) -> some View {
    switch style {
    case .page:
      LinearGradient(
        stops: [
          .init(color: tone, location: 0),
          .init(color: tone, location: 0.22),
          .init(color: tone.mix(with: Color.orbis.paper, by: 0.35), location: 0.42),
          .init(color: tone.mix(with: Color.orbis.paper, by: 0.75), location: 0.62),
          .init(color: Color.orbis.paper, location: 0.85),
        ],
        startPoint: .top, endPoint: .bottom
      )
      .ignoresSafeArea()
    case .card:
      tone
    }
  }
}
