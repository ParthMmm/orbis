import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  cssPath,
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

test("rendering the same source twice produces the same text", () => {
  const tokens = loadTokens();
  assert.deepEqual(render(tokens), render(tokens));
});

test("every colour and radius reaches both generated files", () => {
  const tokens = loadTokens();
  const { css, swift } = render(tokens);
  const colours = Object.keys(tokens.color.categoryText).length + 5;
  assert.equal(swift.match(/static let /gu).length, colours);
  assert.equal(css.match(/--orbis-(?!radius-)/gu).length, colours);
  for (const name of Object.keys(tokens.radius)) {
    assert.ok(
      css.includes(`--orbis-radius-${name}:`),
      `${name} has no CSS radius`
    );
  }
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
