import {
	TDefinitionsObject,
	TNonArrayItemsObject,
	TOperationObject,
	TPathItemObject,
	TPathParameterObject,
	TPathsObject,
	TQueryParameterObject,
	TResponseObject,
	TResponsesObject,
	TSchemaObject,
	TSwaggerObject,
} from './swagger';
import { directory, file, TDirectory, TFile } from './fs';
import { array, catOptions, flatten, uniq } from 'fp-ts/lib/Array';
import { contramap, Setoid, setoidString } from 'fp-ts/lib/Setoid';
import { group, groupBy } from 'fp-ts/lib/NonEmptyArray';
import { getOperationParametersInPath, getOperationParametersInQuery, groupPathsByTag } from './utils';
import { fromNullable, none, Option, some } from 'fp-ts/lib/Option';
import { getArrayMonoid, getRecordMonoid, monoidString, fold } from 'fp-ts/lib/Monoid';
import { camelize } from '@devexperts/utils/dist/string/string';
import { intercalate } from 'fp-ts/lib/Foldable2v';
import { collect, lookup } from 'fp-ts/lib/Record';

// TFSEntity serializers
type TDepdendency = {
	path: string;
	name: string;
};
type TSerialized = {
	content: string;
	dependencies: TDepdendency[];
};

const monoidDependencies = getArrayMonoid<TDepdendency>();
const monoidSerialized = getRecordMonoid<TSerialized>({
	content: monoidString,
	dependencies: monoidDependencies,
});
const foldSerialized = fold(monoidSerialized);
const foldDependencies = fold(monoidDependencies);
const intercalateSerialized = intercalate(monoidSerialized, array);
const uniqString = uniq(setoidString);

export const serializeSwaggerObject = (name: string, swaggerObject: TSwaggerObject): TDirectory =>
	directory(name, [
		directory('client', [file('client.ts', client)]),
		...catOptions([swaggerObject.definitions.map(serializeDefinitions)]),
		serializePaths(swaggerObject.paths),
	]);

const serializeDefinitions = (definitions: TDefinitionsObject): TDirectory =>
	directory('definitions', [...serializeDictionary(definitions, serializeDefinition)]);
const serializePaths = (paths: TPathsObject): TDirectory =>
	directory('paths', serializeDictionary(groupPathsByTag(paths), serializePathGroup));

const serializeDefinition = (name: string, definition: TSchemaObject): TFile => {
	const serialized = serializeSchemaObjectType(definition, './');
	const serializedIO = serializeIOSchemaObjectType(definition);

	const dependencies = serializeDependencies([
		...serialized.dependencies,
		...serializedIO.dependencies,
		{
			name: 'Option',
			path: 'fp-ts/lib/Option',
		},
		{
			name: 'createOptionFromNullable',
			path: 'io-ts-types',
		},
	]);

	return file(
		`${name}.ts`,
		`
		import * as t from 'io-ts';
		${dependencies}
		
		export type ${name} = ${serialized.content};
		export const ${getIOName(name)} = ${serializedIO.content};
	`,
	);
};

const serializePathGroup = (name: string, group: Record<string, TPathItemObject>): TFile => {
	const serializedType = foldSerialized(serializeDictionary(group, serializePathType));
	const serializedIO = foldSerialized(serializeDictionary(group, serializePathIO));
	const dependencies = serializeDependencies([
		...serializedType.dependencies,
		...serializedIO.dependencies,
		{
			name: 'asks',
			path: 'fp-ts/lib/Reader',
		},
		{
			name: 'TAPIClient',
			path: '../client/client',
		},
	]);
	const groupName = name || 'Unknown';
	return file(
		`${groupName}.ts`,
		`
			${dependencies}
		
			export type ${groupName} = {
				${serializedType.content}
			};
			
			export const ${camelize(groupName, true)} = asks((e: { apiClient: TAPIClient }): ${groupName} => ({
				${serializedIO.content}
			}));
		`,
	);
};
const serializePathType = (path: string, item: TPathItemObject): TSerialized => {
	const get = item.get.map(operation => serializeOperationObjectType(path, 'GET', operation));
	const put = item.put.map(operation => serializeOperationObjectType(path, 'PUT', operation));
	const post = item.post.map(operation => serializeOperationObjectType(path, 'POST', operation));
	const remove = item['delete'].map(operation => serializeOperationObjectType(path, 'DELETE', operation));
	const options = item.options.map(operation => serializeOperationObjectType(path, 'OPTIONS', operation));
	const head = item.head.map(operation => serializeOperationObjectType(path, 'HEAD', operation));
	const patch = item.patch.map(operation => serializeOperationObjectType(path, 'PATCH', operation));
	const operations = catOptions([get, put, post, remove, options, head, patch]);
	return foldSerialized(operations);
};

