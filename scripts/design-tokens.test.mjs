import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  BODY_TEXT_LC,
  apca,
  assertContrast,
  assertDisplayable,
  contrastChecks,
  cssPath,
  inDisplayP3,
  loadTokens,
  render,
  staleFiles,
  swiftPath,
  validate,
} from "./design-tokens.mjs";

const withTokens = (change) => change(structuredClone(loadTokens()));

test("the committed token source matches its schema", () => {
  assert.doesNotThrow(() => validate(loadTokens()));
});

test("a colour that is not OKLCH is refused", () => {
  const tokens = withTokens((copy) => {
    copy.color.paper.light = "#fff";
    return copy;
  });
  assert.throws(() => validate(tokens), /does not match its schema/u);
});

test("a colour without a dark value is refused", () => {
  const tokens = withTokens((copy) => {
    delete copy.color.field.dark;
    return copy;
  });
  assert.throws(() => validate(tokens), /does not match its schema/u);
});

test("an unknown token is refused rather than silently ignored", () => {
  const tokens = withTokens((copy) => {
    copy.color.accent = {
      dark: "oklch(0.6 0.1 20)",
      light: "oklch(0.5 0.1 20)",
    };
    return copy;
  });
  assert.throws(() => validate(tokens), /does not match its schema/u);
});

test("a category the Swift enum cannot draw is refused", () => {
  const tokens = withTokens((copy) => {
    delete copy.color.categoryText.brown;
    return copy;
  });
  assert.throws(() => validate(tokens), /does not match its schema/u);
});

test("a $schema that points nowhere in the repo is refused", () => {
  const tokens = withTokens((copy) => {
    copy.$schema = "./missing.schema.json";
    return copy;
  });
  assert.throws(
    () => validate(tokens),
    /not docs\/design\/tokens\.schema\.json/u
  );
});

test("APCA reproduces the measurements the palette was chosen with", () => {
  // The values the owner measured for the pre-increased-contrast palette, to Lc. They pin the
  // formula: a change to the constants or the colour conversion shows up here.
  const published = [
    ["oklch(0.965 0.01 85)", "oklch(0.5 0.2 16)", 73],
    ["oklch(0.965 0.01 85)", "oklch(0.5 0.12 95)", 73],
    ["oklch(0.965 0.01 85)", "oklch(0.5 0.1 212)", 71],
    ["oklch(0.965 0.01 85)", "oklch(0.23 0.012 75)", 97],
    ["oklch(0.202 0.009 75)", "oklch(0.658 0.232 16)", 40],
    ["oklch(0.202 0.009 75)", "oklch(0.556 0.203 278)", 26],
    ["oklch(0.202 0.009 75)", "oklch(0.947 0.014 85)", 95],
  ];
  for (const [surface, text, expected] of published) {
    assert.equal(
      Math.round(Math.abs(apca(surface, text))),
      expected,
      `${text} on ${surface}`
    );
  }
});

test("every text token clears the body-text floor in every appearance", () => {
  const tokens = loadTokens();
  assert.doesNotThrow(() => assertContrast(tokens));
  const checks = contrastChecks(tokens);
  // ink, muted, and one shade per category, against both surfaces, in four appearances.
  assert.equal(checks.length, 12 * 2 * 4);
  for (const check of checks) {
    assert.ok(
      check.lc >= BODY_TEXT_LC,
      `${check.token} on ${check.surface} (${check.appearance}) is Lc ${check.lc.toFixed(1)}`
    );
  }
});

test("a text token that drops under Lc 75 fails the check", () => {
  const tokens = withTokens((copy) => {
    // The dark pink shade as it was designed before Increase Contrast existed.
    copy.color.categoryText.pink.dark = "oklch(0.658 0.232 16)";
    return copy;
  });
  assert.throws(() => assertContrast(tokens), /below Lc 75/u);
});

test("a colour that leaves Display P3 fails rather than being clamped", () => {
  const tokens = withTokens((copy) => {
    copy.color.categoryText.pink.dark = "oklch(0.99 0.4 16)";
    return copy;
  });
  assert.ok(!inDisplayP3(tokens.color.categoryText.pink.dark));
  assert.throws(() => assertDisplayable(tokens), /leave Display P3/u);
});

test("a colour without an increased-contrast value is refused", () => {
  const tokens = withTokens((copy) => {
    delete copy.color.field.increasedContrast;
    return copy;
  });
  assert.throws(() => validate(tokens), /does not match its schema/u);
});

test("rendering the same source twice produces the same text", () => {
  const tokens = loadTokens();
  assert.deepEqual(render(tokens), render(tokens));
});

test("every colour and radius reaches both generated files", () => {
  const tokens = loadTokens();
  const { css, swift } = render(tokens);
  const colours = Object.keys(tokens.color.categoryText).length + 5;
  const base = css.slice(0, css.indexOf("@media"));
  assert.equal(swift.match(/static let /gu).length, colours);
  assert.equal(base.match(/--orbis-(?!radius-)/gu).length, colours);
  for (const name of Object.keys(tokens.radius)) {
    assert.ok(
      css.includes(`--orbis-radius-${name}:`),
      `${name} has no CSS radius`
    );
  }
});

test("every colour carries its increased-contrast value into both files", () => {
  const { css, swift } = render(loadTokens());
  const colours = Object.keys(loadTokens().color.categoryText).length + 5;
  assert.equal(swift.match(/increasedContrastLight: P3\(/gu).length, colours);
  assert.equal(swift.match(/increasedContrastDark: P3\(/gu).length, colours);
  const increased = css.slice(css.indexOf("@media"));
  assert.ok(increased.includes("@media (prefers-contrast: more)"));
  assert.equal(increased.match(/--orbis-(?!radius-)/gu).length, colours);
});

test("the generated files in the repo are current", () => {
  const rendered = render(loadTokens());
  assert.deepEqual(staleFiles(rendered), []);
  assert.equal(readFileSync(swiftPath, "utf-8"), rendered.swift);
  assert.equal(readFileSync(cssPath, "utf-8"), rendered.css);
});

test("a changed token makes the generated files stale", () => {
  const tokens = withTokens((copy) => {
    copy.color.paper.light = "oklch(0.9 0.01 85)";
    return copy;
  });
  assert.deepEqual(staleFiles(render(tokens)), [swiftPath, cssPath]);
});
