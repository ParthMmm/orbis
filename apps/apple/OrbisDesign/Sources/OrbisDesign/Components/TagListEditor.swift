import SwiftUI

/// A Set's Tags as chips, the field that adds one, and the Tags already in use to pick from.
/// `title` heads the section when the editor shares a form with other fields.
public struct TagListEditor: View {
  @Binding public var tags: [String]
  public let suggestions: [String]
  public let title: String?
  public let category: @MainActor (String) -> OrbisColor.Category

  @State private var draft = ""
  @FocusState private var isAdding: Bool

  public init(
    tags: Binding<[String]>, suggestions: [String] = [], title: String? = nil,
    category: @escaping @MainActor (String) -> OrbisColor.Category = OrbisColor.Category.forTag
  ) {
    _tags = tags
    self.suggestions = suggestions
    self.title = title
    self.category = category
  }

  private var offered: [String] {
    Array(TagInput.suggestions(from: suggestions, chosen: tags).prefix(12))
  }

  private var isFull: Bool { tags.count >= TagInput.serviceLimit }

  public var body: some View {
    Group { sections }
      // Picking a Tag you already use is a tap, not typing: it lands without raising the keyboard.
      .sensoryFeedback(trigger: tags) { old, new in
        new.count > old.count ? .impact(flexibility: .soft) : .selection
      }
      .orbisAnimation(.tagToggled, value: tags)
  }

  @ViewBuilder private var sections: some View {
    Section {
      if !tags.isEmpty {
        chips(tags, verb: "Remove", accessory: "xmark", identifier: "tag-remove") { remove($0) }
          #if !os(tvOS)
            .alignmentGuide(.listRowSeparatorLeading) { $0[.leading] }
          #endif
      }
      HStack {
        TextField("Add a Tag", text: $draft)
          .focused($isAdding)
          .submitLabel(.done)
          .onSubmit { add(draft, keepTyping: true) }
          .autocorrectionDisabled()
          #if os(iOS)
            .textInputAutocapitalization(.never)
          #endif
          .disabled(isFull)
          .accessibilityIdentifier("tag-field")
        if TagInput.normalize(draft) != nil, !isFull {
          Button("Add", systemImage: "plus.circle.fill") { add(draft, keepTyping: true) }
            .labelStyle(.iconOnly)
            .font(.title3)
            .foregroundStyle(Color.orbis.tint)
            .buttonStyle(.orbisIcon)
        }
      }
    } header: {
      if let title { Text(title) }
    } footer: {
      if isFull { Text("A Set holds up to \(TagInput.serviceLimit) Tags.") }
    }

    if !offered.isEmpty, !isFull {
      Section("Your Tags") {
        chips(offered, verb: "Add", accessory: "plus", identifier: "tag-suggestion") {
          add($0, keepTyping: false)
        }
      }
    }
  }

  private func chips(
    _ names: [String], verb: String, accessory: String, identifier: String,
    action: @escaping (String) -> Void
  ) -> some View {
    GlassEffectContainer(spacing: 8) {
      ChipFlow(spacing: 8) {
        ForEach(names, id: \.self) { tag in
          Button {
            action(tag)
          } label: {
            GlassTagChip(tag, category: category(tag), accessory: accessory)
          }
          .buttonStyle(.plain)
          .accessibilityLabel("\(verb) \(tag)")
          .accessibilityIdentifier("\(identifier)-\(tag)")
        }
      }
    }
    .padding(.vertical, 4)
  }

  private func add(_ raw: String, keepTyping: Bool) {
    tags = TagInput.adding(raw, to: tags)
    guard keepTyping else { return }
    draft = ""
    isAdding = true
  }

  private func remove(_ tag: String) {
    tags.removeAll { $0 == tag }
  }
}

#Preview("Tag list editor") {
  @Previewable @State var tags = ["techno", "festival"]
  NavigationStack {
    Form {
      TagListEditor(tags: $tags, suggestions: ["house", "breaks", "techno", "ambient"])
    }
    .navigationTitle("Tags")
  }
}