const serializePathIO = (path: string, item: TPathItemObject): TSerialized => {
	const get = item.get.map(operation => serializeOperationObjectIO(path, 'GET', operation));
	const put = item.put.map(operation => serializeOperationObjectIO(path, 'PUT', operation));
	const post = item.post.map(operation => serializeOperationObjectIO(path, 'POST', operation));
	const remove = item['delete'].map(operation => serializeOperationObjectIO(path, 'DELETE', operation));
	const options = item.options.map(operation => serializeOperationObjectIO(path, 'OPTIONS', operation));
	const head = item.head.map(operation => serializeOperationObjectIO(path, 'HEAD', operation));
	const patch = item.patch.map(operation => serializeOperationObjectIO(path, 'PATCH', operation));
	const operations = catOptions([get, put, post, remove, options, head, patch]);
	return foldSerialized(operations);
};

// string serializers

const serializeSchemaObjectType = (schema: TSchemaObject, relative: string): TSerialized => {
	switch (schema.type) {
		case undefined: {
			const reference = `${schema.$ref.replace(/^#\/definitions\//g, '')}`;
			return {
				content: reference,
				dependencies: [{ path: `${relative}${reference}`, name: reference }],
			};
		}
		case 'string': {
			return {
				content: schema.enum.map(serializeEnum).getOrElse('string'),
				dependencies: [],
			};
		}
		case 'boolean':
		case 'number': {
			return {
				content: schema.type,
				dependencies: [],
			};
		}
		case 'integer': {
			return {
				content: 'number',
				dependencies: [],
			};
		}
		case 'array': {
			const result = serializeSchemaObjectType(schema.items, relative);
			return {
				content: `Array<${result.content}>`,
				dependencies: result.dependencies,
			};
		}
		case 'object': {
			const additional = schema.additionalProperties.map(additionalProperties =>
				serializeAdditionalProperties(additionalProperties, relative),
			);
			const serialized = additional.orElse(() =>
				schema.properties.map(properties => {
					const fields = serializeDictionary(properties, (name, value) => {
						const serialized = serializeField(
							name,
							value,
							schema.required.map(required => required.includes(name)).getOrElse(false),
							relative,
						);
						return {
							content: `${serialized.content};`,
							dependencies: serialized.dependencies,
						};
					});
					const content = `{ ${fields.map(field => field.content).join('')} }`;
					const dependencies = flatten(fields.map(field => field.dependencies || []));
					return {
						content,
						dependencies,
					};
				}),
			);
			return {
				content: serialized.map(serialized => serialized.content).getOrElse('{}'),
				dependencies: serialized.map(serialized => serialized.dependencies).getOrElse([]),
			};
		}
	}
};

const serializeIOSchemaObjectType = (schema: TSchemaObject): TSerialized => {
	switch (schema.type) {
		case undefined: {
			const reference = `${schema.$ref.replace(/^#\/definitions\//g, '')}`;
			const name = getIOName(reference);
			return {
				content: name,
				dependencies: [{ path: `./${reference}`, name: name }],
			};
		}
		case 'string': {
			return {
				content: schema.enum.map(serializeIOEnum).getOrElse('t.string'),
				dependencies: [],
			};
		}
		case 'boolean': {
			return {
				content: 't.boolean',
				dependencies: [],
			};
		}
		case 'integer':
		case 'number': {
			return {
				content: 't.number',
				dependencies: [],
			};
		}
		case 'array': {
			const result = serializeIOSchemaObjectType(schema.items);
			return {
				content: `t.array(${result.content})`,
				dependencies: result.dependencies,
			};
		}
		case 'object': {
			const additional = schema.additionalProperties.map(serializeIOAdditionalProperties);
			const serialized = additional.orElse(() =>
				schema.properties.map(properties => {
					const fields = serializeDictionary(properties, (name, value) =>
						serializeIOField(
							name,
							value,
							schema.required.map(required => required.includes(name)).getOrElse(false),
						),
					);
					const content = `t.type({ ${fields.map(field => field.content).join('')} })`;
					const dependencies = flatten(fields.map(field => field.dependencies || []));
					return {
						content,
						dependencies,
					};
				}),
			);
			return {
				content: serialized.map(serialized => serialized.content).getOrElse('t.type({})'),
				dependencies: serialized.map(serialized => serialized.dependencies).getOrElse([]),
			};
		}
	}
};

