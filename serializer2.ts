import {
	TBodyParameterObject,
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
import { array, catOptions, uniq } from 'fp-ts/lib/Array';
import { getRecordSetoid, Setoid, setoidString } from 'fp-ts/lib/Setoid';
import { groupBy } from 'fp-ts/lib/NonEmptyArray';
import {
	getOperationParametersInBody,
	getOperationParametersInPath,
	getOperationParametersInQuery,
	groupPathsByTag,
} from './utils';
import { none, Option, some } from 'fp-ts/lib/Option';
import { getArrayMonoid, getRecordMonoid, monoidString, fold, monoidAny } from 'fp-ts/lib/Monoid';
import { camelize } from '@devexperts/utils/dist/string/string';
import { intercalate } from 'fp-ts/lib/Foldable2v';
import { collect, lookup } from 'fp-ts/lib/Record';
import { identity } from 'fp-ts/lib/function';

const EMPTY_DEPENDENCIES: TDepdendency[] = [];
const SUCCESSFUL_CODES = ['200', 'default'];

const concatIfL = <A>(condition: boolean, as: A[], a: (as: A[]) => A): A[] => (condition ? as.concat(a(as)) : as);
const concatIf = <A>(condition: boolean, as: A[], a: A): A[] => concatIfL(condition, as, as => a);

type TDepdendency = {
	name: string;
	path: string;
};
type TSerializedType = {
	type: string;
	io: string;
	dependencies: TDepdendency[];
};
const serializedType = (
	type: string,
	io: string,
	dependencies: TDepdendency[] = EMPTY_DEPENDENCIES,
): TSerializedType => ({
	type,
	io,
	dependencies,
});
type TSerializedParameter = TSerializedType & {
	name: string;
	isRequired: boolean;
};
const serializedParameter = (
	name: string,
	type: string,
	io: string,
	isRequired: boolean,
	dependencies: TDepdendency[] = EMPTY_DEPENDENCIES,
): TSerializedParameter => ({
	name,
	type,
	io,
	isRequired,
	dependencies,
});
const dependency = (name: string, path: string): TDepdendency => ({
	name,
	path,
});

const monoidDependencies = getArrayMonoid<TDepdendency>();
const monoidSerializedType = getRecordMonoid<TSerializedType>({
	type: monoidString,
	io: monoidString,
	dependencies: monoidDependencies,
});
const monoidSerializedParameter = getRecordMonoid<TSerializedParameter>({
	type: monoidString,
	io: monoidString,
	dependencies: monoidDependencies,
	name: monoidString,
	isRequired: monoidAny,
});
const setoidSerializedTypeWithoutDependencies: Setoid<TSerializedType> = getRecordSetoid<
	Pick<TSerializedType, 'type' | 'io'>
>({
	type: setoidString,
	io: setoidString,
});
const foldSerialized = fold(monoidSerializedType);
const intercalateSerialized = intercalate(monoidSerializedType, array);
const intercalateSerializedParameter = intercalate(monoidSerializedParameter, array);
const uniqString = uniq(setoidString);
const uniqSerializedWithoutDependencies = uniq(setoidSerializedTypeWithoutDependencies);

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
	const serialized = serializeSchemaObject(definition, './');

	const dependencies = serializeDependencies([
		...serialized.dependencies,
		dependency('Option', 'fp-ts/lib/Option'),
		dependency('createOptionFromNullable', 'io-ts-types'),
	]);

	return file(
		`${name}.ts`,
		`
			import * as t from 'io-ts';
			${dependencies}
			
			export type ${name} = ${serialized.type};
			export const ${getIOName(name)} = ${serialized.io};
		`,
	);
};

