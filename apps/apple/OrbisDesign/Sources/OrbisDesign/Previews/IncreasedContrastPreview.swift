import SwiftUI

enum IncreasedContrastPreview {
  static func color(_ dynamic: DynamicColor) -> Color {
    dynamic.color(setting: .increased)
  }

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
