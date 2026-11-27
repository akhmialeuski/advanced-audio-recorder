# Template notation

The decision record for how note templates are written. Every later piece of the
note templates work (prompt variables, parts filled by a model, part formats, the
transcript part, shipped presets, routing) builds on it, so it is fixed first and
changed only on purpose.

## Decision

Templates are **Handlebars**, the engine `obsidian-citation-extended` already uses
for the same job, run through one shared `TemplateEngine` (`src/templates/`).

| What a template says           | How it is written                                                        |
| ------------------------------ | ------------------------------------------------------------------------ |
| A fact of the run              | `{{title}}`, `{{properties.project}}`                                    |
| A date in a Moment format      | `{{date format="YYYY-MM-DD"}}`, or the core form `{{date:YYYY-MM-DD}}`   |
| A condition                    | `{{#if participants}}...{{else}}...{{/if}}`                              |
| A repeat                       | `{{#each turns}}**{{speaker}}**: {{text}}{{/each}}`                      |
| A helper                       | `{{join participants ", "}}`, `{{duration durationSeconds}}`             |
| A part a model fills           | `{{#part "actions" format="tasks" max=5}}instruction{{/part}}`           |
| A part from a prompt profile   | `{{part "actions" profile="Action items"}}`                              |
| A part's value elsewhere       | `{{parts.summary}}`, `{{#if parts.actions}}...{{/if}}`                   |
| Templater commands             | `<% tp.file.title %>`, run on the template before anything else reads it |

The part and transcript helpers arrive with the work that needs them. This record
fixes their shape so that work does not have to.

### What the notation has to express, and where it does

- **Facts of the run** are plain Handlebars variables. One catalogue
  (`TemplateCatalog`) declares them with a description and an example, and the
  same catalogue drives rendering, validation, and the list of variables a profile
  page opens.
- **The place of a part** is where its block stands in the template. The order of
  blocks is the order of sections in the note.
- **The settings of a part** are the hash arguments of its block: `format`, `max`,
  `empty`, `profile`, `language`, `separate`, `target`. The block body is the
  instruction for the model, itself rendered with the run's facts, so an
  instruction can name the meeting and its people. `profile="Action items"` takes
  the instruction from a named prompt profile instead, which is how one instruction
  serves five templates; a part naming both is a validation error.

### Rules the engine enforces

- **Nothing in a template runs code.** Handlebars evaluates only the helpers the
  plugin registers; partials and decorators are refused with a validation error.
- **The output is Markdown**, so nothing is HTML-escaped (`noEscape`).
- **An unknown name stays in the output as typed.** A prompt regularly shows a
  model an example such as `{"owner": "{{owner}}"}`, and cutting a piece out of an
  instruction is worse than leaving a typo the validator already named. The
  renderer finds unknown plain names with the same walk the validator uses and
  escapes them, so they reach the text literally.
- **Every problem has a place.** Syntax errors, unknown helpers, unknown block
  names and unknown variables are reported with their line and column. A name
  inside `{{#each turns}}` is checked against the fields of one turn, `../` and
  `@root` climb out, and a value whose shape is not known (an open object such as
  `properties`) is not checked rather than reported wrongly.
- **Single braces are free.** Handlebars reads only `{{`, so the transcript line
  formats (`{time}`, `{speaker}`, `{text}` in `transcriptFormat.ts`) and the JSON
  examples in a prompt are untouched.

## Why not the other candidates

**Obsidian core Templates syntax alone** (`{{title}}`, `{{date:FORMAT}}`). Known to
every user and dependency-free, but it has no conditions, no repeats and no
arguments, so the settings of a part could not live in the template and the
"remove an empty section" and "repeat per speaker turn" cases could not be written
at all. Its date form is accepted on top of Handlebars, so nothing a core template
user writes is lost.

**Templater as the template engine.** Templater evaluates JavaScript from the
template text. Making it the engine would make a community plugin a hard
requirement, which the plugin must not have, and would execute code from any
template shared by copying. It is integrated instead as an optional last step:
when Templater is installed, the template's text is handed to its
`templater.parse_template(config, text)`, which processes `<% %>` commands in a
string without creating a file; when it is not, the commands stay in the text
untouched and a notice says so. That keeps the trust model Templater users already
accept for their own templates, and costs nothing to anyone else.

The commands run on the template, before its parts and variables, and not on the
assembled note, as first planned. Run on the note, they would also run any
`<% %>` a model wrote into a part or a speaker said into the transcript: JavaScript
from text nobody chose to trust. Run on the template, they see only what the user
wrote, and their output can still write `{{#part}}` blocks or choose which ones the
note has. `tp.file` is the note the recording is in, or the recording itself when it
is in none.

**Configuration of parts outside the template** (named slots in plain Markdown,
settings per part on a separate page). The text would look exactly like the note
it produces, but the settings of a part would live somewhere else and be tied to
it only by name, so renaming a slot or copying a template to another vault breaks
it silently. Rejected for that coupling.

**A fenced YAML block per part inside the template.** Rejected by the user before
the decision.

## Constraints checked

- **Bundle size.** Measured with esbuild, minified as the production build does:
  the engine with Handlebars and its compiler is 114 KB (Handlebars alone 104 KB),
  on a 2.02 MB `main.js`, about 5.6%. The compiler is needed at runtime because
  templates are user text, so the runtime-only build is not an option.
- **A new runtime dependency.** Handlebars is the fourth, and the only one not
  about audio encoding. It is justified by the parser and the AST it exposes: the
  validator walks that AST to report problems with their place, which a
  hand-written substitution would have to reimplement.
- **Frontmatter of a note-backed template.** `ProfileNoteStore` strips the
  frontmatter of a note a profile body is read from, for every kind of profile.
  That stays as it is: a template note's own frontmatter describes the template
  (tags, aliases), not the note it produces. Properties of the produced note are
  written by parts with a `property="name"` setting through
  `app.fileManager.processFrontMatter`, never by text that happens to start with
  `---`.
- **Mobile.** A template is a plain note edited in the ordinary editor; Handlebars
  runs in any JavaScript environment Obsidian runs in.

## A shipped template, written in full

The daily sync preset, as it ships:

<!-- prettier-ignore -->
```handlebars
# {{title}}

{{date recordedAt format="dddd, D MMMM YYYY"}} · {{duration}}{{#if participants}} · {{join participants ", "}}{{/if}}

## Summary

{{#part "summary" format="bullets" max=3}}
The three things that matter from this meeting, most important first. Leave out greetings, small talk and anything nobody acted on.
{{/part}}

## Action items

{{part "actions" format="tasks" profile="Action items"}}

## Blockers

{{#part "blockers" format="bullets"}}
What stops a participant from moving on, as they said it. Name who is blocked.
{{/part}}

## Transcript

{{transcript callout="quote" title="Full transcript" folded=true timestamps=false}}
```

A part the model found nothing for is removed together with the heading right
above it (`empty="remove"`, the default), so a sync without blockers has no
empty "Blockers" section. The transcript stands under a heading of its own,
because a part's heading would otherwise own it and stay when the part goes.

## Tasks this decision adds examples to

- Template variables in LLM prompts
- Note templates built from configured parts
- Part formats and local renderers
- Transcript part rendering options
- Shipped templates per meeting type
- Template output into properties and a separate note
- Template routing by note metadata
