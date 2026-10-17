import OrbisDesign
import SwiftUI

/// Every Set the People this Person sees have saved, as one Library (ADR 0009). There is no
/// Group-wide route, so each visible Person's Library is read and the answers are merged: a Set
/// several People saved shows once, with each of them on it.
@MainActor
@Observable
final class GroupLibraryModel {
  /// A Set in the Group Library and who saved it, newest saver first.
  struct Entry: Identifiable, Equatable {
    var set: SavedSet
    var savers: [PersonFilters]
    /// When its newest saver saved it.
    var savedAt: Date

    var id: String { set.id }
  }

  struct Content: Equatable {
    /// Newest first.
    var entries: [Entry]
    /// People whose Library could not be read this time, so the page can say it is partial.
    var missing: [PersonFilters]
  }

  private let app: AppModel
  var state: Loadable<Content> = .idle
  /// Sets saved from the Group Library, so their button says so before the Library reloads.
  var savedIds: Set<String> = []
  private var loadedFor: [String] = []

  init(app: AppModel) {
    self.app = app
  }

  var entries: [Entry] {
    if case .loaded(let content) = state { content.entries } else { [] }
  }

  /// Reads each visible Person's Library at once. A reload for the same People keeps what is
  /// shown until the new answer arrives, so pulling to refresh does not blank the page.
  func load(_ people: [PersonFilters]) async {
    let visible = people.filter(\.see)
    guard let client = app.client else { return }
    let ids = visible.map(\.id)
    var isShowing = false
    if case .loaded = state { isShowing = true }
    if loadedFor != ids || !isShowing { state = .loading }
    loadedFor = ids
    guard !visible.isEmpty else {
      state = .loaded(Content(entries: [], missing: []))
      return
    }
    let answers = await withTaskGroup(of: (PersonFilters, Result<[SavedSet], any Error>).self) { group in
      for person in visible {
        group.addTask {
          do {
            return (person, .success(try await client.friendSets(person.id)))
          } catch {
            return (person, .failure(error))
          }
        }
      }
      var answers: [(PersonFilters, Result<[SavedSet], any Error>)] = []
      for await answer in group { answers.append(answer) }
      return answers
    }
    guard !Task.isCancelled else { return }
    var merged: [String: Entry] = [:]
    var missing: [PersonFilters] = []
    var firstFailure: (any Error)?
    for (person, result) in answers {
      switch result {
      case .success(let sets):
        for set in sets {
          let savedAt = SetPresentation.date(from: set.createdAt)
          if var entry = merged[set.id] {
            entry.savers.append(person)
            entry.savedAt = max(entry.savedAt, savedAt)
            merged[set.id] = entry
          } else {
            merged[set.id] = Entry(set: set, savers: [person], savedAt: savedAt)
          }
        }
      case .failure(let error):
        if let known = error as? OrbisError, case .cancelled = known { return }
        missing.append(person)
        firstFailure = firstFailure ?? error
      }
    }
    if missing.count == visible.count, let firstFailure {
      state = .failed(.explaining(firstFailure, at: client.address))
      return
    }
    let entries = merged.values.sorted { $0.savedAt > $1.savedAt }
    state = .loaded(Content(entries: entries, missing: missing))
  }

  /// Saves a Group Set into the signed-in Person's own Library, by its link.
  func save(_ set: SavedSet) async {
    let saved = await settingsRequest(app, { _ in }, { try await $0.save(url: set.url) })
    if saved != nil {
      savedIds.insert(set.id)
      await app.refreshLibraryQuietly()
    }
  }

  func isInLibrary(_ set: SavedSet) -> Bool {
    savedIds.contains(set.id) || app.savedSet(set.id) != nil
  }

  /// Plays a Group Set here when its audio is on the service.
  func play(_ set: SavedSet) {
    guard set.downloadState == "ready" else { return }
    app.togglePlayback(set.id)
  }
}

// MARK: - On People

/// The way into the Group Library from People: a card with the newest artwork and who it comes
/// from, then a rail of what the Group saved last.
struct GroupLibrarySection: View {
  @Bindable var model: AppModel
  let people: PeopleModel
  @State private var library: GroupLibraryModel
  private static let railLimit = 10

  init(model: AppModel, people: PeopleModel) {
    self.model = model
    self.people = people
    _library = State(initialValue: GroupLibraryModel(app: model))
  }

