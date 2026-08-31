/**
 * Every CSS selector the tests reach through, in one place.
 *
 * A test that hard-codes `.aar-player-time` is asserting on a class name, not
 * on behaviour: renaming the class turns the suite red although nothing the
 * user can observe changed. Naming the selectors here keeps the class strings
 * to a single file, so a rename is one edit, and gives each one a name that
 * says what the element *is* rather than what it is called in CSS.
 *
 * Selectors that are plain HTML (`button`, `input`) are not listed - those are
 * structural, not project vocabulary, and renaming a tag is not a refactor.
 * @module tests/helpers/selectors
 */

/** The inline player under a note's audio embed. */
export const PLAYER = {
	root: '.aar-player',
	readonly: '.aar-player-readonly',
	editOnly: '.aar-player-edit-only',
	controls: '.aar-player-controls',
	controlButton: '.aar-control-btn',
	time: '.aar-player-time',
	speed: '.aar-player-speed',
	volume: '.aar-player-volume',
	seek: '.aar-player-seek',
	seekBar: '.aar-player-seek-bar',
	seekWaveform: '.aar-player-seek-waveform',
	waveform: '.aar-player-waveform',
	canvas: '.aar-player-canvas',
	canvasPlayed: '.aar-player-canvas-played',
	progressFill: '.aar-player-progress-fill',
	progressThumb: '.aar-player-progress-thumb',
	tick: '.aar-player-tick',
	/** The label rule that only applies inside a player. */
	scopedStaticLabel: '.aar-player .aar-player-marker-label-static',
	/** The edit-only controls a read-only player hides. */
	readonlyEditOnly: '.aar-player-readonly .aar-player-edit-only',
} as const;

/** Marker rows and their controls, both in the player and in the list view. */
export const MARKER = {
	row: '.aar-player-marker-row',
	clickableRow: '.aar-player-marker-row-clickable',
	activeRow: '.aar-player-marker-row.is-active',
	labelInput: 'input.aar-player-marker-label',
	staticLabel: '.aar-player-marker-label-static',
	label: '.aar-player-marker-label',
	segment: '.aar-player-marker-segment',
	delete: '.aar-player-marker-delete',
	timeEdit: 'input.aar-player-marker-time-edit',
	here: '.aar-player-marker-here',
	color: 'select.aar-player-marker-color',
	note: 'textarea.aar-player-marker-note',
	staticNote: '.aar-player-marker-note-static',
	searchTitle: '.aar-marker-search-title',
	searchMeta: '.aar-marker-search-meta',
	coloredRow: '.aar-player-marker-row-colored',
	buttonRow: 'button.aar-player-marker-row',
	coloredButtonRow: '.aar-player-marker-row.aar-player-marker-row-colored',
	/** The note field by its class alone, for reading its CSS rule. */
	noteRule: '.aar-player-marker-note',
	/** A bookmark tick on the timeline. */
	tickBookmark: '.aar-player-tick-bookmark',
	/** The overlay the ticks are drawn onto, over the seek area. */
	overlay: '.aar-player-markers',
	/** The list of marker rows under the player. */
	list: '.aar-player-marker-list',
	byId: (id: string): string =>
		`.aar-player-marker-row-clickable[data-marker-id="${id}"]`,
	tickAt: (seconds: number): string =>
		`.aar-player-tick[data-time="${String(seconds)}"]`,
} as const;

/** The playback half of the status bar. */
export const PLAYBACK = {
	controls: '.aar-playback-controls',
	toggle: '.aar-playback-toggle',
	mute: '.aar-playback-mute',
	volume: '.aar-playback-volume',
	markerControls: '.aar-playback-marker-controls',
	chapterControls: '.aar-playback-chapter-controls',
	chapterLoop: '.aar-playback-chapter-loop',
	time: '.aar-playback-time',
} as const;

/** The recording half of the status bar, and the save progress it shows. */
export const STATUS = {
	recordingControls: '.aar-recording-controls',
	recordingButtons: '.aar-recording-buttons',
	recordingLabel: '.aar-recording-label',
	saveProgress: '.aar-save-progress',
	saveProgressBar: '.aar-save-progress-bar',
	actionableProgress: '.aar-status-progress-actionable',
	live: '.aar-recording-live',
	elapsed: '.aar-recording-time',
	recordedSize: '.aar-recording-size',
	inputMeter: '.aar-input-meter',
	inputMeterFill: '.aar-input-meter-fill',
} as const;

/** The banner the mobile build shows while recording. */
export const BANNER = {
	root: '.aar-recording-banner',
	time: '.aar-recording-banner-time',
	dot: '.aar-recording-banner-dot',
	stop: '.aar-recording-banner-stop',
} as const;

/** Obsidian's own settings markup, plus the parts this plugin adds to it. */
export const SETTING = {
	item: '.setting-item',
	name: '.setting-item-name',
	description: '.setting-item-description',
	checkbox: '.checkbox-container',
	/** A toggle rendered in its on state. */
	toggleOn: '.checkbox-container.is-enabled',
	root: '.aar-settings-root',
	searchInput: '.aar-search-row input',
	addItemButton: '.aar-add-item-row button',
	custom: '.aar-custom',
	docCallout: '.aar-doc-callout',
	docCalloutLink: '.aar-doc-callout-link',
	testAudio: '.aar-test-audio',
	testStatus: '.aar-test-status',
	speakerPreview: 'button.aar-speaker-preview',
	silentChannelConvert: '.aar-silent-channel-convert',
	formatFallbackNote: '.aar-format-fallback-note',
} as const;

/** Modal bodies this plugin renders. */
export const MODAL = {
	config: '.aar-modal-config',
	error: '.aar-modal-error',
	conversionSource: '.aar-conversion-source',
	splitSource: '.aar-split-source',
	recoverySession: '.aar-recovery-session',
	silentChannelConvert: '.aar-silent-channel-convert',
} as const;

/** The transcription queue dialog. */
export const QUEUE = {
	cost: '.aar-queue-cost',
	list: '.aar-queue-list',
	row: '.aar-queue-row',
	state: '.aar-queue-state',
	remove: '.aar-queue-remove',
} as const;
