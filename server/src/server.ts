/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import {
	IPCMessageReader, IPCMessageWriter,
	createConnection, IConnection, TextDocumentSyncKind,
	TextDocuments, TextDocument, Diagnostic, DiagnosticSeverity,
	InitializeParams, InitializeResult, TextDocumentPositionParams,
	CompletionItem, CompletionItemKind
} from 'vscode-languageserver';

import { ModelManager, AclManager, AclFile } from 'composer-common';

//create the two main singleton managers we need to handle all open cto and permissions.acl documents in the workspace.
let modelManager = new ModelManager();
let aclManager = new AclManager(modelManager);

// Create a connection for the server. The connection uses Node's IPC as a transport
let connection: IConnection = createConnection(new IPCMessageReader(process), new IPCMessageWriter(process));

// Create a simple text document manager. The text document manager
// supports full document sync only
let documents: TextDocuments = new TextDocuments();
// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// After the server has started the client sends an initialize request. The server receives
// in the passed params the rootPath of the workspace plus the client capabilities. 
let workspaceRoot: string;
connection.onInitialize((params): InitializeResult => {
	workspaceRoot = params.rootPath;
	return {
		capabilities: {
			// Tell the client that the server works in FULL text document sync mode
			textDocumentSync: documents.syncKind,
			// Tell the client that the server support code complete
			// Note: disabled for now as snippets in the client are better, until the parser can
			// parse char by char or line by line rather than whole doc at once
			// completionProvider: {
			//   resolveProvider: false
			// }
			//lots more providers can be added here...
		}
	}
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent((change) => {
	validateTextDocument(change.document);
});

// The settings interface describes the server relevant settings part
interface Settings {
	composer: ExampleSettings;
}

// These are the example settings we defined in the client's package.json
// file
interface ExampleSettings {
	maxNumberOfProblems: number;
}

// hold the maxNumberOfProblems setting
let maxNumberOfProblems: number;
// The settings have changed. Is sent on server activation
// as well. 
connection.onDidChangeConfiguration((change) => {
	let settings = <Settings>change.settings;
	maxNumberOfProblems = settings.composer.maxNumberOfProblems || 10;
	// Revalidate any open text documents
	documents.all().forEach(validateTextDocument);
});

/**
 * Main method driven by the LSP when the user opens or changes a cto or acl file
 * @param {string} textDocument - ".cto" or "permissions.acl" document from the client to validate
 */
function validateTextDocument(textDocument: TextDocument): void {
	let langId = textDocument.languageId; //type of file we are processing
	//note - this is the FULL document text as we can't do incremental yet! 
	let txt = textDocument.getText();

	//only add files with data
	if (txt != null && txt.length > 0) {
		//different behaviour for each language type
		if (langId == "composer-acl") {
			//permissions.acl file
			validateNewAclModelFile(textDocument);
		} else {
			//raw composer file
			validateCtoModelFile(textDocument);

			//if we have an acl file we should revalidate it incase the model changes broke something
			const aclFile = aclManager.getAclFile();
			if (aclFile != null) {
				validateExistingAclModelFile(aclFile);
			}
		}
	}

}

/**
 * Validates a cto file that the user has just opened or changed in the workspace.
 * @param {string} textDocument - ".cto" file to validate
 * @private
 */
function validateCtoModelFile(textDocument: TextDocument): void {
	try {
		let txt = textDocument.getText(); //*.cto file
		modelManager.addModelFile(txt); //may throw an exception
		sendDiagnosticSuccess(textDocument.uri); //all OK
	} catch (err) {
		buildAndSendDiagnosticFromException(err, textDocument.lineCount, textDocument.uri);
	}
}

/**
 * Validates an acl file that the user has just opened or changed in the workspace.
 * @param {string} textDocument - new "permissions.acl" file to validate
 * @private
 */
function validateNewAclModelFile(textDocument: TextDocument): void {
	try {
		let txt = textDocument.getText(); //permissions.acl file
		let aclFile = aclManager.createAclFile(textDocument.uri, txt);
		aclFile.lineCount = textDocument.lineCount; //store the count so future errors have access
		aclManager.setAclFile(aclFile); //may throw an exception
		sendDiagnosticSuccess(textDocument.uri); //all OK
	} catch (err) {
		buildAndSendDiagnosticFromException(err, textDocument.lineCount, textDocument.uri);
	}
}

/**
 * Validates the existing acl file that the user has open in the workspace.
 * note that currently there can only be one acl file per business network definition
 * @param {string} textDocument - existing "permissions.acl" file to validate
 * @private
 */
function validateExistingAclModelFile(aclFile): void {
	try {
		aclFile.validate(); //may throw an exception
		sendDiagnosticSuccess(aclFile.getIdentifier()); //all OK
	} catch (err) {
		buildAndSendDiagnosticFromException(err, aclFile.lineCount, aclFile.getIdentifier());
	}
}

/**
 * Turns the 'err' exception into a diagnostic message that it sends back to the client.
 * @param {excepion} err - current validation exception
 * @param {number} lineCount - number of lines in the invalid document
 * @param {string} sourceURI - internal url for the invalid document
 * @private
 */
function buildAndSendDiagnosticFromException(err, lineCount: number, sourceURI: string): void {
	let diagnostics: Diagnostic[] = [];
	let curLine = 0; //vscode lines are 0 based.
	let curColumn = 0; //vscode columns are 0 based
	let endLine = lineCount; //default to highlighting to the end of document
	let endColumn = Number.MAX_VALUE //default to highlighting to the end of the line

	//extract Line and Column info
	let fullMsg = err.name + ": " + err.message;
	//connection.console.log(fullMsg); //debug assist
	let finalMsg = fullMsg;

	//some messages do not have a line and column
	if (typeof err.getFileLocation === "function") {
		//genuine composer exception
		let location = err.getFileLocation();
		//we will take the default if we have no location
		if (location) {
			curLine = location.start.line - 1; //Composer errors are 1 based
			endLine = location.end.line - 1;
			curColumn = location.start.column - 1; //Composer errors are 1 based
			endColumn = location.end.column - 1;
		}
	} else {
		//possible composer exception
		let index = fullMsg.lastIndexOf(". Line ");
		if (index != -1) {
			//manually pull out what we can.
			finalMsg = fullMsg.substr(0, index + 1);
			let current = fullMsg.substr(index + 7); //step over ". Line "   
			curLine = parseInt(current, 10) - 1; //Composer errors are 1 based 
			if (isNaN(curLine) || curLine < 0) { curLine = 0; } //sanity check 
			endLine = curLine; //in the normal case only highlight the current line 
			index = current.lastIndexOf(" column ");
			current = current.substr(index + 8); //step over " column " 
			curColumn = parseInt(current, 10) - 1; //Composer errors are 1 based 
			if (isNaN(curColumn) || curColumn < 0) { curColumn = 0; } //sanity check 
			endColumn = curColumn; //set to the same to highlight the current word 
		}
	}

	//build the message to send back to the client 
	diagnostics.push({
		severity: DiagnosticSeverity.Error,
		range: {
			start: { line: curLine, character: curColumn },
			end: { line: endLine, character: endColumn }
		},
		code: err.name,
		message: finalMsg,
		source: 'Composer'
	});


	// Send the computed diagnostics to VSCode. This must always be sent because:
	// 1: If there has been an exception, this will report the details (this case).
	// 2: If there has NOT been an exception, this will clear any previous exception details.
	connection.sendDiagnostics({ uri: sourceURI, diagnostics });
}

/**
 * Sends back a successful diagnostics message for the sourceURI document
 * to clear any outstanding errors against this file in the client
 * @param {string} sourceURI - internal url for the valid document
 * @private
 */
function sendDiagnosticSuccess(sourceURI: string): void {
	let diagnostics: Diagnostic[] = [];
	// Send the computed diagnostics to VSCode. This must always be sent because:
	// 1: If there has been an exception, this will report the details.
	// 2: If there has NOT been an exception, this will clear any previous exception details (this case).
	connection.sendDiagnostics({ uri: sourceURI, diagnostics });
}

connection.onDidChangeWatchedFiles((change) => {
	// Monitored files have change in VSCode
	connection.console.log('We received a file change event');
});


// This handler provides the initial list of the completion items.
connection.onCompletion((textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
	// The pass parameter contains the position of the text document in 
	// which code complete got requested. For the example we ignore this
	// info and always provide the same completion items.
	return [
		{
			label: 'asset',
			kind: CompletionItemKind.Text,
			data: 1
		},
		{
			label: 'participant',
			kind: CompletionItemKind.Text,
			data: 2
		},
		{
			label: 'transaction',
			kind: CompletionItemKind.Text,
			data: 3
		},
		{
			label: 'enum',
			kind: CompletionItemKind.Text,
			data: 4
		}
	]
});

// This handler resolve additional information for the item selected in
// the completion list.
connection.onCompletionResolve((item: CompletionItem): CompletionItem => {
	if (item.data === 1) {
		item.detail = 'asset details',
			item.documentation = 'Add an asset.'
	} else if (item.data === 2) {
		item.detail = 'participant details',
			item.documentation = 'Add an participant'
	} else if (item.data === 3) {
		item.detail = 'transaction details',
			item.documentation = 'Add an transaction'
	} else if (item.data === 4) {
		item.detail = 'enum details',
			item.documentation = 'Add an enum'
	}
	return item;
});

/*
connection.onDidOpenTextDocument((params) => {
  // A text document got opened in VSCode.
  // params.textDocument.uri uniquely identifies the document. For documents store on disk this is a file URI.
  // params.textDocument.text the initial full content of the document.
  connection.console.log(`${params.textDocument.uri} opened.`);
});

connection.onDidChangeTextDocument((params) => {
  // The content of a text document did change in VSCode.
  // params.textDocument.uri uniquely identifies the document.
  // params.contentChanges describe the content changes to the document.
  connection.console.log(`${params.textDocument.uri} changed: ${JSON.stringify(params.contentChanges)}`);
});

connection.onDidCloseTextDocument((params) => {
  // A text document got closed in VSCode.
  // params.textDocument.uri uniquely identifies the document.
  connection.console.log(`${params.textDocument.uri} closed.`);
});
*/

// Listen on the connection
connection.listen();