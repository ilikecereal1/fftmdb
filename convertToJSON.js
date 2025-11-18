// from ChatGPT because I was too lazy to code this myself, don't flame me if you find this script in this repository
const fs = require("fs");
const path = require("path");
const acorn = require("acorn");

const INPUT_DIR = path.resolve(__dirname, "raw-data");
const OUTPUT_DIR = path.resolve(__dirname, "fixed-json");

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

/**
 * Convert an acorn AST node into a real JS value (without using eval).
 * Supports: ObjectExpression, ArrayExpression, Literal, Identifier (null/true/false), UnaryExpression.
 */
function astToValue(node) {
  if (!node) return undefined;

  switch (node.type) {
    case "Literal":
      return node.value;

    case "ObjectExpression": {
      const obj = {};
      for (const prop of node.properties) {
        if (prop.type === "SpreadElement") {
          // not supported in source; skip
          continue;
        }
        // property key can be Identifier, Literal, or Expression
        let key;
        if (prop.key.type === "Identifier") key = prop.key.name;
        else if (prop.key.type === "Literal") key = String(prop.key.value);
        else key = String(astToValue(prop.key));

        // value
        let valueNode = prop.value;
        // Handle shorthand { foo } -> { foo: foo } (not likely in raw data but safe)
        if (prop.shorthand && valueNode.type === "Identifier") {
          // produce identifier string (can't resolve runtime value) -> null
          obj[key] = null;
        } else {
          obj[key] = astToValue(valueNode);
        }
      }
      return obj;
    }

    case "ArrayExpression":
      return node.elements.map(el => (el === null ? null : astToValue(el)));

    case "UnaryExpression": {
      // handles negative numbers like -123
      const val = astToValue(node.argument);
      switch (node.operator) {
        case "-":
          return typeof val === "number" ? -val : -Number(val);
        case "+":
          return +val;
        case "!":
          return !val;
        default:
          return undefined;
      }
    }

    case "Identifier":
      // Common JS literals that are not quoted in your files: true, false, null, undefined
      if (node.name === "undefined") return null;
      if (node.name === "null") return null;
      if (node.name === "true") return true;
      if (node.name === "false") return false;
      // otherwise return name as string (fallback)
      return node.name;

    case "TemplateLiteral": {
      // join quasi/quasis and expressions (expressions may be unsupported) - ChatGPT
      // i have no clue what this ai is yapping about
      let out = "";
      for (let i = 0; i < node.quasis.length; i++) {
        out += node.quasis[i].value.cooked;
        if (i < node.expressions.length) {
          const ev = astToValue(node.expressions[i]);
          out += String(ev);
        }
      }
      return out;
    }

    case "CallExpression":
      // Not supported - return null
      return null;

    default:
      // Unknown/unsupported node type -> null (safer than eval)
      return null;
  }
}

/**
 * Try parsing a text as a JS expression using acorn, and convert AST -> value.
 * We wrap the input in parentheses so object/array top-level expressions are parsed.
 */
function parseJsLikeText(text) {
  // Trim BOM and whitespace
  const src = text.trim();

  // Try direct parse as expression by wrapping in parens
  const wrapped = `(${src})`;

  const ast = acorn.parse(wrapped, { ecmaVersion: "latest" });

  // ast.body[0] should be an ExpressionStatement whose expression is what we want
  if (
    !ast ||
    !ast.body ||
    ast.body.length === 0 ||
    ast.body[0].type !== "ExpressionStatement"
  ) {
    throw new Error("Unexpected AST structure");
  }

  const expr = ast.body[0].expression;
  return astToValue(expr);
}

/**
 * Fallback: try to transform JS-style to JSON-ish using regex:
 * - quote object keys
 * - convert single quotes to double quotes (careful with nested)
 * - remove trailing commas
 * Use only if AST parse fails.
 */
function naiveFixToJson(text) {
  let s = text.trim();

  // Remove JS comments
  s = s.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//gm, "");

  // Replace single quotes with double quotes for strings.
  // But avoid replacing single quotes inside already double-quoted strings (simple approach)
  s = s.replace(/'([^']*)'/g, (m, p1) => {
    // escape existing double quotes in p1
    return `"${p1.replace(/"/g, '\\"')}"`;
  });

  // Quote unquoted keys: { key: -> { "key":
  s = s.replace(/([{,]\s*)([a-zA-Z0-9_$-]+)\s*:/g, '$1"$2":');

  // Remove trailing commas before } or ]
  s = s.replace(/,(\s*[}\]])/g, "$1");

  return s;
}

function processFile(filePath, outputDir) {
  const filename = path.basename(filePath);
  const text = fs.readFileSync(filePath, "utf8");

  // If the response is an axios-like object dump (e.g., "Object { data: \"[...\" }")
  // try to extract the actual data JSON-ish part:
  let trimmed = text.trim();

  // If file contains something like data: "..." we try to extract inner string content
  const dataMatch = trimmed.match(/data\s*:\s*("|\')([\s\S]*)\1/);
  let candidate = trimmed;
  if (dataMatch && dataMatch[2]) {
    candidate = dataMatch[2];
    // Unescape common escaped newlines
    candidate = candidate.replace(/\\n/g, "\n");
  } else {
    // If the content looks like it's the whole string with quotes at start and end
    if ((candidate.startsWith('"') && candidate.endsWith('"')) || (candidate.startsWith("'") && candidate.endsWith("'"))) {
      candidate = candidate.slice(1, -1).replace(/\\n/g, "\n");
    }
  }

  try {
    const value = parseJsLikeText(candidate);
    const outPath = path.join(outputDir, filename);
    fs.writeFileSync(outPath, JSON.stringify(value, null, 2), "utf8");
    console.log(`Converted → ${filename}`);
  } catch (err) {
    console.warn(`Parser failed for ${filename}: ${err.message}`);
    // Try naive regex approach then JSON.parse
    try {
      const maybeJson = naiveFixToJson(candidate);
      const value = JSON.parse(maybeJson);
      const outPath = path.join(outputDir, filename);
      fs.writeFileSync(outPath, JSON.stringify(value, null, 2), "utf8");
      console.log(`Fallback converted → ${filename}`);
    } catch (err2) {
      console.error(`Failed parsing ${filename}: ${err2.message}`);
      // Save original for inspection
      const badPath = path.join(outputDir, filename + ".bad.txt");
      fs.writeFileSync(badPath, text, "utf8");
      console.error(`Saved original to ${badPath}`);
    }
  }
}

function processDirectory(inputDir, outputDir) {
  const files = fs.readdirSync(inputDir);
  for (const f of files) {
    const p = path.join(inputDir, f);
    const stat = fs.statSync(p);
    if (stat.isFile()) {
      processFile(p, outputDir);
    } else {
      // skip directories for now
    }
  }
}

processDirectory(INPUT_DIR, OUTPUT_DIR);