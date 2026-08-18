import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import obsidianmd from 'eslint-plugin-obsidianmd';
import prettier from 'eslint-plugin-prettier';
import eslintConfigPrettier from 'eslint-config-prettier';
import globals from 'globals';
import jest from 'eslint-plugin-jest';

// Non-ASCII typography characters that must never appear in source: em/en
// dashes, curly quotes, arrows, multiplication sign, approximation sign, and
// the horizontal ellipsis. The codebase (comments and user-facing strings
// alike) uses their plain ASCII equivalents instead.
const NON_ASCII_TYPOGRAPHY = /[–—‘’“”…←→↔×≈]/;

// Local plugin: ban banner/divider comments (a run of three or more dashes).
// It inspects comment tokens only, so dashes inside string literals (e.g. a
// multipart boundary or YAML front-matter in a test fixture) are never flagged.
const localRules = {
    rules: {
        'no-non-ascii-typography': {
            meta: {
                type: 'problem',
                docs: {
                    description:
                        'Disallow non-ASCII typography (em/en dashes, curly quotes, arrows) anywhere in source; use plain ASCII equivalents.',
                },
                schema: [],
                messages: {
                    nonAscii:
                        'Non-ASCII typography character "{{char}}"; use its plain ASCII equivalent (e.g. "-", "\'", "->", "x", "~").',
                },
            },
            create(context) {
                return {
                    Program() {
                        const text = context.sourceCode.text;
                        const pattern = new RegExp(
                            NON_ASCII_TYPOGRAPHY.source,
                            'g',
                        );
                        for (const match of text.matchAll(pattern)) {
                            context.report({
                                loc: {
                                    start: context.sourceCode.getLocFromIndex(
                                        match.index,
                                    ),
                                    end: context.sourceCode.getLocFromIndex(
                                        match.index + 1,
                                    ),
                                },
                                messageId: 'nonAscii',
                                data: { char: match[0] },
                            });
                        }
                    },
                };
            },
        },
        'no-dashes-in-comments': {
            meta: {
                type: 'problem',
                docs: {
                    description:
                        'Disallow a run of three or more dashes in comments (banner/divider comments).',
                },
                schema: [],
                messages: {
                    dashes: 'Avoid "---" or longer dash runs in comments; use a plain descriptive comment instead.',
                },
            },
            create(context) {
                return {
                    Program() {
                        for (const comment of context.sourceCode.getAllComments()) {
                            if (/-{3,}/.test(comment.value)) {
                                context.report({
                                    loc: comment.loc,
                                    messageId: 'dashes',
                                });
                            }
                        }
                    },
                };
            },
        },
    },
};

