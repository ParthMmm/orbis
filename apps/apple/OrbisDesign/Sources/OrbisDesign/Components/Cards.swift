import SwiftUI

/// A heading over a section of cards, the size Apple Music gives its own, with an optional line
/// under it.
public struct SectionHeading: View {
  let title: String
  let subtitle: String?

  public init(_ title: String, subtitle: String? = nil) {
    self.title = title
    self.subtitle = subtitle
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(title)
        .font(.orbis.sectionTitle)
        .accessibilityAddTraits(.isHeader)
      if let subtitle {
        Text(subtitle)
          .font(.orbis.detail)
          .foregroundStyle(.secondary)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

/// A short label over a title, in small capitals.
public struct Eyebrow: View {
  let text: String

  public init(_ text: String) {
    self.text = text
  }

  public var body: some View {
    Text(text.uppercased())
      .font(.caption.weight(.bold))
      .tracking(1.2)
      .foregroundStyle(.secondary)
  }
}

/// A Set as a card in a rail: the artwork, then its title and who made it.
public struct SetCard: View {
  let title: String
  let detail: String?
  let artwork: URL?
  let progress: Double?
  let isCurrent: Bool
  let isPlaying: Bool

  public init(
    title: String, detail: String? = nil, artwork: URL?, progress: Double? = nil,
    isCurrent: Bool = false, isPlaying: Bool = false
  ) {
    self.title = title
    self.detail = detail
    self.artwork = artwork
    self.progress = progress
    self.isCurrent = isCurrent
    self.isPlaying = isPlaying
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Artwork(url: artwork, seed: title, size: .card, progress: progress)
        .overlay(alignment: .bottomTrailing) {
          if isCurrent {
            EqualizerBars(isPlaying: isPlaying, color: .white)
              .frame(height: 12)
              .padding(8)
              .background(.black.opacity(0.45), in: .circle)
              .padding(6)
          }
        }
      VStack(alignment: .leading, spacing: 1) {
        Text(title)
          .font(.subheadline.weight(.medium))
          .lineLimit(1)
          .foregroundStyle(isCurrent ? Color.orbis.tint : Color.primary)
        if let detail {
          Text(detail)
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
      }
    }
    .frame(width: Artwork.Size.card.width, alignment: .leading)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel([title, detail].compactMap { $0 }.joined(separator: ", "))
  }
}

/// A Tag as a soft pill in its own colour, with how many Sets carry it.
public struct TagBadge: View {
  let name: String
  let count: Int?
  let category: OrbisColor.Category
  let selected: Bool

  public init(
    _ name: String, count: Int? = nil, category: OrbisColor.Category, selected: Bool = false
  ) {
    self.name = name
    self.count = count
    self.category = category
    self.selected = selected
  }

  public var body: some View {
    HStack(spacing: 6) {
      Text(name)
      if let count {
        Text(count, format: .number)
          .monospacedDigit()
          .opacity(0.65)
      }
    }
    .font(.subheadline.weight(.semibold))
    .foregroundStyle(selected ? Color.white : category.text)
    .padding(.horizontal, 13)
    .frame(minHeight: 34)
    .background(selected ? category.dot : category.soft, in: .capsule)
    .contentShape(.capsule)
    .accessibilityElement(children: .combine)
    .accessibilityAddTraits(selected ? .isSelected : [])
  }
}

/// A Playlist as a folder with its Sets tucked inside: up to three pieces of artwork fan out
/// above a pocket of tinted glass, and the glass bends the artwork behind it.
public struct PlaylistSleeve: View {
  let name: String
  let count: Int
  let artwork: [URL?]
  let category: OrbisColor.Category

  public init(name: String, count: Int, artwork: [URL?], category: OrbisColor.Category) {
    self.name = name
    self.count = count
    self.artwork = Array(artwork.prefix(3))
    self.category = category
  }

  private static let angles: [Double] = [-8, 5, -2]
  private static let offsets: [CGSize] = [
    .init(width: -22, height: 6), .init(width: 20, height: 2), .init(width: 0, height: -6),
  ]

  public var body: some View {
    ZStack(alignment: .bottom) {
      ZStack {
        if artwork.isEmpty {
          RoundedRectangle(cornerRadius: 14)
            .fill(category.dot.opacity(0.3))
            .frame(width: 110, height: 70)
            .offset(y: -6)
        }
        ForEach(Array(artwork.enumerated()), id: \.offset) { index, url in
          Artwork(url: url, seed: "\(name)-\(index)", size: .rail)
            .frame(width: 112)
            .shadow(color: .black.opacity(0.3), radius: 6, y: 3)
            .rotationEffect(.degrees(Self.angles[index]))
            .offset(Self.offsets[index])
        }
      }
      .frame(maxHeight: .infinity, alignment: .top)
      .padding(.top, 4)
      VStack(alignment: .leading, spacing: 2) {
        Text(name)
          .font(.subheadline.weight(.semibold))
          .lineLimit(1)
        Text(count == 1 ? "1 set" : "\(count) sets")
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      .padding(12)
      .frame(maxWidth: .infinity, minHeight: 74, alignment: .bottomLeading)
      .glassEffect(.regular.tint(category.dot.opacity(0.35)), in: .rect(cornerRadius: 20))
    }
    .frame(height: 150)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("\(name), \(count == 1 ? "1 set" : "\(count) sets")")
  }
}

#Preview("Cards") {
  ScrollView {
    VStack(alignment: .leading, spacing: 24) {
      SectionHeading("Recently Filed")
      HStack(alignment: .top, spacing: 12) {
        SetCard(title: "DJ Heartstring — SECTION.", detail: "DJ Heartstring", artwork: nil)
        SetCard(
          title: "Objekt — Live at Freerotation", detail: "Objekt", artwork: nil, progress: 0.4,
          isCurrent: true, isPlaying: true)
      }
      HStack {
        TagBadge("techno", count: 12, category: .pink)
        TagBadge("house", count: 9, category: .green, selected: true)
      }
    }
    .padding()
  }
}
