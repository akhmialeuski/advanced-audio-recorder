/**
 * The note templates the plugin ships, one per kind of recording, and the
 * action items instruction four of them share.
 *
 * The templates differ less in their wording than in which parts they hold
 * and how those are set: a daily sync and an architecture discussion go
 * through the same model, and come out as notes of different shapes because
 * each asks for different things. A part the model finds nothing for is
 * dropped with its heading, so a quiet sync is a short note rather than a
 * page of empty sections. The transcript stands under a heading of its own,
 * since a part's heading would otherwise own it and stay when the part goes.
 * They are a starting point to copy and edit, which is
 * why none of them is put in use by being shipped.
 * @module templates/shippedTemplates
 */

/** A prompt a release ships, with the fixed id it is found by. */
export interface ShippedPrompt {
	/** Fixed id: an install is given each shipped prompt once, by this id. */
	readonly id: string;
	/** Name it is shown and named by in templates. */
	readonly name: string;
	/** The prompt itself. */
	readonly body: string;
}

/** Name of the shared action items instruction, as templates name it. */
export const ACTION_ITEMS_PROFILE_NAME = 'Action items';

/**
 * The instruction for action items, a custom instruction profile so the
 * templates that list tasks share one wording the user can tune in one place.
 */
export const ACTION_ITEMS_PROFILE: ShippedPrompt = {
	id: 'shipped-llm-custom-action-items',
	name: ACTION_ITEMS_PROFILE_NAME,
	body: [
		'The action items agreed in this recording: what somebody took on or was given to do.',
		'Write each one as a short imperative sentence. Name its owner as the transcript names them, and give a due date only when one was said, as YYYY-MM-DD when the day is clear.',
		'Leave out ideas, wishes and things that were only discussed, and anything already done.',
	].join(' '),
};

/**
 * The header most templates open with: the note's title, then the date, the
 * length and the people of the recording on one line.
 * @param withDuration - Whether the line gives the length
 * @param withParticipants - Whether the line names the participants
 */
function header(withDuration: boolean, withParticipants: boolean): string {
	return [
		'# {{title}}',
		'',
		[
			'{{date recordedAt format="dddd, D MMMM YYYY"}}',
			withDuration ? ' · {{duration}}' : '',
			withParticipants
				? '{{#if participants}} · {{join participants ", "}}{{/if}}'
				: '',
		].join(''),
	].join('\n');
}

/** The action items part, with the shared instruction. */
const ACTION_ITEMS_PART = `{{part "actions" format="tasks" profile="${ACTION_ITEMS_PROFILE_NAME}"}}`;

/** A daily sync: little content, so empty sections go and the transcript folds. */
export const DAILY_SYNC_TEMPLATE: ShippedPrompt = {
	id: 'shipped-llm-template-daily-sync',
	name: 'Daily sync',
	body: [
		header(true, true),
		'',
		'## Summary',
		'',
		'{{#part "summary" format="bullets" max=3}}',
		'The three things that matter from this meeting, most important first. Leave out greetings, small talk and anything nobody acted on.',
		'{{/part}}',
		'',
		'## Action items',
		'',
		ACTION_ITEMS_PART,
		'',
		'## Blockers',
		'',
		'{{#part "blockers" format="bullets"}}',
		'What stops a participant from moving on, as they said it. Name who is blocked.',
		'{{/part}}',
		'',
		'## Transcript',
		'',
		'{{transcript callout="quote" title="Full transcript" folded=true timestamps=false}}',
		'',
	].join('\n'),
};

/**
 * An architecture discussion: decisions apart from tasks, each decision with
 * why it was taken and what was turned down.
 */
