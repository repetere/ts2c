import * as ts from 'typescript'
import {GlobalContext} from './global';
import {MemoryManager} from './memory';
import {Emitter, EmitTarget, HeaderKey} from './emit';
import {TypeHelper, CType, StructType, ArrayType} from './types';
import {PrintfTranspiler} from './printf';

export class Transpiler {
    private emitter: Emitter = new Emitter();
    private typeHelper: TypeHelper = new TypeHelper(this.emitter, this.convertString.bind(this));
    private memoryManager: MemoryManager = new MemoryManager(this.typeHelper);
    private printfTranspiler: PrintfTranspiler = new PrintfTranspiler(this.emitter, this.typeHelper, this.transpileNode.bind(this), this.addError.bind(this));
    private errors: string[] = [];

    public transpile(sourceFile: ts.SourceFile) {
        this.typeHelper.figureOutVariablesAndTypes(sourceFile);
        this.memoryManager.preprocess();
        this.memoryManager.insertGCVariablesCreationIfNecessary(null, this.emitter);
        this.transpileNode(sourceFile);
        this.memoryManager.insertDestructorsIfNecessary(sourceFile, this.emitter);

        if (this.errors.length)
            return this.errors.join("\n");
        else
            return this.emitter.finalize();
    }

    private transpileNode(node: ts.Node) {
        switch (node.kind) {
            case ts.SyntaxKind.FunctionDeclaration:
                {
                    this.emitter.beginFunction();
                    let funcDecl = <ts.FunctionDeclaration>node;
                    let signature = GlobalContext.typeChecker.getSignatureFromDeclaration(funcDecl);
                    let returnType = this.typeHelper.convertType(signature.getReturnType());
                    this.emitter.emit(this.typeHelper.getTypeString(returnType));
                    this.emitter.emit(' ');
                    this.emitter.emit(funcDecl.name.getText());
                    this.emitter.emit('(');
                    let parameters = [];
                    for (let param of signature.parameters) {
                        let code = '';
                        code += this.typeHelper.getTypeString(this.typeHelper.convertType(GlobalContext.typeChecker.getTypeOfSymbolAtLocation(param, param.valueDeclaration), <ts.Identifier>param.valueDeclaration.name));
                        code += ' ';
                        code += param.getName();
                        parameters.push(code);
                    }
                    this.emitter.emit(parameters.join(', '));
                    this.emitter.emit(')\n');

                    this.emitter.emit('{\n');
                    this.emitter.increaseIndent();
                    this.emitter.beginFunctionBody();
                    this.memoryManager.insertGCVariablesCreationIfNecessary(funcDecl, this.emitter);
                    funcDecl.body.statements.forEach(s => this.transpileNode(s));
                    if (funcDecl.body.statements[funcDecl.body.statements.length - 1].kind != ts.SyntaxKind.ReturnStatement) {
                        this.memoryManager.insertDestructorsIfNecessary(funcDecl, this.emitter);
                    }
                    this.emitter.decreaseIndent();
                    this.emitter.emit('}\n');
                    this.emitter.finalizeFunction();
                }
                break;
            case ts.SyntaxKind.VariableStatement:
                {
                    let varStatement = <ts.VariableStatement>node;
                    for (let varDecl of varStatement.declarationList.declarations) {
                        this.transpileNode(varDecl);
                    }
                }
                break;
            case ts.SyntaxKind.VariableDeclaration:
                {
                    let varDecl = <ts.VariableDeclaration>node;
                    let varInfo = this.typeHelper.getVariableInfo(<ts.Identifier>varDecl.name);
                    let cType = varInfo && varInfo.type;
                    let cTypeString = cType && this.typeHelper.getTypeString(cType) || "void *";
                    if (cTypeString.indexOf('{var}') != -1)
                        this.emitter.emitToBeginningOfFunction(cTypeString.replace('{var}', varDecl.name.getText()))
                    else
                        this.emitter.emitToBeginningOfFunction(cTypeString + " " + varDecl.name.getText());
                    this.emitter.emitToBeginningOfFunction(";\n");

                    if (varInfo.requiresAllocation) {

                        if (cType instanceof ArrayType) {
                            let optimizedCap = Math.max(cType.capacity * 2, 4);
                            this.emitter.emit("ARRAY_CREATE(" + varInfo.name + ", " + optimizedCap + ", " + cType.capacity + ");\n");
                            this.emitter.emitPredefinedHeader(HeaderKey.asserth);
                            this.emitter.emitPredefinedHeader(HeaderKey.stdlibh);
                            this.memoryManager.insertGlobalPointerIfNecessary(varDecl, varInfo.declaration.pos, varInfo.name + ".data", this.emitter);
                        } else {
                            this.emitter.emit(varInfo.name);
                            this.emitter.emit(" = ");
                            this.emitter.emit('malloc(sizeof(*' + varInfo.name + '));\n');
                            this.emitter.emit('assert(' + varInfo.name + ' != NULL);\n');
                            this.emitter.emitPredefinedHeader(HeaderKey.asserth);
                            this.emitter.emitPredefinedHeader(HeaderKey.stdlibh);
                            this.memoryManager.insertGlobalPointerIfNecessary(varDecl, varInfo.declaration.pos, varInfo.name, this.emitter);
                        }
                    }
                    if (varDecl.initializer) {
                        if (varDecl.initializer.kind == ts.SyntaxKind.ObjectLiteralExpression) {
                            this.transpileObjectLiteralAssignment(varDecl.name.getText(), <ts.ObjectLiteralExpression>varDecl.initializer);
                        }
                        else if (varDecl.initializer.kind == ts.SyntaxKind.ArrayLiteralExpression) {
                            let varString = varInfo.isDynamicArray ? varInfo.name + ".data" : varInfo.name;
                            this.transpileArrayLiteralAssignment(varString, <ts.ArrayLiteralExpression>varDecl.initializer);
                        }
                        else {
                            this.emitter.emit(varDecl.name.getText());
                            this.emitter.emit(" = ");
                            this.transpileNode(varDecl.initializer);
                            this.emitter.emit(";\n");
                        }
                    }
                }
                break;
            case ts.SyntaxKind.Block:
                {
                    this.emitter.emit('{\n');
                    this.emitter.increaseIndent();
                    node.getChildren().forEach(c => this.transpileNode(c));
                    this.emitter.decreaseIndent();
                    this.emitter.emit('}\n');
                }
                break;
            case ts.SyntaxKind.IfStatement:
                {
                    let ifStatement = (<ts.IfStatement>node);
                    this.emitter.emit('if (');
                    this.transpileNode(ifStatement.expression);
                    this.emitter.emit(')\n');
                    if (ifStatement.thenStatement.kind != ts.SyntaxKind.Block)
                        this.emitter.increaseIndent();
                    this.transpileNode(ifStatement.thenStatement);
                    if (ifStatement.thenStatement.kind != ts.SyntaxKind.Block)
                        this.emitter.decreaseIndent();
                    if (ifStatement.elseStatement) {
                        this.emitter.emit('else\n')
                        if (ifStatement.elseStatement.kind != ts.SyntaxKind.Block)
                            this.emitter.increaseIndent();
                        this.transpileNode(ifStatement.elseStatement);
                        if (ifStatement.elseStatement.kind != ts.SyntaxKind.Block)
                            this.emitter.decreaseIndent();
                    }
                }
                break;
            case ts.SyntaxKind.ForStatement:
                {
                    let forStatement = <ts.ForStatement>node;
                    // C89 does not support multiple initializers, so if there are more then one, let's put them outside of the loop
                    let forInitializer: ts.Node = forStatement.initializer;
                    if (forInitializer && forInitializer.kind == ts.SyntaxKind.VariableDeclarationList) {
                        var declList = <ts.VariableDeclarationList>forInitializer;
                        declList.declarations.filter((v, i, a) => i < a.length - 1).forEach(v => {
                            this.transpileNode(v);
                        });
                        let lastChild = declList.declarations[declList.declarations.length - 1];
                        let lastChildVarInfo = this.typeHelper.getVariableInfo(<ts.Identifier>lastChild.name);
                        if (lastChildVarInfo.requiresAllocation) {
                            forInitializer = null;
                            this.transpileNode(lastChild);
                        } else
                            forInitializer = lastChild;
                    }
                    this.emitter.emit("for (");
                    if (forInitializer) {
                        this.transpileNode(forInitializer);
                        let t = this.emitter.defaultTarget;
                        this.emitter.transpiledCode[t] = this.emitter.transpiledCode[t].replace(/;\n$/,''); 
                    }
                    this.emitter.emit(";");
                    if (forStatement.condition)
                        this.transpileNode(forStatement.condition);
                    this.emitter.emit(";");
                    if (forStatement.incrementor)
                        this.transpileNode(forStatement.incrementor);
                    this.emitter.emit(")\n");
                    this.emitter.emit("{\n");
                    this.emitter.increaseIndent();
                    if (forStatement.statement.kind == ts.SyntaxKind.Block)
                        (<ts.Block>forStatement.statement).statements.forEach(s => this.transpileNode(s));
                    else
                        this.transpileNode(forStatement.statement);
                    this.emitter.decreaseIndent();
                    this.emitter.emit("}\n");
                }
                break;
            case ts.SyntaxKind.ForOfStatement:
                {
                    let forOfStatement = <ts.ForOfStatement>node;
                    if (forOfStatement.expression.kind != ts.SyntaxKind.Identifier) {
                        this.addError("Unsupported type of expression as array in for of: " + forOfStatement.getText());
                        break;
                    }

                    let iteratorVarName = this.typeHelper.addNewIteratorVariable(node);
                    this.emitter.emitOnceToBeginningOfFunction("int16_t " + iteratorVarName + ";\n");

                    let arrayName = forOfStatement.expression.getText();
                    let arrayVarInfo = this.typeHelper.getVariableInfo(<ts.Identifier>forOfStatement.expression);
                    let arrayType = <ArrayType>arrayVarInfo.type;
                    let arraySize = arrayVarInfo.isDynamicArray ? arrayName + ".size" : arrayType.capacity + "";
                    let arrayAccess = arrayVarInfo.isDynamicArray ? arrayName + ".data" : arrayName;

                    this.emitter.emit("for (" + iteratorVarName + " = 0; " + iteratorVarName + " < " + arraySize + "; " + iteratorVarName + "++)\n");
                    this.emitter.emit("{\n");
                    this.emitter.increaseIndent();
                    
                    let arrayIteratorVarDecl = (<ts.VariableDeclarationList>forOfStatement.initializer).declarations[0];
                    this.transpileNode(arrayIteratorVarDecl);
                    this.emitter.emit(arrayIteratorVarDecl.getText() + " = " + arrayAccess + "[" + iteratorVarName + "];\n");
                    if (forOfStatement.statement.kind == ts.SyntaxKind.Block)
                        (<ts.Block>forOfStatement.statement).statements.forEach(s => this.transpileNode(s));
                    else
                        this.transpileNode(forOfStatement.statement);
                    this.emitter.decreaseIndent();
                    this.emitter.emit("}\n");

                }
                break;
            case ts.SyntaxKind.ForInStatement:
                this.addError("For-in statement is not yet supported!");
                break;
            case ts.SyntaxKind.WhileStatement:
                {
                    let whileStatement = <ts.WhileStatement>node;
                    this.emitter.emit("while (");
                    this.transpileNode(whileStatement.expression);
                    this.emitter.emit(")");
                    this.emitter.emit("{\n");
                    this.emitter.increaseIndent();
                    if (whileStatement.statement.kind == ts.SyntaxKind.Block)
                        (<ts.Block>whileStatement.statement).statements.forEach(s => this.transpileNode(s));
                    else
                        this.transpileNode(whileStatement.statement);
                    this.emitter.decreaseIndent();
                    this.emitter.emit("}\n");
                }
                break;
            case ts.SyntaxKind.DoStatement:
                {
                    let doStatement = <ts.DoStatement>node;
                    this.emitter.emit("do {\n");
                    this.emitter.increaseIndent();
                    if (doStatement.statement.kind == ts.SyntaxKind.Block)
                        (<ts.Block>doStatement.statement).statements.forEach(s => this.transpileNode(s));
                    else
                        this.transpileNode(doStatement.statement);
                    this.emitter.decreaseIndent();
                    this.emitter.emit("} while (");
                    this.transpileNode(doStatement.expression);
                    this.emitter.emit(");\n");
                }
                break;
            case ts.SyntaxKind.ReturnStatement:
                {
                    this.memoryManager.insertDestructorsIfNecessary(node, this.emitter);
                    this.emitter.emit("return");
                    let expr = (<ts.ReturnStatement>node).expression;
                    if (expr) {
                        this.emitter.emit(" ");
                        this.transpileNode(expr);
                    }
                    this.emitter.emit(";\n");
                }
                break;
            case ts.SyntaxKind.ExpressionStatement:
                {
                    node.getChildren().forEach(c => this.transpileNode(c));
                    this.emitter.emit(";\n");
                }
                break;
            case ts.SyntaxKind.CallExpression:
                {
                    let call = <ts.CallExpression>node;
                    let callReplaced = false;
                    if (call.expression.kind == ts.SyntaxKind.PropertyAccessExpression) {
                        let propAccess = <ts.PropertyAccessExpression>call.expression;
                        if (propAccess.expression.kind == ts.SyntaxKind.Identifier
                            && propAccess.expression.getText() == 'console'
                            && propAccess.name.getText() == 'log') {
                            this.emitter.emitPredefinedHeader(HeaderKey.stdioh);
                            callReplaced = true;
                            for (let i = 0; i < call.arguments.length; i++)
                                this.printfTranspiler.transpile(call.arguments[i]);
                        } else if (propAccess.expression.kind == ts.SyntaxKind.Identifier
                            && propAccess.name.getText() == 'push'
                            && call.arguments.length == 1) {

                            let varInfo = this.typeHelper.getVariableInfo(<ts.Identifier>propAccess.expression);
                            if (varInfo && varInfo.type instanceof ArrayType) {
                                this.emitter.emitPredefinedHeader(HeaderKey.array);
                                this.emitter.emit("ARRAY_PUSH(");
                                this.emitter.emit(propAccess.expression.getText());
                                this.emitter.emit(",");
                                this.transpileNode(call.arguments[0]);
                                this.emitter.emit(")");
                                callReplaced = true;
                            }
                        } else if (propAccess.expression.kind == ts.SyntaxKind.Identifier
                            && propAccess.name.getText() == 'pop'
                            && call.arguments.length == 0) {

                            let varInfo = this.typeHelper.getVariableInfo(<ts.Identifier>propAccess.expression);
                            if (varInfo && varInfo.type instanceof ArrayType) {
                                this.emitter.emitPredefinedHeader(HeaderKey.array_pop);
                                this.emitter.emit("ARRAY_POP(");
                                this.emitter.emit(propAccess.expression.getText());
                                this.emitter.emit(")");
                                callReplaced = true;
                            }
                        }
                    }
                    if (!callReplaced) {
                        this.transpileNode(call.expression);
                        this.emitter.emit("(");
                        for (let i = 0; i < call.arguments.length; i++) {
                            this.transpileNode(call.arguments[i]);
                            if (i != call.arguments.length - 1)
                                this.emitter.emit(", ");
                        }
                        this.emitter.emit(")");
                    }
                }
                break;
            case ts.SyntaxKind.PropertyAccessExpression:
                {
                    let propAccess = <ts.PropertyAccessExpression>node;
                    let callReplaced = false;
                    if (propAccess.expression.kind == ts.SyntaxKind.Identifier
                        && propAccess.name.getText() == 'length') {

                        let varInfo = this.typeHelper.getVariableInfo(<ts.Identifier>propAccess.expression);
                        let varType = varInfo && varInfo.type;
                        if (varType instanceof ArrayType) {
                            if (varInfo.isDynamicArray) {
                                this.emitter.emit(propAccess.expression.getText());
                                this.emitter.emit(".");
                                this.emitter.emit("size");
                            } else
                                this.emitter.emit(varType.capacity + "");
                            callReplaced = true;
                        }
                    }

                    if (!callReplaced) {
                        this.transpileNode(propAccess.expression);
                        this.emitter.emit('->');
                        this.emitter.emit(propAccess.name.getText());
                    }
                }
                break;
            case ts.SyntaxKind.ElementAccessExpression:
                {
                    let appropriateTypeFound = false;
                    let elemAccess = <ts.ElementAccessExpression>node;
                    if (elemAccess.expression.kind == ts.SyntaxKind.Identifier && elemAccess.argumentExpression.kind == ts.SyntaxKind.StringLiteral) {
                        this.emitter.emit(elemAccess.expression.getText());
                        this.emitter.emit("->");
                        this.emitter.emit(elemAccess.argumentExpression.getText().slice(1, -1));
                        appropriateTypeFound = true;
                    }
                    else if (elemAccess.expression.kind == ts.SyntaxKind.Identifier) {
                        let varInfo = this.typeHelper.getVariableInfo(<ts.Identifier>elemAccess.expression);
                        if (varInfo && varInfo.type instanceof ArrayType) {
                            this.emitter.emit(elemAccess.expression.getText());
                            if (varInfo.isDynamicArray)
                                this.emitter.emit(".data");
                            this.emitter.emit("[");
                            this.transpileNode(elemAccess.argumentExpression);
                            this.emitter.emit("]");
                            appropriateTypeFound = true;
                        }
                    }

                    if (!appropriateTypeFound) {
                        this.emitter.emit("js_get(");
                        this.transpileNode(elemAccess.expression);
                        this.emitter.emit(', ');
                        this.transpileNode(elemAccess.argumentExpression);
                        this.emitter.emit(')');
                    }
                }
                break;
            case ts.SyntaxKind.BinaryExpression:
                {
                    let binExpr = <ts.BinaryExpression>node;
                    let leftType = this.typeHelper.convertType(GlobalContext.typeChecker.getTypeAtLocation(binExpr.left));
                    let rightType = this.typeHelper.convertType(GlobalContext.typeChecker.getTypeAtLocation(binExpr.right));
                    if (binExpr.operatorToken.kind == ts.SyntaxKind.EqualsEqualsToken && leftType == 'char *' && rightType == 'char *') {
                        this.emitter.emit("strcmp(");
                        this.transpileNode(binExpr.left);
                        this.emitter.emit(", ");
                        this.transpileNode(binExpr.right);
                        this.emitter.emit(") == 0");
                        this.emitter.emitPredefinedHeader(HeaderKey.stringh);
                    }
                    else if (binExpr.operatorToken.kind == ts.SyntaxKind.EqualsEqualsToken && (leftType != 'int16_t' || rightType != 'int16_t')) {
                        this.emitter.emitPredefinedHeader(HeaderKey.js_eq)
                        this.emitter.emit("js_eq(");
                        this.transpileNode(binExpr.left);
                        this.emitter.emit(", ");
                        this.transpileNode(binExpr.right);
                        this.emitter.emit(")");
                    }
                    else if (binExpr.operatorToken.kind == ts.SyntaxKind.EqualsToken && binExpr.parent.kind != ts.SyntaxKind.ExpressionStatement)
                        this.addError("Assignments inside expressions are not yet supported.");
                    else if (binExpr.operatorToken.kind == ts.SyntaxKind.EqualsToken && binExpr.right.kind == ts.SyntaxKind.ObjectLiteralExpression) {
                        let varInfo = this.typeHelper.getVariableInfo(binExpr.left);
                        if (varInfo)
                            this.transpileObjectLiteralAssignment(varInfo.name, <ts.ObjectLiteralExpression>binExpr.right);
                        else
                            this.addError("Only variable, element access or property access are supported as left hand side expression in assignment of ObjectLiteralExpression.");
                    }
                    else if (binExpr.operatorToken.kind == ts.SyntaxKind.EqualsToken && binExpr.right.kind == ts.SyntaxKind.ArrayLiteralExpression) {
                        let varInfo = this.typeHelper.getVariableInfo(binExpr.left);
                        if (varInfo) {
                            this.transpileArrayLiteralAssignment(varInfo.name, <ts.ArrayLiteralExpression>binExpr.right);
                        } else
                            this.addError("Only variable, element access or property access are supported as left hand side expression in assignment of ArrayLiteralExpression.");
                    }
                    else {
                        this.transpileNode(binExpr.left);
                        this.emitter.emit(this.convertOperatorToken(binExpr.operatorToken));
                        this.transpileNode(binExpr.right);
                    }
                }
                break;
            case ts.SyntaxKind.PrefixUnaryExpression:
                {
                    let prefixUnaryExpr = <ts.PrefixUnaryExpression>node;
                    let rightType = this.typeHelper.convertType(GlobalContext.typeChecker.getTypeAtLocation(prefixUnaryExpr.operand));
                    let operationReplaced = false;
                    let error = false;
                    switch (prefixUnaryExpr.operator) {
                        case ts.SyntaxKind.ExclamationToken:
                            if (rightType == "char *") {
                                this.emitter.emit("(!");
                                this.transpileStringExpression(prefixUnaryExpr.operand);
                                this.emitter.emit(" || !");
                                this.transpileStringExpression(prefixUnaryExpr.operand);
                                this.emitter.emit("[0])");
                                operationReplaced = true;
                            }
                            else
                                this.emitter.emit("!");
                            break;
                        default:
                            this.addError("Non-supported unary operator: " + ts.SyntaxKind[node.kind]);
                            error = true;
                    }
                    if (!operationReplaced && !error)
                        this.transpileNode(prefixUnaryExpr.operand);
                }
                break;
            case ts.SyntaxKind.PostfixUnaryExpression:
                {
                    let postfixUnaryExpr = <ts.PostfixUnaryExpression>node;
                    this.transpileNode(postfixUnaryExpr.operand);
                    switch (postfixUnaryExpr.operator) {
                        case ts.SyntaxKind.MinusMinusToken:
                            this.emitter.emit("--");
                            break;
                        case ts.SyntaxKind.PlusPlusToken:
                            this.emitter.emit("++");
                            break;
                        default:
                            this.addError("Non-supported postfix unary operator: " + ts.SyntaxKind[node.kind]);
                    }
                }
                break;
            case ts.SyntaxKind.TrueKeyword:
                this.emitter.emit("TRUE");
                this.emitter.emitPredefinedHeader(HeaderKey.bool);
                break;
            case ts.SyntaxKind.FalseKeyword:
                this.emitter.emitPredefinedHeader(HeaderKey.bool);
                this.emitter.emit("FALSE");
                break;
            case ts.SyntaxKind.NullKeyword:
                this.emitter.emit("NULL");
                break;
            case ts.SyntaxKind.NumericLiteral:
                this.emitter.emit(node.getText());
                break;
            case ts.SyntaxKind.StringLiteral:
                this.emitter.emit(this.convertString(node.getText()));
                break;
            case ts.SyntaxKind.Identifier:
                this.emitter.emit(node.getText());
                break;
            case ts.SyntaxKind.SourceFile:
            case ts.SyntaxKind.SyntaxList:
            case ts.SyntaxKind.EndOfFileToken:
                node.getChildren().forEach(c => this.transpileNode(c));
                break;
            case ts.SyntaxKind.SemicolonToken:
                break;
            default:
                this.addError("Non-supported node: " + ts.SyntaxKind[node.kind]);
                break;
        }

    }

