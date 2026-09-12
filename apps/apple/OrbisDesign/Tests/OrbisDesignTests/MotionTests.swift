import SwiftUI
import Testing

@testable import OrbisDesign

/// A motion is a promise about meaning: the same gesture should look the same every time, and
/// someone who asked the system not to move things should still be told what happened. These
/// pin the two halves of that.
@Suite struct MotionTests {
  @Test func `every motion names what it is for`() {
    for motion in OrbisMotion.allCases {
      #expect(!motion.purpose.isEmpty, "\(motion) has no stated purpose")
      #expect(motion.purpose.hasSuffix("."), "\(motion)'s purpose reads as a sentence")
    }
  }

  @Test func `filing that worked and filing that was refused do not look the same`() {
    #expect(OrbisMotion.filingSucceeded.effect != OrbisMotion.filingFailed.effect)
  }

  @Test func `every motion has a Reduce Motion form that keeps the feedback`() {
    for motion in OrbisMotion.allCases where motion.effect != nil {
      let standard = motion.effect(reduceMotion: false)
      let reduced = motion.effect(reduceMotion: true)
      #expect(standard != reduced, "\(motion) ignores Reduce Motion")
      #expect(reduced == .pulse, "\(motion) keeps the answer and drops the movement")
    }
  }

  /// A motion that is only a curve plays no symbol effect, and asking for one under Reduce
  /// Motion must not invent one.
  @Test func `a motion that is only a curve plays no symbol effect`() {
    #expect(OrbisMotion.tagToggled.effect == nil)
    #expect(OrbisMotion.playlistReordered.effect == nil)
    #expect(OrbisMotion.tagToggled.effect(reduceMotion: true) == nil)
  }

  @Test func `Reduce Motion takes the travel out of the curve`() {
    for motion in OrbisMotion.allCases {
      #expect(motion.curve(reduceMotion: false).animation != nil)
      #expect(motion.curve(reduceMotion: true).animation == nil)
    }
  }

  /// Only discrete effects exist, so no motion can loop or run without a change to play it.
  @Test func `nothing here repeats or runs on its own`() {
    #expect(OrbisSymbolEffect.allCases == [.bounce, .wiggle, .pulse])
  }
}
