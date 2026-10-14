import OrbisDesign
import SwiftUI

struct SplashTiming: Equatable {
  var floor: Duration = .milliseconds(600)
  var ceiling: Duration = .milliseconds(2500)
  var fade: Duration = .milliseconds(350)

  var fadeAnimation: Animation { .easeOut(duration: fade / .seconds(1)) }

  func shouldDismiss(after elapsed: Duration, firstLoadSettled: Bool) -> Bool {
    if elapsed >= ceiling {
      return true
    }
    return firstLoadSettled && elapsed >= floor
  }
}

#if os(iOS)
  extension OrbisColor {
    static let splashField = Color("LaunchField")
  }

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
      .accessibilityHidden(true)
    }
  }
#endif