const serializePathGroup = (name: string, group: Record<string, TPathItemObject>): TFile => {
	const serialized = foldSerialized(serializeDictionary(group, serializePath));
	const dependencies = serializeDependencies([
		...serialized.dependencies,
		dependency('asks', 'fp-ts/lib/Reader'),
		dependency('TAPIClient', '../client/client'),
	]);
	const groupName = name || 'Unknown';
	return file(
		`${groupName}.ts`,
		`
			import * as t from 'io-ts';
			${dependencies}
		
			export type ${groupName} = {
				${serialized.type}
			};
			
			export const ${camelize(groupName, true)} = asks((e: { apiClient: TAPIClient }): ${groupName} => ({
				${serialized.io}
			}));
		`,
	);
};
const serializePath = (path: string, item: TPathItemObject): TSerializedType => {
	const get = item.get.map(operation => serializeOperationObject(path, 'GET', operation));
	const put = item.put.map(operation => serializeOperationObject(path, 'PUT', operation));
	const post = item.post.map(operation => serializeOperationObject(path, 'POST', operation));
	const remove = item['delete'].map(operation => serializeOperationObject(path, 'DELETE', operation));
	const options = item.options.map(operation => serializeOperationObject(path, 'OPTIONS', operation));
	const head = item.head.map(operation => serializeOperationObject(path, 'HEAD', operation));
	const patch = item.patch.map(operation => serializeOperationObject(path, 'PATCH', operation));
	const operations = catOptions([get, put, post, remove, options, head, patch]);
	return foldSerialized(operations);
};

const serializeSchemaObject = (schema: TSchemaObject, relative: string): TSerializedType => {
	switch (schema.type) {
		case undefined: {
			const type = `${schema.$ref.replace(/^#\/definitions\//g, '')}`;
			const io = getIOName(type);
			return serializedType(type, io, [
				dependency(type, `${relative}${type}`),
				dependency(io, `${relative}${type}`),
			]);
		}
		case 'string': {
			return schema.enum.map(serializeEnum).getOrElseL(() => serializedType('string', 't.string'));
		}
		case 'boolean': {
			return serializedType('boolean', 't.boolean');
		}
		case 'integer':
		case 'number': {
			return serializedType('number', 't.number');
		}
		case 'array': {
			const result = serializeSchemaObject(schema.items, relative);
			return serializedType(`Array<${result.type}>`, `t.array(${result.io})`, result.dependencies);
		}
		case 'object': {
			return schema.additionalProperties
				.map(additionalProperties => serializeAdditionalProperties(additionalProperties, relative))
				.orElse(() =>
					schema.properties.map(properties =>
						toObjectType(
							foldSerialized(
								serializeDictionary(properties, (name, value) => {
									const isRequired = schema.required
										.map(required => required.includes(name))
										.getOrElse(false);
									const field = serializeSchemaObject(value, relative);
									const type = isRequired
										? `${name}: ${field.type}`
										: `${name}: Option<${field.type}>`;
									const io = isRequired
										? `${name}: ${field.io}`
										: `${name}: createOptionFromNullable(${field.io})`;
									return serializedType(`${type};`, `${io},`, field.dependencies);
								}),
							),
						),
					),
				)
				.getOrElseL(() => toObjectType(monoidSerializedType.empty));
		}
	}
};

const serializeEnum = (enumValue: Array<string | number | boolean>): TSerializedType => {
	const type = enumValue.map(value => `'${value}'`).join(' | ');
	const io = `t.union([${enumValue.map(value => `t.literal('${value}')`).join(',')}])`;
	return serializedType(type, io);
};

const serializeAdditionalProperties = (properties: TSchemaObject, relative: string): TSerializedType => {
	const additional = serializeSchemaObject(properties, relative);
	return serializedType(
		`{ [key: string]: ${additional.type} }`,
		`t.dictionary(t.string, ${additional.io})`,
		additional.dependencies,
	);
};

