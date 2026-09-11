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
}