const serializeField = (name: string, schema: TSchemaObject, isRequired: boolean, relative: string): TSerialized => {
	const serialized = serializeSchemaObjectType(schema, relative);
	return {
		content: isRequired ? `${name}: ${serialized.content}` : `${name}: Option<${serialized.content}>`,
		dependencies: serialized.dependencies,
	};
};

const serializeIOField = (name: string, schema: TSchemaObject, isRequired: boolean): TSerialized => {
	const serialized = serializeIOSchemaObjectType(schema);
	return {
		content: isRequired
			? `${name}: ${serialized.content},`
			: `${name}: createOptionFromNullable(${serialized.content}),`,
		dependencies: serialized.dependencies,
	};
};

const serializeEnum = (enumValue: Array<string | number | boolean>): string =>
	enumValue.map(value => `'${value}'`).join(' | ');

const serializeIOEnum = (enumValue: Array<string | number | boolean>): string => {
	const serializedValue = enumValue.map(value => `t.literal('${value}')`).join(',');
	return `t.union([${serializedValue}])`;
};

const serializeAdditionalProperties = (properties: TSchemaObject, relative: string): TSerialized => {
	const serialized = serializeSchemaObjectType(properties, relative);
	return {
		content: `{ [key: string]: ${serialized.content} }`,
		dependencies: serialized.dependencies,
	};
};

const serializeIOAdditionalProperties = (properties: TSchemaObject): TSerialized => {
	const serialized = serializeIOSchemaObjectType(properties);
	return {
		content: `t.dictionary(t.string, ${serialized.content})`,
		dependencies: serialized.dependencies,
	};
};

const serializeOperationObjectType = (
	path: string,
	method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS',
	operation: TOperationObject,
): TSerialized => {
	const parametersInPath = getOperationParametersInPath(operation);
	const parametersInQuery = getOperationParametersInQuery(operation);
	const paramsSummary = parametersInPath.map(serializePathParameterDescription);
	const querySummary = serializeQueryParametersDescription(parametersInQuery);
	const deprecated = operation.deprecated.map(deprecated => `@deprecated`);
	const lines = array.compact([deprecated, operation.summary, ...paramsSummary.map(some), querySummary]);
	const serializedParams = serializePathParameters(parametersInPath);
	const serializedQuery = serializeQueryParameters(parametersInQuery);

	const args = catOptions([serializedParams, serializedQuery]).join(', ');
	const serializedResponses = serializeOperationResponsesType(operation.responses);
	return {
		content: `
			/**
			 ${lines.map(line => `* ${line}`).join('\n')}
			 */
			readonly ${getOperationName(operation, method)}: (${args}) => LiveData<Error, ${serializedResponses.content}>;
		`,
		dependencies: [
			{
				name: 'LiveData',
				path: '@devexperts/rx-utils/dist/rd/live-data.utils',
			},
			...serializedResponses.dependencies,
		],
	};
};

const serializeOperationResponsesType = (responses: TResponsesObject): TSerialized => {
	const serialized = catOptions(
		['200', 'default'].map(code =>
			lookup(code, responses).map(response => serializeOperationResponseType(code, response)),
		),
	);
	const content = uniq(setoidString)(serialized.map(serialized => serialized.content)).join(' | ') || 'void';
	const dependencies = foldDependencies(serialized.map(serialized => serialized.dependencies));
	return {
		content: content,
		dependencies,
	};
};

const serializeOperationResponseType = (code: string, response: TResponseObject): TSerialized =>
	response.schema.map(schema => serializeSchemaObjectType(schema, '../definitions/')).getOrElse({
		content: 'void',
		dependencies: [],
	});