  private var visible: [PersonFilters] { people.people.filter(\.see) }

  var body: some View {
    VStack(alignment: .leading, spacing: 32) {
      if !visible.isEmpty {
        NavigationLink {
          GroupLibraryScreen(model: model, people: people, library: library)
        } label: {
          card
        }
        .buttonStyle(.orbisPressable)
        .accessibilityIdentifier("group-library")
      }
      if !library.entries.isEmpty {
        newInGroup
      }
    }
    .task(id: visible.map(\.id)) { await library.load(people.people) }
  }

  private var countLine: String {
    let names = ListFormatter.localizedString(byJoining: visible.map(\.username))
    guard case .loaded(let content) = library.state else { return "Everything \(names) saved" }
    let count = content.entries.count
    return "\(count == 1 ? "1 Set" : "\(count) Sets") from \(names)"
  }

  private var card: some View {
    VStack(spacing: 0) {
      SleeveFan(
        seed: "group-library",
        artwork: library.entries.prefix(3).map { SetPresentation.row($0.set).artwork },
        category: .indigo, width: 150
      )
      .frame(maxWidth: .infinity)
      .frame(height: 124)
      .padding(.top, 12)
      HStack(spacing: 12) {
        VStack(alignment: .leading, spacing: 2) {
          Text("Group Library")
            .font(.orbis.title)
          Text(countLine)
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .lineLimit(2)
        }
        Spacer(minLength: 8)
        AvatarStack(people: visible, diameter: 28)
        Image(systemName: "chevron.forward")
          .font(.footnote.weight(.semibold))
          .foregroundStyle(.tertiary)
      }
      .padding(16)
    }
    .orbisRaised(radius: Radius.hero)
    .contentShape(.rect)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Group Library, \(countLine)")
    .accessibilityAddTraits(.isButton)
  }

  private var newInGroup: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack(alignment: .firstTextBaseline) {
        SectionHeading("New in the Group")
        NavigationLink("See All") {
          GroupLibraryScreen(model: model, people: people, library: library)
        }
        .font(.orbis.body)
        .tint(Color.orbis.tint)
        .accessibilityIdentifier("group-library-see-all")
      }
      ScrollView(.horizontal, showsIndicators: false) {
        LazyHStack(alignment: .top, spacing: 14) {
          ForEach(library.entries.prefix(Self.railLimit)) { entry in
            Button {
              library.play(entry.set)
            } label: {
              SetCard(
                title: entry.set.title,
                detail: savedLine(entry),
                artwork: SetPresentation.row(entry.set).artwork
              )
              .overlay(alignment: .topTrailing) {
                AvatarStack(people: entry.savers, diameter: 24)
                  .padding(6)
              }
            }
            .buttonStyle(.orbisPressable)
            .contextMenu { GroupSetMenu(library: library, set: entry.set) }
            .accessibilityIdentifier("group-new-\(entry.id)")
          }
        }
        .padding(.horizontal, 16)
        .scrollTargetLayout()
      }
      .padding(.horizontal, -16)
      .scrollTargetBehavior(.viewAligned)
      .scrollClipDisabled()
    }
  }

  private func savedLine(_ entry: GroupLibraryModel.Entry) -> String {
    let who = entry.savers.first?.username ?? ""
    return "\(who) · \(entry.savedAt.formatted(.relative(presentation: .named)))"
  }
}

// MARK: - The Group Library

/// The Group's Sets in one list: search, a chip per Person to narrow it, what more than one Person
/// saved, and every Set newest first, each playable here and savable into your own Library.
struct GroupLibraryScreen: View {
  @Bindable var model: AppModel
  let people: PeopleModel
  let library: GroupLibraryModel
  @State private var query = ""
  /// The Person the list is narrowed to, or nil for everyone.
  @State private var only: String?

  private var visible: [PersonFilters] { people.people.filter(\.see) }

  private var shown: [GroupLibraryModel.Entry] {
    let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
    return library.entries.filter { entry in
      (only == nil || entry.savers.contains { $0.id == only })
        && (trimmed.isEmpty || entry.set.title.localizedStandardContains(trimmed)
          || (entry.set.creator?.localizedStandardContains(trimmed) ?? false)
          || entry.set.tags.contains { $0.localizedStandardContains(trimmed) })
    }
  }

