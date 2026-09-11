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
    var searchQuery = ""
    var search: Loadable<[SavedSet]> = .idle

    var destination: Destination = .library

    init() {
        // A journey lane starts from a clean install so it exercises the connection screen.
        if ProcessInfo.processInfo.arguments.contains("-orbisResetSettings") {
            ClientSettings.serviceAddress = nil
            ClientSettings.deviceToken = nil
        }
        connectionAddress = ClientSettings.serviceAddress ?? ""
        client = ClientSettings.configuredClient()
    }

    var isConfigured: Bool { client != nil }

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
            library = .loaded(try await client.library())
        } catch let error as OrbisError {
            library = .failed(error.message)
        } catch {
            library = .failed(OrbisError.unreachable.message)
        }
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
