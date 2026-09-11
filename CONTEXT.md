# Orbis

Orbis is a personal library for collecting and organizing music and DJ sets from supported sources.

## Language

**Set**:
A saved music recording or DJ performance identified by its source link.
_Avoid_: Item, bookmark, track

**Source Link**:
The original YouTube or SoundCloud address associated with a Set.
_Avoid_: Media URL, download URL

**Retained Audio**:
An audio copy associated with a Set and stored by Orbis for playback.
_Avoid_: Download, media file

**Download**:
A request for Orbis to create Retained Audio for a Set from its Source Link.
_Avoid_: Save

**Playback Position**:
The point in a Set's Retained Audio where listening should resume.
_Avoid_: Progress

**Listen**:
One activation of a Set through an intentional play action or automatic Listening Queue advance. Pausing and resuming the active Set remain part of the same Listen.
_Avoid_: Play, playback session

**Finish**:
A Listen that reaches the natural end of its Set. A Listen can produce at most one Finish.
_Avoid_: Completion

**Library**:
The complete collection of Sets saved by one person.
_Avoid_: Catalog, collection

**Playlist**:
A named, ordered selection of Sets from the Library.
_Avoid_: Folder

**Listening Queue**:
The temporary ordered sequence of Sets scheduled for playback.
_Avoid_: Playlist, play queue

**Tag**:
A short label used to classify and filter Sets across the Library.
_Avoid_: Category
