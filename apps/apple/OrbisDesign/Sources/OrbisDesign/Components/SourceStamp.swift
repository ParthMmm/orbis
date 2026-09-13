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

#Preview("Stamp, xxxLarge and accessibility5, RTL, Mac") {
  AccessibilitySizeMatrix(width: AccessibilityPreview.macWidth) { StampPair() }
}

#Preview("Stamp, xxxLarge and accessibility5, RTL, iPhone") {
  AccessibilitySizeMatrix(width: AccessibilityPreview.phoneWidth) { StampPair() }
}

/// Two stamps side by side, the arrangement the accessibility previews draw at each size.
private struct StampPair: View {
  var body: some View {
    HStack {
      SourceStamp("YouTube")
      SourceStamp("SoundCloud")
    }
    .padding()
  }
}
