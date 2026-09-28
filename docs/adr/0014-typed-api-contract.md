# Define the API once as an Effect HttpApi and change it only by addition

The server's routes are hand-registered on an `HttpRouter` in `apps/server/src/app.ts`. `packages/contracts` holds plain TypeScript interfaces that the desktop app and Raycast import, and the Swift client writes its own `Codable` types. Nothing checks that the three agree. That was tolerable with one person and clients built from the same commit. It is not with a web client, friends running older TestFlight builds, and more than twenty new routes.

The API moves into an `HttpApi` in `packages/contracts`: groups of endpoints with Effect schemas for paths, bodies, responses, and errors. The server implements it with `HttpApiBuilder`. The web client, Raycast, and the Electron renderer call it through the derived `HttpApiClient`, so a changed response is a compile error in every TypeScript client. The server serves the OpenAPI document at `/openapi.json`; the Swift client keeps hand-written types for now and is checked against that document in a test.

Authentication becomes an `HttpApiSecurity` bearer middleware that resolves the key to a Person (ADR 0008) and provides it to every handler. The `/admin` group adds a second middleware that requires the admin scope. The Origin check and the local-listener rule stay in the outer wrapper, because they depend on the listener, not the route.

Changes are additive. A route or field may be added; removing or renaming one waits until every client that reads it has shipped a build without it. Native builds lag the server by days and friends update when they update, so there is no `/v1` prefix and no lockstep release.

The web client cannot use `EventSource` for `GET /events`, because it cannot send an `Authorization` header. It reads the stream with `fetch` instead. The server sends a heartbeat every 30 seconds so no proxy between the client and Vanta closes an idle stream.

Rejected alternatives:

- **Keep hand-registered routes and shared interfaces.** Works until a field changes on the server and a client learns about it at runtime.
- **Generate the Swift client from OpenAPI now.** Replaces working, tested client code for no user-visible gain; the conformance test catches drift first.
- **Version the API with a path prefix.** Two copies of every route for a Group of a few people, when additive change covers the same need.
- **Poll for queue and Presence changes.** Simple, and either slow or wasteful through Funnel; one stream per open client is cheaper.

The trade this accepts is one migration of every existing route before any new work, with no change in behavior to show for it. It lands first so every later route is written once, in the contract.
