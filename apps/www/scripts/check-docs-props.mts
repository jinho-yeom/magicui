import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { Node, Project, SyntaxKind } from "ts-morph"
import type { SourceFile } from "ts-morph"

// Fails when the "Default" column of a docs Props table disagrees with the
// default in the component source (registry/magicui/<name>.tsx).
//
// A row is checked when the component destructures that prop with a literal
// default. Free text in the Default column, e.g. "See below", is not checked.

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const docsRoot = path.join(appRoot, "content/docs/components")
const componentsRoot = path.join(appRoot, "registry/magicui")

const LITERAL_KINDS = new Set([
  SyntaxKind.StringLiteral,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.NumericLiteral,
  SyntaxKind.PrefixUnaryExpression,
  SyntaxKind.TrueKeyword,
  SyntaxKind.FalseKeyword,
  SyntaxKind.NullKeyword,
  SyntaxKind.ArrayLiteralExpression,
  SyntaxKind.ObjectLiteralExpression,
])
const NO_DEFAULT = new Set(["", "-", "—", "undefined"])
const UNESCAPED_PIPE = /(?<!\\)\|/
const VALUE_LIKE = /^(`.*`|-?[\d.]+|true|false|null|".*"|'.*')$/
const INSIGNIFICANT = /[`'"\\]|,(?=[}\]])|(?<=\d)_(?=\d)/g
const WHITESPACE = /\s+/g

// Quotes, spacing and trailing commas are not meaningful differences.
function normalize(value: string) {
  const stripped = value.replace(WHITESPACE, "").replace(INSIGNIFICANT, "")
  return NO_DEFAULT.has(stripped) ? "" : stripped
}

// Prop name -> the literal defaults it is destructured with in the file.
function readSourceDefaults(sourceFile: SourceFile) {
  const defaults = new Map<string, Set<string>>()

  for (const binding of sourceFile.getDescendantsOfKind(
    SyntaxKind.BindingElement
  )) {
    const name = (
      binding.getPropertyNameNode() ?? binding.getNameNode()
    ).getText()
    const values = defaults.get(name) ?? new Set<string>()
    let value = binding.getInitializer()
    if (Node.isIdentifier(value)) {
      // Follow a module constant such as DEFAULT_SIZE to its value. The docs
      // may name the constant instead of repeating a long value.
      values.add(value.getText())
      value = sourceFile
        .getVariableDeclaration(value.getText())
        ?.getInitializer()
    }
    if (value && LITERAL_KINDS.has(value.getKind())) {
      defaults.set(name, values.add(value.getText().replace(WHITESPACE, " ")))
    }
  }

  return defaults
}

// The prop name and Default cell of every row of every Props table.
function readDocRows(text: string) {
  const rows: { line: number; prop: string; value: string }[] = []
  let columns: { prop: number; value: number } | null = null

  for (const [index, line] of text.split("\n").entries()) {
    if (!line.startsWith("|")) {
      columns = null
      continue
    }
    const cells = line
      .split(UNESCAPED_PIPE)
      .slice(1, -1)
      .map((cell) => cell.trim())
    if (columns === null) {
      const header = cells.map((cell) => cell.toLowerCase())
      columns = {
        prop: header.findIndex((cell) => cell.startsWith("prop")),
        value: header.indexOf("default"),
      }
    } else if (columns.prop !== -1 && columns.value !== -1) {
      rows.push({
        line: index + 1,
        prop: (cells.at(columns.prop) ?? "").replace(INSIGNIFICANT, ""),
        value: cells.at(columns.value) ?? "",
      })
    }
  }

  return rows
}

function checkDocsProps() {
  const project = new Project({ skipAddingFilesFromTsConfig: true })
  const problems: string[] = []

  for (const entry of readdirSync(docsRoot).sort()) {
    const sourceFile = project.addSourceFileAtPathIfExists(
      path.join(componentsRoot, entry.replace(".mdx", ".tsx"))
    )
    if (!(entry.endsWith(".mdx") && sourceFile)) {
      continue
    }
    const defaults = readSourceDefaults(sourceFile)
    const text = readFileSync(path.join(docsRoot, entry), "utf8")

    for (const row of readDocRows(text)) {
      const expected = [...(defaults.get(row.prop) ?? [])]
      const isChecked = VALUE_LIKE.test(row.value) || NO_DEFAULT.has(row.value)
      const matches = expected.some(
        (value) => normalize(value) === normalize(row.value)
      )
      if (expected.length > 0 && isChecked && !matches) {
        problems.push(
          `  content/docs/components/${entry}:${row.line}  \`${row.prop}\`: docs say ${row.value}, source default is ${expected.join(" or ")}`
        )
      }
    }
  }

  return problems
}

const problems = checkDocsProps()

if (problems.length > 0) {
  console.error("docs Props tables do not match the component source:")
  console.error(problems.join("\n"))
  console.error(
    "Update the Default column to match registry/magicui/<name>.tsx."
  )
  process.exit(1)
}

console.log("docs Props tables match the component source")
