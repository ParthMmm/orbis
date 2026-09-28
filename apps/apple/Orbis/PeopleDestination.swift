import OrbisDesign
import SwiftUI

/// People: friends on the same Orbis server, what they are listening to, and the switch that
/// shares yours.
///
/// Social starts off for every Person (ADR 0009), so the tab opens on the invitation. The
/// service has no People yet (ADR 0008), so the switch is shown and says why it cannot be turned
/// on, rather than the tab being missing and the feature a surprise later.
struct PeopleDestination: View {
  @Bindable var model: AppModel

  /// Why Social cannot be turned on from this server, in the words the screen shows.
  static let unavailable = "Social arrives once your Host adds People to this server."

  var body: some View {
    SocialInvite(unavailable: Self.unavailable)
      .sidebarPageTitle("People")
      .largeTitleOnIOS()
  }
}
