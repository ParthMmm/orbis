import SwiftUI

public struct PlaylistRow: View {
  public let name: String
  public let count: Int
  public let category: OrbisColor.Category?
  public let isSelected: Bool

  public init(
    _ name: String, count: Int, category: OrbisColor.Category? = nil, isSelected: Bool = false
  ) {
    self.name = name
    self.count = count
    self.category = category
    self.isSelected = isSelected
  }

  public var body: some View {
    Label {
      HStack {
        Text(name)
        Spacer()
        if isSelected {
          Image(systemName: "checkmark")
            .font(.orbis.caption)
            .foregroundStyle(.secondary)
        }
        Text(count, format: .number)
          .font(.orbis.detail)
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

#Preview("Playlists, xxxLarge and accessibility5, RTL, Mac") {
  AccessibilitySizeMatrix(width: AccessibilityPreview.macWidth) { PlaylistColumn() }
}

#Preview("Playlists, xxxLarge and accessibility5, RTL, iPhone") {
  AccessibilitySizeMatrix(width: AccessibilityPreview.phoneWidth) { PlaylistColumn() }
}

private struct PlaylistColumn: View {
  var body: some View {
    List {
      PlaylistRow("Everything", count: 8)
      Section("Playlists") {
        PlaylistRow("Closing sets", count: 3, category: .indigo)
        PlaylistRow("Sunday cleaning", count: 4, category: .mint)
      }
    }
  }
}
