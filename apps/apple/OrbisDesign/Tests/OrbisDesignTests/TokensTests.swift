import SwiftUI
import Testing

@testable import OrbisDesign

@Suite struct TokenTests {
  @Test(arguments: OrbisColor.Category.allCases)
  func `category text colors differ by appearance and stay opaque`(category: OrbisColor.Category) {
    var light = EnvironmentValues()
    light.colorScheme = .light
    var dark = EnvironmentValues()
    dark.colorScheme = .dark
    let lightResolved = category.text.resolve(in: light)
    let darkResolved = category.text.resolve(in: dark)
    #expect(lightResolved.opacity == 1)
    #expect(darkResolved.opacity == 1)
    #expect(lightResolved.red != darkResolved.red || lightResolved.green != darkResolved.green)
  }

  @Test func `paper is dark in dark appearance and light in light`() {
    var light = EnvironmentValues()
    light.colorScheme = .light
    var dark = EnvironmentValues()
    dark.colorScheme = .dark
    #expect(Color.orbis.paper.resolve(in: light).red > 0.9)
    #expect(Color.orbis.paper.resolve(in: dark).red < 0.15)
  }

  @Test func `radii are concentric from chip to hero`() {
    let scale = [Radius.chip, Radius.sidebarRow, Radius.button, Radius.row, Radius.field, Radius.list, Radius.hero]
    #expect(scale == scale.sorted())
    #expect(Radius.hero == Radius.field + 8)
  }

  @Test func `increase contrast raises every color that can be raised`() {
    let raisable: [DynamicColor] = [
      GeneratedColor.paper, GeneratedColor.paperRaised, GeneratedColor.field, GeneratedColor.muted,
      GeneratedColor.categoryPinkText, GeneratedColor.categoryYellowText,
      GeneratedColor.categoryCyanText, GeneratedColor.categoryGreenText,
      GeneratedColor.categoryPurpleText, GeneratedColor.categoryTealText,
      GeneratedColor.categoryMintText, GeneratedColor.categoryBlueText,
      GeneratedColor.categoryIndigoText, GeneratedColor.categoryBrownText,
    ]
    for color in raisable {
      let moves = [false, true].contains { isDark in
        color.p3(dark: isDark, increasedContrast: false)
          != color.p3(dark: isDark, increasedContrast: true)
      }
      // `field` in light appearance is already pure white, so one appearance may stand still.
      #expect(moves)
    }
  }

  @Test func `ink is already above the increased contrast bar and stays put`() {
    for isDark in [false, true] {
      #expect(
        GeneratedColor.ink.p3(dark: isDark, increasedContrast: true)
          == GeneratedColor.ink.p3(dark: isDark, increasedContrast: false)
      )
    }
  }

  @Test(arguments: OrbisColor.Category.allCases)
  func `increased contrast text moves away from its surface`(category: OrbisColor.Category) {
    for isDark in [false, true] {
      let designed = luma(
        textColor(category).p3(dark: isDark, increasedContrast: false)
      )
      let increased = luma(textColor(category).p3(dark: isDark, increasedContrast: true))
      let surface = luma(
        GeneratedColor.paper.p3(dark: isDark, increasedContrast: true)
      )
      // Dark text on a light surface must darken; light text on a dark surface must brighten.
      if isDark {
        #expect(increased > designed)
        #expect(increased > surface)
      } else {
        #expect(increased < designed)
        #expect(increased < surface)
      }
    }
  }

  @Test func `secondary text moves away from its surface too`() {
    for isDark in [false, true] {
      let designed = luma(GeneratedColor.muted.p3(dark: isDark, increasedContrast: false))
      let increased = luma(GeneratedColor.muted.p3(dark: isDark, increasedContrast: true))
      #expect(isDark ? increased > designed : increased < designed)
    }
  }

  @Test func `the increased contrast surfaces move away from their text`() {
    #expect(
      GeneratedColor.paper.p3(dark: true, increasedContrast: true).red
        < GeneratedColor.paper.p3(dark: true, increasedContrast: false).red
    )
    #expect(
      GeneratedColor.paperRaised.p3(dark: true, increasedContrast: true).red
        < GeneratedColor.paperRaised.p3(dark: true, increasedContrast: false).red
    )
    #expect(
      GeneratedColor.paper.p3(dark: false, increasedContrast: true).red
        > GeneratedColor.paper.p3(dark: false, increasedContrast: false).red
    )
  }

  @Test func `every generated color resolves through all four appearance values`() {
    let colors: [DynamicColor] = [
      GeneratedColor.paper, GeneratedColor.paperRaised, GeneratedColor.field,
      GeneratedColor.ink, GeneratedColor.muted,
      GeneratedColor.categoryPinkText, GeneratedColor.categoryYellowText,
      GeneratedColor.categoryCyanText, GeneratedColor.categoryGreenText,
      GeneratedColor.categoryPurpleText, GeneratedColor.categoryTealText,
      GeneratedColor.categoryMintText, GeneratedColor.categoryBlueText,
      GeneratedColor.categoryIndigoText, GeneratedColor.categoryBrownText,
    ]
    for color in colors {
      let values = [
        color.p3(dark: false, increasedContrast: false),
        color.p3(dark: true, increasedContrast: false),
        color.p3(dark: false, increasedContrast: true),
        color.p3(dark: true, increasedContrast: true),
      ]
      for value in values {
        #expect((0...1).contains(value.red))
        #expect((0...1).contains(value.green))
        #expect((0...1).contains(value.blue))
      }
      // Light and dark never collapse into the same value, so the appearance still shows.
      #expect(values[0] != values[1])
      #expect(values[2] != values[3])
    }
  }
}

/// The generated text shade for a category, beside the enum that names it.
private func textColor(_ category: OrbisColor.Category) -> DynamicColor {
  switch category {
  case .pink: GeneratedColor.categoryPinkText
  case .yellow: GeneratedColor.categoryYellowText
  case .cyan: GeneratedColor.categoryCyanText
  case .green: GeneratedColor.categoryGreenText
  case .purple: GeneratedColor.categoryPurpleText
  case .teal: GeneratedColor.categoryTealText
  case .mint: GeneratedColor.categoryMintText
  case .blue: GeneratedColor.categoryBlueText
  case .indigo: GeneratedColor.categoryIndigoText
  case .brown: GeneratedColor.categoryBrownText
  }
}

/// WCAG-style relative luminance of a linear Display P3 value: enough to say which of two
/// colors sits closer to white, without pulling the whole color library into the test target.
private func luma(_ p3: P3) -> Double {
  0.2126 * p3.red + 0.7152 * p3.green + 0.0722 * p3.blue
}
