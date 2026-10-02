/**
 * @fileoverview
 * @summary Lists the public members of interfaces, classes and object types whose TSDoc block is missing or incomplete.
 * @description
 * The project convention is that every public member has its own `/** *\/`
 * block (docs/PLAN.md, principle 5). A description on the parent does not
 * count. This script parses every source file in `packages/*\/src` with the
 * TypeScript compiler API and checks each member.
 *
 * ```text
 *   checked                                         not checked
 *   interface and type-literal members              members of non-exported, @internal declarations
 *   class properties, methods, accessors            #private and `private` members
 *   constructors and their parameter properties     function parameters, local types
 *   enum members
 *
 *   a complete block has                            for
 *   a @summary                                      every member
 *   a @param for each parameter                     methods and accessors
 *   a @returns when the result is not void          methods and accessors
 *   ```
 *
 * Run it with `pnpm check:docs`. `pnpm check` also runs it. It prints one
 * `file:line member: problem` line for each member, and exits with code 1
 * when it finds a problem.
 *
 * @example
 * Check every package
 * ```ts
 * // pnpm check:docs
 * // packages/core/src/unit.ts:220 UnitContext.id: no @summary
 * // 1 public member(s) with a missing or incomplete TSDoc block.
 * ```
 *
 * @author MathAid
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import ts from 'typescript';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

/** @summary Every `.ts` file under a directory, recursively. */
function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith('.ts') && !path.endsWith('.d.ts') ? [path] : [];
  });
}

/**
 * @summary Says what is wrong with a member's TSDoc block, or returns `null` when it is complete.
 * @description A complete block starts with `/**` and has a `@summary`. For a
 * method, it also has one `@param` for each parameter, and `@returns` when the
 * method returns a value other than `void`.
 */
function problem(node: ts.Node, text: string): string | null {
  const ranges = ts.getLeadingCommentRanges(text, node.getFullStart()) ?? [];
  const block = ranges
    .filter((r) => text.startsWith('/**', r.pos))
    .map((r) => text.slice(r.pos, r.end))
    .at(-1);
  if (!block) return 'no TSDoc block';
  if (!/@summary\b/.test(block)) return 'no @summary';
  const signature =
    ts.isMethodSignature(node) || ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node)
      ? node
      : null;
  if (signature) {
    for (const parameter of signature.parameters) {
      const name = parameter.name.getText();
      if (!new RegExp(`@param\\s+(\\{[^}]*\\}\\s+)?\\[?${name}\\b`).test(block)) {
        return `no @param for ${name}`;
      }
    }
    const returns = signature.type?.getText();
    const returnsValue =
      ts.isGetAccessorDeclaration(signature) ||
      (returns !== undefined && returns !== 'void' && returns !== 'Promise<void>');
    if (returnsValue && !/@returns?\b/.test(block)) return 'no @returns';
  }
  return null;
}

/** @summary Whether a declaration is marked `@internal` in its own block. */
function internal(node: ts.Node, text: string): boolean {
  const ranges = ts.getLeadingCommentRanges(text, node.getFullStart()) ?? [];
  return ranges.some((r) => /@internal\b/.test(text.slice(r.pos, r.end)));
}

const exported = (node: ts.Node) =>
  ts.canHaveModifiers(node) &&
  (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

const hidden = (node: ts.Node) =>
  (ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : []).some(
    (m) => m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword,
  ) ||
  ((ts.isPropertyDeclaration(node) || ts.isMethodDeclaration(node)) &&
    ts.isPrivateIdentifier(node.name));

const missing: string[] = [];

const files = readdirSync(join(root, 'packages'))
  .map((name) => join(root, 'packages', name, 'src'))
  .filter((src) => statSync(src, { throwIfNoEntry: false })?.isDirectory())
  .flatMap(sources);

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const report = (node: ts.Node, name: string) => {
    const issue = problem(node, text);
    if (issue === null) return;
    const { line } = source.getLineAndCharacterOfPosition(node.getStart());
    missing.push(`${relative(root, file).replace(/\\/g, '/')}:${line + 1} ${name}: ${issue}`);
  };

  /** Checks the members of an object type, recursing into nested object types. */
  const members = (owner: string, list: ts.NodeArray<ts.TypeElement>) => {
    for (const member of list) {
      const name = member.name ? member.name.getText(source) : '[signature]';
      if (ts.isCallSignatureDeclaration(member) || ts.isIndexSignatureDeclaration(member)) {
        continue;
      }
      report(member, `${owner}.${name}`);
      const type = (member as ts.PropertySignature).type;
      if (type) nested(`${owner}.${name}`, type);
    }
  };
  const nested = (owner: string, type: ts.TypeNode) => {
    if (ts.isTypeLiteralNode(type)) members(owner, type.members);
    else if (ts.isIntersectionTypeNode(type) || ts.isUnionTypeNode(type)) {
      for (const part of type.types) nested(owner, part);
    } else if (ts.isParenthesizedTypeNode(type)) nested(owner, type.type);
  };

  for (const statement of source.statements) {
    if (!exported(statement) || internal(statement, text)) continue;
    if (ts.isInterfaceDeclaration(statement)) {
      members(statement.name.text, statement.members);
    } else if (ts.isTypeAliasDeclaration(statement)) {
      nested(statement.name.text, statement.type);
    } else if (ts.isEnumDeclaration(statement)) {
      for (const member of statement.members) {
        report(member, `${statement.name.text}.${member.name.getText(source)}`);
      }
    } else if (ts.isClassDeclaration(statement) && statement.name) {
      const owner = statement.name.text;
      for (const member of statement.members) {
        if (hidden(member) || ts.isClassStaticBlockDeclaration(member)) continue;
        if (ts.isConstructorDeclaration(member)) {
          report(member, `${owner}.constructor`);
          for (const parameter of member.parameters) {
            const isProperty = (ts.getModifiers(parameter) ?? []).some(
              (m) =>
                m.kind === ts.SyntaxKind.ReadonlyKeyword || m.kind === ts.SyntaxKind.PublicKeyword,
            );
            if (isProperty && !hidden(parameter)) {
              report(parameter, `${owner}.${parameter.name.getText(source)}`);
            }
          }
          continue;
        }
        if (ts.isSemicolonClassElement(member)) continue;
        const name = member.name ? member.name.getText(source) : '[member]';
        // Overloads: only the first signature of a run needs the block.
        report(member, `${owner}.${name}`);
      }
    }
  }
}

for (const line of missing) console.log(line);
console.log(`${missing.length} public member(s) with a missing or incomplete TSDoc block.`);
process.exit(missing.length > 0 ? 1 : 0);
