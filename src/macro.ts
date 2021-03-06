// Packages
import { NodePath } from '@babel/core';
import * as t from '@babel/types';
// @ts-expect-error
import * as importHelpers from '@babel/helper-module-imports';
import { createMacro, MacroHandler } from 'babel-plugin-macros';
import traverse from '@babel/traverse';

// Ours
import { resolveTokens } from './tokens';
import { StyledMacro } from './types';
import { DEFAULT_VARIANT } from './utils/defaultVariant';

const importUtil = (path: string) => {
	return `react-native-styled.macro/build/module/utils/${path}`;
};

const transformRem = (program: NodePath<t.Node>) => {
	traverse(program.parent, {
		StringLiteral: (path) => {
			if (!t.isObjectProperty(path.parent)) {
				return;
			}

			// Transform values only
			if (!t.isNodesEquivalent(path.parent.value, path.node)) {
				return;
			}

			const { value } = path.node;

			// Replace Rem values with function calls
			if (value.match(/rem/)) {
				const remValue = parseFloat(value.replace(/rem|\(|\)/g, ''));

				// => { style: rem(number) }
				path.replaceWith(
					t.callExpression(
						importHelpers.addNamed(program, 'rem', importUtil('rem')),
						[t.numericLiteral(remValue)]
					)
				);
			}
		},
	});
};

const createStyleSheet = (
	program: NodePath<t.Node>,
	stylesId: t.Identifier,
	styles: Record<string, Record<string, any>>
) => {
	// Use StyleSheet.create
	// => const styles = StyleSheet.create({...})
	const stylesheet = t.variableDeclaration('const', [
		t.variableDeclarator(
			stylesId,
			t.callExpression(
				t.memberExpression(
					importHelpers.addNamed(program, 'StyleSheet', 'react-native'),
					t.identifier('create')
				),
				[t.valueToNode(styles)]
			)
		),
	]);

	// Create stylesheet
	// => const styles = StyleSheet.create({...})
	program.unshiftContainer('body' as any, stylesheet);
};

const styledMacro: MacroHandler = ({ references, state }) => {
	const program = state.file.path;

	// A map that holds the key/value pairs of the generated styles.
	const styles: Record<string, Record<string, any>> = {};

	// Variable name to be used later with StyleSheet.create
	const stylesId = program.scope.generateUidIdentifier('styles');

	references.default?.forEach((refPath) => {
		if (!t.isCallExpression(refPath.parent)) {
			return;
		}

		// Get the call expression
		const callExpr = refPath.parent;

		// Parse token argument
		const tokensArg = callExpr.arguments[0];

		// tokens must be an array of strings
		if (!t.isArrayExpression(tokensArg)) {
			return;
		}

		const tokens = tokensArg.elements.map((el) => {
			if (!t.isStringLiteral(el)) {
				throw refPath.buildCodeFrameError(
					'expected styled to be called with a list of string ' +
						'literals. Found: ' +
						el?.type
				);
			}

			return el.value;
		});

		// Avoid wrapping styles around select(..) call if we only have
		// defautl variant styles.
		let shouldUseSelect = false;

		try {
			// Resolve styles
			callExpr.arguments[0] = t.arrayExpression(
				resolveTokens(tokens).map((style) => {
					if (style.variant !== DEFAULT_VARIANT) {
						shouldUseSelect = true;
					}

					// Generate an Id to be used as a key in the StyleSheet
					// later.
					const styleId = program.scope.generateUidIdentifier(
						style.variant
					);

					styles[styleId.name] = style.style;

					return t.objectExpression([
						// => { vairant: style.variant }
						t.objectProperty(
							t.identifier('variant'),
							t.stringLiteral(style.variant)
						),
						// => { style: styles.styleId }
						t.objectProperty(
							t.identifier('style'),
							t.memberExpression(stylesId, styleId)
						),
					]);
				})
			);
		} catch (error) {
			throw refPath.buildCodeFrameError(error.message);
		}

		if (!shouldUseSelect) {
			// We know for sure there is exactly one element (if any)
			const defaultStyle = callExpr.arguments[0]
				.elements[0] as t.ObjectExpression;

			// => { style: defaultStyle , ... }
			refPath.parentPath.replaceWith(
				t.objectExpression(
					defaultStyle ? [defaultStyle.properties[1]] : []
				)
			);

			return;
		}

		// Import StyleUtils.select
		// => import { select } from 'path/to/util';
		//    select([...], ...)
		callExpr.callee = importHelpers.addNamed(
			program,
			'select',
			importUtil('select')
		);
	});

	// Inject generated styles to the module
	if (Object.keys(styles).length > 0) {
		createStyleSheet(program, stylesId, styles);

		// Convert Rem string literals to function calls
		transformRem(program);
	}
};

export default createMacro(styledMacro) as StyledMacro;
