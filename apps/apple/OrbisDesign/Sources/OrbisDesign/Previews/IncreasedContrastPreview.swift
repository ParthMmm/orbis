import SwiftUI

/// The appearance the system shows when Increase Contrast is on, for the three surfaces that
/// carry Orbis color: chips, pills, and the paste hero.
///
/// A preview canvas cannot switch the system setting on, so these previews put the real chips,
/// pills, and hero on the increased-contrast surfaces and name every category label at the
/// value the setting switches to. In the running app the components get it from the platform
/// traits, through `DynamicColor.color`.
enum IncreasedContrastPreview {
  /// The increased-contrast value of a generated color.
  static func color(_ dynamic: DynamicColor) -> Color {
    dynamic.color(setting: .increased)
  }

  /// Every category label at the value the setting switches to.
  static var categoryLabels: some View {
    ChipFlow {
      ForEach(OrbisColor.Category.allCases, id: \.self) { category in
        Text(category.rawValue)
          .font(.orbis.caption)
          .foregroundStyle(category.increasedContrastText)
      }
    }
  }
}

#Preview("Chips and pills, increase contrast") {
  @Previewable @State var techno = true
  @Previewable @State var house = false
  VStack(alignment: .leading, spacing: 12) {
    HStack {
      TagChip("techno", category: .pink, active: true)
      TagChip("festival", category: .purple)
      TagChip("breaks", category: .green)
    }
    HStack {
      TagPill("techno", category: .pink, isOn: $techno)
      TagPill("house", category: .yellow, isOn: $house)
    }
    IncreasedContrastPreview.categoryLabels
  }
  .padding()
  .background(IncreasedContrastPreview.color(GeneratedColor.paper))
}

#Preview("Paste hero, increase contrast") {
  @Previewable @State var link = "https://youtu.be/tPEMP9oYxTo"
  PasteHero(link: $link, state: .valid(source: "YouTube")) {}
    .padding()
    .background(IncreasedContrastPreview.color(GeneratedColor.paperRaised))
}

/// The two surfaces and the secondary text shade, so the values the setting switches to are
/// visible side by side with the components above.
#Preview("Increase contrast surfaces") {
  VStack(alignment: .leading, spacing: 0) {
    Text("Secondary text on raised paper")
      .foregroundStyle(IncreasedContrastPreview.color(GeneratedColor.muted))
      .padding()
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(IncreasedContrastPreview.color(GeneratedColor.paperRaised))
    Text("Secondary text on paper")
      .foregroundStyle(IncreasedContrastPreview.color(GeneratedColor.muted))
      .padding()
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(IncreasedContrastPreview.color(GeneratedColor.paper))
  }
}
