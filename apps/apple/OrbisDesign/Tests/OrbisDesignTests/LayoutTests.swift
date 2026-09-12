import SwiftUI
import Testing

@testable import OrbisDesign

/// The largest text size and a right-to-left layout are where a component that clips or refuses
/// to wrap gives itself away. These render the real views at those settings and measure them,
/// because a decision function can be right while the layout is still wrong.
@Suite struct LayoutTests {
  @Test func `a row stacks at accessibility sizes and on a phone`() {
    #expect(!SetRow.stacks(sizeClass: .regular, dynamicTypeSize: .large))
    #expect(SetRow.stacks(sizeClass: .compact, dynamicTypeSize: .large))
    #expect(SetRow.stacks(sizeClass: .regular, dynamicTypeSize: .accessibility3))
    #expect(SetRow.stacks(sizeClass: .regular, dynamicTypeSize: .accessibility5))
  }

  /// `ImageRenderer` measures the layout without applying Dynamic Type to the glyphs, so these
  /// render the real views and measure structure: whether content wraps, and whether it stays
  /// inside the width it was given. Content that overflows is the failure mode this catches.
  @Test func `a row fits the width it is given at the largest text, in either direction`() {
    for direction in [LayoutDirection.leftToRight, .rightToLeft] {
      let size = measured(row, width: 358, textSize: .accessibility5, direction: direction)
      #expect(size.width <= 358, "the row overflowed towards \(direction)")
      #expect(size.height > 0)
    }
  }

  @Test func `chips reflow onto more lines when the width runs out`() {
    let wide = measured(chips, width: 700, textSize: .large)
    let narrow = measured(chips, width: 180, textSize: .large)
    #expect(narrow.width <= 180)
    #expect(narrow.height > wide.height, "the chips stayed on one line")
  }

  @Test func `the paste hero fits a phone at the largest text in either direction`() {
    for direction in [LayoutDirection.leftToRight, .rightToLeft] {
      let hero = measured(pasteHero, width: 358, textSize: .accessibility5, direction: direction)
      #expect(hero.width <= 358, "the hero overflowed towards \(direction)")
      #expect(hero.height > 0)
    }
  }

  private var row: some View {
    SetRow(
      index: 1, source: "YouTube", title: "Ben UFO — Dekmantel Festival 2019",
      url: "youtube.com/watch?v=dk19benufo",
      tags: [.init("techno", .pink), .init("festival", .purple), .init("breaks", .green)],
      added: .now, activeTag: "techno"
    )
  }

  private var chips: some View {
    ChipFlow {
      ForEach(["techno", "festival", "breaks", "hardgroove", "electro", "live"], id: \.self) { tag in
        TagChip(tag, category: OrbisColor.Category.forTag(tag))
      }
    }
  }

  private var pasteHero: some View {
    PasteHero(link: .constant("https://youtu.be/tPEMP9oYxTo")) {}
  }

  /// The size a view takes when it is offered `width` and as much height as it needs.
  private func measured(
    _ view: some View, width: CGFloat, textSize: DynamicTypeSize,
    direction: LayoutDirection = .rightToLeft
  ) -> CGSize {
    let renderer = ImageRenderer(
      content: view.orbisAccessibilityLayout(textSize: textSize, direction: direction)
        .frame(width: width)
    )
    renderer.proposedSize = ProposedViewSize(width: width, height: nil)
    var size = CGSize.zero
    renderer.render { reported, _ in size = reported }
    return size
  }
}
