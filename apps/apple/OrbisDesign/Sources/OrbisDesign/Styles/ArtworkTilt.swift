import SwiftUI

#if os(iOS)
  import CoreMotion
#endif

/// How far a piece of artwork leans, as a fraction of its full lean on each axis, from -1 to 1.
/// Positive `x` leans the right edge away; positive `y` leans the bottom edge away.
public struct Tilt: Equatable, Sendable {
  public var x: Double
  public var y: Double

  public init(x: Double, y: Double) {
    self.x = min(max(x, -1), 1)
    self.y = min(max(y, -1), 1)
  }

  public static let level = Tilt(x: 0, y: 0)
}

/// The numbers the lean is drawn with, kept together so every card leans the same way.
public enum ArtworkTiltMetrics {
  /// The furthest a card turns on either axis. Enough to catch the light, not enough to read as
  /// the card slipping out of the rail.
  public static let maxDegrees: Double = 7
  /// How much the phone has to turn, in units of gravity, to reach the full lean.
  static let fullLeanAt: Double = 0.25
  /// How quickly the resting angle follows the way the phone is held, per reading. Low enough
  /// that a deliberate turn shows, high enough that a phone held at any angle settles level.
  static let restFollow: Double = 0.02
  /// How much of each new reading is taken, to keep hand tremor out of the artwork.
  static let smoothing: Double = 0.2
  /// Readings per second while something leans.
  static let updateInterval: TimeInterval = 1.0 / 30
  /// The brightest the glare gets at the full lean.
  static let glareOpacity: Double = 0.22
}

/// Carries a fixed lean in place of the phone's own, so a preview, a simulator without a gyro,
/// or a screenshot test can show the effect.
private struct ArtworkTiltOverrideKey: EnvironmentKey {
  static let defaultValue: Tilt? = nil
}

extension EnvironmentValues {
  fileprivate var artworkTiltOverride: Tilt? {
    get { self[ArtworkTiltOverrideKey.self] }
    set { self[ArtworkTiltOverrideKey.self] = newValue }
  }
}

#if os(iOS)
  /// The one reading of how the phone is turning, shared by every card on screen.
  ///
  /// Sensors run only while at least one card that leans is on screen with the app in front, and
  /// never in Low Power Mode. The lean is measured from the way the phone is being held, not from
  /// flat, so a phone read lying down or held upright both start level.
  @Observable final class DeviceTilt {
    static let shared = DeviceTilt()

    private(set) var tilt = Tilt.level

    @ObservationIgnored private let manager = CMMotionManager()
    @ObservationIgnored private var holders = 0
    @ObservationIgnored private var rest: (x: Double, y: Double)?

    func hold() {
      holders += 1
      if holders == 1 { start() }
    }

    func release() {
      holders = max(holders - 1, 0)
      if holders == 0 { stop() }
    }

    private func start() {
      guard manager.isDeviceMotionAvailable, !ProcessInfo.processInfo.isLowPowerModeEnabled else {
        return
      }
      manager.deviceMotionUpdateInterval = ArtworkTiltMetrics.updateInterval
      manager.startDeviceMotionUpdates(to: .main) { [weak self] motion, _ in
        guard let gravity = motion?.gravity else { return }
        MainActor.assumeIsolated { self?.receive(x: gravity.x, y: gravity.y) }
      }
    }

    private func stop() {
      manager.stopDeviceMotionUpdates()
      rest = nil
      tilt = .level
    }

    private func receive(x: Double, y: Double) {
      let follow = ArtworkTiltMetrics.restFollow
      let resting = rest.map { ($0.x + (x - $0.x) * follow, $0.y + (y - $0.y) * follow) } ?? (x, y)
      rest = resting
      let target = Tilt(
        x: (x - resting.0) / ArtworkTiltMetrics.fullLeanAt,
        y: (y - resting.1) / ArtworkTiltMetrics.fullLeanAt)
      let take = ArtworkTiltMetrics.smoothing
      tilt = Tilt(x: tilt.x + (target.x - tilt.x) * take, y: tilt.y + (target.y - tilt.y) * take)
    }
  }
#endif

