import SwiftUI

/// The artwork's own colours, blown up and blurred into a field of light behind a page.
///
/// Liquid Glass refracts what is under it, and a flat page gives it nothing to bend. The glow
/// is what the glass reads: a Set's picture, out of focus, so every control floating over it
/// takes that Set's colours. Dark is where it is strongest, the eclipse the icon draws; light
/// keeps a wash of it.
public struct ArtworkGlow: View {
  public let url: URL?
  /// How much of the page the glow covers before it gives way to paper, from 0 to 1.
  public let reach: Double
  @Environment(\.colorScheme) private var colorScheme

  public init(url: URL?, reach: Double = 1) {
    self.url = url
    self.reach = reach
  }

  public var body: some View {
    GeometryReader { proxy in
      ZStack {
        Color.orbis.paper
        AsyncImage(url: url) { phase in
          if let image = phase.image {
            image
              .resizable()
              .aspectRatio(contentMode: .fill)
              .frame(width: proxy.size.width * 1.6, height: proxy.size.height * reach * 1.1)
              .blur(radius: 70, opaque: true)
              .saturation(1.5)
              .opacity(colorScheme == .dark ? 0.85 : 0.5)
              .frame(width: proxy.size.width, height: proxy.size.height * reach)
              .clipped()
              .transition(.opacity)
          }
        }
        .frame(maxHeight: .infinity, alignment: .top)
        .mask {
          LinearGradient(
            stops: [
              .init(color: .black, location: 0),
              .init(color: .black, location: 0.45 * reach),
              .init(color: .clear, location: reach),
            ],
            startPoint: .top, endPoint: .bottom
          )
        }
        // A scrim the colour of the page, so text over the brightest artwork still reads.
        LinearGradient(
          colors: [Color.orbis.paper.opacity(0.15), Color.orbis.paper.opacity(0.55)],
          startPoint: .top, endPoint: .bottom
        )
      }
    }
    .ignoresSafeArea()
    .accessibilityHidden(true)
  }
}

#Preview("Glow and bars") {
  ZStack {
    ArtworkGlow(url: URL(string: "https://i.ytimg.com/vi/c0-hvjV2A5Y/hqdefault.jpg"), reach: 0.7)
    VStack(spacing: 20) {
      EqualizerBars(isPlaying: true).frame(height: 13)
      EqualizerBars(isPlaying: false).frame(height: 13)
      Button("Glass", systemImage: "play.fill") {}
        .buttonStyle(.glass)
    }
  }
  .preferredColorScheme(.dark)
}
