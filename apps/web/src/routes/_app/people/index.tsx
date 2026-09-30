import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { useId, useState } from "react";

import { useLiveEvents } from "@/components/live-events";
import { RouteProblem } from "@/components/route-problem";
import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { FAILURE_MESSAGES } from "@/lib/orbis";
import type { ApiResult, Credentials } from "@/lib/orbis";
import { listPeopleFilters, setFilter, setSocial } from "@/lib/people";
import type { PersonFilters } from "@/lib/people";
import type { Session } from "@/routes/_app";

/** Runs one change, shows its failure, and reloads the page's data on success. */
const useChange = () => {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const change = async (run: () => Promise<ApiResult<unknown>>) => {
    setPending(true);
    const result = await run();
    setPending(false);
    if (!result.ok) {
      setProblem(FAILURE_MESSAGES[result.failure]);
      return;
    }
    setProblem(null);
    // Re-runs the shell's `/me` too, so the Social switch shows the saved value.
    await router.invalidate();
  };
  return { change, pending, problem };
};

const Problem = ({ problem }: { readonly problem: string | null }) =>
  problem === null ? null : (
    <p className="text-destructive text-sm" role="alert">
      {problem}
    </p>
  );

const SocialSwitch = ({ session }: { readonly session: Session }) => {
  const labelId = useId();
  const { change, pending, problem } = useChange();
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <span className="font-medium" id={labelId}>
            Social
          </span>
          <span className="text-muted-foreground text-sm">
            When Social is off, nobody sees your Library, Playlists, or what you
            listen to, and you see nobody’s.
          </span>
        </div>
        <Switch
          aria-labelledby={labelId}
          checked={session.person.social}
          disabled={pending}
          onCheckedChange={(checked) =>
            change(() => setSocial(session, checked))
          }
        />
      </div>
      <Problem problem={problem} />
    </div>
  );
};

const FilterSwitch = ({
  checked,
  disabled,
  label,
  name,
  onChange,
}: {
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly label: string;
  readonly name: string;
  readonly onChange: (checked: boolean) => void;
}) => (
  <span className="flex items-center gap-2 text-sm">
    <Switch
      aria-label={name}
      checked={checked}
      disabled={disabled}
      onCheckedChange={onChange}
      size="sm"
    />
    <span aria-hidden>{label}</span>
  </span>
);

const PersonRow = ({
  credentials,
  person,
}: {
  readonly credentials: Credentials;
  readonly person: PersonFilters;
}) => {
  const { presence } = useLiveEvents();
  const { change, pending, problem } = useChange();
  const listening = presence.find((entry) => entry.personId === person.id);
  return (
    <li className="flex flex-col gap-3 py-4">
      <div className="flex items-start gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2 className="truncate font-medium">{person.username}</h2>
          {person.see ? (
            <p className="text-muted-foreground text-sm" role="status">
              {listening === undefined
                ? "Not listening right now"
                : `${person.username} is listening to ${listening.set.title}`}
            </p>
          ) : (
            <p className="text-muted-foreground text-sm">
              Hidden from your People. Turn See on to see their Library.
            </p>
          )}
        </div>
        {person.see ? (
          <Link
            className={buttonVariants({ size: "sm", variant: "outline" })}
            params={{ id: person.id }}
            to="/people/$id"
          >
            Open {person.username}’s Library
          </Link>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-6">
        <FilterSwitch
          checked={person.see}
          disabled={pending}
          label="See"
          name={`See ${person.username}`}
          onChange={(see) =>
            change(() => setFilter(credentials, person.id, { see }))
          }
        />
        <FilterSwitch
          checked={person.appear}
          disabled={pending}
          label="Appear"
          name={`Appear to ${person.username}`}
          onChange={(appear) =>
            change(() => setFilter(credentials, person.id, { appear }))
          }
        />
      </div>
      <Problem problem={problem} />
    </li>
  );
};

const People = ({
  people,
  session,
}: {
  readonly people: readonly PersonFilters[];
  readonly session: Session;
}) => {
  const renderPeople = () => {
    if (!session.person.social) {
      return (
        <p className="text-muted-foreground text-sm">
          Turn Social on to see the People who turned it on too.
        </p>
      );
    }
    if (people.length === 0) {
      return (
        <p className="text-muted-foreground text-sm">
          Nobody else has Social on yet.
        </p>
      );
    }
    return (
      <ul aria-label="People" className="divide-y">
        {people.map((person) => (
          <PersonRow credentials={session} key={person.id} person={person} />
        ))}
      </ul>
    );
  };
  return (
    <main className="mx-auto w-full max-w-3xl p-6">
      <Card>
        <CardHeader>
          <CardTitle>
            <h1 className="text-2xl">People</h1>
          </CardTitle>
          <CardDescription>
            See decides whether a Person is in your People. Appear decides
            whether they see you.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <SocialSwitch session={session} />
          {renderPeople()}
        </CardContent>
      </Card>
    </main>
  );
};

export const Route = createFileRoute("/_app/people/")({
  component: () => (
    <People
      people={Route.useLoaderData()}
      session={Route.useRouteContext().session}
    />
  ),
  errorComponent: RouteProblem,
  loader: async ({ context }) => {
    const people = await listPeopleFilters(context.session);
    if (!people.ok) {
      throw new Error(FAILURE_MESSAGES[people.failure]);
    }
    return people.value.people;
  },
});
