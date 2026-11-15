// The configuration the Obsidian community review lints a plugin repository with: the recommended config of
// eslint-plugin-obsidianmd and the parser options its README prescribes. The review never reads eslint.config.mjs,
// so this file holds nothing of the project's own beyond ignoring output a clean clone does not have.
import obsidianmd from 'eslint-plugin-obsidianmd';

export default [
	{ ignores: ['coverage/**', 'dist/**'] },
	...obsidianmd.configs.recommended,
	{
		languageOptions: {
			parserOptions: {
				projectService: { allowDefaultProject: ['eslint.config.*'] },
			},
		},
	},
];
