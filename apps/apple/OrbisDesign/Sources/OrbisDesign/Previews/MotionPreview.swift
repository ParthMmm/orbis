import SwiftUI

/// The samples a motion preview shows, shared with the tests so a motion added to the
/// vocabulary cannot miss its preview.
///
/// The preview walks `samples`, and `samples` walks `OrbisMotion.allCases`, so both forms of
/// every motion are shown by construction rather than by a list someone has to remember to
/// extend. Nothing plays on appear, so a sample always carries a control: a trigger changes
/// only when the person presses it.
enum MotionPreview {
  /// One motion as a preview shows it: the symbol it is played on, and the control that plays it.
  struct Sample: Equatable, Sendable {
    let motion: OrbisMotion
    /// The symbol the motion plays on. Each sample's symbol is its own, so two motions are
    /// never told apart by their words alone.
    let symbol: String
    /// What the person presses to play the motion.
    let control: String
  }

  /// The forms a preview puts side by side: the one the system gives by default, and the one
  /// Reduce Motion asks for.
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

  /// Every motion, in the order the vocabulary lists them.
  static let samples: [Sample] = OrbisMotion.allCases.map { motion in
    Sample(motion: motion, symbol: symbol(for: motion), control: control(for: motion))
  }

  /// The symbol a motion is played on. The two filing outcomes wear the symbols the field
  /// answers with, so the preview shows the vocabulary the app actually speaks.
  private static func symbol(for motion: OrbisMotion) -> String {
    switch motion {
    case .filingSucceeded: "checkmark.circle"
    case .filingFailed: "exclamationmark.triangle"
    case .tagToggled: "tag"
    case .playlistReordered: "arrow.up.arrow.down"
    }
  }

  private static func control(for motion: OrbisMotion) -> String {
    switch motion {
    case .filingSucceeded: "File it"
    case .filingFailed: "Refuse it"
    case .tagToggled: "Toggle the Tag"
    case .playlistReordered: "Move the Set"
    }
  }
}
