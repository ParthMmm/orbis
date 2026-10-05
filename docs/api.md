# API

The [typed HTTP contract](../packages/contracts/src/http-api.ts) defines routes, request schemas, responses, and errors. Use it as the route inventory. The application serves its generated description at `/openapi.json`.

For handlers, runtime adapters, and verification, use the [development map](development.md#find-the-implementation).

Library Entries, Listening Queues, and Playback Positions belong to a Person. Sets and Retained Audio are shared according to visibility and retention rules. Read [CONTEXT.md](../CONTEXT.md) and the relevant [ADRs](adr) before changing that behavior.

The Group owns production API data; Vanta serves audio through signed stream grants. See [API deployment](../apps/api/README.md) for Group configuration and [audio-node operation](../deploy/orbis-server/README.md) for Vanta.
