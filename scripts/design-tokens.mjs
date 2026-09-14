// Generates OrbisDesign/Tokens/GeneratedColors.swift and docs/design/tokens.css from
// docs/design/tokens.json, validates the token source against its schema, and proves every
// text token is readable against paper and raised paper with APCA.
//
// Usage:
//   node scripts/design-tokens.mjs           write the generated files
//   node scripts/design-tokens.mjs --check   fail when a generated file is stale, a colour
//                                            leaves Display P3, or a text token is under Lc 75
//
// A failing contrast measurement is a failure of the token source, not of this script: raise
// light and dark values with APCA, or lower chroma at the same hue when a value cannot reach
// the bar inside Display P3. Never lower BODY_TEXT_LC.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";

export const root = fileURLToPath(new URL("../", import.meta.url));
export const sourcePath = path.join(root, "docs/design/tokens.json");
export const schemaPath = path.join(root, "docs/design/tokens.schema.json");
export const swiftPath = path.join(
  root,
  "apps/apple/OrbisDesign/Sources/OrbisDesign/Tokens/GeneratedColors.swift"
);
export const cssPath = path.join(root, "docs/design/tokens.css");

const parseOklch = (text) => {
  const match =
    /oklch\(\s*(?<l>[\d.]+)\s+(?<c>[\d.]+)\s+(?<h>[\d.]+)\s*\)/u.exec(text);
  if (!match) {
    throw new Error(`Not an oklch() color: ${text}`);
  }
  return {
    c: Number(match.groups.c),
    h: Number(match.groups.h),
    l: Number(match.groups.l),
  };
};

const oklchToLinearSrgb = ({ l, c, h }) => {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
};

// Linear sRGB → linear Display P3 (via XYZ D65).
const linearSrgbToLinearP3 = ([r, g, b]) => {
  const x = 0.4123908 * r + 0.35758434 * g + 0.18048079 * b;
  const y = 0.21263901 * r + 0.71516868 * g + 0.07219232 * b;
  const z = 0.01933082 * r + 0.11919478 * g + 0.95053215 * b;
  return [
    2.4934969 * x - 0.9313836 * y - 0.4027108 * z,
    -0.8294889 * x + 1.7626641 * y + 0.0236247 * z,
    0.0358458 * x - 0.0761724 * y + 0.9568845 * z,
  ];
};

const gamma = (v) =>
  v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
const clamp = (v) => Math.min(1, Math.max(0, v));
const channel = (v) => clamp(gamma(v)).toFixed(4);

/// Whether a colour is inside Display P3. A value that clips is not the value that was
/// designed or measured, so it fails instead of being clamped to something quieter.
export const inDisplayP3 = (oklch) =>
  linearSrgbToLinearP3(oklchToLinearSrgb(parseOklch(oklch)))
    .map(gamma)
    .every((v) => v >= -0.0005 && v <= 1.0005);

const p3 = (oklch) =>
  linearSrgbToLinearP3(oklchToLinearSrgb(parseOklch(oklch))).map(channel);

/// The luminance proxy APCA reads: APCA-W3 `sRGBtoY` (the 2.4 exponent) applied to the
/// sRGB-encoded channels of the colour, clamped where it leaves sRGB — what a display without
/// P3 shows, and what the published measurements in the palette's notes are stated in. Pinned
/// against those measurements in `design-tokens.test.mjs`.
const apcaY = (oklch) => {
  const [r, g, b] = oklchToLinearSrgb(parseOklch(oklch)).map(gamma).map(clamp);
  return 0.2126729 * r ** 2.4 + 0.7151522 * g ** 2.4 + 0.072175 * b ** 2.4;
};

