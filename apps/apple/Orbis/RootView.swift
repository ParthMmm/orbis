import OrbisDesign
import SwiftUI

@main
struct OrbisApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView(model: model)
        }
        #if os(macOS)
        .defaultSize(width: 1000, height: 700)
        #endif
    }
}

struct RootView: View {
    let model: AppModel

    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var sizeClass
    #endif

    var body: some View {
        Group {
            if model.isConfigured, !model.isEditingConnection {
                #if os(macOS)
                    SidebarShell(model: model)
                #else
                    if sizeClass == .compact {
                        CompactShell(model: model)
                    } else {
                        SidebarShell(model: model)
                    }
                #endif
            } else {
                NavigationStack {
                    ConnectionView(model: model, cancellable: model.isConfigured)
                }
            }
        }
        // The first load starts here rather than on the Library screen, because a screen the
        // window builds and discards while laying itself out takes its task down with it, and a
        // cancelled task cancels the request it is waiting on.
        .task {
            if model.isConfigured, model.library == .idle {
                await model.loadLibrary()
                await model.loadPlaylists()
            }
        }
    }
}

/// iPhone. Library and Search are tabs.
struct CompactShell: View {
    @Bindable var model: AppModel

    var body: some View {
        TabView(selection: $model.destination) {
            ForEach(Destination.allCases) { destination in
                NavigationStack {
                    DestinationView(model: model, destination: destination)
                }
                .tabItem {
                    Label(destination.rawValue, systemImage: destination.symbol)
                }
                .tag(destination)
            }
        }
    }
}

/// iPad and macOS. The same destinations become sidebar items. A plain list with explicit
/// selection buttons is used because SwiftUI's selection-based `List` initializers are
/// unavailable on iOS.
struct SidebarShell: View {
    @Bindable var model: AppModel

    var body: some View {
        NavigationSplitView {
            List {
                ForEach(Destination.allCases) { destination in
                    Button {
                        model.destination = destination
                    } label: {
                        Label(destination.rawValue, systemImage: destination.symbol)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .listRowBackground(
                        model.destination == destination
                            ? Color.accentColor.opacity(0.18)
                            : Color.clear
                    )
                    .accessibilityIdentifier("sidebar-\(destination.rawValue.lowercased())")
                }
                Section("Playlists") {
                    playlistRow(nil, name: "Everything", count: model.totalCount)
                    ForEach(model.playlistItems) { playlist in
                        playlistRow(playlist.id, name: playlist.name, count: playlist.setCount)
                    }
                }
            }
            .navigationTitle("Orbis")
            .accessibilityIdentifier("sidebar")
        } detail: {
            NavigationStack {
                DestinationView(model: model, destination: model.destination)
            }
        }
    }

    /// A playlist in the sidebar. Everything is the whole library, so it carries no colour, and
    /// choosing a playlist is the same as asking for the Library filtered by it.
    private func playlistRow(_ id: String?, name: String, count: Int) -> some View {
        Button {
            Task {
                model.destination = .library
                await model.selectPlaylist(id)
            }
        } label: {
            PlaylistRow(
                name,
                count: count,
                category: id == nil ? nil : SetPresentation.category(for: name)
            )
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowBackground(
            model.selectedPlaylistId == id ? Color.accentColor.opacity(0.18) : Color.clear
        )
        .accessibilityIdentifier(id == nil ? "playlist-all" : "playlist-\(name)")
    }
}

struct DestinationView: View {
    @Bindable var model: AppModel
    let destination: Destination

    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var sizeClass
    #endif

    var body: some View {
        switch destination {
        case .library:
            SetList(
                state: model.visibleSets,
                heading: libraryHeading,
                empty: EmptyPresentation(
                    title: "Start your collection",
                    message: "Paste a link above to file your first set.",
                    symbol: "music.note.list",
                    identifier: "library-empty"
                ),
                failureContext: "loading the library",
                activeTag: model.activeTag,
                filters: model.availableTags.isEmpty ? nil : tagFilters,
                hero: AnyView(pasteHero),
                footer: libraryFooter,
                retry: { await model.loadLibrary() },
                select: { set in model.openSet(set.id) }
            )
            .navigationTitle("Library")
            .toolbar { settingsMenu }
            .navigationDestination(item: $model.openedSetId) { id in
                SetDetailScreen(model: model, setId: id)
            }
        case .search:
            SearchDestination(model: model)
        }
    }

    /// The design's heading names the filter in the filtered tag's colour, so the screen says
    /// what it is showing without a separate label.
    private var libraryHeading: Text {
        guard let activeTag = model.activeTag else {
            return Text("Everything")
        }
        let colour = SetPresentation.category(for: activeTag).text
        return Text("Everything \(Text("/ \(activeTag)").foregroundStyle(colour))")
    }

    private var tagFilters: AnyView {
        AnyView(
            HStack(spacing: 6) {
                ForEach(model.availableTags, id: \.self) { tag in
                    TagPill(
                        tag,
                        category: SetPresentation.category(for: tag),
                        isOn: Binding(
                            get: { model.activeTag == tag },
                            set: { isOn in model.setTagFilter(isOn ? tag : nil) }
                        )
                    )
                    .accessibilityIdentifier("tag-filter-\(tag)")
                }
            }
        )
    }

    /// The design's count says how much the filter is hiding, which is the number a person
    /// wants when a list looks short.
    private var libraryFooter: String {
        let total = model.totalCount
        guard let activeTag = model.activeTag else {
            return total == 1 ? "1 set" : "\(total) sets"
        }
        let visible = model.visibleCount
        let outside = total - visible
        let outsideLabel = outside == 1 ? "1 set" : "\(outside) sets"
        return "\(visible) of \(total) · \(outsideLabel) outside this filter"
    }

    /// The design's Library screen opens with the paste field, and the outcome of the last
    /// filing sits under it so the answer appears where the action was taken.
    private var pasteHero: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let reveal = model.reveal {
                revealPanel(reveal)
            } else {
                PasteHero(
                    link: $model.linkToFile,
                    state: SetPresentation.linkState(
                        isFiling: model.isFiling, failure: model.fileFailure),
                    compact: isCompact
                ) {
                    Task { await model.fileLink() }
                }
                if let confirmation = model.fileConfirmation {
                    Text(confirmation)
                        .font(.orbis.mono)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("file-confirmation")
                }
            }
        }
    }

