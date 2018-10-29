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
import { array, catOptions, comprehension, flatten, uniq } from 'fp-ts/lib/Array';
import { getRecordSetoid, setoidString } from 'fp-ts/lib/Setoid';
import { groupBy } from 'fp-ts/lib/NonEmptyArray';
import {
	getOperationParametersInBody,
	getOperationParametersInPath,
	getOperationParametersInQuery,
	groupPathsByTag,
} from './utils';
import { fromPredicate, none, option, Option, some } from 'fp-ts/lib/Option';
import { getArrayMonoid, getRecordMonoid, monoidString, fold } from 'fp-ts/lib/Monoid';
import { camelize } from '@devexperts/utils/dist/string/string';
import { intercalate } from 'fp-ts/lib/Foldable2v';
import { collect, lookup } from 'fp-ts/lib/Record';
import { constTrue } from 'fp-ts/lib/function';

const EMPTY_DEPENDENCIES: TDepdendency[] = [];
const SUCCESSFUL_CODES = ['200', 'default'];

const nonEmpty = <A>(as: A[]): Option<A[]> => (as.length === 0 ? none : some(as));

type TDepdendency = {
	name: string;
	path: string;
};
type TSerialized = {
	type: string;
	io: string;
	dependencies: TDepdendency[];
};
type TSerializedParameter = TSerialized & {
	name: string;
};
const serialized = (type: string, io: string, dependencies: TDepdendency[] = EMPTY_DEPENDENCIES): TSerialized => ({
	type,
	io,
	dependencies,
});
const serializedParameter = (
	name: string,
	type: string,
	io: string,
	dependencies: TDepdendency[] = EMPTY_DEPENDENCIES,
): TSerializedParameter => ({
	name,
	type,
	io,
	dependencies,
});
const dependency = (name: string, path: string): TDepdendency => ({
	name,
	path,
});

