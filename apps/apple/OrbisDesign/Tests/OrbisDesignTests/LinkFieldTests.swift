import Testing

@testable import OrbisDesign

@Suite struct LinkFieldTests {
  @Test func `a link can be filed once it is shaped like one`() {
    #expect(LinkField.canSubmit(link: "https://youtu.be/tPEMP9oYxTo", state: .idle))
    #expect(LinkField.canSubmit(link: "  https://soundcloud.com/rinsefm/x  ", state: .idle))
  }

  @Test(
    arguments: [
      "", "   ", "youtu.be/abc", "example.com", "not a link", "ftp://example.com/set", "https://",
    ])
  func `text that is not a link cannot be filed`(text: String) {
    #expect(!LinkField.canSubmit(link: text, state: .idle))
  }

  @Test func `a link is read for its address`() {
    #expect(LinkField.address(of: "https://youtu.be/abc")?.host() == "youtu.be")
    #expect(LinkField.address(of: "  https://youtu.be/abc  ")?.absoluteString == "https://youtu.be/abc")
  }

  @Test(arguments: ["", "youtu.be/abc", "not a url", "ftp://example.com/set"])
  func `text that names no address is not read as one`(text: String) {
    #expect(LinkField.address(of: text) == nil)
  }

  @Test func `a check in flight cannot be filed twice`() {
    #expect(!LinkField.canSubmit(link: "https://youtu.be/tPEMP9oYxTo", state: .checking))
  }

  @Test func `a refusal can be filed again once the link changes`() {
    #expect(
      LinkField.canSubmit(
        link: "https://example.com/set", state: .invalid(message: "Orbis does not know that.")))
  }

  @Test func `only the refusals have words`() {
    #expect(LinkFieldState.idle.message == nil)
    #expect(LinkFieldState.checking.message == nil)
    #expect(LinkFieldState.valid(source: "YouTube").message == nil)
    #expect(LinkFieldState.invalid(message: "No.").message == "No.")
    #expect(LinkFieldState.duplicate(message: "Again.").message == "Again.")
  }

  @Test func `a refusal is told with a symbol, not color alone`() {
    #expect(
      LinkFieldState.invalid(message: "No.").symbol
        != LinkFieldState.duplicate(message: "No.").symbol)
    #expect(LinkFieldState.valid(source: "YouTube").symbol != LinkFieldState.checking.symbol)
  }
}
