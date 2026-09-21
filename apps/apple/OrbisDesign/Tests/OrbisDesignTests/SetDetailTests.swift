import Testing

@testable import OrbisDesign

@Suite struct SetDetailTests {
  @Test func `removing a Set says the source is left alone`() {
    let notice = SetManagement.removalNotice(retainedAudio: false)
    #expect(notice.scope.contains("source is untouched"))
    #expect(notice.retained == nil)
  }

  @Test func `removing a Set that keeps audio says the audio goes too`() {
    let notice = SetManagement.removalNotice(retainedAudio: true)
    #expect(notice.retained?.contains("audio") == true)
    #expect(notice.scope == SetManagement.removalNotice(retainedAudio: false).scope)
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

  @Test func `a Set nobody has heard has no statistics`() {
    #expect(SetDetail.Statistics(listenCount: 0, finishCount: 0).isEmpty)
  }

  @Test func `statistics say how often a Set was heard and when last`() {
    let heard = SetDetail.Statistics(
      listenCount: 3, finishCount: 1, lastHeard: "Thu 11 Sep")
    #expect(!heard.isEmpty)
    #expect(heard.listens == "3 · last Thu 11 Sep")
    #expect(heard.finishes == "1")
  }

  @Test func `a Listen that never reached the end has no finish`() {
    let started = SetDetail.Statistics(
      listenCount: 1, finishCount: 0, lastHeard: "Thu 11 Sep")
    #expect(started.listens == "1 · last Thu 11 Sep")
    #expect(started.finishes == "None yet")
  }

  @Test func `a Listen with no date still counts`() {
    let withoutDate = SetDetail.Statistics(listenCount: 2, finishCount: 0)
    #expect(withoutDate.listens == "2")
  }
}
