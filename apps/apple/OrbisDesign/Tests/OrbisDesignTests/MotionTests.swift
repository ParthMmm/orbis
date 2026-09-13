import Foundation
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

  /// The preview walks this list rather than naming the motions again, so a motion added to the
  /// vocabulary without a sample and a control fails here instead of going unseen.
  @Test func `every motion has a sample to show and a control to play it`() {
    #expect(MotionPreview.samples.map(\.motion) == OrbisMotion.allCases)
    for sample in MotionPreview.samples {
      #expect(!sample.symbol.isEmpty, "\(sample.motion) has nothing to show")
      #expect(!sample.control.isEmpty, "\(sample.motion) has nothing to press")
    }
  }

  /// Two motions shown on one symbol would be told apart by their words alone.
  @Test func `no two motions are shown on the same symbol`() {
    #expect(Set(MotionPreview.samples.map(\.symbol)).count == OrbisMotion.allCases.count)
  }

  /// The two forms a preview puts side by side, in the order it shows them.
  @Test func `the preview shows the standard form and the Reduce Motion form`() {
    #expect(MotionPreview.Form.allCases.map(\.reduceMotion) == [false, true])
  }

  /// The vocabulary only holds if no view writes an animation of its own. This reads the
  /// package's own sources, so an ad-hoc effect or a loop fails here rather than being caught by
  /// eye. `OrbisMotion.swift` is the one file allowed to call the system's animation API, because
  /// it is the file that decides what the names mean.
  @Test func `no view writes an animation of its own`() throws {
    let sources = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .appendingPathComponent("Sources/OrbisDesign")
    let files = try FileManager.default.subpathsOfDirectory(atPath: sources.path)
      .filter { $0.hasSuffix(".swift") && !$0.hasSuffix("OrbisMotion.swift") }
    let calls = [".symbolEffect(", ".animation(", "withAnimation", "repeatForever", "repeatCount"]
    #expect(!files.isEmpty, "the package sources were not found at \(sources.path)")
    for file in files {
      let text = try String(contentsOf: sources.appendingPathComponent(file), encoding: .utf8)
      for call in calls {
        #expect(!text.contains(call), "\(file) writes \(call) of its own")
      }
    }
  }
}