const monoidDependencies = getArrayMonoid<TDepdendency>();
const monoidSerialized = getRecordMonoid<TSerialized>({
	type: monoidString,
	io: monoidString,
	dependencies: monoidDependencies,
});
const setoidSerializedWithoutDependencies = getRecordSetoid<TSerialized>({
	type: setoidString,
	io: setoidString,
	dependencies: {
		equals: constTrue,
	},
});
const foldSerialized = fold(monoidSerialized);
const intercalateSerialized = intercalate(monoidSerialized, array);
const uniqString = uniq(setoidString);
const uniqSerializedWithoutDependencies = uniq(setoidSerializedWithoutDependencies);

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
const serializePath = (path: string, item: TPathItemObject): TSerialized => {
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

const serializeSchemaObjectType = (schema: TSchemaObject, relative: string): TSerialized => {
	switch (schema.type) {
		case undefined: {
			const type = `${schema.$ref.replace(/^#\/definitions\//g, '')}`;
			const io = getIOName(type);
			return serialized(type, io, [dependency(type, `${relative}${type}`), dependency(io, `${relative}${type}`)]);
		}
		case 'string': {
			return schema.enum.map(serializeEnum).getOrElseL(() => serialized('string', 't.string'));
		}
		case 'boolean': {
			return serialized('boolean', 't.boolean');
		}
		case 'integer':
		case 'number': {
			return serialized('number', 't.number');
		}
		case 'array': {
			const result = serializeSchemaObjectType(schema.items, relative);
			return serialized(`Array<${result.type}>`, `t.array(${result.io})`, result.dependencies);
		}
		case 'object': {
			return schema.additionalProperties
				.map(additionalProperties => serializeAdditionalProperties(additionalProperties, relative))
				.orElse(() =>
					schema.properties.map(properties => {
						const fields = foldSerialized(
							serializeDictionary(properties, (name, value) => {
								const field = serializeField(
									name,
									value,
									schema.required.map(required => required.includes(name)).getOrElse(false),
									relative,
								);
								return serialized(`${field.type};`, `${field.io},`, field.dependencies);
							}),
						);
						return serialized(`{ ${fields.type} }`, `t.type({ ${fields.io} })`, fields.dependencies);
					}),
				)
				.getOrElseL(() => serialized('{}', 't.type({})'));
		}
	}
};

const serializeField = (name: string, schema: TSchemaObject, isRequired: boolean, relative: string): TSerialized => {
	const field = serializeSchemaObjectType(schema, relative);
	const type = isRequired ? `${name}: ${field.type}` : `${name}: Option<${field.type}>`;
	const io = isRequired ? `${name}: ${field.io}` : `${name}: createOptionFromNullable(${field.io})`;
	return serialized(type, io, field.dependencies);
};

const serializeEnum = (enumValue: Array<string | number | boolean>): TSerialized => {
	const type = enumValue.map(value => `'${value}'`).join(' | ');
	const io = `t.union([${enumValue.map(value => `t.literal('${value}')`).join(',')}])`;
	return serialized(type, io);
};

const serializeAdditionalProperties = (properties: TSchemaObject, relative: string): TSerialized => {
	const additional = serializeSchemaObjectType(properties, relative);
	return serialized(
		`{ [key: string]: ${additional.type} }`,
		`t.dictionary(t.string, ${additional.io})`,
		additional.dependencies,
	);
};

const serializeOperationObject = (
	path: string,
	method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS',
	operation: TOperationObject,
): TSerialized => {
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

	const parameters = [...queryParameters, ...bodyParameters];
	const hasParameters = parameters.length > 0;
	const hasRequired = hasRequiredParameters(parameters);
	const serializedParameters = serializeParameters(queryParameters, bodyParameters, relative);

	const serializedResponses = serializeOperationResponses(operation.responses, relative);

	const operationName = getOperationName(operation, method);

	const url = serializeURL(path, serializedPathParameters);

	const argsType = [
		...serializedPathParameters.map(param => param.type),
		hasParameters ? serializeRequired('parameters', serializedParameters.type, hasRequired) : '',
	].join(',');

	const argsIO = [
		...serializedPathParameters.map(param => param.name),
		hasParameters ? `parameters${hasRequired ? '' : ' = {}'}` : '',
	].join(',');

	const type = `
		${jsdoc}
		readonly ${operationName}: (${argsType}) => LiveData<Error, ${serializedResponses.type}>;
	`;

	const io = `
		${operationName}: (${argsIO}) => {
			${hasParameters ? `const encoded = ${serializedParameters.io}.encode(parameters)` : ''}
			return e.apiClient.request({
				url: ${url},
				method: '${method}',
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
		...serializedParameters.dependencies,
	];

	return serialized(type, io, dependencies);
};

const serializeOperationResponses = (responses: TResponsesObject, relative: string): TSerialized => {
	const serializedResponses = uniqSerializedWithoutDependencies(
		catOptions(
			SUCCESSFUL_CODES.map(code =>
				lookup(code, responses).chain(response => serializeOperationResponse(code, response, relative)),
			),
		),
	);
	if (serializedResponses.length === 0) {
		return serialized('void', 't.void');
	}
	const combined = intercalateSerialized(serialized('|', ','), serializedResponses);

	return serialized(
		combined.type,
		serialized.length > 1 ? `t.union([${combined.io}])` : combined.io,
		combined.dependencies,
	);
};

const serializeOperationResponse = (code: string, response: TResponseObject, relative: string): Option<TSerialized> =>
	response.schema.map(schema => serializeSchemaObjectType(schema, relative));

const serializePathParameter = (parameter: TPathParameterObject): TSerializedParameter => {
	const serializedParameterType = serializeParameterType(parameter);

	return serializedParameter(
		parameter.name,
		`${parameter.name}: ${serializedParameterType.type}`,
		`${serializedParameterType.io}.encode(${parameter.name})`,
		serializedParameterType.dependencies,
	);
};

const serializePathParameterDescription = (parameter: TPathParameterObject): string =>
	`@param { ${serializeParameterType(parameter).type} } ${parameter.name} ${parameter.description
		.map(d => '- ' + d)
		.toUndefined()}`;

const serializeQueryParameter = (parameter: TQueryParameterObject): TSerializedParameter => {
	const isRequired = parameter.required.getOrElse(false);
	const serializedParameterType = serializeParameterType(parameter);
	return serializedParameter(
		parameter.name,
		serializeRequired(parameter.name, serializedParameterType.type, isRequired),
		`${parameter.name}: ${serializedParameterType.io}`,
		serializedParameterType.dependencies,
	);
};

const serializeQueryParameters = (parameters: TQueryParameterObject[]): TSerializedParameter => {
	const serializedParameters = parameters.map(serializeQueryParameter);
	const intercalated = intercalateSerialized(serialized(';', ','), serializedParameters);
	console.log('serializing query', serializedParameters);
	return serializedParameter('query', `{ ${intercalated.type} }`, `t.any`, intercalated.dependencies);
};

const serializeBodyParameter = (parameter: TBodyParameterObject, relative: string): TSerializedParameter => {
	const isRequired = parameter.required.getOrElse(false);
	const serializedParameterType = serializeSchemaObjectType(parameter.schema, relative);
	return serializedParameter(
		parameter.name,
		serializeRequired(parameter.name, serializedParameterType.type, isRequired),
		't.any',
		serializedParameterType.dependencies,
	);
};
const serializeBodyParameters = (parameters: TBodyParameterObject[], relative: string): TSerializedParameter => {
	const serializedParameters = parameters.map(parameter => serializeBodyParameter(parameter, relative));
	const intercalated = intercalateSerialized(serialized(';', ','), serializedParameters);
	return serializedParameter('body', `{ ${intercalated.type} }`, `t.any`, intercalated.dependencies);
};

const serializeParameters = (
	query: TQueryParameterObject[],
	body: TBodyParameterObject[],
	relative: string,
): TSerialized => {
	const serializedQuery = nonEmpty(query).map(serializeQueryParameters);
	const serializedBody = nonEmpty(body).map(body => serializeBodyParameters(body, relative));
	const type = catOptions([
		serializedQuery.map(serializedQuery =>
			serializeRequired(serializedQuery.name, serializedQuery.type, hasRequiredParameters(query)),
		),
		serializedBody.map(serializedBody =>
			serializeRequired(serializedBody.name, serializedBody.type, hasRequiredParameters(query)),
		),
	]);
	const dependencies = flatten(
		catOptions([
			serializedQuery.map(serializedQuery => serializedQuery.dependencies),
			serializedBody.map(serializedBody => serializedBody.dependencies),
		]),
	);
	return serialized(`{ ${type} }`, 't.any', dependencies);
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

const serializeParameterType = (parameter: TPathParameterObject | TQueryParameterObject): TSerialized => {
	switch (parameter.type) {
		case 'array': {
			const serializedArrayItems = serializeNonArrayItemsObjectType(parameter.items);
			return serialized(
				`Array<${serializedArrayItems.type}>`,
				`t.array(${serializedArrayItems.io})`,
				serializedArrayItems.dependencies,
			);
		}
		case 'string': {
			return serialized('string', 't.string');
		}
		case 'boolean': {
			return serialized('boolean', 't.boolean');
		}
		case 'integer':
		case 'number': {
			return serialized('number', 't.number');
		}
	}
};

const serializeNonArrayItemsObjectType = (items: TNonArrayItemsObject): TSerialized => {
	switch (items.type) {
		case 'string': {
			return serialized('string', 't.string');
		}
		case 'boolean': {
			return serialized('boolean', 't.boolean');
		}
		case 'integer':
		case 'number': {
			return serialized('number', 't.number');
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
	parameters.some(p => p.required.isSome() && p.required.value);

const serializeRequired = (name: string, type: string, isRequired: boolean): string =>
	`${name}${isRequired ? '' : '?'}:${type}`;

const serializeRequiredIO = (name: string, type: string, isRequired: boolean): string =>
	`${name}${isRequired ? '' : 'createOptionFromNullable('}${type}${isRequired ? '' : ')'}`;

const serializeJSDOC = (lines: string[]): string =>
	lines.length === 0
		? ''
		: `/**
	 ${lines.map(line => `* ${line}`).join('\n')}
	 */`;

const serializeURL = (url: string, pathParameters: TSerializedParameter[]): string =>
	pathParameters.reduce((acc, p) => acc.replace(`{${p.name}}`, `\$\{${p.io}\}`), `\`${url}\``);