const serializeOperationObjectIO = (
	path: string,
	method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS',
	operation: TOperationObject,
): TSerialized => {
	const parametersInPath = getOperationParametersInPath(operation);
	const parametersInQuery = getOperationParametersInQuery(operation);
	const serializedParametersInPath =
		parametersInPath.length === 0 ? none : some(parametersInPath.map(param => param.name).join(','));
	const serializedParametersInQuery = parametersInQuery.length === 0 ? none : some('query');

	const args = catOptions([serializedParametersInPath, serializedParametersInQuery]).join(',');

	const url = parametersInPath.reduce(
		(acc, p) => acc.replace(`{${p.name}}`, `\$\{${camelize(p.name)}\}`),
		`\`${path}\``,
	);
	const query = serializedParametersInQuery.map(query => `query: ${query}`).getOrElse('');
	return {
		content: `
			${getOperationName(operation, method)}: (${args}) => e.apiClient.request({
				url: ${url},
				method: '${method}',
				${query}
			}),
		`,
		dependencies: [
			{
				name: 'map',
				path: 'rxjs/operators',
			},
		],
	};
};

const serializePathParameter = (parameter: TPathParameterObject): string =>
	`${parameter.name}: ${serializeParameterType(parameter)}`;
const serializePathParameters = (parameters: TPathParameterObject[]): Option<string> =>
	parameters.length === 0 ? none : some(parameters.map(serializePathParameter).join(', '));
const serializePathParameterDescription = (parameter: TPathParameterObject): string =>
	`@param {${serializeParameterType(parameter)}} ${parameter.name} ${parameter.description
		.map(d => '- ' + d)
		.toUndefined()}`;

const serializeQueryParameter = (parameter: TQueryParameterObject): string => {
	const isRequired = parameter.required.getOrElse(false);
	return `${parameter.name}${isRequired ? '' : '?'}: ${serializeParameterType(parameter)}`;
};
const serializeQueryParameters = (parameters: TQueryParameterObject[]): Option<string> => {
	if (parameters.length === 0) {
		return none;
	}
	const isRequired = hasRequiredQueryParameters(parameters);
	const serializedParameters = parameters.map(serializeQueryParameter);
	return some(`query${isRequired ? '' : '?'}: { ${serializedParameters.join(';')} }`);
};
const serializeQueryParametersDescription = (parameters: TQueryParameterObject[]): Option<string> =>
	parameters.length === 0
		? none
		: some(hasRequiredQueryParameters(parameters) ? `@param { object } query` : `@param { object } [query]`);

const serializeParameterType = (parameter: TPathParameterObject | TQueryParameterObject): string => {
	switch (parameter.type) {
		case 'string':
		case 'boolean':
		case 'number': {
			return parameter.type;
		}
		case 'integer': {
			return 'number';
		}
		case 'array': {
			return serializeNonArrayItemsObjectType(parameter.items);
		}
	}
};

const serializeNonArrayItemsObjectType = (items: TNonArrayItemsObject): string => {
	switch (items.type) {
		case 'string':
		case 'boolean':
		case 'number': {
			return items.type;
		}
		case 'integer': {
			return 'number';
		}
	}
};

// serialization helpers

const serializeDictionary = <A, B>(dictionary: Record<string, A>, serializeValue: (name: string, value: A) => B): B[] =>
	Object.keys(dictionary).map(name => serializeValue(name, dictionary[name]));

const getIOName = (name: string): string => `${name}IO`;
const getOperationName = (operation: TOperationObject, httpMethod: string) =>
	operation.operationId.getOrElse(httpMethod);

const serializeDependencies = (dependencies: TDepdendency[]): string =>
	collect(groupBy(dependencies, dependency => dependency.path), (key, dependencies) => {
		const names = uniqString(dependencies.toArray().map(dependency => dependency.name));
		return `import { ${names.join(',')} } from '${dependencies.head.path}';`;
	}).join('');

const client = `
	import { LiveData } from '@devexperts/rx-utils/dist/rd/live-data.utils';
	
	export type TAPIRequest = {
		url: string;
		query?: object;
		body?: object;
	};

	export type TFullAPIRequest = TAPIRequest & {
		method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
	};
	
	export type TAPIClient = {
		readonly request: (request: TFullAPIRequest) => LiveData<unknown, unknown>;
	};
`;

const hasRequiredQueryParameters = (parameters: TQueryParameterObject[]): boolean =>
	parameters.some(p => p.required.isSome() && p.required.value);
