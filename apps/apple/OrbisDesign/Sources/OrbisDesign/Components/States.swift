import SwiftUI

/// What a screen says when it has nothing to show, and the one thing it offers to change that.
///
/// Every state names what happened and states its recovery in the button's own words, so a
/// person reading only the button still knows what pressing it does. The wording lives here
/// rather than in each screen, so two screens cannot drift into two names for the same state.
private struct StateMessage: View {
  let title: String
  let message: String
  let symbol: String
  let recoveryLabel: String
  let prominent: Bool
  let recover: () -> Void

  var body: some View {
    ContentUnavailableView {
      Label(title, systemImage: symbol)
    } description: {
      Text(message)
    } actions: {
      if prominent {
        Button(recoveryLabel, action: recover)
          .buttonStyle(OrbisPrimaryButtonStyle())
      } else {
        // Neutral, because the screen this state sits on already carries the one tinted
        // action: the paste field above it.
        Button(recoveryLabel, action: recover)
          .buttonStyle(.bordered)
          .controlSize(.large)
          .buttonBorderShape(.capsule)
          .tint(Color.orbis.muted)
      }
    }
  }
}

/// The Library before the first Set is filed. The recovery is the paste field the screen
/// already shows, so the action asks that field to take focus rather than opening anything.
public struct EmptyLibraryState: View {
  public static let title = "Start your collection"
  public static let message = "Paste a link to file your first set."
  public static let symbol = "music.note.list"
  public static let recoveryLabel = "Paste a link"

  private let recover: () -> Void

  public init(recover: @escaping () -> Void) {
    self.recover = recover
  }

  public var body: some View {
    StateMessage(
      title: Self.title, message: Self.message, symbol: Self.symbol,
      recoveryLabel: Self.recoveryLabel, prominent: false, recover: recover
    )
  }
}

/// A Playlist with no Sets in it. An empty Playlist is not an empty Library: the Sets exist,
/// they are somewhere else, and the way out is to add one.
public struct EmptyPlaylistState: View {
  public static let title = "This Playlist is empty"
  public static let message = "Add Sets from your Library to fill it."
  public static let symbol = "rectangle.stack.badge.plus"
  public static let recoveryLabel = "Add Sets"

  private let recover: () -> Void

  public init(recover: @escaping () -> Void) {
    self.recover = recover
  }

  public var body: some View {
    StateMessage(
      title: Self.title, message: Self.message, symbol: Self.symbol,
      recoveryLabel: Self.recoveryLabel, prominent: true, recover: recover
    )
  }
}

/// A Library that has Sets, none of which match what is being asked for. The difference from
/// `EmptyLibraryState` matters: the person has a library, and the filter is hiding it.
public struct NoResultsState: View {
  public static let title = "No matching sets"
  public static let message = "Try a different title, tag, or source link."
  public static let symbol = "magnifyingglass"
  public static let recoveryLabel = "Clear filters"

  /// A search screen clears a query where a filtered list clears a filter, and the label is
  /// the part that has to say which.
  private let label: String
  private let recover: () -> Void

  public init(recoverLabel: String = NoResultsState.recoveryLabel, recover: @escaping () -> Void) {
    self.label = recoverLabel
    self.recover = recover
  }

  public var body: some View {
    StateMessage(
      title: Self.title, message: Self.message, symbol: Self.symbol,
      recoveryLabel: label, prominent: true, recover: recover
    )
  }
}

/// The service could not be reached, or answered with something Orbis cannot use. The caller
/// supplies the failure, which carries its own heading, sentence, and retryability, so a
/// failure that trying again cannot mend does not offer to try again.
public struct UnavailableState: View {
  public static let recoveryLabel = "Try again"

  private let failure: OrbisFailure
  private let context: String
  private let retry: () -> Void

  public init(failure: OrbisFailure, context: String, retry: @escaping () -> Void) {
    self.failure = failure
    self.context = context
    self.retry = retry
  }

  /// A Try again button appears only when trying again could change the answer.
  public static func showsRetry(for failure: OrbisFailure) -> Bool { failure.isRetryable }

  public var body: some View {
    ContentUnavailableView {
      Label(failure.title, systemImage: failure.symbol)
    } description: {
      Text(failure.message)
    } actions: {
      if Self.showsRetry(for: failure) {
        Button(Self.recoveryLabel, action: retry)
          .buttonStyle(OrbisPrimaryButtonStyle())
      }
      CopyFailureButton(report: FailureReport(failure: failure, context: context))
    }
  }
}

