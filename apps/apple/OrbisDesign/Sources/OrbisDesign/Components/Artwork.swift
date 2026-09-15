import SwiftUI

/// A Set's artwork, as the provider supplies it: a 16:9 thumbnail.
///
/// Square, because the thumbnail is square-cornered where it came from and a listing parts
/// its rows with hairlines rather than cards. Until the image arrives, or when there is none,
/// a flat tone stands in, chosen from the title so the same Set keeps the same tone.
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
    /// Across the top of a page: as wide as it is offered.
    case header

    var width: CGFloat? {
      switch self {
      case .row: 88
      case .lead: 120
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

  public init(url: URL?, seed: String, size: Size = .row, progress: Double? = nil) {
    self.url = url
    self.seed = seed
    self.size = size
    self.progress = progress
  }

  /// Whether a bar is worth drawing. A position that never started or already finished says
  /// nothing a bar could add.
  public static func showsProgress(_ progress: Double?) -> Bool {
    guard let progress else { return false }
    return progress > 0 && progress < 1
  }

  public var body: some View {
    image
      .aspectRatio(16 / 9, contentMode: .fit)
      .frame(width: size.width)
      .frame(maxWidth: size == .header ? .infinity : nil)
      .overlay(alignment: .bottom) {
        if Self.showsProgress(progress), let progress {
          ProgressBar(fraction: progress)
        }
      }
      .clipShape(.rect(cornerRadius: Radius.artwork))
      .accessibilityHidden(true)
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
    OrbisColor.Category.forTag(seed).dot.opacity(0.35)
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
