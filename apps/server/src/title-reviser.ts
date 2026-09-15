import {
  OpenRouterClient,
  OpenRouterLanguageModel,
} from "@effect/ai-openrouter";
import type { SetSource } from "@orbis/contracts";
import {
  Config,
  Context,
  Effect,
  Layer,
  Option,
  Redacted,
  Schema,
} from "effect";
import { LanguageModel } from "effect/unstable/ai";
import { FetchHttpClient } from "effect/unstable/http";

import { TitleReviserError } from "./title-reviser-error.js";

export interface ReviseTitleInput {
  readonly creator: string | null;
  readonly source: SetSource;
  readonly title: string;
}

export interface TitleReviserService {
  readonly revise: (
    input: ReviseTitleInput
  ) => Effect.Effect<string, TitleReviserError>;
}

export interface TitleReviserOptions {
  readonly apiKey?: string | undefined;
  readonly model?: string | undefined;
}

const RevisedTitle = Schema.Struct({
  title: Schema.String,
});

const REVISE_TIMEOUT = "5 seconds";

const PROMPT = `Rewrite the title of a music set so every entry in the library scans the same way.

Format: "Artist - Event" or "Artist - Track name".

- Keep every artist, event, and track name exactly as given. Never invent names, venues, or dates.
- Remove platform noise: suffixes such as "| SoundCloud", "Free Download", "OUT NOW", "Preview", bracketed marketing text, and emojis.
- The artist is the creator when one is given, otherwise the leading artist in the title.
- If the title already matches the format, return it unchanged.
- Keep the title under 60 characters.
- Answer with the revised title only.`;

const revisePrompt = (input: ReviseTitleInput) =>
  [
    PROMPT,
    `Creator: ${input.creator ?? "not given"}`,
    `Source: ${input.source}`,
    `Title: ${input.title}`,
  ].join("\n\n");

const notConfigured = (message: string) =>
  new TitleReviserError({ message, reason: "not-configured" });
const unavailable = (message: string) =>
  new TitleReviserError({ message, reason: "model-unavailable" });
const unexpected = (message: string) =>
  new TitleReviserError({ message, reason: "unexpected-response" });

export class TitleReviser extends Context.Service<
  TitleReviser,
  TitleReviserService
>()("@orbis/TitleReviser") {
  /**
   * Revision backed by any `LanguageModel`. `layer` uses this with OpenRouter;
   * tests supply a stub instead of reaching the network.
   */
  static layerWithModel<R>(
    model: Layer.Layer<LanguageModel.LanguageModel, never, R>
  ): Layer.Layer<TitleReviser, never, R> {
    return Layer.effect(
      TitleReviser,
      Effect.gen(function* layer() {
        const languageModel = yield* LanguageModel.LanguageModel;
        const revise = (input: ReviseTitleInput) =>
          Effect.gen(function* reviseTitle() {
            const response = yield* languageModel
              .generateObject({
                objectName: "revised_title",
                prompt: revisePrompt(input),
                schema: RevisedTitle,
              })
              .pipe(
                Effect.timeoutOrElse({
                  duration: REVISE_TIMEOUT,
                  orElse: () =>
                    unavailable("The title model did not answer in time."),
                }),
                Effect.catchTag("AiError", () =>
                  unavailable("The title model did not answer.")
                )
              );
            const title = response.value.title.trim();
            if (!title) {
              return yield* Effect.fail(
                unexpected("The title model returned an empty title.")
              );
            }
            return title;
          });
        return { revise };
      })
    ).pipe(Layer.provide(model));
  }

  static layer(options: TitleReviserOptions = {}): Layer.Layer<TitleReviser> {
    const apiKey = options.apiKey?.trim();
    const model = options.model?.trim();
    if (!apiKey || !model) {
      return TitleReviser.unconfigured();
    }
    return TitleReviser.layerWithModel(
      OpenRouterLanguageModel.layer({
        config: { strictJsonSchema: true },
        model,
      })
    ).pipe(
      Layer.provide(
        OpenRouterClient.layer({
          apiKey: Redacted.make(apiKey),
          siteTitle: "Orbis",
        })
      ),
      Layer.provide(FetchHttpClient.layer)
    );
  }

  /**
   * The provider layer reads its settings from the environment through
   * `Config`, so the key arrives redacted and a missing setting degrades to
   * the unconfigured reviser with one warning instead of a failed startup.
   */
  static layerConfig(): Layer.Layer<TitleReviser> {
    const missingVariable = (name: string) =>
      Effect.logWarning(
        `${name} is not set, so automatic title revision is unavailable.`
      ).pipe(Effect.as(TitleReviser.unconfigured()));
    return Layer.unwrap(
      Effect.gen(function* layerConfig() {
        const settings = yield* Effect.gen(function* readSettings() {
          return {
            apiKey: yield* Config.option(
              Config.Redacted("ORBIS_OPENROUTER_API_KEY")
            ),
            model: yield* Config.option(Config.String("ORBIS_TITLE_MODEL")),
          };
        }).pipe(
          Effect.catchTag("ConfigError", (error) =>
            Effect.logWarning(
              "title revision settings could not be read, so automatic title revision is unavailable."
            ).pipe(
              Effect.annotateLogs({ error: String(error) }),
              Effect.as({
                apiKey: Option.none<Redacted.Redacted<string>>(),
                model: Option.none<string>(),
              })
            )
          )
        );
        if (Option.isNone(settings.apiKey)) {
          return yield* missingVariable("ORBIS_OPENROUTER_API_KEY");
        }
        if (Option.isNone(settings.model)) {
          return yield* missingVariable("ORBIS_TITLE_MODEL");
        }
        return TitleReviser.layerWithModel(
          OpenRouterLanguageModel.layer({
            config: { strictJsonSchema: true },
            model: settings.model.value.trim(),
          })
        ).pipe(
          Layer.provide(
            OpenRouterClient.layer({
              apiKey: settings.apiKey.value,
              siteTitle: "Orbis",
            })
          ),
          Layer.provide(FetchHttpClient.layer)
        );
      })
    );
  }

  /**
   * No title model is configured. This is the default so that enrichment never
   * waits on the network unless a caller asks for the provider, which keeps
   * tests offline by construction.
   */
  static unconfigured(): Layer.Layer<TitleReviser> {
    return Layer.succeed(TitleReviser, {
      revise: (input) =>
        Effect.fail(
          notConfigured(
            `${input.source} title revision is not configured on this server.`
          )
        ),
    });
  }

  static layerOf(reviser: TitleReviserService): Layer.Layer<TitleReviser> {
    return Layer.succeed(TitleReviser, reviser);
  }
}
