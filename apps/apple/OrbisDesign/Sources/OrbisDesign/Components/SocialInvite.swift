import SwiftUI

/// People while Social is off: a fan of artwork with a few friends around it, what turning
/// Social on shows, and the one button that turns it on.
public struct SocialInvite: View {
  public let unavailable: String?
  public let turnOn: () -> Void

  public init(unavailable: String? = nil, turnOn: @escaping () -> Void = {}) {
    self.unavailable = unavailable
    self.turnOn = turnOn
  }

  public var body: some View {
    ScrollView {
      VStack(spacing: 26) {
        fan
        VStack(spacing: 8) {
          Text("See what friends are playing")
            .font(.orbis.title)
            .multilineTextAlignment(.center)
          Text(
            "Turn on Social to see the Sets, Playlists and listening of people in your Group, and to share yours with them."
          )
          .font(.orbis.body)
          .foregroundStyle(.secondary)
          .multilineTextAlignment(.center)
        }
        VStack(alignment: .leading, spacing: 0) {
          point("waveform", "What they are listening to now, and lately")
          Divider()
          point("music.note.list", "Their Library and Playlists, to play or save")
          Divider()
          point("checkmark.shield", "You choose who sees you, one person at a time")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 4)
        .glassEffect(.regular, in: .rect(cornerRadius: 22))
        VStack(spacing: 10) {
          Button(action: turnOn) {
            Text("Turn On Social")
              .font(.orbis.body.weight(.semibold))
              .frame(maxWidth: .infinity)
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
      .frame(maxWidth: 440)
      .padding(.horizontal, 16)
      .padding(.vertical, 24)
      .frame(maxWidth: .infinity)
    }
    .background { TintGlow() }
    .accessibilityIdentifier("social-invite")
  }

  /// Three pieces of artwork with three friends around them, drawn from fixed seeds so the picture
  /// never changes.
  private var fan: some View {
    SleeveFan(seed: "people", artwork: [nil, nil, nil], category: .pink, width: 150)
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .overlay(alignment: .leading) {
        friend("maya", diameter: 44).padding(.leading, 8).padding(.top, 52)
      }
      .overlay(alignment: .trailing) {
        friend("jules", diameter: 44).padding(.trailing, 10).padding(.bottom, 16)
      }
      .overlay(alignment: .bottomTrailing) {
        friend("sam", diameter: 36).padding(.trailing, 96).padding(.bottom, 4)
      }
      .frame(height: 170)
      .accessibilityHidden(true)
  }

  private func friend(_ username: String, diameter: CGFloat) -> some View {
    PersonAvatar(username, diameter: diameter)
      .overlay { Circle().strokeBorder(.white, lineWidth: 3) }
  }

  private func point(_ symbol: String, _ text: String) -> some View {
    Label {
      Text(text).font(.orbis.body)
    } icon: {
      Image(systemName: symbol)
        .foregroundStyle(Color.orbis.tint)
        .frame(width: 28)
    }
    .frame(maxWidth: .infinity, minHeight: 54, alignment: .leading)
  }
}

#Preview("Social invite") {
  SocialInvite()
}

#Preview("Social invite, dark") {
  SocialInvite()
    .preferredColorScheme(.dark)
}
