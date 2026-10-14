import SwiftUI

enum MotionPreview {
  struct Sample: Equatable, Sendable {
    let motion: OrbisMotion
    let symbol: String
    let control: String
  }

  enum Form: String, CaseIterable, Sendable {
    case standard
    case reduceMotion

    var reduceMotion: Bool { self == .reduceMotion }

    var title: String {
      switch self {
      case .standard: "Standard"
      case .reduceMotion: "Reduce Motion"
      }
    }
  }

  static let samples: [Sample] = OrbisMotion.allCases.map { motion in
    Sample(motion: motion, symbol: symbol(for: motion), control: control(for: motion))
  }

  private static func symbol(for motion: OrbisMotion) -> String {
    switch motion {
    case .filingSucceeded: "checkmark.circle"
    case .filingFailed: "exclamationmark.triangle"
    case .tagToggled: "tag"
    case .playlistReordered: "arrow.up.arrow.down"
    case .pageTinted: "paintpalette"
    case .downloadProgressed: "arrow.down.circle"
    case .pressed: "hand.tap"
    case .playbackToggled: "play.circle"
    case .cueChanged: "music.note.list"
    }
  }

  private static func control(for motion: OrbisMotion) -> String {
    switch motion {
    case .filingSucceeded: "File it"
    case .filingFailed: "Refuse it"
    case .tagToggled: "Toggle the Tag"
    case .playlistReordered: "Move the Set"
    case .pageTinted: "Tint the page"
    case .downloadProgressed: "Move the Download on"
    case .pressed: "Press"
    case .playbackToggled: "Play"
    case .cueChanged: "Next Cue"
    }
  }
}
