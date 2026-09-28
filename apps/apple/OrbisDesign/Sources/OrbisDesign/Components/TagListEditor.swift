import SwiftUI

public struct TagListEditor: View {
  @Binding public var tags: [String]
  public let suggestions: [String]
  public let category: @MainActor (String) -> OrbisColor.Category

  @State private var draft = ""
  @FocusState private var isAdding: Bool

  public init(
    tags: Binding<[String]>, suggestions: [String] = [],
    category: @escaping @MainActor (String) -> OrbisColor.Category = OrbisColor.Category.forTag
  ) {
    _tags = tags
    self.suggestions = suggestions
    self.category = category
  }

  private var offered: [String] {
    Array(TagInput.suggestions(from: suggestions, chosen: tags).prefix(12))
  }

  private var isFull: Bool { tags.count >= TagInput.serviceLimit }

  public var body: some View {
    if !tags.isEmpty {
      Section("Tags") {
        ForEach(tags, id: \.self) { tag in
          HStack(spacing: 12) {
            Circle()
              .fill(category(tag).dot)
              .frame(width: 10, height: 10)
              .accessibilityHidden(true)
            Text(tag)
            Spacer()
            Button("Remove \(tag)", systemImage: "minus.circle.fill") { remove(tag) }
              .labelStyle(.iconOnly)
              .foregroundStyle(.secondary)
              .buttonStyle(.plain)
              .accessibilityIdentifier("tag-remove-\(tag)")
          }
        }
        .onDelete { offsets in tags.remove(atOffsets: offsets) }
      }
    }

    Section {
      HStack {
        TextField("Add a Tag", text: $draft)
          .focused($isAdding)
          .submitLabel(.done)
          .onSubmit { add(draft) }
          .autocorrectionDisabled()
          #if os(iOS)
            .textInputAutocapitalization(.never)
          #endif
          .disabled(isFull)
          .accessibilityIdentifier("tag-field")
        Button("Add", systemImage: "plus.circle.fill") { add(draft) }
          .labelStyle(.iconOnly)
          .font(.title3)
          .foregroundStyle(Color.orbis.tint)
          .buttonStyle(.plain)
          .disabled(TagInput.normalize(draft) == nil || isFull)
      }
    } footer: {
      Text(
        isFull
          ? "A Set holds up to \(TagInput.serviceLimit) Tags."
          : "Press Return to add a Tag."
      )
    }

    if !offered.isEmpty, !isFull {
      Section("Your Tags") {
        ForEach(offered, id: \.self) { tag in
          Button {
            add(tag)
          } label: {
            HStack(spacing: 12) {
              Circle()
                .fill(category(tag).dot)
                .frame(width: 10, height: 10)
                .accessibilityHidden(true)
              Text(tag)
                .foregroundStyle(.primary)
              Spacer()
              Image(systemName: "plus")
                .foregroundStyle(Color.orbis.tint)
                .accessibilityHidden(true)
            }
          }
          .tint(.primary)
          .accessibilityLabel("Add \(tag)")
          .accessibilityIdentifier("tag-suggestion-\(tag)")
        }
      }
    }
  }

  private func add(_ raw: String) {
    tags = TagInput.adding(raw, to: tags)
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
