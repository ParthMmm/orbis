import Testing

@testable import OrbisDesign

@Suite struct TagInputTests {
  @Test(arguments: [("  techno  ", "techno"), ("TECHNO", "techno"), ("  Breaks ", "breaks")])
  func `a tag is trimmed and lowercased`(input: String, expected: String) {
    #expect(TagInput.normalize(input) == expected)
  }

  @Test(arguments: ["", "   ", "\n\t"])
  func `a tag with nothing in it is not a tag`(input: String) {
    #expect(TagInput.normalize(input) == nil)
  }

  @Test func `a tag is capped at the length the service keeps`() {
    let long = String(repeating: "a", count: TagInput.serviceTagLength + 20)
    #expect(TagInput.normalize(long)?.count == TagInput.serviceTagLength)
  }

  @Test func `a tag joins the list once`() {
    #expect(TagInput.adding("Techno", to: ["techno"]) == ["techno"])
    #expect(TagInput.adding("techno", to: []) == ["techno"])
  }

  @Test func `the list stops at the count the service keeps`() {
    let full = (1...TagInput.serviceLimit).map { "tag\($0)" }
    #expect(TagInput.adding("one more", to: full) == full)
    #expect(TagInput.adding("one more", to: Array(full.dropLast())).count == TagInput.serviceLimit)
  }

  @Test func `suggestions exclude what is already chosen`() {
    #expect(TagInput.suggestions(from: ["Techno", "house", "breaks"], chosen: ["techno"]) == ["house", "breaks"])
  }

  @Test func `suggestions offer each tag once, in the library's order`() {
    #expect(TagInput.suggestions(from: ["bass", "bass", "Bass", "house"], chosen: []) == ["bass", "house"])
  }

  @Test func `a tag's color does not change with the case it arrives in`() {
    #expect(OrbisColor.Category.forTag("Techno") == OrbisColor.Category.forTag("techno"))
  }

}
