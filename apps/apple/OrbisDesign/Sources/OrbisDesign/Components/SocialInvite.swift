import SwiftUI

/// People while Social is off: what turning it on shows, what it shares, and the switch.
///
/// Social starts off for every Person, so this is the first thing the People tab shows. It says
/// both directions plainly, because turning it on shares as well as shows. A server that cannot
/// offer Social yet passes `unavailable`, and the switch is shown but not offered, with the
/// reason under it.
public struct SocialInvite: View {
  public let unavailable: String?
  public let turnOn: () -> Void

  public init(unavailable: String? = nil, turnOn: @escaping () -> Void = {}) {
    self.unavailable = unavailable
    self.turnOn = turnOn
  }

  public var body: some View {
    ScrollView {
      VStack(spacing: 20) {
        Image(systemName: "person.2.wave.2.fill")
          .font(.system(size: 56))
          .foregroundStyle(Color.orbis.tint)
          .accessibilityHidden(true)
        VStack(spacing: 8) {
          Text("See what friends are playing")
            .font(.orbis.title)
            .multilineTextAlignment(.center)
          Text(
            "Turn on Social to see the Sets, Playlists and listening of people on your Orbis server, and to share yours with them."
          )
          .font(.orbis.body)
          .foregroundStyle(.secondary)
          .multilineTextAlignment(.center)
        }
        VStack(alignment: .leading, spacing: 14) {
          point("waveform", "What they’re listening to now, and what they played recently")
          point("music.note.list", "Their Library and Playlists, to play or save")
          point("person.crop.circle.badge.checkmark", "You choose who sees you, one person at a time")
        }
        .frame(maxWidth: 420, alignment: .leading)
        VStack(spacing: 10) {
          Button(action: turnOn) {
            Text("Turn On Social")
              .font(.orbis.body.weight(.semibold))
              .frame(maxWidth: 320)
          }
          .buttonStyle(.glassProminent)
          .tint(Color.orbis.tint)
          .controlSize(.large)
          .disabled(unavailable != nil)
          .accessibilityIdentifier("social-turn-on")
          Text(unavailable ?? "Nobody sees anything until you turn it on.")
            .font(.orbis.detail)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            .accessibilityIdentifier("social-note")
        }
      }
      .padding(.horizontal, 24)
      .padding(.vertical, 32)
      .frame(maxWidth: .infinity)
    }
    .background(Color.orbis.paper)
    .accessibilityIdentifier("social-invite")
  }

  private func point(_ symbol: String, _ text: String) -> some View {
    Label {
      Text(text).font(.orbis.body)
    } icon: {
      Image(systemName: symbol)
        .foregroundStyle(Color.orbis.tint)
        .frame(width: 28)
    }
  }
}

#Preview("Social invite") {
  SocialInvite()
}

#Preview("Social invite, unavailable, dark") {
  SocialInvite(unavailable: "Social arrives once your Host adds People to this server.")
    .preferredColorScheme(.dark)
}
