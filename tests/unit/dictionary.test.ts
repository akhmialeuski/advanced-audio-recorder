/**
 * Tests the transcription dictionary parser. The dictionary is one term per
 * line so a term may contain spaces; the parser trims each line, drops blanks,
 * and removes case-insensitive duplicates while keeping first-seen order.
 * @module tests/unit/dictionary.test
 */

import { parseDictionary } from 'src/transcription/dictionary';

describe('parseDictionary', () => {
	it('splits on newlines and trims each term', () => {
		expect(parseDictionary('Kubernetes\n  gRPC  \nCI/CD')).toEqual([
			'Kubernetes',
			'gRPC',
			'CI/CD',
		]);
	});

	it('keeps terms that contain spaces intact', () => {
		expect(parseDictionary('Anatol Khmialeuski\nPull Request')).toEqual([
			'Anatol Khmialeuski',
			'Pull Request',
		]);
	});

	it('drops blank lines and handles CRLF endings', () => {
		expect(parseDictionary('one\r\n\r\n  \r\ntwo')).toEqual(['one', 'two']);
	});

	it('removes case-insensitive duplicates, keeping first-seen order', () => {
		expect(
			parseDictionary('Deepgram\ndeepgram\nDEEPGRAM\nWhisper'),
		).toEqual(['Deepgram', 'Whisper']);
	});

	it('reads a glossary written as a Markdown list under a heading', () => {
		// A glossary kept in a note: the heading is a section title and each
		// marker is list markup, so neither may reach the engine as a term.
		expect(
			parseDictionary(
				'# Glossary\n- Kubernetes\n* gRPC\n+ CI/CD\n1. Deepgram\n2) Whisper\n- [ ] Voxtral\n- [x] Nova',
			),
		).toEqual([
			'Kubernetes',
			'gRPC',
			'CI/CD',
			'Deepgram',
			'Whisper',
			'Voxtral',
			'Nova',
		]);
	});

	it('keeps terms that only start with a marker character', () => {
		expect(parseDictionary('*nix\n1.5x\n#hashtag\nC#')).toEqual([
			'*nix',
			'1.5x',
			'#hashtag',
			'C#',
		]);
	});

	it('reads a linked term as the name the link shows', () => {
		// A glossary in a vault links its terms to their notes; the engine is
		// given the name, and the link markup never reaches it.
		expect(
			parseDictionary(
				'- [[Kubernetes]]\n- [[Tools/gRPC|gRPC]]\n- [[Glossaries/Helm#Charts]]\n- [[Argo CD|]]',
			),
		).toEqual(['Kubernetes', 'gRPC', 'Helm', 'Argo CD']);
	});

	it('skips comments and horizontal rules, which a note hides or only draws', () => {
		expect(
			parseDictionary(
				'Kubernetes %% k8s %%\n%%\nDraft term\n%%\n---\n* * *\n___\nHelm',
			),
		).toEqual(['Kubernetes', 'Helm']);
	});

	it('reads the list inside a callout, without the callout title', () => {
		expect(
			parseDictionary('> [!note] Tools\n> - Helm\n> > Argo\n> ## Later'),
		).toEqual(['Helm', 'Argo']);
	});

	it('reads an emphasized term as the text the note shows', () => {
		// Each marker would otherwise reach the engine as part of the term and
		// take a place the provider caps.
		expect(
			parseDictionary(
				'- **Kubernetes**\n- __gRPC__\n- *Helm*\n- _Argo_\n- ==Nova==\n- `kubectl`',
			),
		).toEqual(['Kubernetes', 'gRPC', 'Helm', 'Argo', 'Nova', 'kubectl']);
	});

	it('reads a Markdown link as its label, and an embed or struck-through text as nothing', () => {
		expect(
			parseDictionary(
				'- [Helm](https://helm.sh)\n- ![[logo.png]]\n- ![diagram](arch.png)\n- ~~Docker Swarm~~\n- Argo ~~CD~~',
			),
		).toEqual(['Helm', 'Argo']);
	});

	it('keeps inline code as written, markup inside it included', () => {
		expect(parseDictionary('- `__init__`\n- `**kwargs`')).toEqual([
			'__init__',
			'**kwargs',
		]);
	});

	it('keeps an underscore or an asterisk inside a word', () => {
		expect(parseDictionary('snake_case_name\n2*3*4\nfoo_bar_')).toEqual([
			'snake_case_name',
			'2*3*4',
			'foo_bar_',
		]);
	});

	it('skips tables and code blocks, which hold no term', () => {
		expect(
			parseDictionary(
				[
					'- Helm',
					'| Term | Meaning |',
					'| --- | --- |',
					'| Argo | CD |',
					'```yaml',
					'kind: Deployment',
					'~~~',
					'```',
					'> ~~~',
					'> quoted code',
					'> ~~~',
					'- Nova',
				].join('\n'),
			),
		).toEqual(['Helm', 'Nova']);
	});

	it('returns an empty array for empty or whitespace-only input', () => {
		expect(parseDictionary('')).toEqual([]);
		expect(parseDictionary('   \n\t\n')).toEqual([]);
	});
});
