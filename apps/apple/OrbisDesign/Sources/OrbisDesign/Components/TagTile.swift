import SwiftUI

/// A Tag as a place to go: a tile in the Tag's colour with its name and how many Sets carry it.
/// The Library lays them out in a grid, the way a music app lays out genres, and pressing one
/// filters the list by it.
///
/// `active` marks the Tag the Library is filtered by with a ring and a checkmark, so the state
/// survives any colour setting.
public struct TagTile: View {
  public let name: String
  public let count: Int
  public let category: OrbisColor.Category
  public let active: Bool

  public init(_ name: String, count: Int, category: OrbisColor.Category, active: Bool = false) {
    self.name = name
    self.count = count
    self.category = category
    self.active = active
  }

  /// "1 set", "14 sets".
  public static func countLabel(_ count: Int) -> String {
    count == 1 ? "1 set" : "\(count) sets"
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack(alignment: .firstTextBaseline) {
        Text(name)
          .font(.headline)
          .foregroundStyle(category.text)
          .lineLimit(2)
        Spacer(minLength: 0)
        if active {
          Image(systemName: "checkmark.circle.fill")
            .foregroundStyle(category.text)
        }
      }
      Spacer(minLength: 0)
      Text(Self.countLabel(count))
        .font(.orbis.detail)
        .monospacedDigit()
        .foregroundStyle(.secondary)
    }
    .padding(12)
    .frame(maxWidth: .infinity, minHeight: 76, alignment: .leading)
    .background(category.dot.opacity(active ? 0.32 : 0.18), in: .rect(cornerRadius: Radius.list))
    .overlay {
      if active {
        RoundedRectangle(cornerRadius: Radius.list).strokeBorder(category.text, lineWidth: 1.5)
      }
    }
    .contentShape(.rect(cornerRadius: Radius.list))
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("\(name), \(Self.countLabel(count))")
    .accessibilityAddTraits(active ? [.isSelected] : [])
  }
}

/// Tag tiles two to a row on a phone, more where there is room.
public struct TagGrid<Content: View>: View {
  @ViewBuilder public let content: () -> Content

  public init(@ViewBuilder content: @escaping () -> Content) {
    self.content = content
  }

  public var body: some View {
    LazyVGrid(
      columns: [GridItem(.adaptive(minimum: 150), spacing: 12)], alignment: .leading, spacing: 12
    ) {
      content()
    }
  }
}

#Preview("Tag tiles") {
  TagGrid {
    TagTile("techno", count: 14, category: .indigo, active: true)
    TagTile("house", count: 9, category: .yellow)
    TagTile("festival", count: 7, category: .pink)
    TagTile("breaks", count: 1, category: .green)
  }
  .padding()
  .background(Color.orbis.paper)
}

#Preview("Tag tiles, dark") {
  TagGrid {
    TagTile("techno", count: 14, category: .indigo)
    TagTile("house", count: 9, category: .yellow, active: true)
    TagTile("festival", count: 7, category: .pink)
    TagTile("boiler room", count: 3, category: .purple)
  }
  .padding()
  .background(Color.orbis.paper)
  .preferredColorScheme(.dark)
}
