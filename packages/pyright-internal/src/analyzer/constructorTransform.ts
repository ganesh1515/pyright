/*
 * constructorTransform.ts
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT license.
 * Author: Eric Traut
 *
 * Code that transforms a newly-created object after a call to the
 * constructor is evaluated. It allows for special-case behavior that
 * cannot otherwise be described in the Python type system.
 *
 */

import { appendArray } from '../common/collectionUtils';
import { DiagnosticAddendum } from '../common/diagnostic';
import { DiagnosticRule } from '../common/diagnosticRules';
import { LocMessage } from '../localization/localize';
import { ArgCategory, ExpressionNode, ParamCategory } from '../parser/parseNodes';
import { createFunctionFromConstructor } from './constructors';
import { getParamListDetails, ParamKind } from './parameterUtils';
import { Symbol, SymbolFlags } from './symbol';
import { Arg, FunctionResult, TypeEvaluator } from './typeEvaluatorTypes';
import {
    AnyType,
    ClassType,
    FunctionParam,
    FunctionType,
    FunctionTypeFlags,
    isClassInstance,
    isFunction,
    isInstantiableClass,
    isOverloadedFunction,
    isTypeSame,
    isTypeVar,
    OverloadedFunctionType,
    Type,
} from './types';
import {
    applySolvedTypeVars,
    convertToInstance,
    getTypeVarScopeId,
    lookUpObjectMember,
    makeInferenceContext,
    MemberAccessFlags,
} from './typeUtils';
import { TypeVarContext } from './typeVarContext';

export function hasConstructorTransform(classType: ClassType): boolean {
    if (classType.shared.fullName === 'functools.partial') {
        return true;
    }

    return false;
}

export function applyConstructorTransform(
    evaluator: TypeEvaluator,
    errorNode: ExpressionNode,
    argList: Arg[],
    classType: ClassType,
    result: FunctionResult
): FunctionResult {
    if (classType.shared.fullName === 'functools.partial') {
        return applyPartialTransform(evaluator, errorNode, argList, result);
    }

    // By default, return the result unmodified.
    return result;
}

