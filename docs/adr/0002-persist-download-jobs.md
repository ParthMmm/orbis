# Persist downloads and run them with an Effect worker

Download jobs will be persisted in SQLite and processed sequentially by a scoped Effect v4 worker on Vanta. An Effect Queue may wake the worker, but SQLite remains the source of truth so queued and interrupted work survives process restarts; Cobalt access, media storage, and job orchestration remain separate Effect services composed as Layers.
