import Foundation
import Observation

/// What a screen is showing. Keeps loading, failure, and the two distinct empty cases
/// explicit instead of inferring them from a list being empty.
enum Loadable<Value: Equatable>: Equatable {
    case idle
    case loading
    case loaded(Value)
    case failed(String)
}

@MainActor
@Observable
final class AppModel {
    private(set) var client: OrbisClient?

    var connectionAddress: String
    var connectionToken = ""
    var connectionError: String?
    var isTestingConnection = false

    var library: Loadable<[SavedSet]> = .idle
    var playlists: Loadable<[Playlist]> = .idle
    /// The playlist the Library is showing. Nil is everything the library holds.
    var selectedPlaylistId: String?
    var searchQuery = ""
    var search: Loadable<[SavedSet]> = .idle

    /// The tag the Library is filtered by. One tag at a time, because the row marks the one
    /// tag a view is filtered by and a Set carries several.
    var activeTag: String?

    /// How many times a cancelled load has been restarted without a success in between.
    private var reloadsAfterCancellation = 0

    /// What the person has pasted but not filed yet, and what the last filing said.
    var linkToFile = ""
    var isFiling = false
    var fileConfirmation: String?
    /// What the last filing refused, kept as the error so the field can tell an address Orbis
    /// does not know from one the library already holds.
    var fileFailure: OrbisError?

    /// The Set filed moments ago, whose title and Tags the service read from the link. This is
    /// the person's chance to overrule that reading, and it closes without a change.
    struct Reveal: Equatable {
        let set: SavedSet
        var title: String
        var tags: [String]

        /// The title to send, or nil when there is nothing to send: an empty field means "leave the
        /// title that came with the Set", which is what a failed enrichment leaves behind, and an
        /// unchanged one is not worth a request.
        var renamedTitle: String? {
            let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines).prefix(200)
            guard !trimmed.isEmpty, String(trimmed) != set.title else { return nil }
            return String(trimmed)
        }

        /// True while the title is still whatever arrived with the Set, including the placeholder
        /// a failed enrichment leaves, so a later retry may replace it.
        var titleUntouched: Bool {
            title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || title == set.title
        }