/// APCA Lc (APCA-W3 0.1.9, `APCAcontrast`) for text drawn on a surface. Positive Lc is dark
/// text on light, negative is light text on dark; the caller almost always wants `Math.abs`.
export const apca = (surface, text) => {
  const blkThrs = 0.022;
  // APCA-W3 writes this as 1.414; it is the square root of two to four places.
  const blkClmp = Math.SQRT2;
  let ybg = apcaY(surface);
  let ytxt = apcaY(text);
  if (ytxt < blkThrs) {
    ytxt += (blkThrs - ytxt) ** blkClmp;
  }
  if (ybg < blkThrs) {
    ybg += (blkThrs - ybg) ** blkClmp;
  }
  if (Math.abs(ybg - ytxt) < 0.0005) {
    return 0;
  }
  let lc;
  if (ybg > ytxt) {
    lc = (ybg ** 0.56 - ytxt ** 0.57) * 1.14;
    lc = lc < 0.1 ? 0 : lc - 0.027;
  } else {
    lc = (ybg ** 0.65 - ytxt ** 0.62) * 1.14;
    lc = lc > -0.1 ? 0 : lc + 0.027;
  }
  return lc * 100;
};

/// The floor for body text. APCA's own scale puts 75 at the minimum for body text and 90 at
/// the preferred level; Orbis category labels are caption size, so 75 is a floor, not a goal.
export const BODY_TEXT_LC = 75;

/// Every text token, against both paper surfaces, in each of the appearances the system can
/// ask for. `increasedContrast` carries its own light and dark pair, so it is measured twice.
export const appearances = ["light", "dark", "increasedContrast"];

/// Every colour of one token, named by the appearance it is drawn in.
const appearanceValues = (value) => ({
  dark: value.dark,
  "increasedContrast-dark": value.increasedContrast.dark,
  "increasedContrast-light": value.increasedContrast.light,
  light: value.light,
});

/// One entry per measurement: `${token}/${surface}/${appearance}` with its Lc.
export const contrastChecks = (tokens) => {
  const checks = [];
  const textTokens = [];
  for (const [name, value] of Object.entries(tokens.color)) {
    if (name === "categoryText") {
      for (const [category, shades] of Object.entries(value)) {
        textTokens.push([`category-${category}-text`, shades]);
      }
    } else if (name === "ink" || name === "muted") {
      textTokens.push([name, value]);
    }
  }
  const surfaces = [
    ["paper", tokens.color.paper],
    ["paper-raised", tokens.color.paperRaised],
  ];
  for (const [token, value] of textTokens) {
    for (const [appearance, colour] of Object.entries(
      appearanceValues(value)
    )) {
      for (const [surface, surfaceValue] of surfaces) {
        const lc = Math.abs(
          apca(appearanceValues(surfaceValue)[appearance], colour)
        );
        checks.push({ appearance, lc, surface, token });
      }
    }
  }
  return checks;
};

/// Throws when a text token is under the body-text floor on either paper surface.
export const assertContrast = (tokens) => {
  const failed = contrastChecks(tokens).filter(
    (check) => check.lc < BODY_TEXT_LC
  );
  if (failed.length > 0) {
    throw new Error(
      `Text tokens are below Lc ${BODY_TEXT_LC} on paper or raised paper:\n${failed
        .map(
          (check) =>
            `  ${check.token} on ${check.surface} (${check.appearance}): Lc ${check.lc.toFixed(1)}`
        )
        .join("\n")}`
    );
  }
};

/// Throws when a colour leaves Display P3, where clamping would draw a different colour than
/// the one that was measured.
export const assertDisplayable = (tokens) => {
  const clipped = [];
  const check = (name, shades) => {
    for (const [appearance, colour] of Object.entries(
      appearanceValues(shades)
    )) {
      if (!inDisplayP3(colour)) {
        clipped.push(`${name} (${appearance}): ${colour}`);
      }
    }
  };
  for (const [name, value] of Object.entries(tokens.color)) {
    if (name === "categoryText") {
      for (const [category, shades] of Object.entries(value)) {
        check(`category-${category}-text`, shades);
      }
    } else {
      check(name, value);
    }
  }
  if (clipped.length > 0) {
    throw new Error(
      `These colours leave Display P3 and would be clamped when drawn:\n${clipped
        .map((line) => `  ${line}`)
        .join("\n")}`
    );
  }
};

const swiftName = (text) =>
  text.replaceAll(/-(?<letter>[a-z])/gu, (_, letter) => letter.toUpperCase());

