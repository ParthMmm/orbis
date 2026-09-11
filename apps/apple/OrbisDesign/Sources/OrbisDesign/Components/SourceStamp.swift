import SwiftUI

/// Where a Set lives. Neutral by design: the source is information, not a brand.
public struct SourceStamp: View {
  public let source: String

  public init(_ source: String) {
    self.source = source
  }

  public var body: some View {
    Text(source)
      .font(.orbis.stamp)
      .textCase(.uppercase)
      .padding(.horizontal, 6)
      .padding(.vertical, 3)
      .overlay(RoundedRectangle(cornerRadius: Radius.chip).strokeBorder(.tertiary))
      .accessibilityLabel(source)
  }
}

#Preview("Stamp") {
  HStack {
    SourceStamp("YouTube")
    SourceStamp("SoundCloud")
  }
  .padding()
}
