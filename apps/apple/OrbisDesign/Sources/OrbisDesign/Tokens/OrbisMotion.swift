import SwiftUI

/// A symbol effect a motion can play, named so the choice is data rather than a call a test
/// cannot read.
///
/// Every case is discrete: nothing here repeats and nothing runs on its own.
public enum OrbisSymbolEffect: String, CaseIterable, Sendable {
  /// A short hop. Movement, for something that worked.
  case bounce
  /// A short shake. Movement, for something that was refused.
  case wiggle
  /// A fade in place. The Reduce Motion form of both: the feedback stays, the movement goes.
  case pulse
}

/// The timing a motion settles with.
public enum OrbisCurve: String, CaseIterable, Sendable {
  /// A toggle, or a small state change.
  case snappy
  /// A row or a card arriving in a new place.
  case smooth
  /// The Reduce Motion form: the change lands without travelling.
  case immediate

  public var animation: Animation? {
    switch self {
    case .snappy: .snappy
    case .smooth: .smooth
    case .immediate: nil
    }
  }
}

/// The motions Orbis uses, named for what they mean rather than for how they look.
///
/// A view asks for `filingSucceeded`, not for a bounce, so the Reduce Motion form is decided in
/// one place and a redesign changes every use at once. Nothing here runs on appear and nothing
/// loops: a motion is played by a change the person just made, and it ends on its own. The
/// trigger for an effect must change only when the motion should play — a flag that returns to
/// false would play it a second time on the way back.
public enum OrbisMotion: String, CaseIterable, Sendable {
  /// A Source Link became a Set.
  case filingSucceeded
  /// The service refused a Source Link.
  case filingFailed
  /// A Tag filter turned on or off.
  case tagToggled
  /// A Set moved within a Playlist.
  case playlistReordered

  public var purpose: String {
    switch self {
    case .filingSucceeded: "A filed Source Link became a Set."
    case .filingFailed: "The service refused a Source Link."
    case .tagToggled: "A Tag filter turned on or off."
    case .playlistReordered: "A Set moved within a Playlist."
    }
  }

  /// The symbol effect the motion plays, or none when the motion is a curve rather than a
  /// symbol. Every case that exists is discrete.
  public var effect: OrbisSymbolEffect? {
    switch self {
    case .filingSucceeded: .bounce
    case .filingFailed: .wiggle
    case .tagToggled, .playlistReordered: nil
    }
  }

  /// What a symbol motion becomes when Reduce Motion is on. A fade keeps the answer and drops
  /// the movement, and the two filing outcomes still differ by symbol, word, and announcement.
  public var reduceMotionEffect: OrbisSymbolEffect { .pulse }

  public func effect(reduceMotion: Bool) -> OrbisSymbolEffect? {
    guard effect != nil else { return nil }
    return reduceMotion ? reduceMotionEffect : effect
  }

  public var curve: OrbisCurve {
    switch self {
    case .filingSucceeded, .filingFailed, .tagToggled: .snappy
    case .playlistReordered: .smooth
    }
  }

  public func curve(reduceMotion: Bool) -> OrbisCurve {
    reduceMotion ? .immediate : curve
  }
}

/// Carries a forced Reduce Motion setting. The system's own value is read-only, so a preview or
/// a test that has to show the reduced form has no way to ask for it without this.
private struct OrbisReduceMotionKey: EnvironmentKey {
  static let defaultValue: Bool? = nil
}

extension EnvironmentValues {
  fileprivate var orbisReduceMotion: Bool? {
    get { self[OrbisReduceMotionKey.self] }
    set { self[OrbisReduceMotionKey.self] = newValue }
  }
}

/// Plays a motion's symbol effect when the trigger changes, in the form the accessibility
/// setting asks for.
private struct OrbisSymbolEffectModifier<Trigger: Equatable>: ViewModifier {
  let motion: OrbisMotion
  let trigger: Trigger

  @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
  @Environment(\.orbisReduceMotion) private var forcedReduceMotion

  private var reduceMotion: Bool { forcedReduceMotion ?? systemReduceMotion }

  @ViewBuilder
  func body(content: Content) -> some View {
    switch motion.effect(reduceMotion: reduceMotion) {
    case .bounce:
      content.symbolEffect(.bounce, options: .speed(1.35), value: trigger)
    case .wiggle:
      content.symbolEffect(.wiggle, options: .speed(1.35), value: trigger)
    case .pulse:
      content.symbolEffect(.pulse, value: trigger)
    case nil:
      content
    }
  }
}

/// Settles a change with a motion's curve, or with none when Reduce Motion is on.
private struct OrbisAnimationModifier<Trigger: Equatable>: ViewModifier {
  let motion: OrbisMotion
  let trigger: Trigger

  @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
  @Environment(\.orbisReduceMotion) private var forcedReduceMotion

  private var reduceMotion: Bool { forcedReduceMotion ?? systemReduceMotion }

  func body(content: Content) -> some View {
    content.animation(motion.curve(reduceMotion: reduceMotion).animation, value: trigger)
  }
}

extension View {
  /// Plays `motion` when `trigger` changes. The trigger should change only when the motion
  /// should play.
  public func orbisSymbolEffect(_ motion: OrbisMotion, trigger: some Equatable) -> some View {
    modifier(OrbisSymbolEffectModifier(motion: motion, trigger: trigger))
  }

  /// Settles `value`'s change with the curve `motion` names.
  public func orbisAnimation(_ motion: OrbisMotion, value: some Equatable) -> some View {
    modifier(OrbisAnimationModifier(motion: motion, trigger: value))
  }

  /// Forces the Reduce Motion form, so a preview or a test can show both forms side by side.
  public func orbisReduceMotion(_ enabled: Bool) -> some View {
    environment(\.orbisReduceMotion, enabled)
  }
}

/// One motion, in one form, with a control that plays it. Nothing plays on appear: the trigger
/// changes only when the button is pressed, and a motion that is a curve settles the same
/// change the button made.
private struct MotionSample: View {
  let sample: MotionPreview.Sample
  let form: MotionPreview.Form

  @State private var plays = 0
  @State private var isOn = false

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text(sample.motion.rawValue).font(.orbis.caption)
      Text(sample.motion.purpose).font(.orbis.mono).foregroundStyle(.secondary)
      HStack(spacing: 12) {
        Image(systemName: sample.symbol)
          .frame(width: 22)
          .foregroundStyle(isOn ? Color.orbis.tint : Color.secondary)
          .orbisSymbolEffect(sample.motion, trigger: plays)
          .orbisAnimation(sample.motion, value: isOn)
        Button(sample.control) {
          plays += 1
          isOn.toggle()
        }
        .buttonStyle(.bordered)
      }
    }
    .padding()
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Color.orbis.paperRaised, in: .rect(cornerRadius: Radius.row))
    .orbisReduceMotion(form.reduceMotion)
  }
}

/// Every motion in one form, so the two forms sit side by side.
private struct MotionFormColumn: View {
  let form: MotionPreview.Form

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text(form.title).font(.orbis.sectionTitle)
      ForEach(MotionPreview.samples, id: \.motion) { sample in
        MotionSample(sample: sample, form: form)
      }
    }
  }
}

#Preview("Motions, standard and Reduce Motion") {
  HStack(alignment: .top, spacing: 24) {
    MotionFormColumn(form: .standard)
    MotionFormColumn(form: .reduceMotion)
  }
  .padding()
  .background(Color.orbis.paper)
}