    /// The step the hero promises: the title and Tags the service read from the link, open to
    /// correction. Nothing here is required, so pressing Done is the common case.
    private func revealPanel(_ reveal: AppModel.Reveal) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Name this set")
                    .font(.orbis.sectionTitle)
                SourceStamp(reveal.set.source.label)
            }
            TextField(
                "Title",
                text: Binding(
                    get: { model.reveal?.title ?? "" },
                    set: { model.reveal?.title = $0 }
                )
            )
            .textFieldStyle(.plain)
            .padding(.leading)
            .padding(.vertical, 8)
            .padding(.trailing)
            .background(Color.orbis.field, in: .rect(cornerRadius: Radius.field))
            .accessibilityIdentifier("reveal-title")
            TagInput(
                tags: Binding(
                    get: { model.reveal?.tags ?? [] },
                    set: { model.reveal?.tags = $0 }
                ),
                suggestions: model.availableTags
            )
            HStack {
                Button("Done") { Task { await model.saveReveal() } }
                    .buttonStyle(OrbisPrimaryButtonStyle())
                    .disabled(model.isSavingReveal)
                    .accessibilityIdentifier("reveal-done")
                Button("Not now") { model.closeReveal() }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("reveal-dismiss")
            }
            if let failure = model.revealFailure {
                VStack(alignment: .leading, spacing: 4) {
                    Text(failure.message)
                        .font(.orbis.mono)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("reveal-error")
                    CopyFailureButton(
                        report: FailureReport(failure: failure, context: "naming a filed set"))
                }
            } else if reveal.set.metadataState == "failed" {
                HStack(spacing: 6) {
                    Text("Orbis could not name this set.")
                        .font(.orbis.mono)
                        .foregroundStyle(.secondary)
                    Button("Try again") { Task { await model.retryMetadata() } }
                        .buttonStyle(.plain)
                        .foregroundStyle(Color.orbis.tint)
                        .accessibilityIdentifier("reveal-retry")
                }
            }
        }
        .padding()
        .orbisRaised(radius: Radius.hero)
    }

    private var isCompact: Bool {
        #if os(iOS)
        sizeClass == .compact
        #else
        false
        #endif
    }

    @ToolbarContentBuilder
    private var settingsMenu: some ToolbarContent {
        ToolbarItem {
            Menu {
                Button("Refresh") { Task { await model.loadLibrary() } }
                Button("Connection settings") { model.editConnection() }
                    .accessibilityIdentifier("library-connection-settings")
                Button("Forget this device", role: .destructive) { model.forget() }
            } label: {
                Label("Library actions", systemImage: "ellipsis.circle")
            }
            .accessibilityIdentifier("library-actions")
        }
    }
}

struct SearchDestination: View {
    @Bindable var model: AppModel

    var body: some View {
        SetList(
            state: displayedState,
            heading: heading,
            empty: EmptyPresentation(
                title: "No matching sets",
                message: "Try a different title, tag, or source link.",
                symbol: "magnifyingglass",
                identifier: "search-no-results"
            ),
            failureContext: "searching the library",
            activeTag: nil,
            filters: nil,
            hero: nil,
            footer: searchFooter,
            retry: { await model.runSearch() }
        )
        .navigationTitle("Search")
        .searchable(text: $model.searchQuery, prompt: "Title, tag, or source link")
        .onSubmit(of: .search) { Task { await model.runSearch() } }
        .onChange(of: model.searchQuery) { _, query in
            if query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                model.search = .idle
            }
        }
    }

    private var heading: Text {
        let query = model.searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        return Text(query.isEmpty ? "Search" : "Results for \"\(query)\"")
    }

    private var searchFooter: String {
        guard case let .loaded(sets) = displayedState else { return "" }
        return sets.count == 1 ? "1 set" : "\(sets.count) sets"
    }

    private var displayedState: Loadable<[SavedSet]> {
        if case .idle = model.search,
           model.searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        {
            return .loaded([])
        }
        return model.search
    }
}
