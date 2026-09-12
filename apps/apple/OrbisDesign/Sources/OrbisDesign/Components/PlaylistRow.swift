import SwiftUI

/// A Playlist in a sidebar or list: color swatch, name, count. Like a Reminders list.
public struct PlaylistRow: View {
  public let name: String
  public let count: Int
  public let category: OrbisColor.Category?

  public init(_ name: String, count: Int, category: OrbisColor.Category? = nil) {
    self.name = name
    self.count = count
    self.category = category
  }

  public var body: some View {
    Label {
      HStack {
        Text(name)
        Spacer()
        Text(count, format: .number)
          .font(.orbis.mono)
          .monospacedDigit()
          .foregroundStyle(.secondary)
      }
    } icon: {
      if let category {
        RoundedRectangle(cornerRadius: 4)
          .fill(category.dot)
          .frame(width: 14, height: 14)
      } else {
        Image(systemName: "rectangle.stack")
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(name), \(count) sets")
  }
}

#Preview("Playlists") {
  List {
    PlaylistRow("Everything", count: 8)
    Section("Playlists") {
      PlaylistRow("Closing sets", count: 3, category: .indigo)
      PlaylistRow("Sunday cleaning", count: 4, category: .mint)
      PlaylistRow("Long drives", count: 2, category: .blue)
    }
  }
}

#Preview("Playlists, largest text, RTL, Mac") {
  List {
    PlaylistRow("Everything", count: 8)
    Section("Playlists") {
      PlaylistRow("Closing sets", count: 3, category: .indigo)
      PlaylistRow("Sunday cleaning", count: 4, category: .mint)
    }
  }
  .orbisAccessibilityLayout()
  .frame(width: 700)
}

#Preview("Playlists, largest text, RTL, iPhone") {
  List {
    PlaylistRow("Everything", count: 8)
    Section("Playlists") {
      PlaylistRow("Closing sets", count: 3, category: .indigo)
      PlaylistRow("Sunday cleaning", count: 4, category: .mint)
    }
  }
  .orbisAccessibilityLayout()
  .frame(width: 358)
}
