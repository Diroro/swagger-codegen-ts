import { array, uniq, flatten } from 'fp-ts/lib/Array';
import {
	TPathItemObject,
	TOperationObject,
	TPathsObject,
	TDictionary,
	TParameterObject,
	TPathParameterObject,
	TReferenceObject,
} from './swagger';
import { tuple } from 'fp-ts/lib/function';
import { setoidString } from 'fp-ts/lib/Setoid';
import { Option } from './node_modules/fp-ts/lib/Option';
import { TQueryParameterObject } from './swagger';

export const getOperationsFromPath = (path: TPathItemObject): TDictionary<TOperationObject> => {
	const result: TDictionary<TOperationObject> = {};
	const operations = array.compact([
		path.get.map(operation => tuple('get', operation)),
		path.put.map(operation => tuple('put', operation)),
		path.delete.map(operation => tuple('delete', operation)),
		path.head.map(operation => tuple('head', operation)),
		path.options.map(operation => tuple('options', operation)),
		path.patch.map(operation => tuple('patch', operation)),
	]);
	for (const [name, operation] of operations) {
		result[name] = operation;
	}
	return result;
};

export const getTagsFromPath = (path: TPathItemObject): string[] => {
	const operations = getOperationsFromPath(path);
	const tags = flatten(array.compact(Object.keys(operations).map(key => operations[key].tags)));
	return uniq(setoidString)(tags);
};

export const groupPathsByTag = (paths: TPathsObject): TDictionary<TDictionary<TPathItemObject>> => {
	const keys = Object.keys(paths);
	const result: TDictionary<TDictionary<TPathItemObject>> = {};
	for (const key of keys) {
		const path = paths[key];
		const tag = getTagsFromPath(path)
			.join('')
			.replace(/\s/g, '');
		result[tag] = {
			...(result[tag] || {}),
			[key]: path,
		};
	}
	return result;
};

const isOperationReferenceParameterObject = (
	parameter: TParameterObject | TReferenceObject,
): parameter is TReferenceObject => typeof (parameter as any)['$ref'] === 'string';
const isOperationNonReferenceParameterObject = (
	parameter: TParameterObject | TReferenceObject,
): parameter is TParameterObject => !isOperationReferenceParameterObject(parameter);

const isPathParameterObject = (parameter: TParameterObject): parameter is TPathParameterObject =>
	parameter.in === 'path';
const isOperationPathParameterObject = (
	parameter: TParameterObject | TReferenceObject,
): parameter is TPathParameterObject =>
	isOperationNonReferenceParameterObject(parameter) && isPathParameterObject(parameter);
export const getOperationParametersInPath = (operation: TOperationObject): TPathParameterObject[] =>
	operation.parameters.map(parameters => parameters.filter(isOperationPathParameterObject)).getOrElse([]);

const isQueryParameterObject = (parameter: TParameterObject): parameter is TQueryParameterObject =>
	parameter.in === 'query';
const isOperationQueryParameterObject = (
	parameter: TParameterObject | TReferenceObject,
): parameter is TQueryParameterObject =>
	isOperationNonReferenceParameterObject(parameter) && isQueryParameterObject(parameter);
export const getOperationParametersInQuery = (operation: TOperationObject): TQueryParameterObject[] =>
	operation.parameters.map(parameters => parameters.filter(isOperationQueryParameterObject)).getOrElse([]);
