import SwiftUI

/// The Tags on a Set, typed or picked from the ones the library already holds.
///
/// The service is the authority on what a Tag is. It trims, lowercases, and deduplicates
/// every list it is given, and refuses a list longer than twenty or a Tag longer than forty
/// characters. The field applies those rules on the way in, so nothing typed here comes back
/// refused, and the two rules live in one place instead of drifting apart.
public struct TagInput: View {
  @Binding public var tags: [String]
  public let suggestions: [String]
  public let limit: Int
  public let category: @MainActor (String) -> OrbisColor.Category

  @State private var draft = ""
  @FocusState private var focused: Bool

  public init(
    tags: Binding<[String]>, suggestions: [String] = [], limit: Int = TagInput.serviceLimit,
    category: @escaping @MainActor (String) -> OrbisColor.Category = OrbisColor.Category.forTag
  ) {
    _tags = tags
    self.suggestions = suggestions
    self.limit = limit
    self.category = category
  }

  /// What the service keeps: twenty Tags, each forty characters.
  public static let serviceLimit = 20
  public static let serviceTagLength = 40

  /// The service's rule, applied on the way in: trim, lowercase, drop the empty, and cap the
  /// length rather than refuse it.
  public static func normalize(_ raw: String) -> String? {
    let tag = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard !tag.isEmpty else { return nil }
    return String(tag.prefix(serviceTagLength))
  }

  /// A Tag joins the list once, and the list stops at the limit.
  public static func adding(
    _ raw: String, to tags: [String], limit: Int = TagInput.serviceLimit
  ) -> [String] {
    guard tags.count < limit, let tag = normalize(raw), !tags.contains(tag) else { return tags }
    return tags + [tag]
  }

  /// The Tags worth offering: the ones not already chosen, normalized, each offered once.
  public static func suggestions(from available: [String], chosen: [String]) -> [String] {
    var taken = Set(chosen)
    var offered: [String] = []
    for candidate in available {
      guard let tag = normalize(candidate), taken.insert(tag).inserted else { continue }
      offered.append(tag)
    }
    return offered
  }

  private var open: [String] { Self.suggestions(from: suggestions, chosen: tags) }

  private var hint: String {
    tags.count >= limit
      ? "\(limit) Tags is all the service keeps."
      : "Press Return to add a Tag."
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        Image(systemName: "tag").foregroundStyle(.secondary)
        TextField("Add a Tag", text: $draft)
          .textFieldStyle(.plain)
          .focused($focused)
          .onSubmit(commit)
          .autocorrectionDisabled()
          #if os(iOS)
            .textInputAutocapitalization(.never)
          #endif
        Button("Add", action: commit)
          .buttonStyle(.plain)
          .foregroundStyle(Color.orbis.tint)
          .disabled(Self.normalize(draft) == nil || tags.count >= limit)
      }
      .padding(.leading)
      .padding(.vertical, 6)
      .padding(.trailing)
      .background(Color.orbis.field, in: .rect(cornerRadius: Radius.field))
      if !tags.isEmpty {
        ChipFlow {
          ForEach(tags, id: \.self) { tag in
            HStack(spacing: 2) {
              TagChip(tag, category: category(tag))
              Button {
                tags.removeAll { $0 == tag }
              } label: {
                Image(systemName: "xmark.circle.fill").font(.orbis.mono)
              }
              .buttonStyle(.plain)
              .foregroundStyle(.secondary)
              .accessibilityLabel("Remove \(tag)")
            }
          }
        }
      }
      if !open.isEmpty {
        ScrollView(.horizontal) {
          LazyHStack(spacing: 6) {
            ForEach(open, id: \.self) { tag in
              Button {
                tags = Self.adding(tag, to: tags, limit: limit)
              } label: {
                Label(tag, systemImage: "plus")
                  .font(.orbis.mono)
              }
              .buttonStyle(.bordered)
              .buttonBorderShape(.capsule)
              .accessibilityLabel("Add \(tag)")
            }
          }
        }
        .scrollIndicators(.hidden)
      }
      Text(hint)
        .font(.orbis.mono)
        .foregroundStyle(.secondary)
    }
  }

  private func commit() {
    let next = Self.adding(draft, to: tags, limit: limit)
    guard next != tags else { return }
    tags = next
    draft = ""
  }
}

/// Lays chips out in rows, wrapping when the width runs out. Rows are as tall as the tallest
/// chip in them, so a removed Tag does not move the ones beside it.
struct ChipFlow: Layout {
  var spacing: CGFloat = 6

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let width = proposal.width ?? .infinity
    var lineWidth: CGFloat = 0
    var height: CGFloat = 0
    var lineHeight: CGFloat = 0
    for subview in subviews {
      let size = subview.sizeThatFits(.unspecified)
      if lineWidth > 0, lineWidth + size.width > width {
        height += lineHeight + spacing
        lineWidth = 0
        lineHeight = 0
      }
      lineWidth += size.width + spacing
      lineHeight = max(lineHeight, size.height)
    }
    return CGSize(width: width == .infinity ? lineWidth : width, height: height + lineHeight)
  }

  func placeSubviews(
    in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()
  ) {
    var x = bounds.minX
    var y = bounds.minY
    var lineHeight: CGFloat = 0
    for subview in subviews {
      let size = subview.sizeThatFits(.unspecified)
      if x > bounds.minX, x + size.width > bounds.maxX {
        x = bounds.minX
        y += lineHeight + spacing
        lineHeight = 0
      }
      subview.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
      x += size.width + spacing
      lineHeight = max(lineHeight, size.height)
    }
  }
}

private struct TagInputSample: View {
  @State private var chosen = ["techno", "festival"]
  @State private var empty: [String] = []
  @State private var full = (1...20).map { "tag\($0)" }

  var body: some View {
    VStack(alignment: .leading, spacing: 24) {
      TagInput(tags: $empty, suggestions: ["techno", "house", "breaks"])
      TagInput(
        tags: $chosen, suggestions: ["techno", "house", "breaks", "bass", "festival", "hardcore"])
      TagInput(tags: $full)
    }
    .padding()
    .background(Color.orbis.paper)
  }
}

#Preview("Tag input, Mac") { TagInputSample() }

#Preview("Tag input, Mac, dark") { TagInputSample().preferredColorScheme(.dark) }

#Preview("Tag input, iPhone") { TagInputSample().frame(width: 358) }

#Preview("Tag input, iPhone, dark") {
  TagInputSample().frame(width: 358).preferredColorScheme(.dark)
}