/// Rows that have not arrived yet.
///
/// The real `SetRow` layout is drawn with placeholder content and then redacted, so the
/// silhouette on screen is the one the Sets will take. A bare spinner would say the same thing
/// with less truth, and the list would jump when the content landed.
public struct LoadingState: View {
  /// A state that is still coming has nothing to recover from, so it states no action.
  public static let recoveryLabel: String? = nil
  public static let announcement = "Loading"

  private let rows: Int

  public init(rows: Int = 6) {
    self.rows = rows
  }

  public var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 0) {
        ForEach(0..<rows, id: \.self) { index in
          SetRow(
            index: index + 1,
            source: "Source",
            title: "A Set title the row will hold when it arrives",
            url: "source.example/set",
            tags: [.init("tag", .pink), .init("another", .teal)],
            added: .now
          )
          .padding(.horizontal)
          if index < rows - 1 {
            Divider().padding(.leading)
          }
        }
      }
      .padding(.vertical, 6)
      .orbisRaised()
      .padding()
    }
    .redacted(reason: .placeholder)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(Self.announcement)
  }
}

#Preview("Empty Library") {
  EmptyLibraryState(recover: {})
    .background(Color.orbis.paper)
}

#Preview("Empty Library, dark") {
  EmptyLibraryState(recover: {})
    .background(Color.orbis.paper)
    .preferredColorScheme(.dark)
}

#Preview("Empty Playlist") {
  EmptyPlaylistState(recover: {})
    .background(Color.orbis.paper)
}

#Preview("Empty Playlist, dark") {
  EmptyPlaylistState(recover: {})
    .background(Color.orbis.paper)
    .preferredColorScheme(.dark)
}

#Preview("No matching sets") {
  NoResultsState(recover: {})
    .background(Color.orbis.paper)
}

#Preview("No matching sets, dark") {
  NoResultsState(recover: {})
    .background(Color.orbis.paper)
    .preferredColorScheme(.dark)
}

#Preview("Unavailable") {
  UnavailableState(
    failure: OrbisFailure(
      title: "Cannot reach your library",
      message:
        "Check that Tailscale is connected and the Orbis service is running on the host.",
      symbol: "wifi.exclamationmark",
      isRetryable: true,
      address: "https://vanta.tail01d084.ts.net:8444"
    ),
    context: "loading the library",
    retry: {}
  )
  .background(Color.orbis.paper)
}

#Preview("Unavailable, dark") {
  UnavailableState(
    failure: OrbisFailure(
      title: "This device is not paired",
      message: "Pair it on the host and enter the new token.",
      symbol: "key.slash",
      isRetryable: false
    ),
    context: "loading the library",
    retry: {}
  )
  .background(Color.orbis.paper)
  .preferredColorScheme(.dark)
}

#Preview("Loading") {
  LoadingState(rows: 4)
    .background(Color.orbis.paper)
}

#Preview("Loading, dark") {
  LoadingState(rows: 4)
    .background(Color.orbis.paper)
    .preferredColorScheme(.dark)
}

/// Every state at the largest text size and in a right-to-left layout, which is where a state
/// that cannot wrap shows itself.
private struct StatesAtLargestText: View {
  var body: some View {
    ScrollView {
      VStack(spacing: 24) {
        EmptyLibraryState(recover: {})
        Divider()
        EmptyPlaylistState(recover: {})
        Divider()
        NoResultsState(recover: {})
        Divider()
        UnavailableState(
          failure: OrbisFailure(
            title: "Cannot reach your library",
            message: "Check that Tailscale is connected and the Orbis service is running.",
            symbol: "wifi.exclamationmark",
            isRetryable: true
          ),
          context: "loading the library",
          retry: {}
        )
        Divider()
        LoadingState(rows: 2)
      }
      .padding()
    }
    .background(Color.orbis.paper)
  }
}

#Preview("States, largest text, RTL, Mac") {
  StatesAtLargestText().orbisAccessibilityLayout().frame(width: 700, height: 900)
}

#Preview("States, largest text, RTL, iPhone") {
  StatesAtLargestText().orbisAccessibilityLayout().frame(width: 358, height: 900)
}