// Applies a transform for the functools.partial class constructor.
function applyPartialTransform(
    evaluator: TypeEvaluator,
    errorNode: ExpressionNode,
    argList: Arg[],
    result: FunctionResult
): FunctionResult {
    // We assume that the normal return result is a functools.partial class instance.
    if (!isClassInstance(result.returnType) || result.returnType.shared.fullName !== 'functools.partial') {
        return result;
    }

    const callMemberResult = lookUpObjectMember(result.returnType, '__call__', MemberAccessFlags.SkipInstanceMembers);
    if (!callMemberResult || !isTypeSame(convertToInstance(callMemberResult.classType), result.returnType)) {
        return result;
    }

    const callMemberType = evaluator.getTypeOfMember(callMemberResult);
    if (!isFunction(callMemberType) || callMemberType.shared.parameters.length < 1) {
        return result;
    }

    if (argList.length < 1) {
        return result;
    }

    const origFunctionTypeResult = evaluator.getTypeOfArg(argList[0], /* inferenceContext */ undefined);
    let origFunctionType = origFunctionTypeResult.type;
    const origFunctionTypeConcrete = evaluator.makeTopLevelTypeVarsConcrete(origFunctionType);

    if (isInstantiableClass(origFunctionTypeConcrete)) {
        const constructor = createFunctionFromConstructor(
            evaluator,
            origFunctionTypeConcrete,
            isTypeVar(origFunctionType) ? convertToInstance(origFunctionType) : undefined
        );

        if (constructor) {
            origFunctionType = constructor;
        }
    }

    // Evaluate the inferred return type if necessary.
    evaluator.inferReturnTypeIfNecessary(origFunctionType);

    // We don't currently handle unpacked arguments.
    if (argList.some((arg) => arg.argCategory !== ArgCategory.Simple)) {
        return result;
    }

    // Make sure the first argument is a simple function.
    if (isFunction(origFunctionType)) {
        const transformResult = applyPartialTransformToFunction(
            evaluator,
            errorNode,
            argList,
            callMemberType,
            origFunctionType
        );
        if (!transformResult) {
            return result;
        }

        // Create a new copy of the functools.partial class that overrides the __call__ method.
        const newPartialClass = ClassType.cloneForSymbolTableUpdate(result.returnType);
        ClassType.getSymbolTable(newPartialClass).set(
            '__call__',
            Symbol.createWithType(SymbolFlags.ClassMember, transformResult.returnType)
        );

        return {
            returnType: newPartialClass,
            isTypeIncomplete: result.isTypeIncomplete,
            argumentErrors: transformResult.argumentErrors,
        };
    }

    if (isOverloadedFunction(origFunctionType)) {
        const applicableOverloads: FunctionType[] = [];
        let sawArgErrors = false;

        // Apply the partial transform to each of the functions in the overload.
        OverloadedFunctionType.getOverloads(origFunctionType).forEach((overload) => {
            // Apply the transform to this overload, but don't report errors.
            const transformResult = applyPartialTransformToFunction(
                evaluator,
                /* errorNode */ undefined,
                argList,
                callMemberType,
                overload
            );

            if (transformResult) {
                if (transformResult.argumentErrors) {
                    sawArgErrors = true;
                } else if (isFunction(transformResult.returnType)) {
                    applicableOverloads.push(transformResult.returnType);
                }
            }
        });

        if (applicableOverloads.length === 0) {
            if (sawArgErrors) {
                evaluator.addDiagnostic(
                    DiagnosticRule.reportCallIssue,
                    LocMessage.noOverload().format({
                        name: origFunctionType.priv.overloads[0].shared.name,
                    }),
                    errorNode
                );
            }

            return result;
        }

        // Create a new copy of the functools.partial class that overrides the __call__ method.
        const newPartialClass = ClassType.cloneForSymbolTableUpdate(result.returnType);

        let synthesizedCallType: Type;
        if (applicableOverloads.length === 1) {
            synthesizedCallType = applicableOverloads[0];
        } else {
            synthesizedCallType = OverloadedFunctionType.create(
                // Set the "overloaded" flag for each of the __call__ overloads.
                applicableOverloads.map((overload) =>
                    FunctionType.cloneWithNewFlags(overload, overload.shared.flags | FunctionTypeFlags.Overloaded)
                )
            );
        }

        ClassType.getSymbolTable(newPartialClass).set(
            '__call__',
            Symbol.createWithType(SymbolFlags.ClassMember, synthesizedCallType)
        );

        return {
            returnType: newPartialClass,
            isTypeIncomplete: result.isTypeIncomplete,
            argumentErrors: false,
        };
    }

    return result;
}

