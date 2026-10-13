import SwiftUI

/// A Set's artwork, as the provider supplies it: a 16:9 thumbnail.
///
/// The box is 16:9 and the image is cropped into it, because a provider's image does not always
/// arrive as one. YouTube's `high` thumbnail is 480x360 with the picture letterboxed inside it,
/// and an image left to size itself hands that 4:3 shape, bars and all, back to the box.
///
/// Rounded, with a hairline inner edge so dark artwork does not dissolve into a dark page. Until
/// the image arrives, or when there is none, a tone stands in, chosen from the title so the same
/// Set keeps the same tone.
///
/// A Set with a Playback Position that is not Finished carries a bar along the bottom edge,
/// in the tint, the way a thumbnail shows how far a person got. Nothing else draws on the
/// artwork, so the bar means one thing.
public struct Artwork: View {
  /// The widths a listing draws artwork at. Height follows at 16:9.
  public enum Size: Sendable {
    /// In a row: 88 points wide.
    case row
    /// The lead item, or a mini player's thumb: 120 points wide.
    case lead
    /// A small card, or artwork tucked in a Playlist's folder: 150 points wide.
    case rail
    /// A card in a horizontal rail on Home: 168 points wide.
    case card
    /// Across the top of a page: as wide as it is offered.
    case header

    var radius: CGFloat {
      switch self {
      case .row: Radius.artwork
      case .lead, .rail, .card: Radius.button
      case .header: Radius.cover
      }
    }

    public var width: CGFloat? {
      switch self {
      case .row: 88
      case .lead: 120
      case .rail: 150
      case .card: 168
      case .header: nil
      }
    }
  }

  public let url: URL?
  /// What the placeholder tone is drawn from, usually the title.
  public let seed: String
  public let size: Size
  /// How far listening got, from 0 to 1. Nothing is drawn when it is absent, zero, or done.
  public let progress: Double?
  /// Overrides the size's corner radius, for artwork set inside a card that rounds it already.
  public let cornerRadius: CGFloat?

  public init(
    url: URL?, seed: String, size: Size = .row, progress: Double? = nil,
    cornerRadius: CGFloat? = nil
  ) {
    self.url = url
    self.seed = seed
    self.size = size
    self.progress = progress
    self.cornerRadius = cornerRadius
  }

  /// Whether a bar is worth drawing. A position that never started or already finished says
  /// nothing a bar could add.
  public static func showsProgress(_ progress: Double?) -> Bool {
    guard let progress else { return false }
    return progress > 0 && progress < 1
  }

  public var body: some View {
    Self.box(size: size, radius: cornerRadius ?? size.radius) {
      image.overlay(alignment: .bottom) {
        if Self.showsProgress(progress), let progress {
          ProgressBar(fraction: progress)
        }
      }
    }
    .accessibilityHidden(true)
  }

  /// The shape the artwork is drawn in: a 16:9 box that sizes itself and crops what it is given.
  ///
  /// The box owns the ratio, not the image, which is the whole of it. Held on the image instead,
  /// a `fit` ratio hands the proposal to an image that answers with its own shape, and a
  /// letterboxed thumbnail then sets the box to 4:3 and keeps its bars.
  ///
  /// Internal, so a test can put a letterboxed image in the real box and read the pixels back.
  static func box<Content: View>(
    size: Size, radius: CGFloat? = nil, @ViewBuilder content: () -> Content
  ) -> some View {
    let radius = radius ?? size.radius
    return
    Color.clear
      .aspectRatio(16 / 9, contentMode: .fit)
      .frame(width: size.width)
      .frame(maxWidth: size == .header ? .infinity : nil)
      .overlay { content() }
      .clipShape(.rect(cornerRadius: radius))
      .overlay {
        RoundedRectangle(cornerRadius: radius)
          .strokeBorder(.white.opacity(0.12), lineWidth: 0.5)
      }
  }

  @ViewBuilder private var image: some View {
    if let url {
      AsyncImage(url: url) { phase in
        if let image = phase.image {
          image.resizable().aspectRatio(contentMode: .fill)
        } else {
          placeholder
        }
      }
    } else {
      placeholder
    }
  }

  private var placeholder: some View {
    // The tone comes from the same hash Tags use, so it is stable across launches.
    let tone = OrbisColor.Category.forTag(seed).dot
    return LinearGradient(
      colors: [tone.opacity(0.55), tone.opacity(0.2)],
      startPoint: .topLeading, endPoint: .bottomTrailing
    )
    .overlay {
      Image(systemName: "waveform")
        .font(.title2.weight(.semibold))
        .foregroundStyle(.white.opacity(0.35))
    }
  }
}

/// The bar along the bottom of artwork. A dark track under a tinted fill, so it reads on any
/// image.
private struct ProgressBar: View {
  let fraction: Double

  var body: some View {
    GeometryReader { proxy in
      ZStack(alignment: .leading) {
        Color.black.opacity(0.35)
        Color.orbis.tint.frame(width: proxy.size.width * fraction)
      }
    }
    .frame(height: 3)
  }
}

#Preview("Artwork") {
  VStack(alignment: .leading, spacing: 16) {
    HStack(spacing: 12) {
      Artwork(url: nil, seed: "Ben UFO — Dekmantel Festival 2019")
      Artwork(url: nil, seed: "Objekt — Live at Freerotation", progress: 0.34)
      Artwork(url: nil, seed: "DJ Stingray 313", progress: 1)
    }
    Artwork(url: nil, seed: "KETTAMA @ Creamfields 2026", size: .lead, progress: 0.57)
    Artwork(url: nil, seed: "KETTAMA @ Creamfields 2026", size: .header, progress: 0.57)
  }
  .padding()
  .background(Color.orbis.paper)
}