/// Leans artwork with the phone, with a glare that slides across it as it turns.
///
/// On a Mac the pointer leans it instead, while it is over the artwork. A television already
/// leans focused cards with its own parallax, so there this does nothing. Under Reduce Motion
/// the artwork stays flat and unlit.
private struct ArtworkTiltModifier: ViewModifier {
  let cornerRadius: CGFloat

  @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
  @Environment(\.orbisReduceMotion) private var forcedReduceMotion
  @Environment(\.artworkTiltOverride) private var override
  @Environment(\.scenePhase) private var scenePhase
  @State private var isVisible = false
  @State private var holdsSensors = false
  @State private var size = CGSize.zero
  @State private var hover = Tilt.level

  private var reduceMotion: Bool { forcedReduceMotion ?? systemReduceMotion }

  func body(content: Content) -> some View {
    #if os(tvOS)
      content
    #else
      let tilt = reduceMotion ? Tilt.level : (override ?? liveTilt)
      content
        .overlay { glare(tilt).clipShape(.rect(cornerRadius: cornerRadius)) }
        .rotation3DEffect(
          .degrees(-tilt.y * ArtworkTiltMetrics.maxDegrees), axis: (x: 1, y: 0, z: 0),
          perspective: 0.6
        )
        .rotation3DEffect(
          .degrees(tilt.x * ArtworkTiltMetrics.maxDegrees), axis: (x: 0, y: 1, z: 0),
          perspective: 0.6
        )
        .onAppear { isVisible = true }
        .onDisappear {
          isVisible = false
          syncSensors()
        }
        .onChange(of: readsSensors, initial: true) { syncSensors() }
        .onGeometryChange(for: CGSize.self) { $0.size } action: { size = $0 }
        #if os(macOS)
          .onContinuousHover { phase in
            guard case .active(let point) = phase, size.width > 0, size.height > 0 else {
              hover = .level
              return
            }
            hover = Tilt(x: point.x / size.width * 2 - 1, y: point.y / size.height * 2 - 1)
          }
        #endif
    #endif
  }

  private var readsSensors: Bool {
    isVisible && scenePhase == .active && !reduceMotion && override == nil
  }

  /// Holds the shared sensors while this artwork reads them, and lets go exactly once, including
  /// when the artwork leaves the screen for good.
  private func syncSensors() {
    #if os(iOS)
      guard readsSensors != holdsSensors else { return }
      holdsSensors = readsSensors
      holdsSensors ? DeviceTilt.shared.hold() : DeviceTilt.shared.release()
    #endif
  }

  private var liveTilt: Tilt {
    #if os(iOS)
      readsSensors ? DeviceTilt.shared.tilt : .level
    #else
      hover
    #endif
  }

  /// A soft band of light that sits where the turn would catch it, and fades out level.
  private func glare(_ tilt: Tilt) -> some View {
    let strength = min(hypot(tilt.x, tilt.y), 1)
    let center = UnitPoint(x: 0.5 - tilt.x * 0.6, y: 0.5 - tilt.y * 0.6)
    return RadialGradient(
      colors: [.white.opacity(ArtworkTiltMetrics.glareOpacity * strength), .clear],
      center: center, startRadius: 0, endRadius: 140
    )
    .blendMode(.plusLighter)
    .allowsHitTesting(false)
    .accessibilityHidden(true)
  }
}

extension View {
  /// Leans this artwork with the phone, or with the pointer on a Mac. `cornerRadius` matches the
  /// artwork's own, so the glare stays inside it.
  public func artworkTilt(cornerRadius: CGFloat) -> some View {
    modifier(ArtworkTiltModifier(cornerRadius: cornerRadius))
  }

  /// Holds every leaning piece of artwork inside at `tilt`, in place of the phone's own.
  public func artworkTilt(fixed tilt: Tilt) -> some View {
    environment(\.artworkTiltOverride, tilt)
  }
}

#Preview("Artwork tilt") {
  HStack(spacing: 16) {
    ForEach([Tilt.level, Tilt(x: 1, y: 0), Tilt(x: -0.6, y: 0.8)], id: \.x) { tilt in
      SetCard(title: "Objekt — Live at Freerotation", detail: "Objekt", artwork: nil)
        .artworkTilt(fixed: tilt)
    }
  }
  .padding()
}
