import XCTest

/// The lane's service, reached over HTTP from the test runner. A journey seeds the state it needs
/// and reads back what the app stored, so it proves the change reached the service rather than
/// only the screen.
struct LaneService {
  let address: String
  let token: String

  init() throws {
    let environment = ProcessInfo.processInfo.environment
    guard let address = environment["ORBIS_UI_TEST_ADDRESS"], !address.isEmpty,
      let token = environment["ORBIS_UI_TEST_TOKEN"], !token.isEmpty
    else {
      throw XCTSkip("the lane must supply ORBIS_UI_TEST_ADDRESS and ORBIS_UI_TEST_TOKEN")
    }
    self.address = address
    self.token = token
  }

  struct Set: Decodable {
    let id: String
    let title: String
  }

  struct Playlist: Decodable {
    let id: String
    let name: String
  }

  private struct Sets: Decodable { let sets: [Set] }
  private struct Playlists: Decodable { let playlists: [Playlist] }

  func saveSet(title: String, url: String) throws -> Set {
    try send("POST", "sets", ["title": title, "url": url, "tags": []])
  }

  func createPlaylist(named name: String) throws -> Playlist {
    try send("POST", "playlists", ["name": name])
  }

  func playlists() throws -> [Playlist] {
    let response: Playlists = try send("GET", "playlists", nil)
    return response.playlists
  }

  func deletePlaylist(_ id: String) throws {
    let _: Playlist = try send("DELETE", "playlists/\(id)", nil)
  }

  @discardableResult
  func setMembers(of playlistId: String, to setIds: [String]) throws -> [Set] {
    let response: Sets = try send("PUT", "playlists/\(playlistId)/sets", ["setIds": setIds])
    return response.sets
  }

  func members(of playlistId: String) throws -> [Set] {
    let response: Sets = try send("GET", "sets?playlistId=\(playlistId)", nil)
    return response.sets
  }

  func library() throws -> [Set] {
    let response: Sets = try send("GET", "sets", nil)
    return response.sets
  }

  private func send<Response: Decodable>(
    _ method: String, _ path: String, _ body: [String: Any]?
  ) throws -> Response {
    var request = URLRequest(url: URL(string: "\(address)/\(path)")!)
    request.httpMethod = method
    request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
    if let body {
      request.setValue("application/json", forHTTPHeaderField: "content-type")
      request.httpBody = try JSONSerialization.data(withJSONObject: body)
    }
    var result: Result<Data, Error> = .failure(URLError(.timedOut))
    let done = DispatchSemaphore(value: 0)
    URLSession.shared.dataTask(with: request) { data, response, error in
      let status = (response as? HTTPURLResponse)?.statusCode ?? 0
      if let error {
        result = .failure(error)
      } else if !(200..<300).contains(status) {
        result = .failure(URLError(.badServerResponse, userInfo: ["status": status]))
      } else {
        result = .success(data ?? Data())
      }
      done.signal()
    }.resume()
    guard done.wait(timeout: .now() + 20) == .success else { throw URLError(.timedOut) }
    return try JSONDecoder().decode(Response.self, from: result.get())
  }
}