/// Both generated files, as the text they should hold. Pure, so `--check` and a write
/// cannot disagree about what the token source means.
export const render = (tokens) => {
  const swiftLines = [
    "// Generated by scripts/design-tokens.mjs from docs/design/tokens.json. Do not edit.",
    "",
    "enum GeneratedColor {",
  ];
  const cssLines = [
    ":root {",
    "  /* generated from docs/design/tokens.json */",
  ];
  // CSS has no increased-contrast value for `light-dark()`, so the appearance the system
  // reports becomes its own block: `prefers-contrast: more` is the web spelling of the same
  // setting the native colors read from the platform traits.
  const increasedContrastLines = [];

  const emit = (name, value) => {
    const { dark, increasedContrast, light } = value;
    const l = p3(light);
    const d = p3(dark);
    const il = p3(increasedContrast.light);
    const id = p3(increasedContrast.dark);
    swiftLines.push(
      [
        `  static let ${name} = DynamicColor(`,
        `    light: P3(${l.join(", ")}),`,
        `    dark: P3(${d.join(", ")}),`,
        `    increasedContrastLight: P3(${il.join(", ")}),`,
        `    increasedContrastDark: P3(${id.join(", ")})`,
        "  )",
      ].join("\n")
    );
    cssLines.push(`  --orbis-${name}: light-dark(${light}, ${dark});`);
    increasedContrastLines.push(
      `  --orbis-${name}: light-dark(${increasedContrast.light}, ${increasedContrast.dark});`
    );
  };

  for (const [name, value] of Object.entries(tokens.color)) {
    if (name === "categoryText") {
      for (const [category, shades] of Object.entries(value)) {
        const setName = `category-${category}-text`;
        emit(swiftName(setName), shades);
      }
    } else {
      emit(name, value);
    }
  }
  for (const [name, value] of Object.entries(tokens.radius)) {
    cssLines.push(`  --orbis-radius-${name}: ${value}px;`);
  }
  cssLines.push(
    "}",
    "",
    "@media (prefers-contrast: more) {",
    "  :root {",
    ...increasedContrastLines.map((line) => `  ${line}`),
    "  }",
    "}"
  );
  swiftLines.push("}");

  return {
    css: `${cssLines.join("\n")}\n`,
    swift: `${swiftLines.join("\n")}\n`,
  };
};

/// Throws when the token source does not match its schema. The declared `$schema` must
/// resolve to the schema in this repo; a dangling path fails rather than being ignored.
export const validate = (tokens) => {
  const ajv = new Ajv2020({ allErrors: true });
  const check = ajv.compile(JSON.parse(readFileSync(schemaPath, "utf-8")));
  if (!check(tokens)) {
    throw new Error(
      `docs/design/tokens.json does not match its schema:\n${ajv.errorsText(check.errors, { separator: "\n" })}`
    );
  }
  const declaredPath = path.resolve(path.dirname(sourcePath), tokens.$schema);
  if (declaredPath !== schemaPath) {
    throw new Error(
      `docs/design/tokens.json points its $schema at ${tokens.$schema}, which is not docs/design/tokens.schema.json.`
    );
  }
};

export const loadTokens = () => JSON.parse(readFileSync(sourcePath, "utf-8"));

const readIfPresent = (file) => {
  try {
    return readFileSync(file, "utf-8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
};

/// Names the generated files that differ from the token source, or an empty list.
export const staleFiles = (rendered) => {
  const stale = [];
  if (readIfPresent(swiftPath) !== rendered.swift) {
    stale.push(swiftPath);
  }
  if (readIfPresent(cssPath) !== rendered.css) {
    stale.push(cssPath);
  }
  return stale;
};

const relative = (file) => path.relative(root, file);

export const main = (argv = process.argv.slice(2)) => {
  const tokens = loadTokens();
  validate(tokens);
  assertDisplayable(tokens);
  assertContrast(tokens);
  const rendered = render(tokens);
  const check = argv.includes("--check");

  if (!check) {
    writeFileSync(swiftPath, rendered.swift);
    writeFileSync(cssPath, rendered.css);
    console.log(`wrote ${relative(swiftPath)} and ${relative(cssPath)}`);
    return 0;
  }

  const stale = staleFiles(rendered);
  if (stale.length > 0) {
    console.error(
      `Design tokens are stale:\n${stale.map((file) => `  ${relative(file)}`).join("\n")}\nRun \`bun run tokens:generate\` and commit the result.`
    );
    return 1;
  }
  console.log("design tokens are up to date");
  return 0;
};

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
