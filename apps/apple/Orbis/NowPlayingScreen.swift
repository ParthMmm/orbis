import OrbisDesign
import SwiftUI

/// Now Playing, the way a music app opens it from the mini player: a sheet the height of the
/// screen, with the artwork, the title and the transport filling the first fold. The rows a Set
/// is managed with follow under the fold, and the first of them peeks over it, so scrolling is
/// the one thing to learn.
///
/// One scroll view rather than a sheet on a sheet, because the second layer earns nothing a
/// scroll cannot, and SwiftUI stacks sheets badly. The screen follows the player: a Set that
/// is swapped out is replaced on screen, and a player that empties closes it.
struct NowPlayingScreen: View {
  @Bindable var model: AppModel
  @Environment(\.dismiss) private var dismiss

  /// How much of the management rows shows above the fold: the rule and the Tags row.
  static let peek: CGFloat = 56
  private static let inset: CGFloat = 16

  var body: some View {
    let player = model.audioPlayer
    NavigationStack {
      Group {
        if let id = player.currentSetId, let set = model.savedSet(id) {
          GeometryReader { proxy in
            ScrollView {
              VStack(alignment: .leading, spacing: 20) {
                hero(set)
                  .frame(minHeight: proxy.size.height - Self.inset * 2 - Self.peek)
                SetManagementSection(model: model, set: set)
              }
              .padding(Self.inset)
            }
          }
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
      .background(Color.orbis.paper)
      .setChangeStatus(model)
      .navigationTitle("Now Playing")
      .toolbarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Done", role: .close) { dismiss() }
            .accessibilityIdentifier("now-playing-done")
        }
      }
    }
    .onChange(of: player.currentSetId) { _, id in
      if id == nil { dismiss() }
    }
    #if os(iOS)
      .presentationDragIndicator(.visible)
    #endif
  }

  /// The first fold. The transport sits at its foot, where a thumb reaches, and the artwork
  /// and the title take what is above.
  private func hero(_ set: SavedSet) -> some View {
    VStack(alignment: .leading, spacing: 16) {
      Artwork(
        url: SetPresentation.pageArtwork(set), seed: set.title, size: .header
      )
      // Raised from the page rather than parted from a listing, so it carries the row radius
      // where the page's own header keeps its corners square.
      .clipShape(.rect(cornerRadius: Radius.row))
      VStack(alignment: .leading, spacing: 6) {
        ListingLabel(
          SetDetail.stampLine(source: set.source.label, subtitle: SetPresentation.subtitle(set)))
        Text(set.title)
          .font(.orbis.title)
          .lineLimit(3)
          .accessibilityIdentifier("now-playing-title")
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .accessibilityElement(children: .combine)
      .accessibilityLabel(SetDetail.headerLabel(title: set.title, source: set.source.label))
      Spacer(minLength: 0)
      Transport(
        player: model.audioPlayer,
        fallbackDuration: set.durationSeconds.map(TimeInterval.init),
        identifierPrefix: "now-playing"
      )
    }
  }
}
