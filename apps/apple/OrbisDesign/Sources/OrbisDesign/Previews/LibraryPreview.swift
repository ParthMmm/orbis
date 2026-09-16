import SwiftUI

/// How the components assemble into the Library screen. Preview only; the app owns the real view.
/// Glass comes from the system: the sidebar, toolbar and tab bar are Liquid Glass on their own.
private struct LibraryPreview: View {
  @State private var techno = true
  @State private var house = false
  @State private var selection: String? = "Everything"

  private let sets: [(String, String, String, String, [SetRow.Tag], Double?)] = [
    (
      "YouTube", "Ben UFO — Dekmantel Festival 2019", "Dekmantel", "1h 58m",
      [.init("techno", .pink), .init("festival", .purple), .init("breaks", .green)], nil
    ),
    (
      "SoundCloud", "Objekt — Live at Freerotation", "Objekt", "2h 33m",
      [.init("techno", .pink), .init("live", .mint)], 0.27
    ),
    (
      "YouTube", "DJ Stingray 313 — Dekmantel 2017", "Dekmantel", "1h 12m",
      [.init("techno", .pink), .init("electro", .cyan)], nil
    ),
  ]

  var body: some View {
    NavigationSplitView {
      List(selection: $selection) {
        PlaylistRow("Everything", count: 8).tag("Everything")
        Section("Playlists") {
          PlaylistRow("Closing sets", count: 3, category: .indigo).tag("Closing sets")
          PlaylistRow("Sunday cleaning", count: 4, category: .mint).tag("Sunday cleaning")
          PlaylistRow("Long drives", count: 2, category: .blue).tag("Long drives")
        }
      }
      .navigationTitle("Orbis")
    } detail: {
      ScrollView {
        VStack(alignment: .leading) {
          Text("Library").font(.orbis.largeTitle)
          ListingRule().padding(.top, 12)
          HStack {
            ListingLabel("3 of 8 · 5 sets outside this filter")
            Spacer()
            TagWord("techno", category: .pink, active: techno)
            TagWord("house", category: .yellow, active: house)
          }
          .padding(.vertical, 12)
          .overlay(alignment: .bottom) { Divider() }
          ListingHeader("Thu 11 Sep")
          VStack(spacing: 0) {
            ForEach(Array(sets.enumerated()), id: \.offset) { index, set in
              SetRow(
                title: set.1, source: set.0, creator: set.2, length: set.3, tags: set.4,
                activeTag: "techno", progress: set.5
              )
              if index < sets.count - 1 {
                Divider()
              }
            }
          }
        }
        .padding()
      }
      .background(Color.orbis.paper)
      .safeAreaInset(edge: .bottom) {
        MiniPlayer(
          title: "Objekt — Live at Freerotation", isPlaying: true, progress: 0.27,
          toggle: {}, open: {}
        )
        .padding()
      }
      .toolbar {
        ToolbarItem {
          Button("File a set", systemImage: "plus") {}
        }
        ToolbarItem {
          Button("Search", systemImage: "magnifyingglass") {}
        }
      }
    }
  }
}

#Preview("Library · dark") {
  LibraryPreview()
    .preferredColorScheme(.dark)
    .frame(minWidth: 1100, minHeight: 700)
}

#Preview("Library · light") {
  LibraryPreview()
    .preferredColorScheme(.light)
    .frame(minWidth: 1100, minHeight: 700)
}
