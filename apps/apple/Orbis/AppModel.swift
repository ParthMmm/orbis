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
    var fileError: String?

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
        fileError = nil
        fileConfirmation = nil
        defer { isFiling = false }
        do {
            let saved = try await client.save(url: link)
            linkToFile = ""
            fileConfirmation = "Filed “\(saved.title)”"
            if case let .loaded(sets) = library {
                library = .loaded([saved] + sets.filter { $0.id != saved.id })
            } else {
                await loadLibrary()
            }
        } catch OrbisError.cancelled {
            return
        } catch let error as OrbisError {
            fileError = error.message
        } catch {
            fileError = OrbisError.unreachable.message
        }
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
