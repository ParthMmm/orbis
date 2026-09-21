import CoreGraphics
import Foundation
import SwiftUI
import Testing

@testable import OrbisDesign

/// The largest text sizes and a right-to-left layout are where a component that clips or refuses
/// to wrap gives itself away. These render the real views at those settings and measure them,
/// because a decision function can be right while the layout is still wrong.
@Suite struct LayoutTests {
  /// Every size the previews carry, at both widths they are drawn at, in each direction.
  private let sizes = AccessibilityPreview.textSizes
  private let widths = [AccessibilityPreview.macWidth, AccessibilityPreview.phoneWidth]
  private let directions: [LayoutDirection] = [.leftToRight, .rightToLeft]

  @Test func `a row stacks its artwork above the text when the text grows`() {
    #expect(!SetRow.stacks(dynamicTypeSize: .large))
    #expect(!SetRow.stacks(dynamicTypeSize: .xxLarge))
    for size in sizes {
      #expect(SetRow.stacks(dynamicTypeSize: size), "a row at \(size) keeps the text beside the artwork")
    }
  }

  /// `ImageRenderer` measures the layout without applying Dynamic Type to the glyphs, so these
  /// render the real views and measure structure: whether content wraps, and whether it stays
  /// inside the width it was given. A view that refuses to compress reports more width than it
  /// was offered, and a view that wraps reports more height, which is what makes these worth
  /// running without the glyphs growing with them.
  @Test func `a row keeps the width it was given at the largest sizes, in either direction`() {
    for size in sizes {
      for direction in directions {
        for width in widths {
          let row = measured(row, width: width, textSize: size, direction: direction)
          #expect(row.width <= width, "the row overflowed \(width) at \(size) towards \(direction)")
          #expect(row.height > 0)
        }
      }
    }
  }