const serializeOperationObject = (
	path: string,
	method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS',
	operation: TOperationObject,
): TSerializedType => {
	const relative = '../definitions/';

	const pathParameters = getOperationParametersInPath(operation);
	const queryParameters = getOperationParametersInQuery(operation);
	const bodyParameters = getOperationParametersInBody(operation);

	const pathParamsSummary = pathParameters.map(serializePathParameterDescription);
	const paramsSummary = serializeParametersDescription(queryParameters, bodyParameters);

	const deprecated = operation.deprecated.map(deprecated => `@deprecated`);
	const jsdoc = serializeJSDOC(
		catOptions([deprecated, operation.summary, ...pathParamsSummary.map(some), paramsSummary]),
	);

	const serializedPathParameters = pathParameters.map(serializePathParameter);

	const hasQueryParameters = queryParameters.length > 0;
	const hasBodyParameters = bodyParameters.length > 0;
	const hasParameters = hasQueryParameters || hasBodyParameters;

	const serializedResponses = serializeOperationResponses(operation.responses, relative);

	const operationName = getOperationName(operation, method);

	const url = serializeURL(path, serializedPathParameters);

	const serializedQueryParameters = serializeQueryParameters(queryParameters);
	const serializedBodyParameters = serializeBodyParameters(bodyParameters, relative);

	const argsName = concatIf(hasParameters, serializedPathParameters.map(p => p.name), 'parameters').join(',');
	const argsType = concatIf(
		hasParameters,
		serializedPathParameters.map(p => p.type),
		`parameters: { query: ${serializedQueryParameters.type}, body: ${serializedBodyParameters.type} }`,
	).join(',');

	const type = `
		${jsdoc}
		readonly ${operationName}: (${argsType}) => LiveData<Error, ${serializedResponses.type}>;
	`;

	const io = `
		${operationName}: (${argsName}) => {
			const query = ${hasQueryParameters ? `${serializedQueryParameters.io}.encode(parameters.query)` : 'undefined'};
			const body = ${hasBodyParameters ? `${serializedBodyParameters.io}.encode(parameters.body)` : 'undefined'};
		
			return e.apiClient.request({
				url: ${url},
				method: '${method}',
				body,
				query
			}).pipe(map(data => data.chain(value => fromEither(${
				serializedResponses.io
			}.decode(value).mapLeft(ResponseValiationError.create)))))
		},
	`;

	const dependencies = [
		dependency('map', 'rxjs/operators'),
		dependency('fromEither', '@devexperts/remote-data-ts'),
		dependency('ResponseValiationError', '../client/client'),
		dependency('LiveData', '@devexperts/rx-utils/dist/rd/live-data.utils'),
		...serializedResponses.dependencies,
		...serializedQueryParameters.dependencies,
		...serializedBodyParameters.dependencies,
	];

	return serializedType(type, io, dependencies);
};

const serializeOperationResponses = (responses: TResponsesObject, relative: string): TSerializedType => {
	const serializedResponses = uniqSerializedWithoutDependencies(
		catOptions(
			SUCCESSFUL_CODES.map(code =>
				lookup(code, responses).chain(response => serializeOperationResponse(code, response, relative)),
			),
		),
	);
	if (serializedResponses.length === 0) {
		return serializedType('void', 't.void');
	}
	const combined = intercalateSerialized(serializedType('|', ','), serializedResponses);

	return serializedType(
		combined.type,
		serializedType.length > 1 ? `t.union([${combined.io}])` : combined.io,
		combined.dependencies,
	);
};

const serializeOperationResponse = (
	code: string,
	response: TResponseObject,
	relative: string,
): Option<TSerializedType> => response.schema.map(schema => serializeSchemaObject(schema, relative));

const serializePathParameter = (parameter: TPathParameterObject): TSerializedParameter => {
	const serializedParameterType = serializeParameter(parameter);

	return serializedParameter(
		parameter.name,
		`${parameter.name}: ${serializedParameterType.type}`,
		`${serializedParameterType.io}.encode(${parameter.name})`,
		true,
		serializedParameterType.dependencies,
	);
};

const serializePathParameterDescription = (parameter: TPathParameterObject): string =>
	`@param { ${serializeParameter(parameter).type} } ${parameter.name} ${parameter.description
		.map(d => '- ' + d)
		.toUndefined()}`;

const serializeQueryParameter = (parameter: TQueryParameterObject): TSerializedParameter => {
	const isRequired = parameter.required.getOrElse(false);
	const serializedParameterType = serializeParameter(parameter);
	const serializedRequired = serializeRequired(
		parameter.name,
		serializedParameterType.type,
		serializedParameterType.io,
		isRequired,
	);

	return serializedParameter(
		parameter.name,
		serializedRequired.type,
		serializedRequired.io,
		serializedParameterType.isRequired || isRequired,
		[...serializedParameterType.dependencies, ...serializedRequired.dependencies],
	);
};

const serializeQueryParameters = (parameters: TQueryParameterObject[]): TSerializedParameter => {
	const serializedParameters = parameters.map(serializeQueryParameter);
	const intercalated = intercalateSerializedParameter(
		serializedParameter(',', ';', ',', false),
		serializedParameters,
	);
	const object = toObjectType(intercalated);
	return serializedParameter('query', object.type, object.io, intercalated.isRequired, object.dependencies);
};

