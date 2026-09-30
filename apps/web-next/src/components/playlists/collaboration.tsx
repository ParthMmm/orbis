import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { FormEvent } from "react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { FAILURE_MESSAGES } from "@/lib/orbis";
import type { ApiResult, Credentials } from "@/lib/orbis";
import { setCollaborative, setEditors } from "@/lib/playlists";
import type { Collaboration, VisiblePerson } from "@/lib/playlists";

/**
 * The creator's Collaborative switch and editors (ADR 0010). Only the creator
 * sees this card; an editor must be a Person the creator can see, and who can
 * see them.
 */
export const CollaborationCard = ({
  collaboration,
  credentials,
  people,
  playlistId,
}: {
  readonly collaboration: Collaboration;
  readonly credentials: Credentials;
  readonly people: readonly VisiblePerson[];
  readonly playlistId: string;
}) => {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const settle = async (
    call: Promise<ApiResult<unknown>>,
    notFound: string
  ) => {
    setPending(true);
    const result = await call;
    if (result.ok) {
      setProblem(null);
      await router.invalidate();
    } else {
      setProblem(
        result.status === 404 ? notFound : FAILURE_MESSAGES[result.failure]
      );
    }
    setPending(false);
  };
  const { editorIds } = collaboration;
  const nameOf = (id: string) =>
    people.find((person) => person.id === id)?.username ??
    "A Person you cannot see";
  const candidates = people.filter((person) => !editorIds.includes(person.id));
  const addEditor = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const id = String(new FormData(event.currentTarget).get("editor") ?? "");
    if (id !== "") {
      void settle(
        setEditors(credentials, playlistId, [...editorIds, id]),
        "That Person must be able to see you, and you them, to edit."
      );
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2 className="text-lg">Collaboration</h2>
        </CardTitle>
        <CardDescription>
          Editors can add, remove, and reorder Sets. Only you can rename or
          delete this Playlist and choose its editors.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Label>
          <Switch
            checked={collaboration.collaborative}
            disabled={pending}
            onCheckedChange={(checked) =>
              settle(
                setCollaborative(credentials, playlistId, checked),
                FAILURE_MESSAGES.failed
              )
            }
          />
          Collaborative
        </Label>
        {collaboration.collaborative ? (
          <>
            {editorIds.length === 0 ? (
              <p className="text-muted-foreground text-sm">No editors yet.</p>
            ) : (
              <ul aria-label="Editors" className="divide-y">
                {editorIds.map((id) => (
                  <li
                    className="flex items-center justify-between gap-4 py-2"
                    key={id}
                  >
                    <span className="text-sm">{nameOf(id)}</span>
                    <Button
                      aria-label={`Remove editor ${nameOf(id)}`}
                      disabled={pending}
                      onClick={() =>
                        settle(
                          setEditors(
                            credentials,
                            playlistId,
                            editorIds.filter((editor) => editor !== id)
                          ),
                          FAILURE_MESSAGES.failed
                        )
                      }
                      size="sm"
                      variant="outline"
                    >
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {candidates.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                No one else can be an editor. An editor must have Social on, and
                you must be able to see each other.
              </p>
            ) : (
              <form className="flex flex-col gap-2" onSubmit={addEditor}>
                <Label htmlFor="playlist-editor">Add editor</Label>
                <div className="flex gap-2">
                  <NativeSelect id="playlist-editor" name="editor">
                    {candidates.map((person) => (
                      <NativeSelectOption key={person.id} value={person.id}>
                        {person.username}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                  <Button disabled={pending} type="submit" variant="outline">
                    Add editor
                  </Button>
                </div>
              </form>
            )}
          </>
        ) : null}
        {problem === null ? null : (
          <p className="text-destructive text-sm" role="alert">
            {problem}
          </p>
        )}
      </CardContent>
    </Card>
  );
};
