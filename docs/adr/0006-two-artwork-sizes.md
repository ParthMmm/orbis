# Hold two artwork images per Set, one for a listing and one for the Set's own page

A provider's image comes in sizes, and the size a listing needs is not the size a Set's own page needs. A row draws artwork 88 points wide, which is 264 pixels at 3x. The page draws it as wide as the window, which is more than 1200 pixels on a phone. One address for both means either a soft page or a listing that fetches six times the bytes it can show: measured on one YouTube video, `mqdefault` is 10KB and `maxresdefault` is 65KB.

So a Set holds two. `artworkUrl` is the image a listing draws, at the size a row needs. `artworkLargeUrl` is the same image at the largest size the provider offers, which only the Set's own page draws. Enrichment fills both, because it is the one place that talks to the provider and the provider is the only thing that knows which sizes a video has: the API's thumbnail object lists the sizes that exist, and `maxres` exists for most videos and not all.

The client draws the large image when it has one and falls back to the listing's when it does not, which is what a Set from a service that predates the second image gets. `bun run backfill:artwork` walks the Sets that predate it and fills the column.

Either image can be a 4:3 canvas with a 16:9 picture letterboxed inside it. YouTube documents those bars, and the sizes are fixed per name: `hqdefault` is 480x360 with 45 rows of black above and below the picture. The design system crops whatever it is handed into a 16:9 box, so a 4:3 size can still be chosen for its pixels.

Rejected alternatives:

- **One image, the largest.** Never soft and never a guess, but every row in a scrolling library fetches 65KB to fill 264 pixels.
- **One image, the size a row needs.** The cheapest library, and the Set page stretches a 320-pixel image across 1200 pixels.
- **Derive the large address from the small one.** No column and no backfill, and it would reach the library that already exists. Rejected because only the provider knows whether a video has a `maxresdefault`, and a wrong guess answers 404 where an image used to be.
- **Store the video id and let each client build addresses.** Puts the provider's address scheme inside every client, and the second size stops working whenever a client is offline.