const serializeBodyParameter = (parameter: TBodyParameterObject, relative: string): TSerializedParameter => {
	const isRequired = parameter.required.getOrElse(false);
	const serializedParameterType = serializeSchemaObject(parameter.schema, relative);
	const serializedRequired = serializeRequired(
		parameter.name,
		serializedParameterType.type,
		serializedParameterType.io,
		isRequired,
	);
	return serializedParameter(parameter.name, serializedRequired.type, 't.any', isRequired, [
		...serializedParameterType.dependencies,
		...serializedRequired.dependencies,
	]);
};
const serializeBodyParameters = (parameters: TBodyParameterObject[], relative: string): TSerializedParameter => {
	const serializedParameters = parameters.map(parameter => serializeBodyParameter(parameter, relative));
	const intercalated = intercalateSerializedParameter(
		serializedParameter(',', ';', ',', false),
		serializedParameters,
	);
	return serializedParameter(
		'body',
		`{ ${intercalated.type} }`,
		`t.any`,
		intercalated.isRequired,
		intercalated.dependencies,
	);
};

const serializeParametersDescription = (
	query: TQueryParameterObject[],
	body: TBodyParameterObject[],
): Option<string> => {
	const parameters = [...query, ...body];
	return parameters.length === 0
		? none
		: some(hasRequiredParameters(parameters) ? '@param { object } parameters' : '@param { object } [parameters]');
};

const serializeParameter = (parameter: TPathParameterObject | TQueryParameterObject): TSerializedParameter => {
	const isRequired =
		typeof parameter.required === 'boolean' ? parameter.required : parameter.required.getOrElse(false);
	switch (parameter.type) {
		case 'array': {
			const serializedArrayItems = serializeNonArrayItemsObject(parameter.items);
			return serializedParameter(
				parameter.name,
				`Array<${serializedArrayItems.type}>`,
				`t.array(${serializedArrayItems.io})`,
				isRequired,
				serializedArrayItems.dependencies,
			);
		}
		case 'string': {
			return serializedParameter(parameter.name, 'string', 't.string', isRequired);
		}
		case 'boolean': {
			return serializedParameter(parameter.name, 'boolean', 't.boolean', isRequired);
		}
		case 'integer':
		case 'number': {
			return serializedParameter(parameter.name, 'number', 't.number', isRequired);
		}
	}
};

const serializeNonArrayItemsObject = (items: TNonArrayItemsObject): TSerializedType => {
	switch (items.type) {
		case 'string': {
			return serializedType('string', 't.string');
		}
		case 'boolean': {
			return serializedType('boolean', 't.boolean');
		}
		case 'integer':
		case 'number': {
			return serializedType('number', 't.number');
		}
	}
};

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
	import { Errors, mixed } from 'io-ts';

	export type TAPIRequest = {
		url: string;
		query?: object;
		body?: object;
	};

	export type TFullAPIRequest = TAPIRequest & {
		method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
	};
	
	export type TAPIClient = {
		readonly request: (request: TFullAPIRequest) => LiveData<Error, mixed>;
	};
	
	export class ResponseValiationError extends Error {
		static create(errors: Errors): ResponseValiationError {
			return new ResponseValiationError(errors);
		} 
	
		constructor(errors: Errors) {
			super('ResponseValiationError');
			Object.setPrototypeOf(this, ResponseValiationError);
		}
	}
`;

const hasRequiredParameters = (parameters: Array<TQueryParameterObject | TBodyParameterObject>): boolean =>
	parameters.some(p => p.required.exists(identity));

const serializeRequired = (name: string, type: string, io: string, isRequired: boolean): TSerializedType =>
	isRequired
		? serializedType(`${name}: ${type}`, `${name}: ${io}`)
		: serializedType(`${name}?: ${type}`, `${name}: createOptionFromNullable(${io})`, [
				dependency('createOptionFromNullable', 'io-ts-types'),
		  ]);

const serializeJSDOC = (lines: string[]): string =>
	lines.length === 0
		? ''
		: `/**
	 ${lines.map(line => `* ${line}`).join('\n')}
	 */`;

const serializeURL = (url: string, pathParameters: TSerializedParameter[]): string =>
	pathParameters.reduce((acc, p) => acc.replace(`{${p.name}}`, `\$\{encodeURIComponent(${p.io})\}`), `\`${url}\``);

const toObjectType = (serialized: TSerializedType): TSerializedType =>
	serializedType(`{ ${serialized.type} }`, `t.type({ ${serialized.io} })`, serialized.dependencies);
