import SwiftUI

/// How the components assemble into the Library screen. Preview only; the app owns the real view.
/// Glass comes from the system: the sidebar, toolbar and tab bar are Liquid Glass on their own.
private struct LibraryPreview: View {
  @State private var link = ""
  @State private var techno = true
  @State private var house = false
  @State private var selection: String? = "Everything"

  private let sets: [(String, String, String, [SetRow.Tag])] = [
    ("YouTube", "Ben UFO — Dekmantel Festival 2019", "youtube.com/watch?v=dk19benufo", [.init("techno", .pink), .init("festival", .purple), .init("breaks", .green)]),
    ("SoundCloud", "Objekt — Live at Freerotation", "soundcloud.com/objekt/freerotation-2023", [.init("techno", .pink), .init("live", .mint)]),
    ("YouTube", "DJ Stingray 313 — Dekmantel 2017", "youtube.com/watch?v=stingray-dkmtl17", [.init("techno", .pink), .init("electro", .cyan)]),
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
          PasteHero(link: $link) {}
          HStack {
            Text("Everything \(Text("/ techno").foregroundStyle(OrbisColor.Category.pink.text))")
              .font(.orbis.sectionTitle)
            Spacer()
            TagPill("techno", category: .pink, isOn: $techno)
            TagPill("house", category: .yellow, isOn: $house)
          }
          .padding(.top)
          VStack(spacing: 0) {
            ForEach(Array(sets.enumerated()), id: \.offset) { index, set in
              SetRow(
                index: index + 1, source: set.0, title: set.1, url: set.2, tags: set.3,
                added: .now, activeTag: "techno"
              )
              .padding(.horizontal)
              if index < sets.count - 1 {
                Divider().padding(.leading)
              }
            }
          }
          .padding(.vertical, 4)
          .orbisRaised()
          Text("3 of 8 · 5 sets outside this filter")
            .font(.orbis.mono)
            .foregroundStyle(.secondary)
        }
        .padding()
      }
      .background(Color.orbis.paper)
      .toolbar {
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
