import OrbisDesign
import SwiftUI

/// How long the splash stays up, and how it leaves.
///
/// The splash covers the app's own first load, so its length is two answers rather than one
/// beat: the load finishing, and a floor so the orb is seen at all. The ceiling matters most —
/// a service that is slow, or paired but unreachable, must not leave a person looking at a logo
/// where the sentence that explains the wait belongs.
struct SplashTiming: Equatable {
  /// The least time the orb is on screen. Below this the splash is a flash frame, not an
  /// opening.
  var floor: Duration = .milliseconds(600)
  /// The most time the orb may cover the app. The Library's own loading and failure states are
  /// better company than a logo once waiting starts to feel like waiting.
  var ceiling: Duration = .milliseconds(2500)
  /// How long the orb takes to leave. The app arrives underneath it, so the exit is the app
  /// appearing rather than the orb sliding away.
  var fade: Duration = .milliseconds(350)

  /// The exit as the animation it is, built from the duration above so the two cannot drift
  /// apart. Dividing by a second is how a `Duration` becomes the seconds this API counts in.
  var fadeAnimation: Animation { .easeOut(duration: fade / .seconds(1)) }

  /// Whether the splash should be gone, given how long it has been up and whether the first
  /// load has an answer.
  func shouldDismiss(after elapsed: Duration, firstLoadSettled: Bool) -> Bool {
    if elapsed >= ceiling {
      return true
    }
    return firstLoadSettled && elapsed >= floor
  }
}

#if os(iOS)
  extension OrbisColor {
    /// The field the splash is drawn on and the launch screen fills with.
    ///
    /// It is not in the design system's palette because it is not a surface a view chooses: it
    /// is read from the splash render so that the flat launch screen and the image that replaces
    /// it are the same color. It lives in the asset catalog because a launch screen can only
    /// name a catalog color, and one value should not exist twice.
    static let splashField = Color("LaunchField")
  }

  /// The eclipse, held over the app until the first load has an answer.
  ///
  /// The launch screen draws this same field with no orb on it, so the first frame the app
  /// draws adds the orb to a color that has not changed. The image fills whatever screen it
  /// lands on: it is soft, and the crop keeps its center, where the orb is.
  struct SplashView: View {
    var body: some View {
      GeometryReader { proxy in
        Image("Splash")
          .resizable()
          .scaledToFill()
          .frame(width: proxy.size.width, height: proxy.size.height)
          .clipped()
      }
      .background(Color.orbis.splashField)
      .ignoresSafeArea()
      // Decoration. VoiceOver should reach the app, not read a picture of it.
      .accessibilityHidden(true)
    }
  }
#endif
