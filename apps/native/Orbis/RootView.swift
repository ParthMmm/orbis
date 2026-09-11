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
        if model.isConfigured {
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
                ConnectionView(model: model)
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
            }
            .navigationTitle("Orbis")
            .accessibilityIdentifier("sidebar")
        } detail: {
            NavigationStack {
                DestinationView(model: model, destination: model.destination)
            }
        }
    }
}

struct DestinationView: View {
    @Bindable var model: AppModel
    let destination: Destination

    var body: some View {
        switch destination {
        case .library:
            SetList(
                state: model.library,
                emptyTitle: "Start your collection",
                emptyMessage: "Sets you save appear here.",
                emptySymbol: "music.note.list",
                emptyIdentifier: "library-empty",
                retry: { await model.loadLibrary() }
            )
            .navigationTitle("Library")
            .toolbar { settingsMenu }
            .task {
                if model.library == .idle {
                    await model.loadLibrary()
                }
            }
        case .search:
            SearchDestination(model: model)
        }
    }

    @ToolbarContentBuilder
    private var settingsMenu: some ToolbarContent {
        ToolbarItem {
            Menu {
                Button("Refresh") { Task { await model.loadLibrary() } }
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
            emptyTitle: "No matching sets",
            emptyMessage: "Try a different title, tag, or source link.",
            emptySymbol: "magnifyingglass",
            emptyIdentifier: "search-no-results",
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

    private var displayedState: Loadable<[SavedSet]> {
        if case .idle = model.search,
           model.searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        {
            return .loaded([])
        }
        return model.search
    }
}
