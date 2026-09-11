import Testing

@testable import OrbisDesign

@Suite struct SetDetailTests {
  @Test func `removing a Set says the source is left alone`() {
    let notice = SetDetail.removalNotice(retainedAudio: false)
    #expect(notice.scope.contains("source is untouched"))
    #expect(notice.retained == nil)
  }

  @Test func `removing a Set that keeps audio says the audio goes too`() {
    let notice = SetDetail.removalNotice(retainedAudio: true)
    #expect(notice.retained?.contains("audio") == true)
    #expect(notice.scope == SetDetail.removalNotice(retainedAudio: false).scope)
  }

  @Test func `the header reads out the title and where it came from`() {
    #expect(
      SetDetail.headerLabel(title: "KETTAMA @ Creamfields", source: "YouTube")
        == "KETTAMA @ Creamfields, YouTube")
  }

  @Test func `the picker names the Playlist it is on`() {
    let choices = [
      PlaylistPicker.Choice(id: "1", name: "Long drives", category: .cyan),
      PlaylistPicker.Choice(id: "2", name: "Closing sets", category: .purple),
    ]
    #expect(PlaylistPicker.label(for: "2", in: choices) == "Playlist, Closing sets")
  }

  @Test func `the picker says when a Set is in no Playlist`() {
    #expect(PlaylistPicker.label(for: nil, in: []) == "Playlist, none")
    #expect(
      PlaylistPicker.label(
        for: "gone",
        in: [
          PlaylistPicker.Choice(id: "1", name: "Long drives", category: .cyan)
        ]) == "Playlist, none")
  }
}
