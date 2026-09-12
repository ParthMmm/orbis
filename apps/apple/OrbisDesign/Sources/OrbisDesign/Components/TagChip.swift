import SwiftUI

/// A Tag on a row: colored dot plus the name. `active` marks the tag the view is filtered by.
public struct TagChip: View {
  public let name: String
  public let category: OrbisColor.Category
  public let active: Bool

  public init(_ name: String, category: OrbisColor.Category, active: Bool = false) {
    self.name = name
    self.category = category
    self.active = active
  }

  public var body: some View {
    HStack(spacing: 5) {
      Circle()
        .fill(category.dot)
        .frame(width: 7, height: 7)
      Text(name)
        .font(.orbis.mono)
        .fontWeight(active ? .medium : .regular)
    }
    .foregroundStyle(active ? AnyShapeStyle(category.text) : AnyShapeStyle(.primary))
    .padding(.horizontal, 7)
    .padding(.vertical, 4)
    .background(active ? category.soft : Color.primary.opacity(0.07), in: .rect(cornerRadius: Radius.chip))
    .accessibilityLabel(active ? "\(name), active filter" : name)
  }
}

/// A Tag as a filter control. Capsule, toggles on and off, tints in the tag's color when on.
public struct TagPill: View {
  public let name: String
  public let category: OrbisColor.Category
  @Binding public var isOn: Bool

  public init(_ name: String, category: OrbisColor.Category, isOn: Binding<Bool>) {
    self.name = name
    self.category = category
    _isOn = isOn
  }

  public var body: some View {
    Toggle(isOn: $isOn) {
      Label {
        Text(name)
      } icon: {
        Circle().fill(category.dot).frame(width: 8, height: 8)
      }
      .labelStyle(.titleAndIcon)
    }
    .toggleStyle(.button)
    .buttonStyle(.bordered)
    .buttonBorderShape(.capsule)
    .tint(isOn ? category.dot : nil)
    .foregroundStyle(isOn ? AnyShapeStyle(category.text) : AnyShapeStyle(.primary))
    .orbisAnimation(.tagToggled, value: isOn)
  }
}

#Preview("Chips and pills") {
  @Previewable @State var techno = true
  @Previewable @State var house = false
  VStack(alignment: .leading) {
    HStack {
      TagChip("techno", category: .pink, active: true)
      TagChip("festival", category: .purple)
      TagChip("breaks", category: .green)
    }
    HStack {
      TagPill("techno", category: .pink, isOn: $techno)
      TagPill("house", category: .yellow, isOn: $house)
    }
  }
  .padding()
  .background(Color.orbis.paper)
}

/// Both chip shapes at the largest text size and in a right-to-left layout, where a row that
/// will not wrap shows itself.
private struct ChipsAndPillsAtLargestText: View {
  @State private var techno = true
  @State private var house = false

  var body: some View {
    VStack(alignment: .leading) {
      ChipFlow {
        TagChip("techno", category: .pink, active: true)
        TagChip("festival", category: .purple)
        TagChip("breaks", category: .green)
      }
      ChipFlow {
        TagPill("techno", category: .pink, isOn: $techno)
        TagPill("house", category: .yellow, isOn: $house)
      }
    }
    .padding()
    .orbisAccessibilityLayout()
  }
}

#Preview("Chips and pills, largest text, RTL, Mac") {
  ChipsAndPillsAtLargestText().frame(width: 700)
}

#Preview("Chips and pills, largest text, RTL, iPhone") {
  ChipsAndPillsAtLargestText().frame(width: 358)
}
