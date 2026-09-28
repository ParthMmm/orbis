import OrbisDesign
import SwiftUI

struct PeopleDestination: View {
  @Bindable var model: AppModel

  static let unavailable = "Social arrives once your Host adds People to this server."

  var body: some View {
    SocialInvite(unavailable: Self.unavailable)
      .sidebarPageTitle("People")
      .largeTitleOnIOS()
  }
}