    private transpileObjectLiteralAssignment(varString: string, objLiteral: ts.ObjectLiteralExpression) {
        for (let i = 0; i < objLiteral.properties.length; i++) {
            let propAssign = <ts.PropertyAssignment>objLiteral.properties[i];
            this.emitter.emit(varString + "->");
            this.emitter.emit(propAssign.name.getText());
            this.emitter.emit(" = ");
            this.transpileNode(propAssign.initializer);
            this.emitter.emit(";\n");
       }
    }

    private transpileArrayLiteralAssignment(varString: string, arrLiteral: ts.ArrayLiteralExpression) {
        for (let i = 0; i < arrLiteral.elements.length; i++) {
            this.emitter.emit(varString);
            this.emitter.emit("[" + i + "]");
            this.emitter.emit(" = ");
            this.transpileNode(arrLiteral.elements[i]);
            this.emitter.emit(";\n");
        }
    }

    private convertOperatorToken(token: ts.Node) {
        switch (token.kind) {
            case ts.SyntaxKind.GreaterThanEqualsToken:
                return " >= ";
            case ts.SyntaxKind.GreaterThanToken:
                return " > ";
            case ts.SyntaxKind.LessThanEqualsToken:
                return " <= ";
            case ts.SyntaxKind.LessThanToken:
                return " < ";
            case ts.SyntaxKind.EqualsEqualsEqualsToken:
                return " == ";
            case ts.SyntaxKind.EqualsEqualsToken:
                return " == ";
            case ts.SyntaxKind.PlusToken:
                return " + ";
            case ts.SyntaxKind.MinusToken:
                return " - ";
            case ts.SyntaxKind.AsteriskToken:
                return " * ";
            case ts.SyntaxKind.SlashToken:
                return " / ";
            case ts.SyntaxKind.EqualsToken:
                return " = ";
            default:
                this.addError("Unsupported operator: " + token.getText());
                return "<unsupported operator>";
        }
    }

    private transpileStringExpression(tsNode: ts.Node) {
        if (tsNode.kind != ts.SyntaxKind.Identifier) {
            this.emitter.emit("(");
            this.transpileNode(tsNode);
            this.emitter.emit(")");
        } else
            this.emitter.emit(tsNode.getText());
    }

    private convertString(tsString: string) {
        if (tsString.indexOf("'") == 0) {
            return '"' + tsString.replace(/"/g, '\\"').replace(/([^\\])\\'/g, "$1'").slice(1, -1) + '"';
        }
        return tsString;
    }

    private addError(error: string) {
        this.errors.push(error);
    }

}