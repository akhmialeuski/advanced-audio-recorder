import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import obsidianmd from 'eslint-plugin-obsidianmd';
import prettier from 'eslint-plugin-prettier';
import eslintConfigPrettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    {
        plugins: {
            prettier,
            obsidianmd,
        },
        languageOptions: {
            globals: {
                ...globals.browser,
                ...globals.node,
                ...globals.es2021,
            },
            parserOptions: {
                project: './tsconfig.eslint.json',
            },
        },
        rules: {
            // Obsidian Plugin Rules (Recommended)
            ...obsidianmd.configs.recommended,

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
            'obsidianmd/ui/sentence-case': 'warn',
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
        rules: {
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