function applyPartialTransformToFunction(
    evaluator: TypeEvaluator,
    errorNode: ExpressionNode | undefined,
    argList: Arg[],
    partialCallMemberType: FunctionType,
    origFunctionType: FunctionType
): FunctionResult | undefined {
    // Create a map to track which parameters have supplied arguments.
    const paramMap = new Map<string, boolean>();

    const paramListDetails = getParamListDetails(origFunctionType);

    // Verify the types of the provided arguments.
    let argumentErrors = false;
    let reportedPositionalError = false;
    const typeVarContext = new TypeVarContext(getTypeVarScopeId(origFunctionType));

    const remainingArgsList = argList.slice(1);
    remainingArgsList.forEach((arg, argIndex) => {
        if (!arg.valueExpression) {
            return;
        }

        // Is it a positional argument or a keyword argument?
        if (!arg.name) {
            // Does this positional argument map to a positional parameter?
            if (
                argIndex >= paramListDetails.params.length ||
                paramListDetails.params[argIndex].kind === ParamKind.Keyword
            ) {
                if (paramListDetails.argsIndex !== undefined) {
                    const paramType = FunctionType.getEffectiveParamType(
                        origFunctionType,
                        paramListDetails.params[paramListDetails.argsIndex].index
                    );
                    const diag = new DiagnosticAddendum();

                    const argTypeResult = evaluator.getTypeOfExpression(
                        arg.valueExpression,
                        /* flags */ undefined,
                        makeInferenceContext(paramType)
                    );

                    if (!evaluator.assignType(paramType, argTypeResult.type, diag, typeVarContext)) {
                        if (errorNode) {
                            evaluator.addDiagnostic(
                                DiagnosticRule.reportArgumentType,
                                LocMessage.argAssignmentParamFunction().format({
                                    argType: evaluator.printType(argTypeResult.type),
                                    paramType: evaluator.printType(paramType),
                                    functionName: origFunctionType.shared.name,
                                    paramName: paramListDetails.params[paramListDetails.argsIndex].param.name ?? '',
                                }),
                                arg.valueExpression ?? errorNode
                            );
                        }

                        argumentErrors = true;
                    }
                } else {
                    // Don't report multiple positional errors.
                    if (!reportedPositionalError) {
                        if (errorNode) {
                            evaluator.addDiagnostic(
                                DiagnosticRule.reportCallIssue,
                                paramListDetails.positionParamCount === 1
                                    ? LocMessage.argPositionalExpectedOne()
                                    : LocMessage.argPositionalExpectedCount().format({
                                          expected: paramListDetails.positionParamCount,
                                      }),
                                arg.valueExpression ?? errorNode
                            );
                        }
                    }

                    reportedPositionalError = true;
                    argumentErrors = true;
                }
            } else {
                const paramType = FunctionType.getEffectiveParamType(origFunctionType, argIndex);
                const diag = new DiagnosticAddendum();
                const paramName = paramListDetails.params[argIndex].param.name ?? '';

                const argTypeResult = evaluator.getTypeOfExpression(
                    arg.valueExpression,
                    /* flags */ undefined,
                    makeInferenceContext(paramType)
                );

                if (!evaluator.assignType(paramType, argTypeResult.type, diag, typeVarContext)) {
                    if (errorNode) {
                        evaluator.addDiagnostic(
                            DiagnosticRule.reportArgumentType,
                            LocMessage.argAssignmentParamFunction().format({
                                argType: evaluator.printType(argTypeResult.type),
                                paramType: evaluator.printType(paramType),
                                functionName: origFunctionType.shared.name,
                                paramName,
                            }),
                            arg.valueExpression ?? errorNode
                        );
                    }

                    argumentErrors = true;
                }

                // Mark the parameter as assigned.
                paramMap.set(paramName, false);
            }
        } else {
            const matchingParam = paramListDetails.params.find(
                (paramInfo) => paramInfo.param.name === arg.name?.d.value && paramInfo.kind !== ParamKind.Positional
            );

            if (!matchingParam) {
                // Is there a kwargs parameter?
                if (paramListDetails.kwargsIndex === undefined) {
                    if (errorNode) {
                        evaluator.addDiagnostic(
                            DiagnosticRule.reportCallIssue,
                            LocMessage.paramNameMissing().format({ name: arg.name.d.value }),
                            arg.name
                        );
                    }
                    argumentErrors = true;
                } else {
                    const paramType = FunctionType.getEffectiveParamType(
                        origFunctionType,
                        paramListDetails.params[paramListDetails.kwargsIndex].index
                    );
                    const diag = new DiagnosticAddendum();

                    const argTypeResult = evaluator.getTypeOfExpression(
                        arg.valueExpression,
                        /* flags */ undefined,
                        makeInferenceContext(paramType)
                    );

                    if (!evaluator.assignType(paramType, argTypeResult.type, diag, typeVarContext)) {
                        if (errorNode) {
                            evaluator.addDiagnostic(
                                DiagnosticRule.reportArgumentType,
                                LocMessage.argAssignmentParamFunction().format({
                                    argType: evaluator.printType(argTypeResult.type),
                                    paramType: evaluator.printType(paramType),
                                    functionName: origFunctionType.shared.name,
                                    paramName: paramListDetails.params[paramListDetails.kwargsIndex].param.name ?? '',
                                }),
                                arg.valueExpression ?? errorNode
                            );
                        }

                        argumentErrors = true;
                    }
                }
            } else {
                const paramName = matchingParam.param.name!;
                const paramType = FunctionType.getEffectiveParamType(origFunctionType, matchingParam.index);

                if (paramMap.has(paramName)) {
                    if (errorNode) {
                        evaluator.addDiagnostic(
                            DiagnosticRule.reportCallIssue,
                            LocMessage.paramAlreadyAssigned().format({ name: arg.name.d.value }),
                            arg.name
                        );
                    }

                    argumentErrors = true;
                } else {
                    const diag = new DiagnosticAddendum();

                    const argTypeResult = evaluator.getTypeOfExpression(
                        arg.valueExpression,
                        /* flags */ undefined,
                        makeInferenceContext(paramType)
                    );

                    if (!evaluator.assignType(paramType, argTypeResult.type, diag, typeVarContext)) {
                        if (errorNode) {
                            evaluator.addDiagnostic(
                                DiagnosticRule.reportArgumentType,
                                LocMessage.argAssignmentParamFunction().format({
                                    argType: evaluator.printType(argTypeResult.type),
                                    paramType: evaluator.printType(paramType),
                                    functionName: origFunctionType.shared.name,
                                    paramName,
                                }),
                                arg.valueExpression ?? errorNode
                            );
                        }

                        argumentErrors = true;
                    }
                    paramMap.set(paramName, true);
                }
            }
        }
    });

    const specializedFunctionType = applySolvedTypeVars(origFunctionType, typeVarContext);
    if (!isFunction(specializedFunctionType)) {
        return undefined;
    }

    // Create a new parameter list that omits parameters that have been
    // populated already.
    const updatedParamList: FunctionParam[] = specializedFunctionType.shared.parameters.map((param, index) => {
        const specializedParam: FunctionParam = { ...param };
        specializedParam.type = FunctionType.getEffectiveParamType(specializedFunctionType, index);

        // If it's a keyword parameter that has been assigned a value through
        // the "partial" mechanism, mark it has having a default value.
        if (param.name && paramMap.get(param.name)) {
            specializedParam.defaultType = AnyType.create(/* isEllipsis */ true);
        }
        return specializedParam;
    });
    const unassignedParamList = updatedParamList.filter((param) => {
        if (param.category === ParamCategory.KwargsDict) {
            return false;
        }
        if (param.category === ParamCategory.ArgsList) {
            return true;
        }
        return !param.name || !paramMap.has(param.name);
    });
    const assignedKeywordParamList = updatedParamList.filter((param) => {
        return param.name && paramMap.get(param.name);
    });
    const kwargsParam = updatedParamList.filter((param) => {
        return param.category === ParamCategory.KwargsDict;
    });

    const newParamList: FunctionParam[] = [];
    appendArray(newParamList, unassignedParamList);
    appendArray(newParamList, assignedKeywordParamList);
    appendArray(newParamList, kwargsParam);

    // Create a new __call__ method that uses the remaining parameters.
    const newCallMemberType = FunctionType.createInstance(
        partialCallMemberType.shared.name,
        partialCallMemberType.shared.fullName,
        partialCallMemberType.shared.moduleName,
        partialCallMemberType.shared.flags,
        specializedFunctionType.shared.docString
    );

    if (partialCallMemberType.shared.parameters.length > 0) {
        FunctionType.addParam(newCallMemberType, partialCallMemberType.shared.parameters[0]);
    }
    newParamList.forEach((param) => {
        FunctionType.addParam(newCallMemberType, param);
    });

    newCallMemberType.shared.declaredReturnType = specializedFunctionType.shared.declaredReturnType
        ? FunctionType.getEffectiveReturnType(specializedFunctionType)
        : specializedFunctionType.priv.inferredReturnType;
    newCallMemberType.shared.declaration = partialCallMemberType.shared.declaration;
    newCallMemberType.shared.typeVarScopeId = specializedFunctionType.shared.typeVarScopeId;

    return { returnType: newCallMemberType, isTypeIncomplete: false, argumentErrors };
}
