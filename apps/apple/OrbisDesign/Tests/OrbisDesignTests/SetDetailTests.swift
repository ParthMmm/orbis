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

  @Test func `the facts line says when a Set arrived and how often it was heard`() {
    let line = SetDetail.factsLine(
      dates: .init(imported: "11 Sep 2026", released: "22 Aug 2026"),
      statistics: .init(listenCount: 3, finishCount: 1, lastHeard: "Thu 11 Sep"))
    #expect(line == "Released 22 Aug 2026 · Added 11 Sep 2026 · 3 listens · finished once")
  }

  @Test func `the facts line leaves out what has not happened`() {
    #expect(
      SetDetail.factsLine(
        dates: .init(imported: "11 Sep 2026"), statistics: .init(listenCount: 0, finishCount: 0))
        == "Added 11 Sep 2026")
    #expect(
      SetDetail.factsLine(
        dates: nil, statistics: .init(listenCount: 1, finishCount: 2))
        == "1 listen · finished 2 times")
    #expect(SetDetail.factsLine(dates: nil, statistics: nil) == nil)
  }

  @Test func `the meta line leads with the source and length`() {
    #expect(
      SetDetail.metaLine(
        source: "YouTube", length: "1h 59m", dates: .init(imported: "27 Sep 2026"),
        statistics: .init(listenCount: 3, finishCount: 0))
        == "YouTube · 1h 59m · Added 27 Sep 2026 · 3 listens")
    #expect(SetDetail.metaLine(source: "SoundCloud", length: nil, dates: nil, statistics: nil) == "SoundCloud")
  }

  @Test func `the download capsule says where the Download is and fills with it`() {
    #expect(DownloadCapsule.label(for: .available) == "Download")
    #expect(DownloadCapsule.label(for: .queued) == "Waiting to download")
    #expect(DownloadCapsule.label(for: .downloading(0.416)) == "Downloading 42%")
    #expect(DownloadCapsule.label(for: .downloading(nil)) == "Downloading")
    #expect(DownloadCapsule.label(for: .failed) == "Retry Download")
    #expect(DownloadCapsule.fill(for: .queued) == 0)
    #expect(DownloadCapsule.fill(for: .downloading(1.4)) == 1)
    #expect(DownloadCapsule.fill(for: .available) == 1)
  }
}
