export type LibraryEmptyCopy = {
  title: string;
  message: string;
};

export const libraryEmptyCopy = (input: {
  filtering: boolean;
  playlistId: string | null | undefined;
}): LibraryEmptyCopy => {
  if (input.filtering) {
    return {
      title: "No matching sets",
      message: "Try another search or clear your filters.",
    };
  }
  if (input.playlistId) {
    return {
      title: "This playlist is empty",
      message: "Add saved sets using Manage playlist.",
    };
  }
  return {
    title: "Start your collection",
    message: "Save your first YouTube or SoundCloud set using the form.",
  };
};
