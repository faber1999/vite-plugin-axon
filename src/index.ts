/**
 * vite-plugin-axon
 *
 * Transforms JSX attribute expressions that contain reactive calls into arrow
 * functions, so that axon's h() can pick them up as reactive props.
 *
 * Before:  class={`foo ${active() ? 'bar' : 'baz'}`}
 * After:   class={() => `foo ${active() ? 'bar' : 'baz'}`}
 *
 * Before:  disabled={isDisabled()}
 * After:   disabled={() => isDisabled()}
 *
 * Rules:
 *   - Only JSX attributes (not children — those are already functions in signal patterns)
 *   - Skip event handlers (on*)
 *   - Skip expressions that are already arrow functions or function expressions
 *   - Only wrap when the expression contains at least one CallExpression
 */

import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import _generate from '@babel/generator';
import * as t from '@babel/types';
import type { Plugin } from 'vite';

// Babel's ESM interop
const traverse = (_traverse as unknown as { default: typeof _traverse }).default ?? _traverse;
const generate = (_generate as unknown as { default: typeof _generate }).default ?? _generate;

/**
 * Returns true if the node (or any descendant) is a CallExpression.
 */
function containsCall(node: t.Node): boolean {
  if (t.isCallExpression(node)) return true;

  // Manually walk the most common expression nodes
  if (t.isTemplateLiteral(node)) {
    return node.expressions.some(expr => containsCall(expr));
  }
  if (t.isConditionalExpression(node)) {
    return containsCall(node.test) || containsCall(node.consequent) || containsCall(node.alternate);
  }
  if (t.isLogicalExpression(node) || t.isBinaryExpression(node)) {
    return containsCall(node.left) || containsCall(node.right);
  }
  if (t.isUnaryExpression(node)) {
    return containsCall(node.argument);
  }
  if (t.isMemberExpression(node)) {
    return containsCall(node.object);
  }
  if (t.isArrayExpression(node)) {
    return node.elements.some(el => el != null && containsCall(el));
  }
  if (t.isObjectExpression(node)) {
    return node.properties.some(prop => {
      if (t.isObjectProperty(prop)) return containsCall(prop.value as t.Node);
      return false;
    });
  }

  return false;
}

/**
 * Returns true when we should NOT wrap this attribute.
 *   - Event handlers: onClick, onInput, …
 *   - Already a function: () => …, function() {}
 *   - ref prop
 */
function shouldSkip(attrName: string, valueNode: t.Node): boolean {
  if (attrName.startsWith('on') && attrName.length > 2) return true;
  if (attrName === 'ref') return true;
  if (t.isArrowFunctionExpression(valueNode)) return true;
  if (t.isFunctionExpression(valueNode)) return true;
  return false;
}

export default function axonPlugin(): Plugin {
  return {
    name: 'vite-plugin-axon',
    enforce: 'pre',

    config() {
      return {
        esbuild: {
          jsxFactory: 'h',
          jsxFragment: 'Fragment',
          jsxInject: `import { h, Fragment } from '@faber1999/axon.js/jsx'`,
        },
      };
    },

    transform(code: string, id: string) {
      // Only process JSX/TSX files
      if (!id.endsWith('.jsx') && !id.endsWith('.tsx')) return null;

      let ast: ReturnType<typeof parse>;
      try {
        ast = parse(code, {
          sourceType: 'module',
          plugins: ['jsx', 'typescript'],
        });
      } catch {
        // If parsing fails, let Vite/esbuild handle it
        return null;
      }

      let changed = false;

      traverse(ast, {
        JSXAttribute(path) {
          const { name, value } = path.node;

          // Attribute name (handles both Identifier and NamespacedName)
          const attrName = t.isJSXIdentifier(name)
            ? name.name
            : `${name.namespace.name}:${name.name.name}`;

          // We only care about JSXExpressionContainer values (i.e. {expr})
          if (!t.isJSXExpressionContainer(value)) return;

          const expr = value.expression;

          // JSXEmptyExpression → nothing to do
          if (t.isJSXEmptyExpression(expr)) return;

          if (shouldSkip(attrName, expr)) return;
          if (!containsCall(expr)) return;

          // Wrap: {expr} → {() => expr}
          value.expression = t.arrowFunctionExpression([], expr);
          changed = true;
        },
      });

      if (!changed) return null;

      const result = generate(ast, { retainLines: true }, code);
      return { code: result.code, map: result.map };
    },
  };
}