  private var inCommon: [GroupLibraryModel.Entry] {
    library.entries.filter { $0.savers.count > 1 }
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 24) {
        switch library.state {
        case .idle, .loading:
          ProgressView().frame(maxWidth: .infinity).padding(.top, 40)
        case .failed(let failure):
          UnavailableState(failure: failure, context: "loading the Group Library") {
            Task { await library.load(people.people) }
          }
        case .loaded(let content):
          chips(content)
          if !content.missing.isEmpty {
            Text(
              "Could not read \(ListFormatter.localizedString(byJoining: content.missing.map(\.username)))’s Library just now. Pull to try again."
            )
            .font(.footnote)
            .foregroundStyle(.secondary)
          }
          if only == nil, query.isEmpty, !inCommon.isEmpty {
            savedByMore
          }
          list
        }
      }
      .padding(.horizontal)
      .padding(.bottom, 32)
    }
    .searchable(text: $query, prompt: "Search the Group’s Sets")
    .refreshable { await library.load(people.people) }
    .background {
      ArtworkGlow(url: library.entries.first.flatMap { SetPresentation.pageArtwork($0.set) }, reach: 0.5)
    }
    .navigationTitle("Group Library")
    .accessibilityIdentifier("group-library-page")
  }

  private func chips(_ content: GroupLibraryModel.Content) -> some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 8) {
        PersonChip(label: "Everyone", count: content.entries.count, person: nil, selected: only == nil) {
          only = nil
        }
        ForEach(visible) { person in
          PersonChip(
            label: person.username,
            count: content.entries.filter { $0.savers.contains { $0.id == person.id } }.count,
            person: person, selected: only == person.id
          ) {
            only = only == person.id ? nil : person.id
          }
          .accessibilityIdentifier("group-chip-\(person.username)")
        }
      }
      .padding(.horizontal, 16)
    }
    .padding(.horizontal, -16)
    .scrollClipDisabled()
  }

  private var savedByMore: some View {
    VStack(alignment: .leading, spacing: 14) {
      SectionHeading("Saved by more than one", subtitle: "What your Group keeps coming back to.")
      ScrollView(.horizontal, showsIndicators: false) {
        LazyHStack(alignment: .top, spacing: 14) {
          ForEach(inCommon) { entry in
            Button {
              library.play(entry.set)
            } label: {
              SetCard(
                title: entry.set.title, detail: "\(entry.savers.count) saved",
                artwork: SetPresentation.row(entry.set).artwork
              )
              .overlay(alignment: .topTrailing) {
                AvatarStack(people: entry.savers, diameter: 24).padding(6)
              }
            }
            .buttonStyle(.orbisPressable)
            .contextMenu { GroupSetMenu(library: library, set: entry.set) }
          }
        }
        .padding(.horizontal, 16)
        .scrollTargetLayout()
      }
      .padding(.horizontal, -16)
      .scrollTargetBehavior(.viewAligned)
      .scrollClipDisabled()
    }
  }

  @ViewBuilder
  private var list: some View {
    let entries = shown
    VStack(alignment: .leading, spacing: 6) {
      SectionHeading(listTitle)
      if entries.isEmpty {
        Text(query.isEmpty ? "Nothing saved yet." : "No Sets match “\(query)”.")
          .font(.orbis.body)
          .foregroundStyle(.secondary)
          .padding(.vertical, 12)
      }
      LazyVStack(spacing: 0) {
        ForEach(entries) { entry in
          GroupSetRow(model: model, library: library, entry: entry)
            .contextMenu { GroupSetMenu(library: library, set: entry.set) }
        }
      }
    }
  }

  private var listTitle: String {
    guard let only, let person = visible.first(where: { $0.id == only }) else { return "All Sets" }
    return "\(person.username)’s Sets"
  }
}

/// A Set in the Group Library: artwork, title, who saved it and when, and a button that saves it
/// into your own Library or says it is already there.
private struct GroupSetRow: View {
  @Bindable var model: AppModel
  let library: GroupLibraryModel
  let entry: GroupLibraryModel.Entry
  @ScaledMetric(relativeTo: .body) private var saveSide: CGFloat = 44
  @ScaledMetric(relativeTo: .subheadline) private var saverSide: CGFloat = 18

  private var set: SavedSet { entry.set }
  private var isCurrent: Bool { model.audioPlayer.currentSetId == set.id }
  private var inLibrary: Bool { library.isInLibrary(set) }

