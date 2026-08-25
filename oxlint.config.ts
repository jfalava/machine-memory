import { defineConfig, type DummyRuleMap } from "oxlint";

// Oxlint rejects relative jsPlugins specifiers inside configs consumed via
// `extends`, so the base exposes a factory and each workspace registers the
// plugins itself with a path prefix relative to its own directory
// (".." for workspace roots, "../.." for remote-db/cloudflare).
export const antiSlopJsPlugins = (specifierPrefix: string) => [
  {
    name: "anti-slop",
    specifier: `${specifierPrefix}/tools/oxlint/anti-slop/index.ts`,
  },
  {
    name: "anti-slop-effect",
    specifier: `${specifierPrefix}/tools/oxlint/anti-slop/effect/index.ts`,
  },
];

export const antiSlopRules: DummyRuleMap = {
  "anti-slop/no-chained-type-assertions": "error",
  "anti-slop/no-conditional-empty-object-spread": "error",
  "anti-slop/no-known-value-widening": "error",
  "anti-slop/no-module-mocking": "error",
  "anti-slop/no-object-parameters": "error",
  "anti-slop/no-reflect-apply": "error",
  "anti-slop/no-reflect-get": "error",
  "anti-slop/no-runtime-typeof": "error",
  "anti-slop/no-shape-in-symbol-names": "error",
  "anti-slop/no-unknown-parameters": "error",
  "anti-slop/no-unknown-returns": "error",
  "anti-slop/no-unknown-type-aliases": "error",
  "anti-slop/no-unsafe-dictionary-type": "error",
  "anti-slop/no-widen-then-assert": "error",
  "anti-slop/require-safety-comment-for-type-assertion": "error",
  "anti-slop-effect/no-service-constructor-imports": "error",
};

const builtinRules: DummyRuleMap = {
  "typescript/no-explicit-any": "error",
  "typescript/no-unsafe-assignment": "error",
  "typescript/no-unsafe-call": "error",
  "typescript/no-unsafe-member-access": "error",
  "typescript/no-unsafe-return": "error",
  "no-unused-vars": [
    "error",
    {
      vars: "all",
      args: "after-used",
      caughtErrors: "all",
      ignoreRestSiblings: false,
      varsIgnorePattern: "^_",
      argsIgnorePattern: "^_",
      caughtErrorsIgnorePattern: "^_",
    },
  ],
  "no-undef": "error",
  "no-unreachable": "error",
  "no-dupe-keys": "error",
  "no-dupe-class-members": "error",
  "no-fallthrough": "error",
  "no-duplicate-imports": "error",
  "no-implied-eval": "error",
  "no-eval": "error",
  "no-debugger": "error",
  "no-console": [
    "error",
    {
      allow: ["warn", "error", "info"],
    },
  ],
  "no-with": "error",
  "no-proto": "error",
  "no-new-wrappers": "error",
  "no-iterator": "error",
  "no-labels": "error",
  "no-var": "error",
  "no-shadow": [
    "error",
    {
      hoist: "functions",
      builtinGlobals: true,
    },
  ],
  "no-param-reassign": "error",
  "no-extend-native": "error",
  "no-func-assign": "error",
  "no-empty-function": "error",
  "no-extra-bind": "error",
  "no-useless-constructor": "error",
  "no-unused-expressions": "error",
  eqeqeq: [
    "error",
    "always",
    {
      null: "ignore",
    },
  ],
  curly: ["error", "all"],
  "no-implicit-coercion": [
    "error",
    {
      boolean: true,
      number: true,
      string: true,
      disallowTemplateShorthand: true,
    },
  ],
  "prefer-const": [
    "error",
    {
      destructuring: "all",
    },
  ],
  "prefer-arrow-callback": "error",
  complexity: ["error", 12],
  "max-depth": ["error", 4],
  "max-params": ["error", 5],
  "max-statements": ["error", 20],
  "import/no-duplicates": "error",
  "import/no-mutable-exports": "error",
};

// Strict application base: type-aware linting over the built-in plugins plus
// the vendored anti-slop rules. Workspace configs spread this and add their
// own jsPlugins registration and ignorePatterns.
export default defineConfig({
  options: {
    typeAware: true,
    typeCheck: true,
  },
  plugins: ["eslint", "react", "typescript", "unicorn", "oxc", "import", "promise"],
  env: {
    node: true,
    browser: false,
    es2022: true,
  },
  globals: {
    Bun: "readonly",
  },
  overrides: [
    {
      files: ["*.test.ts"],
      rules: {
        "no-shadow": "off",
      },
    },
  ],
  rules: {
    ...builtinRules,
    ...antiSlopRules,
  },
});
