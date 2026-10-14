import OrbisDesign
import SwiftUI

/// People (ADR 0009): the invite while the signed-in Person has Social off, and the People who
/// have it on, with See and Appear for each, once they turn it on.
struct PeopleDestination: View {
  @Bindable var model: AppModel
  @State private var people: PeopleModel

  init(model: AppModel) {
    self.model = model
    _people = State(initialValue: PeopleModel(app: model))
  }

  var body: some View {
    content
      .sidebarPageTitle("People")
      .largeTitleOnIOS()
      // Runs on every appearance, so Social turned on in Settings shows when People opens again.
      .task(id: model.client?.token) { await people.load() }
  }

  @ViewBuilder
  private var content: some View {
    switch people.me {
    case .idle, .loading:
      ProgressView()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.orbis.paper)
    case .failed(let failure):
      List {
        FailureRows(failure: failure, context: "loading People", identifier: "people-load-error")
        Button("Try Again") { Task { await people.load() } }
      }
    case .loaded(let me) where !me.social:
      SocialInvite { Task { await people.turnOn() } }
        .safeAreaInset(edge: .bottom) {
          if let failure = people.failure {
            Text(failure.message)
              .font(.orbis.detail)
              .foregroundStyle(OrbisColor.destructive)
              .padding()
              .accessibilityIdentifier("people-error")
          }
        }
    case .loaded:
      list
    }
  }

  private var list: some View {
    List {
      Section {
        if people.people.isEmpty {
          Text("Nobody else has Social on yet.")
            .foregroundStyle(OrbisColor.muted)
            .accessibilityIdentifier("people-empty")
        }
        ForEach(people.people) { person in
          VStack(alignment: .leading, spacing: 8) {
            Text(person.username)
              .font(.orbis.body.weight(.semibold))
            Toggle("See", isOn: filter(person, \.see) { SocialFiltersUpdate(see: $0) })
              .accessibilityIdentifier("people-see-\(person.username)")
            Toggle("Appear", isOn: filter(person, \.appear) { SocialFiltersUpdate(appear: $0) })
              .accessibilityIdentifier("people-appear-\(person.username)")
          }
          .disabled(people.isSaving)
          .accessibilityIdentifier("person-\(person.username)")
        }
        FailureRows(failure: people.failure, context: "changing People", identifier: "people-error")
      } footer: {
        Text("See decides whether a Person is in your People. Appear decides whether they see you.")
      }
    }
    .font(.orbis.body)
    .refreshable { await people.load() }
    .accessibilityIdentifier("people-list")
  }

  private func filter(
    _ person: PersonFilters, _ value: KeyPath<PersonFilters, Bool>,
    _ update: @escaping (Bool) -> SocialFiltersUpdate
  ) -> Binding<Bool> {
    Binding(
      get: { person[keyPath: value] },
      set: { enabled in Task { await people.setFilters(for: person.id, update(enabled)) } })
  }
}

/// What People shows and the requests that change it.
@MainActor
@Observable
final class PeopleModel {
  private let app: AppModel
  var me: Loadable<Me> = .idle
  var people: [PersonFilters] = []
  var failure: OrbisFailure?
  var isSaving = false
  private var loadedToken: String?

  init(app: AppModel) {
    self.app = app
  }

  /// Reads `/me` each time, not once: Social is switched in Settings too, and a stale answer is
  /// what kept this screen on the invite after Social was on.
  func load() async {
    guard app.isConfigured else { return }
    if loadedToken != app.client?.token {
      loadedToken = app.client?.token
      me = .idle
      people = []
      failure = nil
    }
    if case .loaded = me {} else { me = .loading }
    guard
      let person = await settingsRequest(
        app, { if let failure = $0 { self.me = .failed(failure) } }, { try await $0.me() })
    else { return }
    if person.social { await loadPeople() }
    me = .loaded(person)
  }

  func turnOn() async {
    guard !isSaving else { return }
    isSaving = true
    defer { isSaving = false }
    guard
      let person = await settingsRequest(
        app, { self.failure = $0 }, { try await $0.updateMe(MeUpdate(social: true)) })
    else { return }
    await loadPeople()
    me = .loaded(person)
  }

  func setFilters(for personId: String, _ update: SocialFiltersUpdate) async {
    guard !isSaving else { return }
    isSaving = true
    defer { isSaving = false }
    guard
      let saved = await settingsRequest(
        app, { self.failure = $0 }, { try await $0.setFilters(for: personId, update) }),
      let index = people.firstIndex(where: { $0.id == personId })
    else { return }
    people[index].see = saved.see
    people[index].appear = saved.appear
  }

  private func loadPeople() async {
    if let list = await settingsRequest(app, { self.failure = $0 }, { try await $0.socialFilters() }) {
      people = list
    }
  }
}
