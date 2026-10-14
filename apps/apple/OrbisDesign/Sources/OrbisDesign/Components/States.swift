import SwiftUI

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
        Button(recoveryLabel, action: recover)
          .buttonStyle(.bordered)
          .controlSize(.large)
          .buttonBorderShape(.capsule)
          .tint(Color.orbis.muted)
      }
    }
  }
}

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

public struct NoPlaylistsState: View {
  public static let title = "No playlists yet"
  public static let message = "Create a playlist to organize your Sets."
  public static let symbol = "rectangle.stack.badge.plus"
  public static let recoveryLabel = "New playlist"

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

public struct NoResultsState: View {
  public static let title = "No matching sets"
  public static let message = "Try a different title, tag, or source link."
  public static let symbol = "magnifyingglass"
  public static let recoveryLabel = "Clear filters"

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

public struct LoadingState: View {
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
            title: "A Set title the row will hold when it arrives",
            source: "Source",
            creator: "Whoever made it",
            length: "1h 00m",
            tags: [.init("tag", .pink), .init("another", .teal)]
          )
          if index < rows - 1 {
            Divider()
          }
        }
      }
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

#Preview("No Playlists") {
  NoPlaylistsState(recover: {})
    .background(Color.orbis.paper)
}

#Preview("No Playlists, dark") {
  NoPlaylistsState(recover: {})
    .background(Color.orbis.paper)
    .preferredColorScheme(.dark)
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
      address: "https://vanta.example.ts.net:8444"
    ),
    context: "loading the library",
    retry: {}
  )
  .background(Color.orbis.paper)
}

#Preview("Unavailable, dark") {
  UnavailableState(
    failure: OrbisFailure(
      title: "This device is not signed in",
      message: "Sign out in Settings and sign in again.",
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

private struct StatesSample: View {
  var body: some View {
    ScrollView {
      VStack(spacing: 24) {
        EmptyLibraryState(recover: {})
        Divider()
        NoPlaylistsState(recover: {})
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

#Preview("States, xxxLarge and accessibility5, RTL, Mac") {
  AccessibilitySizeMatrix(width: AccessibilityPreview.macWidth) {
    StatesSample().frame(height: 900)
  }
}

#Preview("States, xxxLarge and accessibility5, RTL, iPhone") {
  AccessibilitySizeMatrix(width: AccessibilityPreview.phoneWidth) {
    StatesSample().frame(height: 900)
  }
}
