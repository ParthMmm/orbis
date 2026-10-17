import SwiftUI

/// Three bars that bounce like an equalizer, for someone listening now. Each keeps its own
/// pace, so the pattern does not visibly repeat. Still when Reduce Motion is on.
///
/// `EqualizerBars` marks the Set in this device's player; these mark another Person's, so they
/// are green, the colour of the dot on a listening Person's disc.
public struct LiveBars: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @ScaledMetric private var height: CGFloat

  /// `height` is at the default text size: 10 beside a footnote on a phone, larger on a TV,
  /// where nothing scales the text.
  public init(height: CGFloat = 10) {
    _height = ScaledMetric(wrappedValue: height, relativeTo: .footnote)
  }

  public var body: some View {
    TimelineView(.animation(paused: reduceMotion)) { context in
      let time = context.date.timeIntervalSinceReferenceDate
      HStack(alignment: .bottom, spacing: height / 5) {
        ForEach(0..<3, id: \.self) { index in
          RoundedRectangle(cornerRadius: height / 10)
            .fill(Color.green.gradient)
            .frame(width: height * 0.3, height: height * level(index, time))
        }
      }
      .frame(height: height, alignment: .bottom)
    }
    .shadow(color: .green.opacity(0.6), radius: height * 0.3)
    .accessibilityHidden(true)
  }

  private func level(_ index: Int, _ time: TimeInterval) -> CGFloat {
    let speeds: [Double] = [6.1, 8.3, 7.0]
    let main = sin(time * speeds[index] + Double(index) * 2.1)
    let second = sin(time * speeds[index] * 1.7 + Double(index))
    return 0.25 + 0.75 * CGFloat((main * 0.65 + second * 0.35) * 0.5 + 0.5)
  }
}

#Preview("Live bars") {
  HStack(spacing: 24) {
    LiveBars()
    LiveBars(height: 24)
  }
  .padding()
  .background(Color.orbis.paper)
}
