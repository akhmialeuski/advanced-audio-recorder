/**
 * Cuts a release of the plugin.
 *
 * Everything here has one correct answer, so it is done the same way every
 * time: the checks before a bump, the shape of the bump commit, the tag, the
 * push, the wait for the workflow, and the replacement of its generated notes.
 * What is left to a person is the version number and the text of the notes.
 *
 * The steps are separate commands because two of them cannot be taken back in
 * public: the push of the tag and the release built from it. Each command
 * re-checks the state it needs rather than trusting the one before it, so an
 * interrupted release is resumed by running the next command again.
 *
 * Usage:
 *   node scripts/release.mjs preflight <version>
 *   node scripts/release.mjs bump <version> [--trailer <line>]...
 *   node scripts/release.mjs publish <version>
 *   node scripts/release.mjs notes <version> [file]
 *   node scripts/release.mjs status <version>
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import esbuild from 'esbuild';

const ROOT = process.cwd();

/** The branch a release is cut from. This repo's default branch is master. */
const RELEASE_BRANCH = 'master';
const REMOTE = 'origin';

/** The four files a version bump is allowed to touch, in git's own order. */
const BUMP_FILES = [
	'manifest.json',
	'package-lock.json',
	'package.json',
	'versions.json',
];

/** What .github/workflows/release.yml attaches to the published release. */
const RELEASE_ASSETS = ['main.js', 'manifest.json', 'styles.css'];

/** The module the plugin's What's new dialog reads its text from. */
const RELEASE_NOTES_MODULE = 'src/release/releaseNotes.ts';

/**
 * A tag carries no `v` prefix, and .npmrc sets an empty tag-version-prefix so
 * npm agrees. The release workflow triggers on this shape alone, which is why
 * three integers are the whole grammar a version has here.
 */
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

/** How long to wait for the workflow run of a freshly pushed tag to appear. */
const RUN_LOOKUP_TIMEOUT_MS = 90_000;
const RUN_LOOKUP_INTERVAL_MS = 3_000;

/**
 * Reports what went wrong and stops. Every check in this file ends here rather
 * than throwing, because a half-finished release needs the reason on one line.
 * @param message - What failed, in the imperative of the state it expected
 * @returns Never
 */
function fail(message) {
	console.error(`release: ${message}`);
	process.exit(1);
}

/**
 * Runs a command and returns its trimmed output.
 * @param command - Executable name
 * @param args - Arguments
 * @returns Standard output with surrounding whitespace removed
 */
function capture(command, args) {
	const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8' });
	if (result.error) {
		fail(`${command} could not be started: ${result.error.message}`);
	}
	if (result.status !== 0) {
		const detail = (result.stderr || result.stdout || '').trim();
		fail(`${command} ${args.join(' ')} failed: ${detail}`);
	}
	return result.stdout.trim();
}

/**
 * Runs a command whose failure is an answer rather than an error, such as a
 * lookup of a tag that may not exist.
 * @param command - Executable name
 * @param args - Arguments
 * @returns Standard output when the command succeeded, null otherwise
 */
function tryCapture(command, args) {
	const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8' });
	if (result.error || result.status !== 0) {
		return null;
	}
	return result.stdout.trim();
}

/**
 * Runs a long command with its output going straight to the terminal, so a
 * build or a test run is watched while it happens.
 * @param command - Executable name
 * @param args - Arguments
 */
function run(command, args) {
	console.log(`\n$ ${command} ${args.join(' ')}`);
	const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit' });
	if (result.error) {
		fail(`${command} could not be started: ${result.error.message}`);
	}
	if (result.status !== 0) {
		fail(`${command} ${args.join(' ')} exited with ${result.status}`);
	}
}

/**
 * Compares two versions of three integers. The shape is fixed by the release
 * workflow's tag filter, so this is an ordering of three numbers rather than
 * the semver grammar. Numeric collation compares each run of digits as a
 * number, which is the whole of it, and is what the plugin's own release
 * notes order themselves by. The locale is named so the answer cannot depend
 * on the machine cutting the release.
 * @param left - Version to order first
 * @param right - Version to order against
 * @returns True when left names a later release than right
 */
function isAhead(left, right) {
	return left.localeCompare(right, 'en', { numeric: true }) > 0;
}

/**
 * Waits.
 * @param ms - Milliseconds to wait
 * @returns A promise that settles once the time has passed
 */
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The version a JSON file of the repository states.
 * @param file - Repo-relative path to a file carrying a `version` field
 * @returns The stored version
 */
function storedVersion(file) {
	return JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8')).version;
}

