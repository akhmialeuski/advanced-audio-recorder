# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Join complexity and coverage into a CRAP score per function, and gate code size, CRAP and coverage.

``CRAP = complexity ** 2 * (1 - coverage) ** 3 + complexity`` (Savoia and Evans, crap4j). Complexity comes from a
mature analyzer's JSON, never from this script: ruff ``C901`` for Python and ESLint ``complexity`` for JavaScript and
TypeScript, both run with a maximum of 0 so every function is reported with its score. Coverage comes from
coverage.py's JSON report or Istanbul's ``coverage-final.json``. A function's coverage is the lower of its statement
and branch coverage, and a function the coverage report does not mention counts as uncovered.

Two subcommands::

    uv run --no-project crap_gate.py size SRC_FILE...
    uv run --no-project crap_gate.py crap --ruff-json ruff.json --python-coverage coverage.json \
        --baseline crap-baseline.json
    uv run --no-project crap_gate.py crap --eslint-json eslint.json --istanbul coverage/coverage-final.json

``size`` counts code lines in Python files, without blank lines, comments or docstrings, and reports functions and
files over the limits. ``crap`` reports every function over the CRAP threshold and a total coverage under the floor.
With ``--baseline``, debt already recorded may stay but may not grow, the total coverage may not fall below the
recorded value, and ``--update-baseline`` rewrites the file with only the improvements. ``--skip-coverage`` leaves
coverage to a project that already gates it with a ratchet of its own: the floor and the recorded total are not
checked, and only the CRAP of each function is.

