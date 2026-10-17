import OrbisDesign
import SwiftUI

/// A page that opens out of the artwork that was tapped and closes back into it, the way Photos
/// and Music open an item. The page keeps the system's edge swipe and gains a pinch or a drag
/// down to close. Only iOS has the zoom; a Mac or a TV pushes the page as it always did, and
/// marking a source there costs nothing.
///
/// A source and its page meet on one id in one namespace, so the page that pushes owns the
/// namespace and hands it down to its rows and cards.
struct SetZoom {
  let namespace: Namespace.ID
  /// Which place on the page opened the Set, for a page that shows the same Set twice: Home's
  /// lead is often also the first recently filed card. Nil where each Set shows once.
  let origin: Binding<String?>

  static func sourceID(_ setId: String, place: String?) -> String {
    place.map { "\($0)/\(setId)" } ?? setId
  }

  /// Notes where a Set is about to open from, before the page is pushed.
  func open(from place: String?) {
    origin.wrappedValue = place
  }

  func transition(_ setId: String, place: String?) -> ArtworkTransition {
    ArtworkTransition(id: Self.sourceID(setId, place: place), namespace: namespace)
  }
}

private struct SetZoomKey: EnvironmentKey {
  static var defaultValue: SetZoom? { nil }
}

extension EnvironmentValues {
  var setZoom: SetZoom? {
    get { self[SetZoomKey.self] }
    set { self[SetZoomKey.self] = newValue }
  }
}

/// Makes the `Artwork` inside a row or card the place its Set's page zooms from.
private struct SetZoomSource: ViewModifier {
  let setId: String
  let place: String?
  @Environment(\.setZoom) private var zoom

  func body(content: Content) -> some View {
    content.environment(\.artworkTransition, zoom?.transition(setId, place: place))
  }
}

extension View {
  /// The `Artwork` inside this view is where the Set's page zooms from. `place` tells apart two
  /// places on one page that show the same Set; the tap that opens from one names it with
  /// `SetZoom.open(from:)`.
  func zoomsSetPage(_ setId: String, place: String? = nil) -> some View {
    modifier(SetZoomSource(setId: setId, place: place))
  }

  /// This whole view is where a page zooms from: for a source that is not a Set's artwork, such
  /// as a person or a playlist.
  func zoomSource(_ id: String, in namespace: Namespace.ID, cornerRadius: CGFloat) -> some View {
    matchedTransitionSource(id: id, in: namespace) {
      $0.clipShape(.rect(cornerRadius: cornerRadius))
    }
  }

  /// The page or sheet opens out of the source named `id` and closes back into it.
  @ViewBuilder func zoomTransition(from id: String, in namespace: Namespace.ID) -> some View {
    #if os(iOS)
      navigationTransition(.zoom(sourceID: id, in: namespace))
    #else
      self
    #endif
  }
}
