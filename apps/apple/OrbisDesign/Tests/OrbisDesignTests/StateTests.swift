import SwiftUI
import Testing

@testable import OrbisDesign

/// A state is only useful if the person can see the way out of it. These pin the words on the
/// button, because the label is the whole recovery for someone who reads only the label.
@Suite struct StateTests {
  @Test func `every state offers the recovery its name promises`() {
    #expect(EmptyLibraryState.recoveryLabel == "Paste a link")
    #expect(EmptyPlaylistState.recoveryLabel == "Add Sets")
    #expect(NoResultsState.recoveryLabel == "Clear filters")
    #expect(UnavailableState.recoveryLabel == "Try again")
    #expect(LoadingState.recoveryLabel == nil, "there is nothing to recover from yet")
  }

  @Test func `a state that offers an action says what happened`() {
    let states: [(title: String, message: String, symbol: String)] = [
      (EmptyLibraryState.title, EmptyLibraryState.message, EmptyLibraryState.symbol),
      (EmptyPlaylistState.title, EmptyPlaylistState.message, EmptyPlaylistState.symbol),
      (NoResultsState.title, NoResultsState.message, NoResultsState.symbol),
    ]
    for state in states {
      #expect(!state.title.isEmpty)
      #expect(!state.message.isEmpty)
      #expect(!state.symbol.isEmpty)
    }
  }

  /// An empty Playlist and an empty Library both hold nothing, and they are not the same thing.
  @Test func `the two empty states do not share their words`() {
    #expect(EmptyLibraryState.title != EmptyPlaylistState.title)
    #expect(EmptyLibraryState.message != EmptyPlaylistState.message)
  }

  @Test func `retry appears only when retrying could change the answer`() {
    let retryable = OrbisFailure(
      title: "Cannot reach your library", message: "Try again later.", symbol: "wifi.exclamationmark",
      isRetryable: true
    )
    let settled = OrbisFailure(
      title: "This device is not paired", message: "Pair it on the host.", symbol: "key.slash",
      isRetryable: false
    )
    #expect(UnavailableState.showsRetry(for: retryable))
    #expect(!UnavailableState.showsRetry(for: settled))
  }

  /// The report a person copies has to name the failure, its address, and what the app was
  /// doing, or the reader has to ask for all three.
  @Test func `a copied report carries what the reader needs`() {
    let failure = OrbisFailure(
      title: "That address is not your library",
      message: "Check the address.",
      symbol: "doc.questionmark",
      isRetryable: false,
      address: "https://library.example:8444"
    )
    let text = FailureReport(failure: failure, context: "loading the library").text
    #expect(text.hasPrefix("Orbis "))
    #expect(text.contains("What: That address is not your library"))
    #expect(text.contains("Where: https://library.example:8444"))
    #expect(text.contains("Doing: loading the library"))
  }

  @Test func `a report without an address leaves that line out`() {
    let failure = OrbisFailure(
      title: "Cannot reach your library", message: "Check Tailscale.", symbol: "wifi.exclamationmark",
      isRetryable: true
    )
    let text = FailureReport(failure: failure, context: "loading the library").text
    #expect(!text.contains("Where:"))
    #expect(text.contains("Check Tailscale."))
  }
}
