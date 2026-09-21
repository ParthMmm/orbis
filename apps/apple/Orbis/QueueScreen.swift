import OrbisDesign
import SwiftUI

/// The Listening Queue: what plays next, in order, with the Set playing now marked.
///
/// A sheet from the Library rather than a destination, because the queue is a fact about playback
/// rather than a place in the library. A person opens it to see what is coming, and tapping an
/// entry is what starts it.
struct QueueScreen: View {
  @Bindable var model: AppModel
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      content
        .navigationTitle("Queue")
        #if os(iOS)
          .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
          ToolbarItem(placement: .confirmationAction) {
            Button("Done") { dismiss() }
              .accessibilityIdentifier("queue-done")
          }
        }
    }
    .accessibilityIdentifier("queue-screen")
    // Read again on open: the other device may be the one that changed it.
    .task { await model.loadQueue() }
  }

  @ViewBuilder private var content: some View {
    switch model.queue {
    case .idle, .loading:
      ProgressView()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.orbis.paper)
    case .failed(let failure):
      UnavailableState(failure: failure, context: "loading the queue") {
        Task { await model.loadQueue() }
      }
      .accessibilityIdentifier("queue-unavailable")
    case .loaded(let queue):
      if queue.entries.isEmpty {
        ContentUnavailableView {
          Label("Nothing queued", systemImage: "list.bullet")
        } description: {
          Text("Play a set, or add one with Play next.")
        }
        .background(Color.orbis.paper)
        .accessibilityIdentifier("queue-empty")
      } else {
        listing(queue)
      }
    }
  }

  private func listing(_ queue: ListeningQueue) -> some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 0) {
        ListingLabel(countLabel(queue))
          .padding(.bottom, 8)
        ListingRule()
        ForEach(Array(queue.entries.enumerated()), id: \.element.id) { position, set in
          entry(set, position: position + 1, isActive: queue.isActive(set.id))
        }
      }
      .padding()
    }
    .background(Color.orbis.paper)
    .accessibilityIdentifier("queue-list")
  }

  /// One queued Set. The Set playing now carries a mark as well as the tint, because a colour
  /// alone says nothing to a person who cannot see it.
  private func entry(_ set: SavedSet, position: Int, isActive: Bool) -> some View {
    Button {
      Task { await model.playSet(set.id) }
    } label: {
      HStack(alignment: .center, spacing: 10) {
        Image(systemName: isActive ? "speaker.wave.2.fill" : "\(position).circle")
          .font(.orbis.caption)
          .foregroundStyle(isActive ? Color.orbis.tint : Color.secondary)
          .frame(width: 20)
        SetRow(
          title: set.title,
          source: set.source.label,
          artwork: set.artworkUrl.flatMap(URL.init(string:)),
          creator: set.creator,
          length: set.durationSeconds.map(SetPresentation.length),
          tags: set.tags.map { SetRow.Tag($0, SetPresentation.category(for: $0)) },
          state: SetRow.State(
            resumeAt: set.playbackPositionSeconds > 0 ? set.playbackPositionSeconds : nil),
          progress: SetPresentation.progress(of: set)
        )
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(
      isActive ? "\(set.title), playing" : "\(set.title), position \(position)"
    )
    .accessibilityIdentifier("queue-entry-\(set.id)")
  }

  private func countLabel(_ queue: ListeningQueue) -> String {
    let count = queue.entries.count
    if count == 1 {
      return "1 set"
    }
    return "\(count) sets"
  }
}
