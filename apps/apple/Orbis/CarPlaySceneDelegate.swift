#if os(iOS)
  import CarPlay
  import OrbisDesign
  import UIKit

  @MainActor
  final class CarPlaySceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate,
    CPNowPlayingTemplateObserver
  {
    private enum Action {
      case playSet(String)
      case playPlaylist(String)
      case playCue(Cue, setId: String)
      case openPlaylist(Playlist)
      case openRail(String, [SavedSet])
      case reload
    }

    private var interfaceController: CPInterfaceController?
    private let model = OrbisSession.model
    private let artwork = CarPlayArtwork()
    private var catalog: CarPlayCatalog?
    private var connection = 0

    private let homeTab = CPListTemplate(title: Destination.home.rawValue, sections: [])
    private let playlistsTab = CPListTemplate(title: Destination.playlists.rawValue, sections: [])
    private let libraryTab = CPListTemplate(title: Destination.library.rawValue, sections: [])
    private weak var tracklist: CPListTemplate?

    func templateApplicationScene(
      _ templateApplicationScene: CPTemplateApplicationScene,
      didConnect interfaceController: CPInterfaceController
    ) {
      self.interfaceController = interfaceController
      artwork.scale = interfaceController.carTraitCollection.displayScale
      // Configured on connection rather than on push: the system can show Now Playing on its
      // own, from the car's home screen, before Orbis pushes anything.
      let nowPlaying = CPNowPlayingTemplate.shared
      nowPlaying.upNextTitle = "Tracklist"
      nowPlaying.isUpNextButtonEnabled = false
      nowPlaying.add(self)

      let templates: [Destination: CPListTemplate] = [
        .home: homeTab, .library: libraryTab, .playlists: playlistsTab,
      ]
      let tabs = Destination.allCases.compactMap { destination in
        templates[destination].map { template in
          template.tabTitle = destination.rawValue
          template.tabImage = UIImage(systemName: destination.symbol)
          return template
        }
      }
      interfaceController.setRootTemplate(
        CPTabBarTemplate(templates: tabs), animated: false, completion: nil)

      catalog = nil
      connection += 1
      observeModel(connection)
      Task { await loadIfNeeded() }
    }

    func templateApplicationScene(
      _ templateApplicationScene: CPTemplateApplicationScene,
      didDisconnectInterfaceController interfaceController: CPInterfaceController
    ) {
      guard self.interfaceController === interfaceController else { return }
      self.interfaceController = nil
      tracklist = nil
      CPNowPlayingTemplate.shared.remove(self)
    }

    nonisolated func nowPlayingTemplateUpNextButtonTapped(_ nowPlayingTemplate: CPNowPlayingTemplate) {
      MainActor.assumeIsolated { showTracklist() }
    }

    private func observeModel(_ connection: Int) {
      guard connection == self.connection, interfaceController != nil else { return }
      let next = withObservationTracking {
        CarPlayCatalog(model: model)
      } onChange: { [weak self] in
        Task { @MainActor in self?.observeModel(connection) }
      }
      guard next != catalog else { return }
      catalog = next
      draw(next)
    }

    private func loadIfNeeded() async {
      guard model.isConfigured, model.library == .idle else { return }
      await model.loadLibrary()
      await model.loadPlaylists()
      await model.loadQueue()
    }

    private func draw(_ catalog: CarPlayCatalog) {
      fill(homeTab, status: catalog.library, empty: "No sets are ready to play yet.") {
        homeSections(catalog)
      }
      fill(playlistsTab, status: catalog.playlistsStatus, empty: "No playlists yet.") {
        [CPListSection(items: catalog.playlists.map(playlistItem))]
      }
      fill(libraryTab, status: catalog.library, empty: "No sets are ready to play yet.") {
        [CPListSection(items: setItems(catalog.sets, catalog: catalog))]
      }
      CPNowPlayingTemplate.shared.isUpNextButtonEnabled = !catalog.cues.isEmpty
      if let tracklist {
        tracklist.updateSections(cueSections(catalog))
      }
    }

    private func fill(
      _ template: CPListTemplate, status: CarPlayCatalog.Status, empty: String,
      sections: () -> [CPListSection]
    ) {
      template.showsSpinnerWhileEmpty = status == .loading
      switch status {
      case .loading:
        template.emptyViewTitleVariants = ["Loading…"]
        template.emptyViewSubtitleVariants = []
        template.updateSections([])
      case .signedOut:
        template.emptyViewTitleVariants = ["Not signed in"]
        template.emptyViewSubtitleVariants = ["Sign in to Orbis to see your library here."]
        template.updateSections([])
      case .failed(let failure):
        template.updateSections([retrySection(failure)])
      case .ready:
        template.emptyViewTitleVariants = [empty]
        template.emptyViewSubtitleVariants = []
        template.updateSections(Self.fit(sections()))
      }
    }

    private func homeSections(_ catalog: CarPlayCatalog) -> [CPListSection] {
      let home = catalog.home
      var sections: [CPListSection] = []
      if let lead = home.lead {
        let card = CPListImageRowItemCardElement(
          image: CarPlayArtwork.placeholder, showsImageFullHeight: true, title: lead.title,
          subtitle: home.isResume ? SetPresentation.timeLeft(lead) : lead.creator, tintColor: nil)
        artwork.apply(
          SetPresentation.pageArtwork(lead),
          size: CPListImageRowItemCardElement.maximumFullHeightImageSize
        ) { [weak card] in card?.image = $0 }
        let row = CPListImageRowItem(
          text: home.isResume ? "Continue listening" : "Fresh in your library",
          cardElements: [card], allowsMultipleLines: false)
        row.handler = handler(.playSet(lead.id))
        row.listImageRowHandler = { [weak self] _, _, completion in
          self?.perform(.playSet(lead.id), completion: completion) ?? completion()
        }
        sections.append(CPListSection(items: [row]))
      }
      let rails: [(String, [SavedSet], (SavedSet) -> String?)] = [
        ("Continue listening", home.continueRail, SetPresentation.timeLeft),
        ("Recently filed", home.recentlyFiled, \.creator),
      ]
      for (title, sets, detail) in rails where !sets.isEmpty {
        sections.append(CPListSection(items: [rail(title, sets: sets, detail: detail)]))
      }
      if !catalog.playlists.isEmpty {
        sections.append(
          CPListSection(
            items: catalog.playlists.map(playlistItem), header: Destination.playlists.rawValue,
            sectionIndexTitle: nil))
      }
      return sections
    }

    private func rail(
      _ title: String, sets: [SavedSet], detail: (SavedSet) -> String?
    ) -> CPListImageRowItem {
      let shown = Array(sets.prefix(Int(CPMaximumNumberOfGridImages)))
      let elements = shown.map { set in
        let element = CPListImageRowItemRowElement(
          image: CarPlayArtwork.placeholder, title: set.title, subtitle: detail(set))
        artwork.apply(
          set.artworkUrl.flatMap(URL.init(string:)),
          size: CPListImageRowItemRowElement.maximumImageSize
        ) { [weak element] in element?.image = $0 }
        return element
      }
      let row = CPListImageRowItem(text: title, elements: elements, allowsMultipleLines: false)
      row.handler = handler(.openRail(title, sets))
      row.listImageRowHandler = { [weak self] _, index, completion in
        guard shown.indices.contains(index) else { return completion() }
        self?.perform(.playSet(shown[index].id), completion: completion) ?? completion()
      }
      return row
    }

    private func playlistItem(_ playlist: Playlist) -> CPListItem {
      let item = CPListItem(
        text: playlist.name,
        detailText: playlist.setCount == 1 ? "1 set" : "\(playlist.setCount) sets",
        image: UIImage(systemName: Destination.playlists.symbol))
      item.accessoryType = .disclosureIndicator
      item.handler = handler(.openPlaylist(playlist))
      return item
    }

    private func setItems(_ sets: [SavedSet], catalog: CarPlayCatalog?) -> [CPListItem] {
      sets.prefix(Int(CPListTemplate.maximumItemCount)).map { set in
        let item = CPListItem(
          text: set.title, detailText: set.creator, image: CarPlayArtwork.placeholder)
        item.isPlaying = set.id == catalog?.playingSetId
        artwork.apply(set.artworkUrl.flatMap(URL.init(string:)), size: CPListItem.maximumImageSize) {
          [weak item] in item?.setImage($0)
        }
        item.handler = handler(.playSet(set.id))
        return item
      }
    }

    private func cueSections(_ catalog: CarPlayCatalog) -> [CPListSection] {
      guard let setId = catalog.playingSetId else { return [] }
      let current = model.audioPlayer.currentCue
      let items = catalog.cues.map { cue in
        let start = cue.startSeconds.map(SetPresentation.timestamp)
        let item = CPListItem(
          text: cue.title, detailText: [cue.artist, start].compactMap(\.self).joined(separator: " · "))
        item.isPlaying = cue == current
        item.isEnabled = cue.startSeconds != nil
        item.handler = handler(.playCue(cue, setId: setId))
        return item
      }
      return Self.fit([CPListSection(items: items)])
    }

    private func retrySection(_ failure: OrbisFailure) -> CPListSection {
      let retry = CPListItem(
        text: "Try Again", detailText: failure.message,
        image: UIImage(systemName: "arrow.clockwise"))
      retry.handler = handler(.reload)
      return CPListSection(items: [retry], header: failure.title, sectionIndexTitle: nil)
    }

    private static func fit(_ sections: [CPListSection]) -> [CPListSection] {
      var budget = Int(CPListTemplate.maximumItemCount)
      return sections.prefix(Int(CPListTemplate.maximumSectionCount)).compactMap { section in
        guard budget > 0 else { return nil }
        let items = Array(section.items.prefix(budget))
        budget -= items.count
        return CPListSection(items: items, header: section.header, sectionIndexTitle: nil)
      }
    }

    private func handler(_ action: Action) -> (any CPSelectableListItem, @escaping () -> Void) -> Void {
      { [weak self] _, completion in
        self?.perform(action, completion: completion) ?? completion()
      }
    }

    private func perform(_ action: Action, completion: @escaping () -> Void) {
      Task {
        defer { completion() }
        switch action {
        case .playSet(let id):
          await model.playSet(id)
          showNowPlaying(ifPlaying: model.audioPlayer.currentSetId == id)
        case .playPlaylist(let id):
          await model.playPlaylist(id)
          showNowPlaying(ifPlaying: model.audioPlayer.currentSetId != nil)
        case .playCue(let cue, let setId):
          await model.playCue(cue, in: setId)
        case .openPlaylist(let playlist):
          await openPlaylist(playlist)
        case .openRail(let title, let sets):
          let template = CPListTemplate(title: title, sections: [])
          template.updateSections(
            Self.fit([CPListSection(items: setItems(sets, catalog: catalog))]))
          interfaceController?.pushTemplate(template, animated: true, completion: nil)
        case .reload:
          await model.loadLibrary()
          await model.loadPlaylists()
        }
      }
    }

    private func openPlaylist(_ playlist: Playlist) async {
      let template = CPListTemplate(title: playlist.name, sections: [])
      template.showsSpinnerWhileEmpty = true
      interfaceController?.pushTemplate(template, animated: true, completion: nil)
      switch await model.playlistSets(playlist.id) {
      case .loaded(let sets):
        template.showsSpinnerWhileEmpty = false
        let playable = sets.filter(CarPlayCatalog.isPlayable)
        guard !playable.isEmpty else {
          template.emptyViewTitleVariants = ["Nothing in this playlist is ready to play yet."]
          return
        }
        let playAll = CPListItem(
          text: "Play All", detailText: nil, image: UIImage(systemName: "play.fill"))
        playAll.handler = handler(.playPlaylist(playlist.id))
        let rows = setItems(playable, catalog: catalog)
        template.updateSections(
          Self.fit([CPListSection(items: [playAll]), CPListSection(items: rows)]))
      case .failed(let failure):
        template.showsSpinnerWhileEmpty = false
        template.emptyViewTitleVariants = [failure.title]
        template.emptyViewSubtitleVariants = [failure.message]
      case .idle, .loading:
        template.showsSpinnerWhileEmpty = false
      }
    }

    private func showNowPlaying(ifPlaying isPlaying: Bool) {
      guard let interfaceController else { return }
      guard isPlaying else {
        let alert = CPAlertTemplate(
          titleVariants: [model.setFailure?.message ?? "Nothing here is ready to play yet."],
          actions: [
            CPAlertAction(title: "OK", style: .cancel) { [weak interfaceController] _ in
              interfaceController?.dismissTemplate(animated: true, completion: nil)
            }
          ])
        interfaceController.presentTemplate(alert, animated: true, completion: nil)
        return
      }
      guard interfaceController.topTemplate !== CPNowPlayingTemplate.shared else { return }
      interfaceController.pushTemplate(CPNowPlayingTemplate.shared, animated: true, completion: nil)
    }

    private func showTracklist() {
      guard let interfaceController, let catalog else { return }
      let template = CPListTemplate(title: "Tracklist", sections: cueSections(catalog))
      tracklist = template
      interfaceController.pushTemplate(template, animated: true, completion: nil)
    }
  }

  @MainActor
  final class CarPlayArtwork {
    static let placeholder = UIImage(systemName: "music.note") ?? UIImage()

    var scale: CGFloat = 2

    private let images = NSCache<NSString, UIImage>()
    private var waiting: [String: [(UIImage) -> Void]] = [:]

    init() {
      images.countLimit = 200
    }

    func apply(_ url: URL?, size: CGSize, deliver: @escaping (UIImage) -> Void) {
      guard let url else { return }
      let key = "\(url.absoluteString)@\(size.width)x\(size.height)"
      if let image = images.object(forKey: key as NSString) {
        deliver(image)
        return
      }
      guard waiting[key] == nil else {
        waiting[key]?.append(deliver)
        return
      }
      waiting[key] = [deliver]
      let scale = scale
      Task {
        let image = await Self.fetch(url, size: size, scale: scale)
        let deliveries = waiting.removeValue(forKey: key) ?? []
        guard let image else { return }
        images.setObject(image, forKey: key as NSString)
        for deliver in deliveries { deliver(image) }
      }
    }

    @concurrent
    private nonisolated static func fetch(_ url: URL, size: CGSize, scale: CGFloat) async -> UIImage? {
      guard let (data, _) = try? await URLSession.shared.data(from: url),
        let source = UIImage(data: data), source.size.width > 0, source.size.height > 0
      else { return nil }
      let fill = max(size.width / source.size.width, size.height / source.size.height)
      let drawn = CGSize(width: source.size.width * fill, height: source.size.height * fill)
      let format = UIGraphicsImageRendererFormat()
      format.scale = scale
      return UIGraphicsImageRenderer(size: size, format: format).image { _ in
        source.draw(
          in: CGRect(
            x: (size.width - drawn.width) / 2, y: (size.height - drawn.height) / 2,
            width: drawn.width, height: drawn.height))
      }
    }
  }
#endif
