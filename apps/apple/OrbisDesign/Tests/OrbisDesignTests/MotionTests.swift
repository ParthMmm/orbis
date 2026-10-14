import Foundation
import SwiftUI
import Testing

@testable import OrbisDesign

@Suite struct MotionTests {
  @Test func `every motion has a Reduce Motion form that keeps the feedback`() {
    for motion in OrbisMotion.allCases where motion.effect != nil {
      let standard = motion.effect(reduceMotion: false)
      let reduced = motion.effect(reduceMotion: true)
      #expect(standard != reduced, "\(motion) ignores Reduce Motion")
      #expect(reduced == .pulse, "\(motion) keeps the answer and drops the movement")
    }
  }

  @Test func `Reduce Motion takes the travel out of the curve`() {
    for motion in OrbisMotion.allCases {
      #expect(motion.curve(reduceMotion: false).animation != nil)
      #expect(motion.curve(reduceMotion: true).animation == nil)
    }
  }

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
