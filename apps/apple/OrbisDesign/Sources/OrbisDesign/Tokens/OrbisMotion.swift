import SwiftUI

public enum OrbisSymbolEffect: String, CaseIterable, Sendable {
  case bounce
  case wiggle
  case pulse
}

public enum OrbisCurve: String, CaseIterable, Sendable {
  case snappy
  case smooth
  case immediate
  case press
  case lively

  public var animation: Animation? {
    switch self {
    case .snappy: .snappy
    case .smooth: .smooth
    case .immediate: nil
    case .press: .snappy(duration: 0.15)
    case .lively: .spring(response: 0.55, dampingFraction: 0.62)
    }
  }
}

public enum OrbisMotion: String, CaseIterable, Sendable {
  case filingSucceeded
  case filingFailed
  case tagToggled
  case playlistReordered
  case pageTinted
  case downloadProgressed
  case pressed
  case playbackToggled
  case cueChanged

  public var purpose: String {
    switch self {
    case .filingSucceeded: "A filed Source Link became a Set."
    case .filingFailed: "The service refused a Source Link."
    case .tagToggled: "A Tag filter turned on or off."
    case .playlistReordered: "A Set moved within a Playlist."
    case .pageTinted: "A page took its colour from the Set's artwork."
    case .downloadProgressed: "A Download the person asked for moved on."
    case .pressed: "A card or row is under a finger."
    case .playbackToggled: "A Set started or paused."
    case .cueChanged: "The mix moved on to its next Cue."
    }
  }

  public var effect: OrbisSymbolEffect? {
    switch self {
    case .filingSucceeded: .bounce
    case .filingFailed: .wiggle
    case .tagToggled, .playlistReordered, .pageTinted, .downloadProgressed, .pressed,
      .playbackToggled, .cueChanged:
      nil
    }
  }

  public var reduceMotionEffect: OrbisSymbolEffect { .pulse }

  public func effect(reduceMotion: Bool) -> OrbisSymbolEffect? {
    guard effect != nil else { return nil }
    return reduceMotion ? reduceMotionEffect : effect
  }

  public var curve: OrbisCurve {
    switch self {
    case .filingSucceeded, .filingFailed, .tagToggled: .snappy
    case .playlistReordered, .pageTinted, .downloadProgressed, .cueChanged: .smooth
    case .pressed: .press
    case .playbackToggled: .lively
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

private struct OrbisSymbolReplaceModifier: ViewModifier {
  @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
  @Environment(\.orbisReduceMotion) private var forcedReduceMotion

  func body(content: Content) -> some View {
    if forcedReduceMotion ?? systemReduceMotion {
      content.contentTransition(.opacity)
    } else {
      content.contentTransition(.symbolEffect(.replace))
    }
  }
}

private struct OrbisWorkingModifier: ViewModifier {
  let isActive: Bool
  @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
  @Environment(\.orbisReduceMotion) private var forcedReduceMotion

  func body(content: Content) -> some View {
    content.symbolEffect(
      .variableColor.iterative.dimInactiveLayers,
      isActive: isActive && !(forcedReduceMotion ?? systemReduceMotion))
  }
}

public struct EqualizerBars: View {
  public let isPlaying: Bool
  public var color: Color
  @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
  @Environment(\.orbisReduceMotion) private var forcedReduceMotion

  public init(isPlaying: Bool, color: Color = .orbis.tint) {
    self.isPlaying = isPlaying
    self.color = color
  }

  private static let speeds: [Double] = [7.3, 9.1, 6.2]
  private static let phases: [Double] = [0, 1.7, 3.1]
  private static let rest: [Double] = [0.55, 0.9, 0.4]

  public var body: some View {
    let animates = isPlaying && !(forcedReduceMotion ?? systemReduceMotion)
    TimelineView(.animation(paused: !animates)) { context in
      let t = context.date.timeIntervalSinceReferenceDate
      HStack(alignment: .bottom, spacing: 2) {
        ForEach(0..<3, id: \.self) { index in
          let level =
            animates
            ? 0.3 + 0.7 * abs(sin(t * Self.speeds[index] / 2 + Self.phases[index]))
            : Self.rest[index]
          Capsule()
            .fill(color)
            .frame(width: 3)
            .frame(maxHeight: .infinity, alignment: .bottom)
            .scaleEffect(y: level, anchor: .bottom)
        }
      }
    }
    .frame(width: 13)
    .accessibilityHidden(true)
  }
}

extension View {
  /// Plays `motion` when `trigger` changes. The trigger should change only when the motion
  /// should play.
  public func orbisSymbolEffect(_ motion: OrbisMotion, trigger: some Equatable) -> some View {
    modifier(OrbisSymbolEffectModifier(motion: motion, trigger: trigger))
  }

  public func orbisAnimation(_ motion: OrbisMotion, value: some Equatable) -> some View {
    modifier(OrbisAnimationModifier(motion: motion, trigger: value))
  }

  public func orbisSymbolReplace() -> some View {
    modifier(OrbisSymbolReplaceModifier())
  }

  public func orbisWorking(_ isActive: Bool) -> some View {
    modifier(OrbisWorkingModifier(isActive: isActive))
  }

  public func orbisReduceMotion(_ enabled: Bool) -> some View {
    environment(\.orbisReduceMotion, enabled)
  }
}

private struct MotionSample: View {
  let sample: MotionPreview.Sample
  let form: MotionPreview.Form

  @State private var plays = 0
  @State private var isOn = false

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text(sample.motion.rawValue).font(.orbis.caption)
      Text(sample.motion.purpose).font(.orbis.detail).foregroundStyle(.secondary)
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