export const ARCHITECTURE_TEMPLATE: ShippedPrompt = {
	id: 'shipped-llm-template-architecture',
	name: 'Architecture discussion',
	body: [
		header(false, true),
		'',
		'## Decisions',
		'',
		'{{#part "decisions" format="decisions" callout="success" title="Decided"}}',
		'Only what the participants agreed on, not what was proposed. For each decision, the reason it was taken and the alternatives that were considered and turned down, with why.',
		'{{/part}}',
		'',
		'## Open questions',
		'',
		'{{#part "questions" format="bullets"}}',
		'Questions raised and left without an answer, each as one question.',
		'{{/part}}',
		'',
		'## Tasks',
		'',
		ACTION_ITEMS_PART,
		'',
		'## Terms',
		'',
		'{{#part "terms" format="table" columns="Term, Definition"}}',
		'Technical terms, components and acronyms the discussion relies on, each with what it means in this system.',
		'{{/part}}',
		'',
		'## Transcript',
		'',
		'{{transcript callout="quote" title="Full transcript" folded=true}}',
		'',
	].join('\n'),
};

/** A lecture or lesson: notes in the order taught, terms, and questions. */
export const LECTURE_TEMPLATE: ShippedPrompt = {
	id: 'shipped-llm-template-lecture',
	name: 'Lecture',
	body: [
		header(true, false),
		'',
		'## Notes',
		'',
		'{{#part "notes" format="outline"}}',
		'The topics of the lecture in the order they were taught, each with its key points. Keep definitions, formulas and examples as the speaker gave them.',
		'{{/part}}',
		'',
		'## Terms',
		'',
		'{{#part "terms" format="terms"}}',
		'The terms the lecture defines, in the order they come up, each with its definition as given.',
		'{{/part}}',
		'',
		'## Questions to check yourself',
		'',
		'{{#part "questions" format="numbered" max=7}}',
		'Questions that check the main ideas of the lecture. Each question asks for one idea and does not give its answer away.',
		'{{/part}}',
		'',
		'## Transcript',
		'',
		'{{transcript callout="quote" title="Full transcript" folded=true}}',
		'',
	].join('\n'),
};

/**
 * An interview: the transcript is what the note is for, so it stays open with
 * its timestamps and speakers, after the topics and the quotes worth keeping.
 */
export const INTERVIEW_TEMPLATE: ShippedPrompt = {
	id: 'shipped-llm-template-interview',
	name: 'Interview',
	body: [
		header(false, true),
		'',
		'## Topics',
		'',
		'{{#part "topics" format="bullets"}}',
		'The topics of the interview, in the order they come up, each in a few words.',
		'{{/part}}',
		'',
		'## Quotes',
		'',
		'{{#part "quotes" format="quotes" max=5}}',
		'The statements most worth quoting, word for word as said, each with who said it and when.',
		'{{/part}}',
		'',
		'## Agreements',
		'',
		ACTION_ITEMS_PART,
		'',
		'## Transcript',
		'',
		'{{transcript timestamps=true speakers=true}}',
		'',
	].join('\n'),
};

/**
 * A one-on-one: what was agreed and what to prepare, and no transcript in the
 * note, since a recording of such a talk is kept more often than reread.
 */
export const ONE_ON_ONE_TEMPLATE: ShippedPrompt = {
	id: 'shipped-llm-template-one-on-one',
	name: 'One-on-one',
	body: [
		header(false, false),
		'',
		'## Discussed',
		'',
		'{{#part "discussed" format="bullets" max=5}}',
		'What the two people talked about, as plain facts without judging either of them.',
		'{{/part}}',
		'',
		'## Agreements',
		'',
		ACTION_ITEMS_PART,
		'',
		'## For next time',
		'',
		'{{#part "next" format="bullets"}}',
		'What either of them is to prepare, find out or check before the next conversation.',
		'{{/part}}',
		'',
	].join('\n'),
};

/** Every shipped note template, in the order the catalogue shows them. */
export const SHIPPED_TEMPLATES: readonly ShippedPrompt[] = [
	DAILY_SYNC_TEMPLATE,
	ARCHITECTURE_TEMPLATE,
	LECTURE_TEMPLATE,
	INTERVIEW_TEMPLATE,
	ONE_ON_ONE_TEMPLATE,
];