export default tseslint.config(
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    // Obsidian Plugin Rules (Recommended): a flat config array since
    // eslint-plugin-obsidianmd 0.3.0. Its rule entries target plugin
    // source code (and ship partially unscoped, which breaks on JSON
    // manifests where type-aware rules cannot execute), so they are
    // constrained to src/. The plugin's own JSON manifest linting
    // entries keep their original file scope.
    ...obsidianmd.configs.recommended.map((entry) => {
        if (!entry.rules) {
            return entry;
        }
        const isJsonEntry =
            (typeof entry.language === 'string' &&
                entry.language.startsWith('json')) ||
            (Array.isArray(entry.files) &&
                entry.files.every((file) => String(file).endsWith('.json')));
        return isJsonEntry ? entry : { ...entry, files: ['src/**/*.ts'] };
    }),
    {
        // Typed linting applies to TypeScript sources only: the
        // obsidianmd recommended config also lints JSON manifests,
        // where type-aware rules cannot run
        files: ['**/*.ts'],
        plugins: {
            prettier,
        },
        languageOptions: {
            globals: {
                ...globals.browser,
                ...globals.node,
                ...globals.es2021,
                // Build-time global injected by esbuild (see
                // esbuild.config.mjs and src/globals.d.ts)
                __ENCODING_WORKER_SOURCE__: 'readonly',
            },
            parserOptions: {
                project: './tsconfig.eslint.json',
            },
        },
        rules: {
            // Prettier integration
            'prettier/prettier': 'error',

            // Strict Type Safety
            '@typescript-eslint/no-explicit-any': 'error',
            '@typescript-eslint/no-floating-promises': 'error',
            '@typescript-eslint/no-require-imports': 'error',
            '@typescript-eslint/no-unsafe-function-type': 'error',
            '@typescript-eslint/no-base-to-string': 'error',
            '@typescript-eslint/await-thenable': 'error',
            '@typescript-eslint/no-unnecessary-type-assertion': 'error',
            '@typescript-eslint/unbound-method': 'error',

            // Console usage
            'no-console': ['error', { allow: ['warn', 'error', 'debug'] }],

            // Obsidian Plugin Rules
            // ignoreWords keeps audio units/format acronyms the default
            // dictionary lacks; listing them is additive (DEFAULT_ACRONYMS
            // such as API/URL are unaffected) and preserves their exact
            // mixed casing (dB, dBFS) instead of lowercasing them.
            'obsidianmd/ui/sentence-case': [
                'warn',
                { ignoreWords: ['WAV', 'dB', 'dBFS'] },
            ],
        },
    },
    {
        // Ban banner/divider comments in plugin source. Scoped to src/ so the
        // pre-existing banner comments in some test files do not have to be
        // cleaned up in the same change; production code stays free of them.
        files: ['src/**/*.ts'],
        plugins: { local: localRules },
        rules: {
            'local/no-dashes-in-comments': 'error',
        },
    },
    {
        // Non-ASCII typography is banned everywhere (source and tests),
        // in comments and user-facing strings alike.
        files: ['src/**/*.ts', 'tests/**/*.ts'],
        plugins: { local: localRules },
        rules: {
            'local/no-non-ascii-typography': 'error',
        },
    },
    eslintConfigPrettier,

    {
        ignores: [
            'dist/**',
            'coverage/**',
            'node_modules/**',
            '**/*.config.mjs',
            '.agent/**',
            'eslint.config.mjs',
            'scripts/**',
            '*.js',
            '*.mjs',
        ],
    },
    {
        files: ['tests/**/*.ts'],
        plugins: { jest },
        languageOptions: {
            globals: globals.jest,
        },
        rules: {
            // A suite is only worth what its weakest test is worth, and these
            // are the ways a test quietly stops being one. Errors, not
            // warnings: a warning in a 3000-test suite is invisible.
            'jest/no-focused-tests': 'error',
            'jest/no-disabled-tests': 'error',
            // A test with no expectation passes forever, including after the
            // behaviour it was written for is deleted.
            'jest/expect-expect': [
                'error',
                {
                    assertFunctionNames: [
                        'expect',
                        // Helpers that assert on the caller's behalf.
                        'settingRow',
                        'defined',
                    ],
                },
            ],
            // An expectation inside an if or a catch can be skipped without
            // the test failing, which is the same as not having it.
            'jest/no-conditional-expect': 'error',
            'jest/valid-expect': 'error',
            'jest/valid-expect-in-promise': 'error',
            'jest/no-standalone-expect': 'error',
            'jest/no-identical-title': 'error',
            // One naming convention, checked rather than agreed. A title in
            // the third person states the contract - "returns null for an
            // empty path" - where "should return null" states an intention
            // about the code instead of a fact about it.
            'jest/valid-title': [
                'error',
                {
                    mustNotMatch: {
                        it: [
                            '^should\\b',
                            'Name a test after what the code does, in the third person: "returns X", not "should return X".',
                        ],
                        test: [
                            '^should\\b',
                            'Name a test after what the code does, in the third person: "returns X", not "should return X".',
                        ],
                    },
                },
            ],
            'jest/no-done-callback': 'error',
            // Awaiting is the difference between asserting and hoping.
            'jest/no-conditional-in-test': 'off',
            'jest/prefer-to-be': 'error',
            'jest/prefer-to-contain': 'error',
            'jest/prefer-to-have-length': 'error',
            // Guards the parametrisation pass: a run of tests that differ
            // only by their inputs belongs in a table.
            'jest/prefer-each': 'warn',
            'jest/require-top-level-describe': 'off',
            // Test files need unbound methods for jest mocks
            '@typescript-eslint/unbound-method': 'off',
            // Test mocks may require type assertions and flexible typing
            '@typescript-eslint/no-explicit-any': 'warn',
            '@typescript-eslint/no-unsafe-function-type': 'off',
            // Test files may use require for jest.mock
            '@typescript-eslint/no-require-imports': 'off',
            // Mock files use _prefixed params to indicate intentionally unused args
            '@typescript-eslint/no-unused-vars': [
                'error',
                {
                    argsIgnorePattern: '^_',
                    varsIgnorePattern: '^_',
                },
            ],
        },
    },
);