Exit status: 0 when every check passes, 1 on a violation, 2 when an input cannot be read.
"""

from __future__ import annotations

import argparse
import ast
import io
import json
import re
import sys
import tokenize
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from collections.abc import Iterable, Sequence

ENCODING: str = 'utf-8'
EXIT_OK: int = 0
EXIT_VIOLATION: int = 1
EXIT_INPUT: int = 2

DEFAULT_THRESHOLD: float = 8.0
DEFAULT_MIN_COVERAGE: float = 95.0
STORE_TRUE: str = 'store_true'
DEFAULT_FUNCTION_LINES: int = 50
DEFAULT_FILE_LINES: int = 500
#: A coverage total may drift this much between runs of the same code before it counts as a drop.
COVERAGE_TOLERANCE: float = 0.01
PERCENT: float = 100.0
BASELINE_VERSION: int = 1
SCORE_PLACES: int = 4

RUFF_COMPLEXITY_CODE: str = 'C901'
ESLINT_COMPLEXITY_RULE: str = 'complexity'
RUFF_SCORE_RE: re.Pattern[str] = re.compile(r'\((\d+) > \d+\)')
ESLINT_SCORE_RE: re.Pattern[str] = re.compile(r'complexity of (\d+)')
NAME_SEPARATOR: str = '.'
KEY_SEPARATOR: str = '::'
UNNAMED: str = 'line '
SIZE_COMMAND: str = 'size'
OVER_LIMIT: str = ' code lines, the limit is '
PLACE: str = ': '
TWO_PLACES: str = '.2f'

KEY_MESSAGE: str = 'message'
KEY_LINE: str = 'line'
KEY_LOC: str = 'loc'
KEY_START: str = 'start'
KEY_END: str = 'end'
KEY_FILES: str = 'files'
KEY_FUNCTIONS: str = 'functions'
KEY_SUMMARY: str = 'summary'
KEY_TOTALS: str = 'totals'
KEY_NUM_STATEMENTS: str = 'num_statements'
KEY_VERSION: str = 'version'
KEY_TOTAL_COVERAGE: str = 'total_coverage'
KEY_CRAP: str = 'crap'
NOT_CODE_TOKENS: frozenset[int] = frozenset(
    {tokenize.COMMENT, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT, tokenize.ENDMARKER},
)


class InputError(Exception):
    """An input file is missing or not in the expected shape."""


@dataclass(frozen=True, slots=True, kw_only=True)
class Score:
    """One function's CRAP score and the two numbers behind it.

    :ivar path:       The file, relative to the root.
    :ivar name:       The function's qualified name, or ``line N`` when no name is known.
    :ivar line:       The line the analyzer reports the function on.
    :ivar complexity: Its cyclomatic complexity.
    :ivar coverage:   Its coverage, from 0.0 to 1.0.
    """

    path: str
    name: str
    line: int
    complexity: int
    coverage: float

    @property
    def crap(self) -> float:
        """The CRAP score."""
        uncovered = 1.0 - self.coverage
        return self.complexity * self.complexity * uncovered * uncovered * uncovered + self.complexity

    @property
    def key(self) -> str:
        """The identity the baseline stores the score under."""
        return f'{self.path}{KEY_SEPARATOR}{self.name}'


@dataclass(frozen=True, slots=True)
class Span:
    """A function's name and the lines it covers.

    :ivar name:  The qualified name.
    :ivar first: The first line.
    :ivar last:  The last line.
    """

    name: str
    first: int
    last: int


@dataclass(slots=True)
class Baseline:
    """The recorded debt and coverage a change may not make worse.

    :ivar total_coverage: The total coverage recorded, in percent.
    :ivar crap:           The recorded CRAP score of every function over the threshold.
    """

    total_coverage: float = 0.0
    crap: dict[str, float] = field(default_factory=dict)


def relative(path: str, root: Path) -> str:
    """Return *path* relative to *root* in POSIX form, the shape every input is compared in.

    :param path: An absolute or root-relative path.
    :type path: str
    :param root: The project root.
    :type root: Path
    :returns:    The root-relative path, or *path* unchanged when it lies outside the root.
    :rtype: str
    """
    try:
        return (root / path).resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return Path(path).as_posix()


def read_json(path: Path) -> Any:
    """Read one JSON input.

    :param path: The file.
    :type path: Path
    :returns:    Its parsed contents.
    :rtype: Any
    :raises InputError: If it is absent or not JSON.
    """
    try:
        return json.loads(path.read_text(encoding=ENCODING))
    except (OSError, json.JSONDecodeError) as error:
        msg = f'cannot read {path}{PLACE}{error}'
        raise InputError(msg) from error


def ruff_complexity(report: list[dict[str, Any]], root: Path) -> dict[tuple[str, int], int]:
    """Return the complexity of every function in a ruff report run with ``C901`` at a maximum of 0.

    :param report: The parsed ``ruff check --output-format json`` output.
    :type report: list[dict[str, Any]]
    :param root:   The project root.
    :type root: Path
    :returns:      Complexity by file and ``def`` line.
    :rtype: dict[tuple[str, int], int]
    """
    scores: dict[tuple[str, int], int] = {}
    for item in report:
        match = RUFF_SCORE_RE.search(str(item.get(KEY_MESSAGE, '')))
        if item.get('code') == RUFF_COMPLEXITY_CODE and match:
            scores[relative(str(item['filename']), root), int(item['location']['row'])] = int(match.group(1))
    return scores


def eslint_complexity(report: list[dict[str, Any]], root: Path) -> dict[tuple[str, int], int]:
    """Return the complexity of every function in an ESLint report run with ``complexity`` at a maximum of 0.

    :param report: The parsed ``eslint --format json`` output.
    :type report: list[dict[str, Any]]
    :param root:   The project root.
    :type root: Path
    :returns:      Complexity by file and the line the function starts on.
    :rtype: dict[tuple[str, int], int]
    """
    scores: dict[tuple[str, int], int] = {}
    for result in report:
        path = relative(str(result.get('filePath', '')), root)
        for message in result.get('messages', ()):
            match = ESLINT_SCORE_RE.search(str(message.get(KEY_MESSAGE, '')))
            if message.get('ruleId') == ESLINT_COMPLEXITY_RULE and match:
                scores[path, int(message[KEY_LINE])] = int(match.group(1))
    return scores


def python_spans(source: str) -> list[Span]:
    """Return every function in a Python module under the qualified name coverage.py gives it.

    :param source: The module's text.
    :type source: str
    :returns:      One span per function, methods and nested functions included.
    :rtype: list[Span]
    """
    spans: list[Span] = []

    def visit(node: ast.AST, prefix: str) -> None:
        """Collect a span for every function under *node*, descending through classes and function bodies.

        :param node:   Syntax tree node whose children are scanned.
        :type node: ast.AST
        :param prefix: Qualified name of the enclosing class or function, ending in the name separator.
        :type prefix: str
        """
        for child in ast.iter_child_nodes(node):
            if not isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                visit(child, prefix)
                continue
            name = f'{prefix}{child.name}'
            if not isinstance(child, ast.ClassDef):
                spans.append(Span(name, child.lineno, child.end_lineno or child.lineno))
            visit(child, f'{name}{NAME_SEPARATOR}')

    visit(ast.parse(source), '')
    return spans


def fraction(covered: int, total: int) -> float:
    """Return a coverage fraction, counting nothing to cover as fully covered.

    :param covered: The units covered.
    :type covered: int
    :param total:   The units there are.
    :type total: int
    :returns:       A value from 0.0 to 1.0.
    :rtype: float
    """
    return covered / total if total else 1.0


def python_coverage(report: dict[str, Any], root: Path) -> dict[str, dict[str, float]]:
    """Return each function's coverage from a coverage.py JSON report, the lower of statements and branches.

    :param report: The parsed ``coverage json`` output, which carries ``functions`` since coverage.py 7.5.
    :type report: dict[str, Any]
    :param root:   The project root.
    :type root: Path
    :returns:      Coverage by file, then by qualified function name.
    :rtype: dict[str, dict[str, float]]
    """
    coverage: dict[str, dict[str, float]] = {}
    for path, data in report.get(KEY_FILES, {}).items():
        functions: dict[str, float] = {}
        for name, entry in data.get(KEY_FUNCTIONS, {}).items():
            summary = entry[KEY_SUMMARY]
            statements = fraction(summary['covered_lines'], summary[KEY_NUM_STATEMENTS])
            branches = fraction(summary.get('covered_branches', 0), summary.get('num_branches', 0))
            functions[name] = min(statements, branches)
        coverage[relative(path, root)] = functions
    return coverage


def _covered_share(hits: Iterable[int]) -> tuple[int, int]:
    """Count the covered entries among coverage hit counters.

    :param hits: Execution count of each statement, branch or function.
    :type hits: Iterable[int]
    :returns:    Number of counters above zero, and the number of counters.
    :rtype: tuple[int, int]
    """
    counts = list(hits)
    return sum(1 for count in counts if count > 0), len(counts)


def _start_line(location: dict[str, Any]) -> int:
    """Return the line a coverage location starts on.

    :param location: Istanbul location entry with a ``start`` position.
    :type location: dict[str, Any]
    :returns:        One-based start line.
    :rtype: int
    """
    return int(location[KEY_START][KEY_LINE])


def istanbul_functions(entry: dict[str, Any]) -> list[tuple[Span, float]]:
    """Return every function of one Istanbul file entry with its coverage, the lower of statements and branches.

    A function whose call count is 0 is uncovered, whatever its statement counters say.

    :param entry: One value of ``coverage-final.json``.
    :type entry: dict[str, Any]
    :returns:     Each function's span and coverage.
    :rtype: list[tuple[Span, float]]
    """
    result: list[tuple[Span, float]] = []
    calls = entry.get('f', {})
    for key, function in entry.get('fnMap', {}).items():
        first, last = _start_line(function[KEY_LOC]), int(function[KEY_LOC][KEY_END][KEY_LINE])
        statements = [
            entry['s'][key] for key, loc in entry.get('statementMap', {}).items() if first <= _start_line(loc) <= last
        ]
        branches = [
            hit
            for key, data in entry.get('branchMap', {}).items()
            if first <= _start_line(data[KEY_LOC]) <= last
            for hit in entry['b'][key]
        ]
        # V8-based providers such as c8 mark the line of a one-line function executed when only its definition ran,
        # so a function nobody called is uncovered whatever its statements say.
        lines_and_branches = min(fraction(*_covered_share(statements)), fraction(*_covered_share(branches)))
        coverage = lines_and_branches if calls.get(key, 1) > 0 else 0.0
        result.append((Span(str(function['name']), first, last), coverage))
    return result


def python_scores(complexity: dict[tuple[str, int], int], coverage_report: dict[str, Any], root: Path) -> list[Score]:
    """Join ruff complexity with coverage.py coverage through each function's ``def`` line.

    :param complexity:      Complexity by file and ``def`` line.
    :type complexity: dict[tuple[str, int], int]
    :param coverage_report: The parsed coverage.py JSON report.
    :type coverage_report: dict[str, Any]
    :param root:            The project root.
    :type root: Path
    :returns:               One score per function ruff reported.
    :rtype: list[Score]
    """
    coverage = python_coverage(coverage_report, root)
    scores: list[Score] = []
    for path in sorted({file for file, _ in complexity}):
        names = {span.first: span.name for span in python_spans((root / path).read_text(encoding=ENCODING))}
        covered = coverage.get(path, {})
        for (file, line), value in complexity.items():
            if file == path:
                name = names.get(line, f'{UNNAMED}{line}')
                scores.append(Score(path=path, name=name, line=line, complexity=value, coverage=covered.get(name, 0.0)))
    return scores


def istanbul_scores(complexity: dict[tuple[str, int], int], report: dict[str, Any], root: Path) -> list[Score]:
    """Join ESLint complexity with Istanbul coverage through the line each function starts on.

    :param complexity: Complexity by file and start line.
    :type complexity: dict[tuple[str, int], int]
    :param report:     The parsed ``coverage-final.json``.
    :type report: dict[str, Any]
    :param root:       The project root.
    :type root: Path
    :returns:          One score per function ESLint reported.
    :rtype: list[Score]
    """
    by_file = {relative(path, root): istanbul_functions(entry) for path, entry in report.items()}
    scores: list[Score] = []
    for (path, line), value in sorted(complexity.items()):
        functions = by_file.get(path, [])
        match = next(((span, cov) for span, cov in functions if span.first == line), None)
        name = match[0].name if match else f'{UNNAMED}{line}'
        coverage = match[1] if match else 0.0
        scores.append(Score(path=path, name=name, line=line, complexity=value, coverage=coverage))
    return scores


def python_total(report: dict[str, Any]) -> float:
    """Return the total coverage of a coverage.py JSON report, in percent.

    :param report: The parsed report.
    :type report: dict[str, Any]
    :returns:      Its ``percent_covered`` total.
    :rtype: float
    :raises InputError: If the report measured no statements, which would otherwise read as full coverage.
    """
    totals = report[KEY_TOTALS]
    if not totals.get(KEY_NUM_STATEMENTS):
        msg = 'the coverage.py report measured no statements, so the tests ran without coverage of the source'
        raise InputError(msg)
    return float(totals['percent_covered'])


def istanbul_total(report: dict[str, Any]) -> float:
    """Return the coverage of an Istanbul report, in percent: the lowest of statements, branches and functions.

    Taking the lowest keeps a V8-based report honest, since it can count the line of a function nobody called.

    :param report: The parsed ``coverage-final.json``.
    :type report: dict[str, Any]
    :returns:      The lowest of the three shares, across every file.
    :rtype: float
    :raises InputError: If the report measured no statements, which would otherwise read as full coverage.
    """
    covered, total = _covered_share(hit for entry in report.values() for hit in entry.get('s', {}).values())
    if not total:
        msg = 'the Istanbul report measured no statements, so the tests ran without coverage of the source'
        raise InputError(msg)
    branches = _covered_share(hit for entry in report.values() for hits in entry.get('b', {}).values() for hit in hits)
    functions = _covered_share(hit for entry in report.values() for hit in entry.get('f', {}).values())
    return min(covered / total, fraction(*branches), fraction(*functions)) * PERCENT


def docstring_lines(tree: ast.Module) -> set[int]:
    """Return every line that belongs to a module, class or function docstring.

    :param tree: The parsed module.
    :type tree: ast.Module
    :returns:    The line numbers.
    :rtype: set[int]
    """
    lines: set[int] = set()
    for node in ast.walk(tree):
        if not isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) or not node.body:
            continue
        first = node.body[0]
        if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant) and isinstance(first.value.value, str):
            lines.update(range(first.lineno, (first.end_lineno or first.lineno) + 1))
    return lines


def code_lines(source: str) -> set[int]:
    """Return the lines of a Python module that hold code, without blank lines, comments or docstrings.

    :param source: The module's text.
    :type source: str
    :returns:      The line numbers.
    :rtype: set[int]
    """
    lines: set[int] = set()
    for token in tokenize.generate_tokens(io.StringIO(source).readline):
        if token.type not in NOT_CODE_TOKENS:
            lines.update(range(token.start[0], token.end[0] + 1))
    return lines - docstring_lines(ast.parse(source))


def size_violations(path: Path, *, function_lines: int, file_lines: int) -> list[str]:
    """Return every function and the file itself when they hold more code lines than allowed.

    :param path:           A Python file.
    :type path: Path
    :param function_lines: The most code lines a function may hold.
    :type function_lines: int
    :param file_lines:     The most code lines the file may hold.
    :type file_lines: int
    :returns:              One message per violation.
    :rtype: list[str]
    """
    source = path.read_text(encoding=ENCODING)
    try:
        code = code_lines(source)
        spans = python_spans(source)
    except (SyntaxError, tokenize.TokenError):
        # A file that does not parse is ruff's to report. A size check that crashed here would bury that message
        # under a traceback, and the edit hook would print one after every half-finished edit.
        return []
    found = [
        f'{path}:{span.first}{PLACE}{span.name} has {count}{OVER_LIMIT}{function_lines}'
        for span in spans
        if (count := len({line for line in code if span.first <= line <= span.last})) > function_lines
    ]
    if len(code) > file_lines:
        found.append(f'{path}{PLACE}{len(code)}{OVER_LIMIT}{file_lines}')
    return found


def load_baseline(path: Path | None) -> Baseline | None:
    """Read the baseline, or return None when none is configured or it does not exist yet.

    :param path: The baseline file.
    :type path: Path | None
    :returns:    The recorded debt and coverage.
    :rtype: Baseline | None
    """
    if path is None or not path.is_file():
        return None
    data = read_json(path)
    return Baseline(
        float(data.get(KEY_TOTAL_COVERAGE, 0.0)),
        {str(key): float(score) for key, score in data.get(KEY_CRAP, {}).items()},
    )


def write_baseline(path: Path, baseline: Baseline) -> None:
    """Write the baseline with sorted keys, so a change to it reads as a small diff.

    :param path:     The baseline file.
    :type path: Path
    :param baseline: What to record.
    :type baseline: Baseline
    """
    data = {
        KEY_VERSION: BASELINE_VERSION,
        KEY_TOTAL_COVERAGE: round(baseline.total_coverage, 2),
        KEY_CRAP: baseline.crap,
    }
    path.write_text(json.dumps(data, indent=2, sort_keys=True) + '\n', encoding=ENCODING)


def crap_violations(scores: Sequence[Score], threshold: float, baseline: Baseline | None) -> list[str]:
    """Return every function over the threshold that the baseline does not already record at that score or higher.

    :param scores:    Every function's score.
    :type scores: Sequence[Score]
    :param threshold: The highest CRAP allowed.
    :type threshold: float
    :param baseline:  The recorded debt, or None.
    :type baseline: Baseline | None
    :returns:         One message per violation, worst first.
    :rtype: list[str]
    """
    recorded = baseline.crap if baseline else {}
    over = [score for score in scores if round(score.crap, SCORE_PLACES) > threshold]
    allowed = [score for score in over if round(score.crap, SCORE_PLACES) <= recorded.get(score.key, -1.0)]
    return [
        f'{score.path}:{score.line}: {score.name} CRAP {score.crap:{TWO_PLACES}} (complexity {score.complexity}, '
        f'coverage {score.coverage * PERCENT:.0f}%), the limit is {threshold:g}'
        for score in sorted(set(over) - set(allowed), key=lambda item: -item.crap)
    ]


def coverage_violations(total: float, min_coverage: float, baseline: Baseline | None) -> list[str]:
    """Return a message when the total coverage is under the floor or under what the baseline recorded.

    A baseline recorded under the floor is coverage debt: the floor is then the recorded value, which may only rise.

    :param total:        The measured total, in percent.
    :type total: float
    :param min_coverage: The floor, in percent.
    :type min_coverage: float
    :param baseline:     The recorded coverage, or None.
    :type baseline: Baseline | None
    :returns:            Zero or more messages.
    :rtype: list[str]
    """
    found = []
    if total < min_coverage and (baseline is None or baseline.total_coverage >= min_coverage):
        found.append(f'total coverage {total:{TWO_PLACES}}% is under {min_coverage:g}%')
    if baseline and total < baseline.total_coverage - COVERAGE_TOLERANCE:
        found.append(f'total coverage fell from {baseline.total_coverage:{TWO_PLACES}}% to {total:{TWO_PLACES}}%')
    return found


def improved(baseline: Baseline | None, scores: Sequence[Score], threshold: float, total: float) -> Baseline:
    """Return the baseline with only the improvements of this run applied.

    :param baseline:  The recorded state, or None for a first baseline.
    :type baseline: Baseline | None
    :param scores:    Every function's score.
    :type scores: Sequence[Score]
    :param threshold: The highest CRAP allowed.
    :type threshold: float
    :param total:     The measured total coverage, in percent.
    :type total: float
    :returns:         Debt that went down or away, and a coverage total that went up.
    :rtype: Baseline
    """
    current = {score.key: round(score.crap, SCORE_PLACES) for score in scores if score.crap > threshold}
    if baseline is None:
        return Baseline(total, current)
    debt = {key: min(value, baseline.crap[key]) for key, value in current.items() if key in baseline.crap}
    return Baseline(max(total, baseline.total_coverage), debt)


def _parser() -> argparse.ArgumentParser:
    """Build the command line parser with its ``size`` and ``crap`` subcommands.

    :returns: Parser whose required ``command`` destination names the subcommand chosen.
    :rtype: argparse.ArgumentParser
    """
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest='command', required=True)
    size = commands.add_parser(SIZE_COMMAND, help='Report Python functions and files over the code-line limits.')
    size.add_argument('paths', nargs='+', type=Path)
    size.add_argument('--function-lines', type=int, default=DEFAULT_FUNCTION_LINES)
    size.add_argument('--file-lines', type=int, default=DEFAULT_FILE_LINES)
    crap = commands.add_parser('crap', help='Report functions over the CRAP threshold and coverage under the floor.')
    crap.add_argument('--root', type=Path, default=Path.cwd())
    crap.add_argument('--ruff-json', type=Path)
    crap.add_argument('--python-coverage', type=Path)
    crap.add_argument('--eslint-json', type=Path)
    crap.add_argument('--istanbul', type=Path)
    crap.add_argument('--threshold', type=float, default=DEFAULT_THRESHOLD)
    crap.add_argument('--min-coverage', type=float, default=DEFAULT_MIN_COVERAGE)
    crap.add_argument('--baseline', type=Path)
    crap.add_argument('--update-baseline', action=STORE_TRUE)
    crap.add_argument('--skip-coverage', action=STORE_TRUE, help='The project gates coverage itself. Check CRAP only.')
    return parser


def _measure(args: argparse.Namespace) -> tuple[list[Score], float]:
    """Read whichever inputs were given and return the scores and the total coverage.

    :param args: The parsed ``crap`` arguments.
    :type args: argparse.Namespace
    :returns:    Every function's score, and the lowest total coverage among the reports.
    :rtype: tuple[list[Score], float]
    :raises InputError: If no complete pair of inputs was given.
    """
    scores: list[Score] = []
    totals: list[float] = []
    if args.ruff_json and args.python_coverage:
        report = read_json(args.python_coverage)
        scores += python_scores(ruff_complexity(read_json(args.ruff_json), args.root), report, args.root)
        totals.append(python_total(report))
    if args.eslint_json and args.istanbul:
        report = read_json(args.istanbul)
        scores += istanbul_scores(eslint_complexity(read_json(args.eslint_json), args.root), report, args.root)
        totals.append(istanbul_total(report))
    if not totals:
        msg = 'give --ruff-json with --python-coverage, or --eslint-json with --istanbul'
        raise InputError(msg)
    return scores, min(totals)


def _run_crap(args: argparse.Namespace) -> int:
    """Report the CRAP and coverage violations of one ``crap`` run, seeding or ratcheting the baseline on request.

    :param args: Parsed arguments of the ``crap`` subcommand.
    :type args: argparse.Namespace
    :returns:    Zero when the run found no violation, otherwise the violation exit status.
    :rtype: int
    """
    scores, total = _measure(args)
    baseline = load_baseline(args.baseline)
    if args.update_baseline and args.baseline and baseline is None:
        baseline = improved(None, scores, args.threshold, total)
        write_baseline(args.baseline, baseline)
        print(f'seeded {args.baseline} with {len(baseline.crap)} function(s) over the threshold')
    problems = crap_violations(scores, args.threshold, baseline)
    if not args.skip_coverage:
        problems += coverage_violations(total, args.min_coverage, baseline)
    if args.update_baseline and args.baseline and not problems:
        write_baseline(args.baseline, improved(baseline, scores, args.threshold, total))
    for problem in problems:
        print(problem, file=sys.stderr)
    print(f'{len(scores)} function(s), total coverage {total:{TWO_PLACES}}%, {len(problems)} violation(s)')
    return EXIT_VIOLATION if problems else EXIT_OK


def _run_size(args: argparse.Namespace) -> int:
    """Report the Python functions and files that exceed the code-line limits.

    :param args: Parsed arguments of the ``size`` subcommand.
    :type args: argparse.Namespace
    :returns:    Zero when nothing exceeds a limit, otherwise the violation exit status.
    :rtype: int
    """
    problems = [
        problem
        for path in args.paths
        for problem in size_violations(path, function_lines=args.function_lines, file_lines=args.file_lines)
    ]
    for problem in problems:
        print(problem, file=sys.stderr)
    return EXIT_VIOLATION if problems else EXIT_OK


def main(argv: Sequence[str] | None = None) -> int:
    """Run one subcommand.

    :param argv: Arguments, defaulting to ``sys.argv[1:]``.
    :type argv: Sequence[str] | None
    :returns:    The exit status.
    :rtype: int
    """
    args = _parser().parse_args(argv)
    try:
        return _run_size(args) if args.command == SIZE_COMMAND else _run_crap(args)
    except (InputError, OSError, SyntaxError, KeyError, ValueError) as error:
        print(f'crap_gate{PLACE}{error}', file=sys.stderr)
        return EXIT_INPUT


if __name__ == '__main__':
    sys.exit(main())
