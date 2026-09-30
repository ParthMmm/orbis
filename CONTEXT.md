# Orbis

Orbis is a personal library for collecting and organizing music and DJ sets from supported sources.

## Language

**Set**:
A music recording or DJ performance identified by its Source Link. One Set exists per Source Link, shared by every Library that saves it.
_Avoid_: Item, bookmark, track

**Tracklist**:
The ordered Cues identified for one Set, shared by everyone who can see that Set.
_Avoid_: Playlist, chapters

**Cue**:
One named recording in a Set's Tracklist. It may name a start time in the Set's Retained Audio.
_Avoid_: Track, chapter

**Library Entry**:
One Person's saving of one Set, holding that Person's title override and Tags.
_Avoid_: Save, bookmark

**Artwork**:
The provider's image for a Set. A Set holds two: the one a listing draws, and the large one its own page draws.
_Avoid_: Thumbnail, cover, image

**Source Link**:
The original YouTube or SoundCloud address associated with a Set.
_Avoid_: Media URL, download URL

**Retained Audio**:
An audio copy of a Set stored on Vanta for playback. One per Set, streamable by anyone who can see the Set.
_Avoid_: Download, media file

**Download**:
A request for Orbis to create Retained Audio for a Set from its Source Link. It never means a copy on a device.

**Auto Download**:
A Person's setting, on by default, that starts a Download whenever they save a Set without Retained Audio.
_Avoid_: Save

**Playback Position**:
The point in a Set's Retained Audio where one Person's listening should resume.
_Avoid_: Progress

**Listen**:
One Person's activation of a Set through an intentional play action or automatic Listening Queue advance. Pausing and resuming the active Set remain part of the same Listen.
_Avoid_: Play, playback session

**Finish**:
A Listen that reaches the natural end of its Set. A Listen can produce at most one Finish.
_Avoid_: Completion

**Library**:
The complete collection of one Person's Library Entries.
_Avoid_: Catalog, collection

**Playlist**:
A named, ordered selection of Sets, owned by the Person who created it. The word on screen is Playlist.
_Avoid_: Folder, Crate

**Listening Queue**:
One Person's temporary ordered sequence of Sets scheduled for playback, shared by all of that Person's clients.
_Avoid_: Playlist, play queue

**Tag**:
A short label used to classify and filter Sets across the Library.
_Avoid_: Category

**Collaborative**:
A Playlist flag, set by its creator, that lets named editors add, remove, and reorder its Sets.

**Person**:
A member of the Group with a username and one or more API keys.
_Avoid_: User, account

**Group**:
Everyone the Host admits to one Orbis deployment. One Group per deployment.
_Avoid_: Team, org, server

**Host**:
The Person who runs the deployment and can mint and revoke keys and remove People.
_Avoid_: Admin

**Invite**:
A one-time link the Host sends that signs in a Person's first device, or a returning Person's new one, by minting that device's key.
_Avoid_: Signup link, magic link

**Device Link**:
Signing in a new device by approving its short code on a device the Person already uses.
_Avoid_: Pairing code, QR login

**Social**:
A Person's switch, off by default. Off hides them from others and others from them.
_Avoid_: Sharing mode, public mode

**See / Appear**:
One Person's filters for another. See includes them in your social views; Appear lets them see you.
_Avoid_: Follow, mute

**Presence**:
The Set a Person is in a Listen on now, plus their few most recent Sets.
_Avoid_: Now playing, status

**Listen History**:
A Person's Listens and Finishes, shown on their profile to People who pass the social gate.
_Avoid_: Activity feed
