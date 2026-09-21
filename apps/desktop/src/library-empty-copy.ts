export interface LibraryEmptyCopy {
  message: string;
  title: string;
}

export const libraryEmptyCopy = (input: {
  filtering: boolean;
  playlistId: string | null | undefined;
}): LibraryEmptyCopy => {
  if (input.filtering) {
    return {
      message: "Try another search or clear your filters.",
      title: "No matching sets",
    };
  }
  if (input.playlistId) {
    return {
      message: "Add saved sets using Manage playlist.",
      title: "This playlist is empty",
    };
  }
  return {
    message: "Save your first YouTube or SoundCloud set using the form.",
    title: "Start your collection",
  };
};
