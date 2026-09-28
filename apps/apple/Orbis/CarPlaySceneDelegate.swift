#if os(iOS)
  import CarPlay
  import UIKit

  @MainActor
  final class CarPlaySceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate {
    private var interfaceController: CPInterfaceController?
    private let model = OrbisSession.model

    func templateApplicationScene(
      _ templateApplicationScene: CPTemplateApplicationScene,
      didConnect interfaceController: CPInterfaceController
    ) {
      self.interfaceController = interfaceController
      showLoading()
      Task {
        guard model.isConfigured else {
          showMessage("Open Orbis on your iPhone to connect your library.")
          return
        }
        await model.loadLibrary()
        await model.loadPlaylists()
        guard self.interfaceController === interfaceController else { return }
        showLibrary()
      }
    }

    func templateApplicationScene(
      _ templateApplicationScene: CPTemplateApplicationScene,
      didDisconnectInterfaceController interfaceController: CPInterfaceController
    ) {
      if self.interfaceController === interfaceController {
        self.interfaceController = nil
      }
    }

    private func showLoading() {
      showRoot(
        CPListTemplate(
          title: "Orbis",
          sections: [
            CPListSection(items: [CPListItem(text: "Loading library…", detailText: nil)])
          ]))
    }

    private func showMessage(_ message: String) {
      showRoot(
        CPListTemplate(
          title: "Orbis",
          sections: [
            CPListSection(items: [CPListItem(text: message, detailText: nil)])
          ]))
    }

    private func showLibrary() {
      guard case .loaded(let sets) = model.library else {
        showMessage("Could not load your library. Open Orbis on your iPhone to try again.")
        return
      }

      var sections: [CPListSection] = []
      if case .loaded(let playlists) = model.playlists, !playlists.isEmpty {
        let items = playlists.prefix(CPListTemplate.maximumItemCount).map { playlist in
          let item = CPListItem(text: playlist.name, detailText: nil)
          item.handler = { [weak self] _, completion in
            completion()
            Task { @MainActor [weak self] in
              guard let self else { return }
              await self.model.playPlaylist(playlist.id)
              self.showNowPlaying()
            }
          }
          return item
        }
        sections.append(CPListSection(items: items, header: "Playlists", sectionIndexTitle: nil))
      }

      let remainingItems = CPListTemplate.maximumItemCount - (sections.first?.items.count ?? 0)
      let playableSets = sets.filter { $0.downloadState == "ready" }.prefix(remainingItems)
      if !playableSets.isEmpty {
        let items = playableSets.map { set in
          let item = CPListItem(text: set.title, detailText: set.creator)
          item.handler = { [weak self] _, completion in
            completion()
            Task { @MainActor [weak self] in
              guard let self else { return }
              await self.model.playSet(set.id)
              self.showNowPlaying()
            }
          }
          return item
        }
        sections.append(CPListSection(items: items, header: "Sets", sectionIndexTitle: nil))
      }

      if sections.isEmpty {
        showMessage("No audio is ready to play yet.")
      } else {
        showRoot(CPListTemplate(title: "Orbis", sections: sections))
      }
    }

    private func showRoot(_ template: CPListTemplate) {
      interfaceController?.setRootTemplate(template, animated: false, completion: nil)
    }

    private func showNowPlaying() {
      guard case .loaded(let queue) = model.queue, queue.active != nil else { return }
      interfaceController?.pushTemplate(CPNowPlayingTemplate.shared, animated: true, completion: nil)
    }
  }
#endif
