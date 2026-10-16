import SwiftUI

/// One Set in a listing: its artwork, its title, and one line of data under it.
///
/// The data line says who made it and how long it runs, or, once listening has started, how much
/// is left. Tags follow as colored dots, the first with its name, except the ones the list is
/// filtered by. The line never wraps: the words truncate before a symbol or a dot does. The row
/// draws no separator of its own; the listing spaces rows apart.
///
/// The row has two targets and no mode. The artwork plays when there is Retained Audio to play,
/// and the rest of the row opens the Set, the way a podcast app lays an episode out. A Set is
/// long, and managing one is as common as hearing it, so neither action hides behind the other.
/// The Set in the player is marked in the tint, with a pause glyph while it plays.
public struct SetRow: View {
  public struct Tag: Identifiable, Hashable, Sendable {
    public let name: String
    public let category: OrbisColor.Category
    public var id: String { name }
    public init(_ name: String, _ category: OrbisColor.Category) {
      self.name = name
      self.category = category
    }
  }

  public let title: String
  /// Where the Set came from. Read out, not drawn: the artwork says it well enough.
  public let source: String
  public let artwork: URL?
  public let creator: String?
  /// How long it runs, composed by the caller ("1h 18m").
  public let length: String?
  public let tags: [Tag]
  public let hiddenTags: [String]
  public let state: State?
  /// How far listening got, from 0 to 1, for the bar along the artwork.
  public let progress: Double?
  /// What the artwork's control does, or nothing when there is no Retained Audio to play.
  public let playback: Playback?
  /// Starts, pauses, or resumes the Set, as `playback` says.
  public let togglePlayback: (() -> Void)?
  /// Opens the Set. Absent on a screen that only reads, where the row is not pressable.
  public let select: (() -> Void)?

  /// What the control on the artwork does for this Set.
  public enum Playback: Hashable, Sendable {
    /// Audio is kept and the player holds another Set, or none: the control starts a Listen.
    case ready
    /// This is the Set playing: the control pauses it.
    case playing
    /// This is the Set in the player, paused: the control resumes it.
    case paused

    public var symbol: String { self == .playing ? "pause.fill" : "play.fill" }
    /// Named for the change the control makes, as a control should be.
    public var label: String { self == .playing ? "Pause" : "Play" }
    /// The Set in the player, playing or paused, is the one the row marks.
    public var isCurrent: Bool { self != .ready }
    /// What the row reads out about the player, after the title.
    public var announcement: String? {
      switch self {
      case .ready: nil
      case .playing: "Now playing"
      case .paused: "Paused"
      }
    }
  }

  /// How much listening is left and what the Download is doing. Both are optional, so a row
  /// with neither renders exactly as before. The design system carries plain values here, as it
  /// does for `source`, so it stays free of the app's domain types.
  public struct State: Hashable, Sendable {
    /// What is left of a Set already started, composed by the caller ("18m left").
    public let remaining: String?
    /// What a Download in flight is doing ("Download queued"); nothing once it is done.
    public let download: String?
    /// Audio is kept on the device. Drawn as a symbol, because it is a fact about the Set, not
    /// news about it.
    public let kept: Bool
    public init(remaining: String? = nil, download: String? = nil, kept: Bool = false) {
      self.remaining = remaining
      self.download = download
      self.kept = kept
    }
    public var isEmpty: Bool { remaining == nil && download == nil && !kept }
    /// The symbol beside a Download in flight, and the one that stands for kept audio.
    public static let downloadSymbol = "arrow.down.circle"
    public static let keptSymbol = "arrow.down.circle.fill"
    public static let keptLabel = "Audio kept"
    /// "18m left · Download queued · Audio kept"
    public var label: String {
      var parts: [String] = []
      if let remaining { parts.append(remaining) }
      if let download { parts.append(download) }
      if kept { parts.append(Self.keptLabel) }
      return parts.joined(separator: " · ")
    }
  }

  @Environment(\.dynamicTypeSize) private var typeSize

  public init(
    title: String, source: String, artwork: URL? = nil, creator: String? = nil,
    length: String? = nil, tags: [Tag] = [], hiddenTags: [String] = [],
    state: State? = nil,
    progress: Double? = nil, playback: Playback? = nil,
    togglePlayback: (() -> Void)? = nil, select: (() -> Void)? = nil
  ) {
    self.title = title
    self.source = source
    self.artwork = artwork
    self.creator = creator
    self.length = length
    self.tags = tags
    self.hiddenTags = hiddenTags
    self.state = state
    self.progress = progress
    self.playback = playback
    self.togglePlayback = togglePlayback
    self.select = select
  }