/** One release, and every step that takes it from a clean master to a page. */
class Release {
	/**
	 * @param version - The version to release, such as `2.3.2`
	 */
	constructor(version) {
		if (!version) {
			fail('name the version to release, such as 2.3.2');
		}
		if (!VERSION_PATTERN.test(version)) {
			fail(`"${version}" is not three integers separated by dots`);
		}
		this.version = version;
	}

	/** Refuses anything but a clean checkout of the release branch. */
	assertOnCleanReleaseBranch() {
		const branch = capture('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
		if (branch !== RELEASE_BRANCH) {
			fail(`a release is cut on ${RELEASE_BRANCH}, and HEAD is ${branch}`);
		}
		const dirty = capture('git', ['status', '--porcelain']);
		if (dirty) {
			fail(`the working tree carries changes:\n${dirty}`);
		}
	}

	/** Refuses a local branch that has drifted from the remote one. */
	assertInSyncWithRemote() {
		run('git', ['fetch', REMOTE, RELEASE_BRANCH, '--tags']);
		const local = capture('git', ['rev-parse', 'HEAD']);
		const remote = capture('git', [
			'rev-parse',
			`${REMOTE}/${RELEASE_BRANCH}`,
		]);
		if (local !== remote) {
			fail(
				`${RELEASE_BRANCH} is at ${local.slice(0, 7)} and ` +
					`${REMOTE}/${RELEASE_BRANCH} at ${remote.slice(0, 7)}; ` +
					'pull or push before releasing',
			);
		}
	}

	/** Refuses a version that has already been tagged here or on the remote. */
	assertTagFree() {
		if (capture('git', ['tag', '--list', this.version])) {
			fail(`tag ${this.version} already exists locally`);
		}
		const remote = tryCapture('git', [
			'ls-remote',
			'--tags',
			REMOTE,
			this.version,
		]);
		if (remote) {
			fail(`tag ${this.version} already exists on ${REMOTE}`);
		}
	}

	/** Refuses a version that does not move the stored one forward. */
	assertVersionAhead() {
		const current = storedVersion('package.json');
		if (!isAhead(this.version, current)) {
			fail(`${this.version} does not come after the stored ${current}`);
		}
	}

	/**
	 * The release notes the plugin bundles, asked of the module rather than
	 * read out of its source with a pattern. The map is TypeScript, and a
	 * pattern that quietly stopped matching would pass every release, which is
	 * worse than no check. esbuild is what the plugin is built with, so asking
	 * this way costs no dependency.
	 * @returns The bundled catalogue, keyed by tag
	 */
	async bundledNotes() {
		const built = await esbuild.build({
			entryPoints: [path.join(ROOT, RELEASE_NOTES_MODULE)],
			bundle: true,
			format: 'esm',
			platform: 'neutral',
			write: false,
		});
		const source = Buffer.from(built.outputFiles[0].text).toString(
			'base64',
		);
		const loaded = await import(`data:text/javascript;base64,${source}`);
		return loaded.RELEASE_NOTES;
	}

	/**
	 * Refuses a version the plugin cannot announce.
	 *
	 * The What's new dialog reads the bundled map, so a tag pushed without its
	 * entry ships a build that opens on nothing for everyone who updates to
	 * it. The entry reaches master through an ordinary pull request, which is
	 * why this is asked before the bump rather than fixed by it.
	 */
	async assertNotesBundled() {
		const notes = await this.bundledNotes();
		const entry = notes[this.version];
		if (!entry || !entry.trim()) {
			fail(
				`${RELEASE_NOTES_MODULE} carries no notes for ${this.version}; ` +
					'add its entry on master before cutting the release',
			);
		}
	}

	/** Refuses to continue where the GitHub CLI cannot answer. */
	assertGhReady() {
		if (tryCapture('gh', ['auth', 'status']) === null) {
			fail('gh is not authenticated; run gh auth login');
		}
	}

	/**
	 * Everything that has to hold before a bump, followed by the three gates
	 * the release itself depends on. Leaves the repository untouched.
	 */
	async preflight() {
		this.assertOnCleanReleaseBranch();
		this.assertInSyncWithRemote();
		this.assertTagFree();
		this.assertVersionAhead();
		await this.assertNotesBundled();
		this.assertGhReady();
		run('npm', ['run', 'build']);
		run('npm', ['run', 'lint']);
		run('npm', ['test', '--', '--no-coverage']);
		const stats = this.suiteStats();
		const size = stats
			? `${stats.tests} tests across ${stats.suites} suites`
			: 'suite size unavailable';
		console.log(
			`\nrelease: ${this.version} is ready to cut from ` +
				`${capture('git', ['rev-parse', '--short', 'HEAD'])} (${size})`,
		);
	}

	/**
	 * How big the suite is, as the jest reporter recorded it during the run
	 * preflight just made. The release notes quote this number.
	 * @returns The recorded counts, or null when no run has written them
	 */
	suiteStats() {
		const file = path.join(ROOT, 'coverage', 'suite-stats.json');
		if (!fs.existsSync(file)) {
			return null;
		}
		return JSON.parse(fs.readFileSync(file, 'utf8'));
	}

	/**
	 * Writes the version into the four files npm and the plugin manifest share
	 * and commits them, with nothing else in the commit.
	 * @param trailers - Lines git appends to the commit message
	 */
	async bump(trailers) {
		this.assertOnCleanReleaseBranch();
		this.assertInSyncWithRemote();
		this.assertTagFree();
		this.assertVersionAhead();
		await this.assertNotesBundled();
		// The `version` npm script writes manifest.json and versions.json and
		// stages them, so this one command covers all four files.
		run('npm', ['version', this.version, '--no-git-tag-version']);
		this.assertBumpFilesOnly();
		const message = `chore: bump version to ${this.version}`;
		const args = ['commit', '-m', message];
		for (const trailer of trailers) {
			args.push('--trailer', trailer);
		}
		run('git', ['add', ...BUMP_FILES]);
		run('git', args);
		this.assertBumpCommit();
		run('git', ['show', '--stat', '--oneline', 'HEAD']);
	}

	/** Refuses a working tree where the bump has reached anything else. */
	assertBumpFilesOnly() {
		const touched = capture('git', ['status', '--porcelain'])
			.split('\n')
			.filter(Boolean)
			.map((line) => line.slice(3))
			.sort();
		const unexpected = touched.filter(
			(file) => !BUMP_FILES.includes(file),
		);
		if (unexpected.length > 0) {
			fail(`the bump touched more than its four files: ${unexpected}`);
		}
	}

	/**
	 * Refuses a commit that does not carry the version into all four files.
	 * The pre-commit hook rewrites two of them, so what was staged and what
	 * was committed are different questions.
	 */
	assertBumpCommit() {
		const subject = capture('git', ['log', '-1', '--format=%s']);
		if (subject !== `chore: bump version to ${this.version}`) {
			fail(`HEAD is "${subject}" rather than the bump commit`);
		}
		const files = capture('git', [
			'show',
			'--name-only',
			'--format=',
			'HEAD',
		])
			.split('\n')
			.filter(Boolean)
			.sort();
		if (files.join(',') !== [...BUMP_FILES].sort().join(',')) {
			fail(`the bump commit carries ${files} rather than the four files`);
		}
		for (const file of ['package.json', 'manifest.json']) {
			if (storedVersion(file) !== this.version) {
				fail(`${file} states ${storedVersion(file)} after the bump`);
			}
		}
		const versions = JSON.parse(
			fs.readFileSync(path.join(ROOT, 'versions.json'), 'utf8'),
		);
		if (!versions[this.version]) {
			fail(`versions.json has no entry for ${this.version}`);
		}
		const dirty = capture('git', ['status', '--porcelain']);
		if (dirty) {
			fail(`the pre-commit hook left changes behind:\n${dirty}`);
		}
	}

	/**
	 * Tags the bump commit, pushes both, waits for the workflow, and checks
	 * that the release it built carries its three assets.
	 */
	async publish() {
		this.assertOnCleanReleaseBranch();
		this.assertBumpCommit();
		this.assertTagFree();
		run('git', ['tag', this.version]);
		run('git', ['push', REMOTE, RELEASE_BRANCH]);
		run('git', ['push', REMOTE, this.version]);
		const runId = await this.awaitWorkflowRun();
		run('gh', ['run', 'watch', runId, '--exit-status']);
		this.assertReleaseAssets();
		console.log(
			`\nrelease: ${this.version} is published at ${this.releaseUrl()}`,
		);
	}

	/**
	 * The id of the release workflow run the pushed tag started. A run takes a
	 * few seconds to appear, so the lookup is repeated rather than asked once.
	 * @returns The run id, as a string
	 */
	async awaitWorkflowRun() {
		const deadline = Date.now() + RUN_LOOKUP_TIMEOUT_MS;
		while (Date.now() < deadline) {
			const listed = tryCapture('gh', [
				'run',
				'list',
				'--workflow=release.yml',
				'--limit',
				'20',
				'--json',
				'databaseId,headBranch',
			]);
			const found = JSON.parse(listed || '[]').find(
				(entry) => entry.headBranch === this.version,
			);
			if (found) {
				return String(found.databaseId);
			}
			await sleep(RUN_LOOKUP_INTERVAL_MS);
		}
		return fail(`no release workflow run appeared for ${this.version}`);
	}

	/** Refuses a release the workflow built without its three files. */
	assertReleaseAssets() {
		const listed = capture('gh', [
			'release',
			'view',
			this.version,
			'--json',
			'assets',
			'-q',
			'[.assets[].name] | join(",")',
		]);
		const missing = RELEASE_ASSETS.filter(
			(asset) => !listed.split(',').includes(asset),
		);
		if (missing.length > 0) {
			fail(`the release is missing ${missing}; it carries ${listed}`);
		}
	}

	/**
	 * The notes to publish, and the name of where they came from.
	 *
	 * The bundle is the default, so the release page and the What's new dialog
	 * cannot say different things about the same version. A file is still
	 * accepted, for the rare page that has to differ from what ships.
	 * @param file - Path to Markdown notes, or undefined for the bundled entry
	 * @returns The text and the origin to name in a message
	 */
	async notesToPublish(file) {
		if (file) {
			return { text: fs.readFileSync(file, 'utf8').trim(), origin: file };
		}
		const bundled = await this.bundledNotes();
		return {
			text: (bundled[this.version] ?? '').trim(),
			origin: RELEASE_NOTES_MODULE,
		};
	}

	/**
	 * Replaces the notes the workflow generated with the ones the release
	 * ships, and reads the page back to prove the replacement took.
	 *
	 * Both origins go to the command line through a file of this script's own,
	 * which is one path to read and gives the page the same trailing newline
	 * whichever origin it came from.
	 * @param file - Path to Markdown notes, or undefined for the bundled entry
	 */
	async notes(file) {
		const { text, origin } = await this.notesToPublish(file);
		if (!text) {
			fail(`${origin} holds no notes for ${this.version}`);
		}
		const directory = fs.mkdtempSync(
			path.join(os.tmpdir(), 'aar-release-'),
		);
		try {
			const page = path.join(directory, `${this.version}.md`);
			fs.writeFileSync(page, `${text}\n`);
			run('gh', [
				'release',
				'edit',
				this.version,
				'--notes-file',
				page,
			]);
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
		const published = capture('gh', [
			'release',
			'view',
			this.version,
			'--json',
			'body',
			'-q',
			'.body',
		]).replace(/\r\n/g, '\n');
		if (published.trim() !== text) {
			fail(`the published notes differ from ${origin}`);
		}
		console.log(
			`\nrelease: notes of ${this.version} replaced from ${origin}`,
		);
	}

	/** Where the release lives. */
	releaseUrl() {
		return capture('gh', [
			'release',
			'view',
			this.version,
			'--json',
			'url',
			'-q',
			'.url',
		]);
	}

	/** What the repository and GitHub say about this version right now. */
	status() {
		const branch = capture('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
		const dirty = capture('git', ['status', '--porcelain']);
		const tagged = capture('git', ['tag', '--list', this.version]);
		const remoteTag = tryCapture('git', [
			'ls-remote',
			'--tags',
			REMOTE,
			this.version,
		]);
		const release = tryCapture('gh', [
			'release',
			'view',
			this.version,
			'--json',
			'url',
			'-q',
			'.url',
		]);
		const lines = [
			['branch', branch],
			['working tree', dirty ? 'dirty' : 'clean'],
			['package.json', storedVersion('package.json')],
			['manifest.json', storedVersion('manifest.json')],
			['tag here', tagged || 'absent'],
			[`tag on ${REMOTE}`, remoteTag ? 'present' : 'absent'],
			['release', release || 'absent'],
		];
		const width = Math.max(...lines.map(([label]) => label.length));
		for (const [label, value] of lines) {
			console.log(`${label.padEnd(width)}  ${value}`);
		}
	}
}

const STEPS = ['preflight', 'bump', 'publish', 'notes', 'status'];

const [step, version, ...rest] = process.argv.slice(2);
if (!STEPS.includes(step)) {
	fail(`unknown step "${step ?? ''}"; the steps are ${STEPS.join(', ')}`);
}
const release = new Release(version);
const trailers = [];
for (let index = 0; index < rest.length; index += 1) {
	if (rest[index] === '--trailer') {
		index += 1;
		if (!rest[index]) {
			fail('--trailer needs the line to append');
		}
		trailers.push(rest[index]);
	}
}

switch (step) {
	case 'preflight':
		await release.preflight();
		break;
	case 'bump':
		await release.bump(trailers);
		break;
	case 'publish':
		await release.publish();
		break;
	case 'notes':
		await release.notes(rest[0]);
		break;
	case 'status':
		release.status();
		break;
}
