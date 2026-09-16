import SwiftUI

/// The vocabulary of a listing: the Library, the Queue, a Set's rows.
///
/// A listing is dense and flat. Labels are small, uppercase and monospaced; rows are parted by
/// hairlines; a heavier rule opens the list under its title. Nothing in a listing is raised.

/// A label in a listing: a day, a field name, a count. Uppercase and tracked so it reads as a
/// label and never as a value.
public struct ListingLabel: View {
  public let text: String
  public let tint: Color?

  public init(_ text: String, tint: Color? = nil) {
    self.text = text
    self.tint = tint
  }

  public var body: some View {
    Text(text)
      .font(.orbis.label)
      .textCase(.uppercase)
      .tracking(1)
      .foregroundStyle(tint.map(AnyShapeStyle.init) ?? AnyShapeStyle(.secondary))
      .accessibilityLabel(text)
  }
}

/// The heading a group of rows sits under, such as the day they were filed.
public struct ListingHeader: View {
  public let text: String

  public init(_ text: String) {
    self.text = text
  }

  public var body: some View {
    ListingLabel(text)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.top, 18)
      .padding(.bottom, 8)
      .accessibilityAddTraits(.isHeader)
  }
}

/// The rule that opens a listing under its title. Heavier than a hairline, in the tint: the
/// one line of the corona on a page, so the palette shows where a list begins.
public struct ListingRule: View {
  public init() {}

  public var body: some View {
    Rectangle()
      .fill(Color.orbis.tint)
      .frame(height: 2)
      .accessibilityHidden(true)
  }
}

/// A Tag as a listing writes it: `#techno`, monospaced, in the Tag's colour. `active` marks
/// the Tag the listing is filtered by with an underline, which survives any colour setting.
public struct TagWord: View {
  public let name: String
  public let category: OrbisColor.Category
  public let active: Bool

  public init(_ name: String, category: OrbisColor.Category, active: Bool = false) {
    self.name = name
    self.category = category
    self.active = active
  }

  public var body: some View {
    Text("#\(name)")
      .font(.orbis.mono)
      .fontWeight(active ? .medium : .regular)
      .underline(active)
      .foregroundStyle(category.text)
      .accessibilityLabel(active ? "\(name), active filter" : name)
  }
}

/// One row of a Set's fields: a label, a value, and the way to change it. Parted from the
/// next by a hairline. At the largest sizes the value moves under the label rather than being
/// squeezed out.
public struct ListingRow<Value: View>: View {
  public let label: String
  public var value: String?
  public let action: (() -> Void)?
  public let identifier: String?
  @ViewBuilder public let content: () -> Value

  @Environment(\.dynamicTypeSize) private var typeSize

  public init(
    _ label: String, value: String? = nil, action: (() -> Void)? = nil,
    identifier: String? = nil, @ViewBuilder content: @escaping () -> Value
  ) {
    self.label = label
    self.value = value
    self.action = action
    self.identifier = identifier
    self.content = content
  }

  public var body: some View {
    Group {
      if let action {
        Button(action: action) { arrangement.contentShape(.rect) }
          .buttonStyle(.plain)
      } else {
        arrangement
      }
    }
    .orbisRowHeight()
    .padding(.vertical, 12)
    .overlay(alignment: .bottom) { Divider() }
    .accessibilityIdentifier(identifier)
  }

  @ViewBuilder private var arrangement: some View {
    if typeSize.isAccessibilitySize {
      VStack(alignment: .leading, spacing: 6) {
        HStack(spacing: 8) {
          ListingLabel(label)
          Spacer()
          disclosure
        }
        valueText
        content()
      }
    } else {
      HStack(spacing: 8) {
        ListingLabel(label)
        Spacer()
        valueText.lineLimit(1)
        content()
        disclosure
      }
    }
  }

  @ViewBuilder private var valueText: some View {
    if let value {
      Text(value)
        .font(.orbis.mono)
        .foregroundStyle(.secondary)
    }
  }

  /// `chevron.forward`, not `chevron.right`: the disclosure points the way the language reads,
  /// and the system mirrors it in a right-to-left layout.
  @ViewBuilder private var disclosure: some View {
    if action != nil {
      Image(systemName: "chevron.forward")
        .font(.orbis.caption)
        .foregroundStyle(.tertiary)
    }
  }
}

extension View {
  /// An identifier only when the caller gave one. Setting an empty one on a row takes the
  /// identifiers off the controls inside it.
  @ViewBuilder fileprivate func accessibilityIdentifier(_ identifier: String?) -> some View {
    if let identifier {
      accessibilityIdentifier(identifier)
    } else {
      self
    }
  }
}

extension ListingRow where Value == EmptyView {
  public init(
    _ label: String, value: String? = nil, action: (() -> Void)? = nil,
    identifier: String? = nil
  ) {
    self.init(label, value: value, action: action, identifier: identifier) { EmptyView() }
  }
}

#Preview("Listing") {
  VStack(alignment: .leading, spacing: 0) {
    Text("Library").font(.orbis.largeTitle)
    ListingRule().padding(.top, 12)
    HStack {
      ListingLabel("8 sets · 11h 42m kept")
      Spacer()
      TagWord("techno", category: .pink, active: true)
      TagWord("house", category: .yellow)
    }
    .padding(.vertical, 12)
    .overlay(alignment: .bottom) { Divider() }
    ListingHeader("Thu 11 Sep")
    ListingRow("Tags") { TagWord("techno", category: .pink) }
    ListingRow("Playlist", value: "None", action: {})
    ListingRow("Kept audio", value: "112 MB")
  }
  .padding()
  .background(Color.orbis.paper)
}

#Preview("Listing, dark") {
  VStack(alignment: .leading, spacing: 0) {
    ListingRule()
    ListingHeader("Wed 10 Sep")
    ListingRow("Source", value: "YouTube") {
      Button("Open") {}.buttonStyle(.plain).foregroundStyle(Color.orbis.tint)
    }
  }
  .padding()
  .background(Color.orbis.paper)
  .preferredColorScheme(.dark)
}