  /// The data line's words. What is left takes the creator's place, because once a person has
  /// started a Set the question is how much remains, not who made it. The Download and kept audio
  /// are symbols, drawn after the words.
  public static func dataLine(creator: String?, length: String?, state: State?) -> String {
    var parts: [String] = []
    if let remaining = state?.remaining {
      parts.append(remaining)
    } else if let creator, !creator.isEmpty {
      parts.append(creator)
    }
    if let length, !length.isEmpty {
      parts.append(length)
    }
    return parts.joined(separator: " · ")
  }

  /// At the largest text sizes the artwork and two lines of text cannot share a row, so the
  /// artwork moves above the text. `.xxxLarge` is the last size of the standard range and the
  /// first where the title loses the room it needs beside the artwork, which is why it is named
  /// rather than left to the accessibility range. The width does not enter into it: a wide row
  /// gains nothing from a title that runs the width of a Mac window beside a thumbnail.
  public static func stacks(dynamicTypeSize: DynamicTypeSize) -> Bool {
    dynamicTypeSize >= .xxxLarge
  }

  public var body: some View {
    Group {
      if Self.stacks(dynamicTypeSize: typeSize) {
        VStack(alignment: .leading, spacing: 8) {
          artworkControl(size: .lead)
          textControl
        }
      } else {
        #if os(macOS)
          HStack(alignment: .center, spacing: 16) {
            artworkControl(size: .row)
            // A narrow column, such as Search's list beside its Tracklist matches, has no room
            // for the table, so the row falls back to the phone's two lines.
            control(select) {
              ViewThatFits(in: .horizontal) {
                columns
                text
              }
              .contentShape(.rect)
            }
          }
        #else
          HStack(alignment: .top, spacing: 12) {
            artworkControl(size: .row)
            textControl
          }
        #endif
      }
    }
    .padding(.vertical, 12)
    // One element, so a screen reader hears one Set and not two buttons that both name it.
    // Opening is the default action; playing is the named one.
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(accessibilityLabel)
    .accessibilityAddTraits(select == nil ? [] : .isButton)
    .accessibilityAction { select?() }
    .accessibilityActions {
      if let playback, let togglePlayback {
        Button(playback.label, action: togglePlayback)
      }
    }
  }

  /// The artwork plays when it can, and opens the Set when it cannot, so no part of the row
  /// is dead. The glyph says which: it is only drawn when there is audio to play.
  private func artworkControl(size: Artwork.Size) -> some View {
    let art = Artwork(url: artwork, seed: title, size: size, progress: progress)
      .overlay {
        if let playback {
          PlayGlyph(playback: playback)
        }
      }
    return control(playback == nil ? select : togglePlayback ?? select) { art }
  }

  private var textControl: some View {
    control(select) { text.contentShape(.rect) }
  }

  @ViewBuilder
  private func control(_ action: (() -> Void)?, @ViewBuilder content: () -> some View)
    -> some View
  {
    if let action {
      Button(action: action) { content() }
        .buttonStyle(.orbisPressable)
    } else {
      content()
    }
  }