  @Test func `a row that cannot hold its text beside the artwork makes room instead`() {
    let beside = measured(row, width: AccessibilityPreview.phoneWidth, textSize: .large)
    for size in sizes {
      let row = measured(row, width: AccessibilityPreview.phoneWidth, textSize: size)
      #expect(
        row.height > beside.height,
        "the row at \(size) still squeezes its title beside the artwork")
    }
  }

  @Test func `the artwork bar is drawn only for a Set in progress`() {
    #expect(!Artwork.showsProgress(nil))
    #expect(!Artwork.showsProgress(0))
    #expect(Artwork.showsProgress(0.34))
    #expect(!Artwork.showsProgress(1))
  }

  /// A provider's thumbnail can arrive letterboxed: YouTube's `high` image is 480x360 with the
  /// picture inside a 16:9 window and black bars above and below it. The box has to keep its own
  /// 16:9 shape and crop them away, or every Set a provider sends that way is drawn 4:3, taller
  /// than the rows beside it, with the bars on show.
  @Test func `artwork crops the bars off a letterboxed thumbnail`() {
    let row = letterboxed(.row)
    let box = measured(row, width: 88, textSize: .large)
    #expect(
      abs(box.width / box.height - 16.0 / 9.0) < 0.01,
      "the artwork took the thumbnail's shape: \(box)")

    let middle = box.width / 2
    let top = sample(row, at: CGPoint(x: middle, y: 1), in: box, direction: .leftToRight)
    let bottom = sample(
      row, at: CGPoint(x: middle, y: box.height - 2), in: box, direction: .leftToRight)
    #expect(!isBlack(top), "the top bar is still on show: \(top)")
    #expect(!isBlack(bottom), "the bottom bar is still on show: \(bottom)")

    let header = measured(letterboxed(.header), width: 390, textSize: .large)
    #expect(
      abs(header.width / header.height - 16.0 / 9.0) < 0.01,
      "the header artwork took the thumbnail's shape: \(header)")
  }

  @Test func `the data line puts a resume position where the creator was`() {
    #expect(SetRow.dataLine(creator: "Dekmantel", length: "1h 58m", state: nil) == "Dekmantel · 1h 58m")
    #expect(
      SetRow.dataLine(creator: "Dekmantel", length: "1h 58m", state: .init(resumeAt: 2462))
        == "Resume at 41:02 · 1h 58m")
    #expect(
      SetRow.dataLine(creator: "Dekmantel", length: "1h 58m", state: .init(download: "Audio ready"))
        == "Dekmantel · 1h 58m · Audio ready")
    #expect(SetRow.dataLine(creator: nil, length: nil, state: nil) == "")
  }

  @Test func `the artwork control is named for the change it makes`() {
    #expect(SetRow.Playback.ready.label == "Play")
    #expect(SetRow.Playback.paused.label == "Play")
    #expect(SetRow.Playback.playing.label == "Pause")
    #expect(SetRow.Playback.playing.symbol == "pause.fill")
    #expect(!SetRow.Playback.ready.isCurrent)
    #expect(SetRow.Playback.paused.isCurrent)
    #expect(SetRow.Playback.ready.announcement == nil)
    #expect(SetRow.Playback.playing.announcement == "Now playing")
  }

  @Test func `chips reflow onto more lines when the width runs out, in either direction`() {
    for size in sizes {
      for direction in directions {
        let wide = measured(
          chips, width: AccessibilityPreview.macWidth, textSize: size,
          direction: direction)
        let narrow = measured(chips, width: 180, textSize: size, direction: direction)
        #expect(narrow.width <= 180)
        #expect(narrow.height > wide.height, "the chips stayed on one line at \(size)")
      }
    }
  }

  /// A Tag can be forty characters, the most the service keeps, which is wider than a phone at
  /// the largest text sizes. A chip that wide has to wrap inside the width it was given; running
  /// past the edge is the clipping this whole exercise is about.
  @Test func `a chip too wide for its row wraps inside it`() {
    let long = String(repeating: "hardgroove", count: 4)
    let oneRow = measured(
      longChip(long), width: AccessibilityPreview.macWidth,
      textSize: .accessibility5)
    for direction in directions {
      let wrapped = measured(
        longChip(long), width: 120, textSize: .accessibility5,
        direction: direction)
      #expect(wrapped.width <= 120, "the chip overflowed towards \(direction)")
      #expect(wrapped.height > oneRow.height, "the chip ran off the edge instead of wrapping")
    }
  }

  @Test func `the paste hero fits a phone at the largest sizes, in either direction`() {
    for size in sizes {
      for direction in directions {
        let hero = measured(
          pasteHero, width: AccessibilityPreview.phoneWidth, textSize: size,
          direction: direction)
        #expect(
          hero.width <= AccessibilityPreview.phoneWidth,
          "the hero overflowed at \(size) towards \(direction)")
        #expect(hero.height > 0)
      }
    }
  }

  /// The first chip of a flow draws at the far edge the direction reads from; in a right-to-left
  /// layout that is the right one. A physical offset would hold it on the left in both.
  @Test func `the chip flow starts at the leading edge in either direction`() {
    let canvas = CGSize(width: 200, height: 40)
    let edges = [CGPoint(x: 6, y: 10), CGPoint(x: 194, y: 10)]
    let leftToRight = edges.map {
      sample(mirroredChips, at: $0, in: canvas, direction: .leftToRight)
    }
    let rightToLeft = edges.map {
      sample(mirroredChips, at: $0, in: canvas, direction: .rightToLeft)
    }

    #expect(isRed(leftToRight[0]), "the first chip does not start on the left")
    #expect(!isRed(leftToRight[1]), "the chips did not stay on the leading side")
    #expect(isRed(rightToLeft[1]), "the first chip does not start on the right")
    #expect(!isRed(rightToLeft[0]), "the chips did not stay on the leading side")
  }

  /// A leading or trailing edge belongs to the system to flip, never to a number in the source,
  /// which is the one way a row can mirror wrongly and still measure the same. This reads the
  /// package's own sources, so a physical offset cannot come back unnoticed.
  @Test func `no component places anything with a physical offset`() {
    let physical = [".padding(.left", ".padding(.right", "offset(x:", "offset(CGSize(width:"]
    let sources = packageSources()
    #expect(!sources.isEmpty, "the package sources were not found to read")
    var offenders: [String] = []
    for (file, source) in sources {
      for (number, line) in source.split(separator: "\n").enumerated() {
        for pattern in physical where line.contains(pattern) {
          offenders.append("\(file):\(number + 1) uses \(pattern)")
        }
      }
    }
    #expect(offenders.isEmpty, "\(offenders)")
  }

  private var row: some View {
    SetRow(
      title: "Ben UFO — Dekmantel Festival 2019", source: "YouTube", creator: "Dekmantel",
      length: "1h 58m",
      tags: [.init("techno", .pink), .init("festival", .purple), .init("breaks", .green)],
      activeTag: "techno", progress: 0.34
    )
  }

  private var chips: some View {
    ChipFlow {
      ForEach(["techno", "festival", "breaks", "hardgroove", "electro", "live"], id: \.self) { tag in
        TagChip(tag, category: OrbisColor.Category.forTag(tag))
      }
    }
  }

  private func longChip(_ name: String) -> some View {
    ChipFlow {
      TagChip(name, category: .pink)
    }
  }

  /// Two chips whose colours tell which side of the flow each one landed on.
  private var mirroredChips: some View {
    ChipFlow {
      Color.red.frame(width: 40, height: 20)
      Color.blue.frame(width: 40, height: 20)
    }
  }

  private var pasteHero: some View {
    PasteHero(link: .constant("https://youtu.be/tPEMP9oYxTo")) {}
  }

  /// The real artwork box around the image a provider sends for a widescreen video at `high`.
  private func letterboxed(_ size: Artwork.Size) -> some View {
    Artwork.box(size: size) {
      Image(decorative: letterboxedThumbnail, scale: 1)
        .resizable()
        .aspectRatio(contentMode: .fill)
    }
  }

  /// A 16:9 picture inside a 4:3 canvas, with the black bars YouTube adds to fill it.
  private var letterboxedThumbnail: CGImage {
    let width = 480
    let height = 360
    let bar = 45
    let context = CGContext(
      data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
      space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    let black = CGColor(colorSpace: CGColorSpaceCreateDeviceRGB(), components: [0, 0, 0, 1])!
    let picture = CGColor(
      colorSpace: CGColorSpaceCreateDeviceRGB(), components: [0.6, 0.5, 0.85, 1])!
    context.setFillColor(black)
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    context.setFillColor(picture)
    context.fill(CGRect(x: 0, y: bar, width: width, height: height - bar * 2))
    return context.makeImage()!
  }

  /// The size a view takes when it is offered `width` and as much height as it needs.
  private func measured(
    _ view: some View, width: CGFloat, textSize: DynamicTypeSize,
    direction: LayoutDirection = .rightToLeft
  ) -> CGSize {
    let renderer = ImageRenderer(
      content: view.orbisAccessibilityLayout(textSize: textSize, direction: direction))
    renderer.proposedSize = ProposedViewSize(width: width, height: nil)
    var size = CGSize.zero
    renderer.render { reported, _ in size = reported }
    return size
  }

  private func isRed(_ sample: (red: Int, green: Int, blue: Int)) -> Bool {
    sample.red > sample.blue
  }

  private func isBlack(_ sample: (red: Int, green: Int, blue: Int)) -> Bool {
    sample.red < 24 && sample.green < 24 && sample.blue < 24
  }

  /// The colour of one pixel of a rendered view, at one pixel per point.
  private func sample(
    _ view: some View, at point: CGPoint, in size: CGSize, direction: LayoutDirection
  ) -> (red: Int, green: Int, blue: Int) {
    let renderer = ImageRenderer(
      content: view.orbisAccessibilityLayout(
        textSize: AccessibilityPreview.standardTextSize,
        direction: direction
      )
      .frame(width: size.width, height: size.height)
    )
    renderer.proposedSize = ProposedViewSize(size)
    renderer.scale = 1
    var sampled = (red: 0, green: 0, blue: 0)
    renderer.render { _, draw in
      guard
        let context = CGContext(
          data: nil, width: Int(size.width), height: Int(size.height), bitsPerComponent: 8,
          bytesPerRow: Int(size.width) * 4, space: CGColorSpaceCreateDeviceRGB(),
          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
      else { return }
      draw(context)
      guard let data = context.data else { return }
      let pixels = data.bindMemory(to: UInt8.self, capacity: Int(size.width * size.height) * 4)
      let index = (Int(point.y) * Int(size.width) + Int(point.x)) * 4
      sampled = (
        red: Int(pixels[index]), green: Int(pixels[index + 1]), blue: Int(pixels[index + 2])
      )
    }
    return sampled
  }

  /// Each source file in the package, by name, so a test can read what the components do rather
  /// than only what they measure.
  private func packageSources() -> [(String, String)] {
    let root =
      URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .appending(path: "Sources/OrbisDesign")
    let files =
      FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)?
      .compactMap { $0 as? URL }
      .filter { $0.pathExtension == "swift" } ?? []
    return files.compactMap { url in
      (try? String(contentsOf: url, encoding: .utf8)).map { (url.lastPathComponent, $0) }
    }
  }
}
