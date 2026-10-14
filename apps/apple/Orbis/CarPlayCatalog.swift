import Foundation
import OrbisDesign

struct CarPlayCatalog: Equatable {
  enum Status: Equatable {
    case loading
    case signedOut
    case failed(OrbisFailure)
    case ready
  }

  let library: Status
  let playlistsStatus: Status
  let home: HomeSelection
  let playlists: [Playlist]
  let sets: [SavedSet]
  let playingSetId: String?
  let cues: [Cue]

  @MainActor
  init(model: AppModel) {
    guard model.isConfigured else {
      library = .signedOut
      playlistsStatus = .signedOut
      home = HomeSelection(library: [], visible: [])
      playlists = []
      sets = []
      playingSetId = nil
      cues = []
      return
    }
    let all = if case .loaded(let sets) = model.library { sets } else { [SavedSet]() }
    let visible = if case .loaded(let sets) = model.visibleSets { sets } else { [SavedSet]() }
    library = Self.status(of: model.library)
    playlistsStatus = Self.status(of: model.playlists)
    sets = all.filter(Self.isPlayable)
    home = HomeSelection(library: sets, visible: visible.filter(Self.isPlayable))
    playlists = model.playlistItems
    playingSetId = model.audioPlayer.currentSetId
    cues = playingSetId.flatMap { model.tracklists[$0]?.cues } ?? []
  }

  static func isPlayable(_ set: SavedSet) -> Bool { set.downloadState == "ready" }

  private static func status<Value>(of loadable: Loadable<Value>) -> Status {
    switch loadable {
    case .idle, .loading: .loading
    case .loaded: .ready
    case .failed(let failure): .failed(failure)
    }
  }
}