  private var text: some View {
    VStack(alignment: .leading, spacing: 3) {
      Text(title)
        .font(.orbis.rowTitle)
        .lineLimit(2)
        .foregroundStyle(playback?.isCurrent == true ? Color.orbis.tint : Color.primary)
      let line = Self.dataLine(creator: creator, length: length, state: state)
      HStack(spacing: 6) {
        if state?.remaining != nil {
          Image(systemName: "play.circle")
            .layoutPriority(2)
        }
        if !line.isEmpty {
          Text(line)
        }
        if state?.download != nil {
          Image(systemName: State.downloadSymbol)
            .layoutPriority(2)
        }
        if state?.kept == true {
          Image(systemName: State.keptSymbol)
            .layoutPriority(2)
        }
        ForEach(Array(otherTags.enumerated()), id: \.element.id) { index, tag in
          if index == 0 {
            TagWord(tag.name, category: tag.category)
              .layoutPriority(1)
          } else {
            Circle()
              .fill(tag.category.dot)
              .frame(width: 6, height: 6)
              .layoutPriority(2)
          }
        }
      }
      .font(.orbis.detail)
      .foregroundStyle(.secondary)
      .lineLimit(1)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  /// A Mac window lays the row out as a table: the title and who made it, then the Tags, the
  /// length and the kept-audio symbol in columns, so lengths line up down the list.
  private var columns: some View {
    HStack(alignment: .center, spacing: 16) {
      VStack(alignment: .leading, spacing: 3) {
        Text(title)
          .font(.orbis.rowTitle)
          .lineLimit(1)
          .foregroundStyle(playback?.isCurrent == true ? Color.orbis.tint : Color.primary)
        let line = Self.dataLine(creator: creator, length: nil, state: state)
        if !line.isEmpty {
          HStack(spacing: 6) {
            if state?.remaining != nil {
              Image(systemName: "play.circle")
            }
            Text(line)
          }
          .font(.orbis.detail)
          .foregroundStyle(.secondary)
          .lineLimit(1)
        }
      }
      // The title truncates first, but never below a readable width: under it, the row is too
      // narrow for the table and takes the two-line layout instead.
      .frame(
        minWidth: Self.minimumTitleWidth, idealWidth: Self.minimumTitleWidth, maxWidth: .infinity,
        alignment: .leading)
      ChipFlow {
        ForEach(otherTags) { tag in
          TagWord(tag.name, category: tag.category)
        }
      }
      .frame(width: 220, alignment: .leading)
      Text(length ?? "")
        .font(.orbis.detail)
        .foregroundStyle(.secondary)
        .monospacedDigit()
        .frame(width: 90, alignment: .trailing)
      // A ZStack, not a Group: an empty Group takes no frame, so a row with neither symbol
      // would lose the column and its Tags and length would fall out of line.
      ZStack {
        if state?.kept == true {
          Image(systemName: State.keptSymbol)
            .accessibilityLabel(State.keptLabel)
        } else if state?.download != nil {
          Image(systemName: State.downloadSymbol)
            .accessibilityHidden(true)
        }
      }
      .font(.orbis.detail)
      .foregroundStyle(.secondary)
      .frame(width: 18)
    }
  }

  private static let minimumTitleWidth: CGFloat = 200

  /// The Tags the list is filtered by are true of every row, so a row leaves them out.
  private var otherTags: [Tag] {
    tags.filter { !hiddenTags.contains($0.name) }
  }

  private var accessibilityLabel: String {
    var parts = [title, source]
    if let announcement = playback?.announcement { parts.append(announcement) }
    let line = Self.dataLine(creator: creator, length: length, state: state)
    if !line.isEmpty { parts.append(line) }
    if let download = state?.download { parts.append(download) }
    if state?.kept == true { parts.append(State.keptLabel) }
    if !otherTags.isEmpty { parts.append(otherTags.map(\.name).joined(separator: ", ")) }
    return parts.joined(separator: ", ")
  }
}

/// The control drawn on a row's artwork. Glass, because it sits on an image it must read
/// against, and small enough to leave the artwork legible around it.
private struct PlayGlyph: View {
  let playback: SetRow.Playback
  @ScaledMetric(relativeTo: .footnote) private var scaledSide: CGFloat = 32

  /// Grows with the text size up to half the row's 88-point artwork, so the artwork stays legible
  /// around it.
  private var side: CGFloat { min(scaledSide, 44) }

  var body: some View {
    Group {
      if playback == .playing {
        EqualizerBars(isPlaying: true, color: .white)
          .frame(height: 12)
      } else {
        Image(systemName: playback.symbol)
          .font(.system(size: side * 13 / 32, weight: .bold))
          .foregroundStyle(.white)
      }
    }
    .frame(width: side, height: side)
    .orbisGlass(radius: side / 2, interactive: true)
    .accessibilityHidden(true)
  }
}

private struct SetRowSample: View {
  var body: some View {
    VStack(spacing: 8) {
      ListingHeader("Thu 11 Sep")
      SetRow(
        title: "Ben UFO — Dekmantel Festival 2019", source: "YouTube", creator: "Dekmantel",
        length: "1h 58m",
        tags: [.init("techno", .pink), .init("festival", .purple), .init("breaks", .green)],
        hiddenTags: ["techno"]
      )
      SetRow(
        title: "Objekt — Live at Freerotation", source: "SoundCloud", creator: "Objekt",
        length: "2h 33m", tags: [.init("techno", .pink), .init("live", .mint)],
        hiddenTags: ["techno"], state: .init(remaining: "1h 52m left", kept: true), progress: 0.27,
        playback: .playing, togglePlayback: {}, select: {}
      )
      SetRow(
        title: "DJ Stingray 313 — Dekmantel 2017", source: "YouTube", creator: "Dekmantel",
        length: "1h 12m", state: .init(download: "Download queued")
      )
      SetRow(
        title: "Objekt — Boiler Room Berlin", source: "SoundCloud", creator: "Boiler Room",
        length: "1h 00m", state: .init(kept: true), playback: .ready,
        togglePlayback: {}, select: {}
      )
    }
    .padding(.horizontal)
    .background(Color.orbis.paper)
  }
}

#Preview("Set rows") {
  SetRowSample()
}

#Preview("Set rows, dark") {
  SetRowSample().preferredColorScheme(.dark)
}

#Preview("Set rows, xxxLarge and accessibility5, RTL, Mac") {
  AccessibilitySizeMatrix(width: AccessibilityPreview.macWidth) { SetRowSample() }
}

#Preview("Set rows, xxxLarge and accessibility5, RTL, iPhone") {
  AccessibilitySizeMatrix(width: AccessibilityPreview.phoneWidth) { SetRowSample() }
}
