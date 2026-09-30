import OrbisDesign
import SwiftUI

/// Now Playing, laid out the way a music app's full-screen player is: the artwork, the title with
/// its menu, the seek bar and the transport, and a bottom row for the source, AirPlay and Up Next.
/// Always dark, on the artwork's colour. The screen follows the player, and closes when it empties.
struct NowPlayingScreen: View {
  @Bindable var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @Environment(\.openURL) private var openURL
  @State private var isRenaming = false
  @State private var isShowingQueue = false

  var body: some View {
    let player = model.audioPlayer
    let set = player.currentSetId.flatMap { model.savedSet($0) }
    Group {
      if let set {
        content(set)
          .accessibilityIdentifier("now-playing")
      } else {
        ContentUnavailableView {
          Label("Nothing playing", systemImage: "play.slash")
        } description: {
          Text("Play a set from your library.")
        }
        .accessibilityIdentifier("now-playing-empty")
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background {
      ArtworkBackdrop(url: set.flatMap(SetPresentation.pageArtwork), style: .card)
        .overlay(LinearGradient(colors: [.clear, .black.opacity(0.35)], startPoint: .top, endPoint: .bottom))
        .ignoresSafeArea()
    }
    .environment(\.colorScheme, .dark)
    .setChangeStatus(model)
    .sheet(isPresented: $isShowingQueue) { QueueScreen(model: model) }
    .overlay(alignment: .top) {
      #if os(iOS)
        Capsule()
          .fill(.tertiary)
          .frame(width: 36, height: 5)
          .padding(.top, 8)
          .accessibilityHidden(true)
      #endif
    }
    .accessibilityAction(.escape) { dismiss() }
    .onChange(of: player.currentSetId) { _, id in
      if id == nil { dismiss() }
    }
  }

  private func content(_ set: SavedSet) -> some View {
    VStack(spacing: 0) {
      Spacer(minLength: 28)
      Artwork(url: SetPresentation.pageArtwork(set), seed: set.title, size: .header)
        .clipShape(.rect(cornerRadius: Radius.list))
        .shadow(color: .black.opacity(0.4), radius: 24, y: 12)
      Spacer(minLength: 28)
      HStack(spacing: 12) {
        VStack(alignment: .leading, spacing: 2) {
          Text(set.title)
            .font(.title3.weight(.semibold))
            .lineLimit(2)
            .accessibilityIdentifier("now-playing-title")
          if let cue = model.audioPlayer.currentCue {
            Text("\(cue.title) · \(cue.artist)")
              .font(.title3)
              .foregroundStyle(.secondary)
              .lineLimit(1)
              .accessibilityIdentifier("now-playing-cue")
          } else {
            Text(set.creator ?? set.source.label)
              .font(.title3)
              .foregroundStyle(.secondary)
              .lineLimit(1)
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        SetManagementSection(model: model, set: set, isRenaming: $isRenaming, style: .inline)
      }
      Transport(
        player: model.audioPlayer,
        fallbackDuration: set.durationSeconds.map(TimeInterval.init),
        identifierPrefix: "now-playing",
        prominentPlay: false
      )
      .padding(.top, 24)
      Spacer(minLength: 24)
      HStack {
        Button("Open in \(set.source.label)", systemImage: SetPresentation.sourceSymbol(set.source)) {
          if let url = SetPresentation.sourceURL(set) { openURL(url) }
        }
        .frame(width: 44, height: 44)
        Spacer()
        AirPlayButton()
        Spacer()
        Button("Up Next", systemImage: "list.bullet") { isShowingQueue = true }
          .frame(width: 44, height: 44)
          .accessibilityIdentifier("now-playing-queue")
      }
      .labelStyle(.iconOnly)
      .buttonStyle(.plain)
      .font(.title3)
      .foregroundStyle(.secondary)
    }
    .padding(.horizontal, 24)
    .padding(.bottom, 12)
  }
}
