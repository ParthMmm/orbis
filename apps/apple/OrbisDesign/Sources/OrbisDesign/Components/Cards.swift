import SwiftUI

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

public struct SleeveFan: View {
  let seed: String
  let artwork: [URL?]
  let category: OrbisColor.Category
  let width: CGFloat

  public init(seed: String, artwork: [URL?], category: OrbisColor.Category, width: CGFloat) {
    self.seed = seed
    self.artwork = Array(artwork.prefix(3))
    self.category = category
    self.width = width
  }

  private static let angles: [Double] = [-8, 5, -2]
  private static let offsets: [CGSize] = [
    .init(width: -0.2, height: 0.05), .init(width: 0.18, height: 0.02), .init(width: 0, height: -0.05),
  ]

  public var body: some View {
    ZStack {
      if artwork.isEmpty {
        RoundedRectangle(cornerRadius: width / 8)
          .fill(category.dot.opacity(0.3))
          .frame(width: width, height: width * 9 / 16)
      }
      ForEach(Array(artwork.enumerated()), id: \.offset) { index, url in
        let fraction = Self.offsets[index]
        let shift = CGSize(width: fraction.width * width, height: fraction.height * width)
        Artwork(url: url, seed: "\(seed)-\(index)", size: .header)
          .frame(width: width)
          .shadow(color: .black.opacity(0.3), radius: width / 18, y: width / 36)
          .rotationEffect(.degrees(Self.angles[index]))
          .offset(shift)
      }
    }
    .accessibilityHidden(true)
  }
}

public struct GlassTagChip: View {
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
      Circle()
        .fill(selected ? Color.white : category.dot)
        .frame(width: 8, height: 8)
      Text(name)
        .font(.subheadline.weight(.semibold))
      if let count {
        Text(count, format: .number)
          .font(.caption.weight(.semibold))
          .monospacedDigit()
          .opacity(0.7)
      }
    }
    .foregroundStyle(selected ? Color.white : Color.primary)
    .padding(.horizontal, 14)
    .frame(minHeight: 40)
    .glassEffect(
      .regular.tint(selected ? category.dot : category.dot.opacity(0.18)).interactive(),
      in: .capsule
    )
    .contentShape(.capsule)
    .accessibilityElement(children: .combine)
    .accessibilityAddTraits(selected ? .isSelected : [])
  }
}

public struct PlaylistSleeve: View {
  let name: String
  let count: Int
  let artwork: [URL?]
  let category: OrbisColor.Category
  let fanWidth: CGFloat
  let height: CGFloat

  public init(
    name: String, count: Int, artwork: [URL?], category: OrbisColor.Category,
    fanWidth: CGFloat = 112, height: CGFloat = 150
  ) {
    self.name = name
    self.count = count
    self.artwork = Array(artwork.prefix(3))
    self.category = category
    self.fanWidth = fanWidth
    self.height = height
  }

  private var scale: CGFloat { height / 150 }

  public var body: some View {
    ZStack(alignment: .bottom) {
      SleeveFan(seed: name, artwork: artwork, category: category, width: fanWidth).frame(
        maxHeight: .infinity, alignment: .top
      )
      .padding(.top, 4 * scale)
      VStack(alignment: .leading, spacing: 2) {
        Text(name)
          .font(scale > 1 ? .title3.weight(.semibold) : .subheadline.weight(.semibold))
          .lineLimit(1)
        Text(count == 1 ? "1 set" : "\(count) sets")
          .font(scale > 1 ? .body : .caption)
          .foregroundStyle(.secondary)
      }
      .padding(12 * scale)
      .frame(maxWidth: .infinity, minHeight: 74 * scale, alignment: .bottomLeading)
      .background { pocket }
    }
    .frame(height: height)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("\(name), \(count == 1 ? "1 set" : "\(count) sets")")
  }

  @ViewBuilder private var pocket: some View {
    #if os(tvOS)
      RoundedRectangle(cornerRadius: 20 * scale).fill(category.dot.opacity(0.3))
    #else
      Color.clear.glassEffect(
        .regular.tint(category.dot.opacity(0.35)), in: .rect(cornerRadius: 20 * scale))
    #endif
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
        GlassTagChip("techno", count: 12, category: .pink)
        GlassTagChip("house", count: 9, category: .green, selected: true)
      }
    }
    .padding()
  }
}
