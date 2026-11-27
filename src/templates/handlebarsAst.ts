/**
 * The node types of a parsed Handlebars template, under names this plugin
 * imports.
 *
 * The handlebars package declares its syntax tree in a global `hbs` namespace
 * rather than exporting it, so the one reference to that global lives here
 * and every reader of a parsed template imports plain type names instead.
 * @module templates/handlebarsAst
 */

/* global hbs -- declared by the handlebars package's own typings */

/** A whole template, or the body of a block. */
export type AstProgram = hbs.AST.Program;
/** Any node, for its location. */
export type AstNode = hbs.AST.Node;
/** One top-level piece of a program. */
export type AstStatement = hbs.AST.Statement;
/** `{{name args}}`. */
export type AstMustache = hbs.AST.MustacheStatement;
/** `{{#name args}}...{{/name}}`. */
export type AstBlock = hbs.AST.BlockStatement;
/** An argument, a hash value, or the callee of a call. */
export type AstExpression = hbs.AST.Expression;
/** `(helper args)` nested in a call. */
export type AstSubExpression = hbs.AST.SubExpression;
/** A name or dotted path, such as `title` or `../turns.length`. */
export type AstPath = hbs.AST.PathExpression;
/** The `key=value` arguments of a call. */
export type AstHash = hbs.AST.Hash;
/** `"text"`, as an argument or a hash value. */
export type AstStringLiteral = hbs.AST.StringLiteral;
/** `3`, as an argument or a hash value. */
export type AstNumberLiteral = hbs.AST.NumberLiteral;
/** `true` or `false`, as an argument or a hash value. */
export type AstBooleanLiteral = hbs.AST.BooleanLiteral;
/** Literal text between the braces. */
export type AstContent = hbs.AST.ContentStatement;