  var body: some View {
    HStack(spacing: 12) {
      Button {
        library.play(set)
      } label: {
        HStack(spacing: 12) {
          Artwork(url: SetPresentation.row(set).artwork, seed: set.title, size: .row)
          VStack(alignment: .leading, spacing: 3) {
            Text(set.title)
              .font(.orbis.body.weight(.medium))
              .foregroundStyle(isCurrent ? Color.orbis.tint : Color.primary)
              .lineLimit(1)
            HStack(spacing: 6) {
              AvatarStack(people: entry.savers, diameter: saverSide)
              Text(detail)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            }
          }
          Spacer(minLength: 0)
        }
        .contentShape(.rect)
      }
      .buttonStyle(.plain)
      .accessibilityElement(children: .ignore)
      .accessibilityLabel("\(set.title), saved by \(saverNames)")
      .accessibilityHint(set.downloadState == "ready" ? "Plays this Set" : "Not downloaded yet")
      Button {
        Task { await library.save(set) }
      } label: {
        Image(systemName: inLibrary ? "checkmark" : "plus")
          .font(.body.weight(.semibold))
          .foregroundStyle(inLibrary ? Color.green : Color.orbis.tint)
          .frame(width: saveSide, height: saveSide)
          .contentShape(.rect)
      }
      .buttonStyle(.plain)
      .disabled(inLibrary)
      .accessibilityLabel(inLibrary ? "In your Library" : "Save \(set.title) to your Library")
      .accessibilityIdentifier("group-save-\(set.id)")
    }
    .padding(.vertical, 6)
  }

  private var saverNames: String {
    ListFormatter.localizedString(byJoining: entry.savers.map(\.username))
  }

  private var detail: String {
    var parts: [String] = []
    if let creator = set.creator, !creator.isEmpty { parts.append(creator) }
    parts.append(entry.savedAt.formatted(.relative(presentation: .named)))
    if set.downloadState != "ready" { parts.append("Not downloaded") }
    return parts.joined(separator: " · ")
  }
}

/// Play and Save, for a long press on a Group Set.
private struct GroupSetMenu: View {
  let library: GroupLibraryModel
  let set: SavedSet

  var body: some View {
    if set.downloadState == "ready" {
      Button("Play", systemImage: "play.fill") { library.play(set) }
    }
    if !library.isInLibrary(set) {
      Button("Save to Library", systemImage: "plus") { Task { await library.save(set) } }
    }
  }
}

/// Up to three People as overlapping discs, then how many more.
private struct AvatarStack: View {
  let people: [PersonFilters]
  let diameter: CGFloat

  var body: some View {
    HStack(spacing: -diameter / 3) {
      ForEach(people.prefix(3)) { person in
        PersonAvatar(person.username, diameter: diameter)
          .overlay { Circle().strokeBorder(OrbisColor.paper, lineWidth: max(1.5, diameter / 14)) }
      }
      if people.count > 3 {
        Text("+\(people.count - 3)")
          .font(.caption2.weight(.bold))
          .foregroundStyle(.secondary)
          .padding(.leading, diameter / 3 + 2)
      }
    }
    .accessibilityHidden(true)
  }
}

/// A chip that narrows the Group Library to one Person, or to everyone.
private struct PersonChip: View {
  let label: String
  let count: Int
  let person: PersonFilters?
  let selected: Bool
  let action: () -> Void
  @ScaledMetric(relativeTo: .subheadline) private var avatarSide: CGFloat = 26

  var body: some View {
    Button(action: action) {
      HStack(spacing: 7) {
        if let person {
          PersonAvatar(person.username, diameter: avatarSide)
        }
        Text(label)
          .font(.subheadline.weight(.semibold))
        Text(count, format: .number)
          .font(.caption.weight(.semibold))
          .monospacedDigit()
          .opacity(0.7)
      }
      .foregroundStyle(selected ? Color.white : Color.primary)
      .padding(.leading, person == nil ? 14 : 6)
      .padding(.trailing, 14)
      .frame(minHeight: 40)
      .background(selected ? Color.orbis.tint : Color.orbis.paperRaised, in: .capsule)
      .contentShape(.capsule)
    }
    .buttonStyle(.plain)
    .accessibilityLabel("\(label), \(count) Sets")
    .accessibilityAddTraits(selected ? .isSelected : [])
  }
}
