import SwiftUI

/// The vocabulary of a listing: the Library, the Queue, a Set's rows.
///
/// A listing is dense and flat. Labels are small and semibold in sentence case; rows are parted
/// by hairlines. Nothing in a listing is raised.

/// A label in a listing: a day, a count. Semibold and secondary, so it reads as a label and
/// never as a value.
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

/// The hairline that opens a listing under its title. The tint is kept for controls, so the
/// rule is the system separator like every other line in a list.
public struct ListingRule: View {
  public init() {}

  public var body: some View {
    Divider()
      .accessibilityHidden(true)
  }
}

/// A Tag as a listing writes it: a capsule in the Tag's colour, so Tags are the most colourful
/// thing on a row. `active` marks the Tag the listing is filtered by with a checkmark and a
/// stronger fill, which survives any colour setting.
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
    HStack(spacing: 3) {
      if active {
        Image(systemName: "checkmark")
          .imageScale(.small)
      }
      Text(name)
    }
    .font(.orbis.detail.weight(.semibold))
    .foregroundStyle(category.text)
    .padding(.horizontal, 8)
    .padding(.vertical, 3)
    .background(category.dot.opacity(active ? 0.34 : 0.18), in: .capsule)
    .accessibilityElement(children: .ignore)
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
  /// Whether a hairline parts this row from the next. The last row of a card has none.
  public let divided: Bool
  @ViewBuilder public let content: () -> Value

  @Environment(\.dynamicTypeSize) private var typeSize

  public init(
    _ label: String, value: String? = nil, action: (() -> Void)? = nil,
    identifier: String? = nil, divided: Bool = true,
    @ViewBuilder content: @escaping () -> Value
  ) {
    self.label = label
    self.value = value
    self.action = action
    self.identifier = identifier
    self.divided = divided
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
    .overlay(alignment: .bottom) {
      if divided { Divider() }
    }
    .accessibilityIdentifier(identifier)
  }

  @ViewBuilder private var arrangement: some View {
    if typeSize.isAccessibilitySize {
      VStack(alignment: .leading, spacing: 6) {
        HStack(spacing: 8) {
          fieldName
          Spacer()
          disclosure
        }
        valueText
        content()
      }
    } else {
      HStack(spacing: 8) {
        fieldName
        Spacer()
        valueText.lineLimit(1)
        content()
        disclosure
      }
    }
  }

  /// The field's name, in body text the way a Settings row names itself.
  private var fieldName: some View {
    Text(label)
      .font(.orbis.body)
  }

  @ViewBuilder private var valueText: some View {
    if let value {
      Text(value)
        .font(.orbis.body)
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
    identifier: String? = nil, divided: Bool = true
  ) {
    self.init(label, value: value, action: action, identifier: identifier, divided: divided) {
      EmptyView()
    }
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