        var hasChanges: Bool { renamedTitle != nil || tags != set.tags }
    }

    var reveal: Reveal?
    var isSavingReveal = false
    var revealError: String?

    var destination: Destination = .library

    init() {
        // A journey lane starts from a clean install so it exercises the connection screen.
        if ProcessInfo.processInfo.arguments.contains("-orbisResetSettings") {
            ClientSettings.serviceAddress = nil
            ClientSettings.deviceToken = nil
        }
        // A lane that checks the filtered Library starts already filtered, because the design's
        // filter control is a custom toggle a UI test cannot drive reliably.
        let arguments = ProcessInfo.processInfo.arguments
        if let flag = arguments.firstIndex(of: "-orbisStartTagFiltered"),
            arguments.indices.contains(flag + 1)
        {
            activeTag = arguments[flag + 1]
        }
        connectionAddress = ClientSettings.serviceAddress ?? ""
        client = ClientSettings.configuredClient()
    }

    var isConfigured: Bool { client != nil }

    /// Every tag in the loaded library, in a stable order, so the filter row does not reshuffle
    /// between loads. Derived from the Sets rather than fetched, because the Library already
    /// holds all of them.
    var availableTags: [String] {
        guard case let .loaded(sets) = library else { return [] }
        return Set(sets.flatMap(\.tags)).sorted()
    }

    /// The Sets the filter admits. Unfiltered, it is the library itself.
    var visibleSets: Loadable<[SavedSet]> {
        guard case let .loaded(sets) = library else { return library }
        guard let activeTag else { return .loaded(sets) }
        return .loaded(sets.filter { $0.tags.contains(activeTag) })
    }

    var visibleCount: Int {
        guard case let .loaded(sets) = visibleSets else { return 0 }
        return sets.count
    }

    var totalCount: Int {
        guard case let .loaded(sets) = library else { return 0 }
        return sets.count
    }

    var playlistItems: [Playlist] {
        guard case let .loaded(items) = playlists else { return [] }
        return items
    }

    func setTagFilter(_ tag: String?) {
        activeTag = tag
    }

    /// Tests the connection before storing anything, so a wrong address or token never
    /// replaces a working configuration.
    func connect() async {
        connectionError = nil
        isTestingConnection = true
        defer { isTestingConnection = false }
        do {
            let url = try OrbisClient.address(from: connectionAddress)
            let candidate = OrbisClient(address: url, token: connectionToken)
            _ = try await candidate.health()
            ClientSettings.serviceAddress = url.absoluteString
            ClientSettings.deviceToken = connectionToken
            client = candidate
            await loadLibrary()
        } catch let error as OrbisError {
            connectionError = error.message
        } catch {
            connectionError = OrbisError.unreachable.message
        }
    }

    func forget() {
        ClientSettings.serviceAddress = nil
        ClientSettings.deviceToken = nil
        client = nil
        connectionToken = ""
        connectionAddress = ""
        library = .idle
        search = .idle
    }

    func loadLibrary() async {
        guard let client else { return }
        library = .loading
        do {
            library = .loaded(try await client.library(playlistId: selectedPlaylistId))
            reloadsAfterCancellation = 0
        } catch OrbisError.cancelled {
            // The screen that asked for this went away, which is not a failure. The retry runs
            // in a task that is not a child of this one, because a cancelled task cancels
            // everything it waits on, and it is bounded so a screen that keeps vanishing cannot
            // spin forever.
            library = .idle
            if reloadsAfterCancellation < 2 {
                reloadsAfterCancellation += 1
                Task { await loadLibrary() }
            }
        } catch let error as OrbisError {
            library = .failed(error.message)
        } catch {
            library = .failed(OrbisError.unreachable.message)
        }
    }

    /// Files the pasted link and puts the saved Set at the top of the list it belongs in.
    /// The list is not reloaded through a spinner, so filing does not blank the screen.
    func fileLink() async {
        guard let client else { return }
        let link = linkToFile.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !link.isEmpty else { return }
        isFiling = true
        fileFailure = nil
        fileConfirmation = nil
        defer { isFiling = false }
        do {
            let saved = try await client.save(url: link)
            linkToFile = ""
            // A failed enrichment leaves a placeholder title, so the field starts empty rather
            // than inviting the placeholder to be kept.
            reveal = Reveal(
                set: saved,
                title: saved.metadataState == "failed" ? "" : saved.title,
                tags: saved.tags
            )
            if case let .loaded(sets) = library {
                library = .loaded([saved] + sets.filter { $0.id != saved.id })
            } else {
                await loadLibrary()
            }
        } catch OrbisError.cancelled {
            return
        } catch let error as OrbisError {
            fileFailure = error
        } catch {
            fileFailure = .unreachable
        }
    }

    /// Names the Set that was just filed. Only what changed goes to the service, and each change
    /// lands in the list as it is accepted, so a failure halfway keeps the part that worked.
    func saveReveal() async {
        guard let open = reveal else { return }
        guard open.hasChanges else {
            closeReveal()
            return
        }
        guard let client else { return }
        isSavingReveal = true
        revealError = nil
        defer { isSavingReveal = false }
        do {
            var updated = open.set
            if let title = open.renamedTitle {
                updated = try await client.updateTitle(open.set.id, title: title)
                replace(updated)
            }
            if open.tags != open.set.tags {
                updated = try await client.updateTags(open.set.id, tags: open.tags)
                replace(updated)
            }
            closeReveal(with: updated)
        } catch OrbisError.cancelled {
            return
        } catch let error as OrbisError {
            revealError = error.message
        } catch {
            revealError = OrbisError.unreachable.message
        }
    }

    /// Asks the service again to name a Set, which is what a link it could not read leaves
    /// behind. A title the person typed over the guess stays theirs.
    func retryMetadata() async {
        guard let client, let open = reveal else { return }
        isSavingReveal = true
        revealError = nil
        defer { isSavingReveal = false }
        do {
            let updated = try await client.retryMetadata(open.set.id)
            replace(updated)
            reveal = Reveal(
                set: updated, title: open.titleUntouched ? updated.title : open.title,
                tags: open.tags)
        } catch OrbisError.cancelled {
            return
        } catch let error as OrbisError {
            revealError = error.message
        } catch {
            revealError = OrbisError.unreachable.message
        }
    }

    /// Closes the reveal, leaving nothing behind when the person filed the Set and walked away.
    func closeReveal(with set: SavedSet? = nil) {
        guard let closed = set ?? reveal?.set else {
            reveal = nil
            revealError = nil
            return
        }
        reveal = nil
        revealError = nil
        fileConfirmation = "Filed “\(closed.title)”"
    }

    /// Swaps one Set in the loaded library for a newer copy of it.
    private func replace(_ set: SavedSet) {
        guard case let .loaded(sets) = library else { return }
        library = .loaded(sets.map { $0.id == set.id ? set : $0 })
    }

    /// The playlists a sidebar offers. A failure is not shown on its own, because the Library is
    /// still readable without it and an empty sidebar reads as no playlists.
    func loadPlaylists() async {
        guard let client else { return }
        playlists = .loading
        do {
            playlists = .loaded(try await client.playlists())
        } catch OrbisError.cancelled {
            playlists = .idle
        } catch {
            playlists = .loaded([])
        }
    }

    func selectPlaylist(_ id: String?) async {
        guard selectedPlaylistId != id else { return }
        selectedPlaylistId = id
        await loadLibrary()
    }

    func runSearch() async {
        guard let client else { return }
        let query = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else {
            search = .idle
            return
        }
        search = .loading
        do {
            search = .loaded(try await client.library(query: query))
        } catch OrbisError.cancelled {
            search = .idle
        } catch let error as OrbisError {
            search = .failed(error.message)
        } catch {
            search = .failed(OrbisError.unreachable.message)
        }
    }
}

enum Destination: String, CaseIterable, Identifiable, Hashable {
    case library = "Library"
    case search = "Search"

    /// Identity is the destination itself, so a list binding can select the case directly.
    var id: Self { self }

    var symbol: String {
        switch self {
        case .library: "music.note.list"
        case .search: "magnifyingglass"
        }
    }
}
