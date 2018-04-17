/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
'use strict';

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { spawn } from 'child_process';

import { workspace, commands, ConfigurationTarget, Disposable, ExtensionContext, OutputChannel, window, WorkspaceConfiguration, TextDocumentChangeEvent, TextDocumentContentChangeEvent, Range, Position, Uri, TextDocumentShowOptions, ViewColumn, extensions } from 'vscode';
import { LanguageClient, LanguageClientOptions, SettingMonitor, ServerOptions, TransportKind, NotificationType, Code2ProtocolConverter, DidChangeTextDocumentParams } from 'vscode-languageclient';

let client: LanguageClient = null;

export function activate(context: ExtensionContext) {
   // console.log('CLIENT activate!!!');

  const disposable3 = workspace.onDidChangeConfiguration((params) => {
    // console.log(`CLIENT onDidChangeConfiguration ${JSON.stringify(params)}`); //debug
    // let conf = workspace.getConfiguration();
  });
  context.subscriptions.push(disposable3);

  // The server is implemented in node
  const serverModule = context.asAbsolutePath(path.join('server/src', 'server.js'));
  const outputChannel: OutputChannel = window.createOutputChannel('Hyperledger Composer');

  // The debug options for the server
  const debugOptions = { execArgv: ['--nolazy', '--inspect=6009'] };

  // If the extension is launched in debug mode then the debug server options are used
  // Otherwise the run options are used
  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: { module: serverModule, transport: TransportKind.ipc, options: debugOptions }
  };

  // Options to control the composer validator client
  const clientOptions: LanguageClientOptions = {
    // Register the server for composer documents
    documentSelector: ['composer', 'composer-acl', 'composer-qry'],
    synchronize: {
      // Synchronize the setting section 'Composer' to the server
      configurationSection: 'composer',
      // Notify the server about file changes to '.clientrc files contain in the workspace
      // fileEvents: workspace.createFileSystemWatcher('**/.clientrc')
    },
    outputChannel: outputChannel
  };

  // Create the language client and start the client.
  client = new LanguageClient('Hyperledger Composer', serverOptions, clientOptions);
  const disposable = client.start();
  client.onReady().then(() => {
    // Push the disposable to the context's subscriptions so that the
    // client can be deactivated on extension deactivation
    context.subscriptions.push(disposable);

    const disposable2 = window.onDidChangeActiveTextEditor((editor) => {
      if (!editor) {
        return;
      }

      // make sure it is one of the languages we care about
      if ((editor.document.languageId !== 'composer') &&
        (editor.document.languageId !== 'composer-acl') &&
        (editor.document.languageId !== 'composer-qry')) {
        return;
      }

      // For now, force an update when the editor is changed and a new one is selected.
      // This allows us to update properly in the event of referential integrity changes between files.
      const params = client.code2ProtocolConverter.asChangeTextDocumentParams(editor.document);
      const notification: NotificationType<any, 1> = new NotificationType('textDocument/didChange');
      client.sendNotification(notification, params);
    });
    context.subscriptions.push(disposable2);

    // Register a request handler to catch 'composer.generateUML' requests from the server.
    client.onRequest('openUML', async (docContent: string, originatingFileName: string) => {
      try {
        return await handleGenerateUml(docContent, originatingFileName);
      } catch (ex) {
        console.log('CLIENT Exception:' + ex.message);
      }
    });
  });
}

/**
 * Client handler for 'composer.generateUML' Command
 * @param {string} docContent - info passed from server - UML text as a string
 * @param {string} originatingFileName - name of the cto file command was activated on as passed to server
 *        note that this can be undefined if the command was activated by a keyboard shortcut!
 */
async function handleGenerateUml(docContent: string, originatingFileName: string) {
  // if the diagram was created with a keyboard shortcut, the server does not get the doc name passed in
  // so get the name here, if the active doc is a .cto file.
  const currentEditor = window.activeTextEditor;
  let targetViewColumn;
  if (currentEditor) {
    // console.log("CLIENT current active editor: " + currentEditor.document.uri);
    const activeUri = currentEditor.document.uri.toString();
    if (!originatingFileName || originatingFileName.length === 0) {
      // let activeUri = currentEditor.document.uri.toString();
      if (activeUri.endsWith('.cto')) {
        originatingFileName = activeUri;
      }
    }
    // always get the view column if we can
    if (originatingFileName === activeUri) {
      targetViewColumn = currentEditor.viewColumn;
    }
  }

  // get config info we need to set flags
  const allConfig = workspace.getConfiguration();
  const keepSrcFileOpen = allConfig.get('composer.UML.keepSourceFileOpen');
  let autoShowDiagam = allConfig.get('composer.UML.autoShowDiagam');
  const diagramTheme = allConfig.get('composer.UML.diagramTheme');

  // if we are to try and show the diagram, we need the plantUML extention installed.
  if (autoShowDiagam) {
    // detect install of plantUML extention.
    const ext = extensions.getExtension('jebbs.plantuml');
    if (!ext) {
      await window.showErrorMessage("The 'jebbs.plantuml' extention must be installed and configured to view the UML diagram.");
      // TODO auto install extension.
      /*await window.showErrorMessage("The 'plantuml' extention must be installed and configured. Install?",
        {
          title: "Install",
          action: "install",
        }).then(handleInstallResponse);
      */
      // turn off diagram drawing as we do not have the extention installed
      autoShowDiagam = false;
    } else {
      // we have the extention, turn off auto updating
      // console.log("Client: plantuml ext-path: " + ext.extensionPath); //debug
      const fileType = allConfig.get('plantuml.previewFileType');
      const autoUpdate = allConfig.get('plantuml.previewAutoUpdate');
      if (autoUpdate || (fileType !== 'svg')) {
        // force plantUML to turn off autoUpdate as it causes problems when other files are changed
        // also set fileType to 'svg' as the default 'png' drops the RHS of wide diagrams.

        // Note these changes make persisted changes to the users settings.
        // TODO - is there a temporary way instead?
        allConfig.update('plantuml.previewAutoUpdate', false, ConfigurationTarget.Global);
        allConfig.update('plantuml.previewFileType', 'svg', ConfigurationTarget.Global);

        if (diagramTheme === 'blue') {
          // currently, the include of styles is broken in plantuml plugin - issue #110
          // so this is patched in server.ts and this code is not needed until the issue is fixed
          // allConfig.update('plantuml.includes',['styles/blue'], ConfigurationTarget.Global);
        }
      }

    }
  }

  // construct temp file name
  const fileName = os.tmpdir() + path.sep + 'composer.puml';
  const umlDocUri = Uri.file(fileName);

  // make sure file exists - needed as a workaround to vscode issue #29156
  if (!fs.existsSync(fileName)) {
    fs.writeFileSync(fileName, '');
  }

  // open file - contents will always be replaced later on.
  const document = await workspace.openTextDocument(umlDocUri);

  // show doc to the user
  const options: TextDocumentShowOptions = {
    preserveFocus: false,
    preview: true,
    viewColumn: ViewColumn.One
  };
  const textEditor = await window.showTextDocument(document, options);
  return await textEditor.edit(async (editBuilder) => {
    // edit doc to replace all doc content with new PlantUML syntax
    const lastLineLength = document.lineAt(document.lineCount - 1).text.length;
    editBuilder.replace(new Range(new Position(0, 0), new Position(textEditor.document.lineCount - 1, lastLineLength)), docContent);
  }).then(async (editApplied) => {

    if (!editApplied) {
      console.log('Client could not apply edit');
      return;
    }

    // save the file whilst it's the active one
    const saved = await document.save();
    if (!saved) {
      console.log('Client could not save doc: ' + umlDocUri.toString());
    }

    let result;
    if (autoShowDiagam) {
      try {
        result = await commands.executeCommand('plantuml.preview');
      } catch (ex) {
        console.log('CLIENT error: ' + ex);
        return await window.showErrorMessage('' + ex);
      }
    }
    if (result !== undefined) {
      // console.log("Client preview returned: " + result); //debug
    }

    // check for option to close the composer.puml file
    if (!keepSrcFileOpen) {
      // make sure we are closing the correct window, just in case
      if (window.activeTextEditor) {
        if (window.activeTextEditor.document.uri.toString() === umlDocUri.toString()) {
          // console.log("CLIENT closing: " + window.activeTextEditor.document.uri)
          // Note that this can still go wrong sometimes and close the wrong window,
          // looks like a missing .then() in plantuml.
          await commands.executeCommand('workbench.action.closeActiveEditor');
        } else {
          console.log('CLIENT: could not close ActiveTextEditor: wrong URI: ' + window.activeTextEditor.document.uri.toString() + ' : ' + umlDocUri.toString());
        }
      } else {
        // console.log("CLIENT: could not close window - no ActiveTextEditor");
      }
    } else {
      // move cursor to top in composer.puml file to clear the selection of the whole doc
      // that is present by default (as we replaced all the text in the doc).
      await commands.executeCommand('cursorTop');
    }

    // reset the correct cto editor as active if we are showing the diagram
    // otherwise let the composer.puml file have focus
    if (autoShowDiagam) {
      // Note that the visibleTextEditors list is the nost accurate as it contains
      // the correct view column. However, we're not always present in this list
      // and I'm not sure why, but we always seem to be in the textDocuments
      // list so we try both.
      for (const editor of window.visibleTextEditors) {
        // console.log("CLIENT visible editor: " + editor.document.uri.toString());
        if (editor.document.uri.toString() === originatingFileName) {
          await window.showTextDocument(editor.document, editor.viewColumn);
          return;
        }
      }

      for (const editor of workspace.textDocuments) {
        // console.log("CLIENT visible TEXTdOC: " + editor.uri.toString());
        if (editor.uri.toString() === originatingFileName) {
          // note that targetViewColumn may be undefined, but that's OK - it will default to ViewColumn.One
          await window.showTextDocument(editor, targetViewColumn);
          return;
        }
      }
    }

    // Note, if we ever find ourselves here and keepSrcFileOpen is false,
    // then callimg navigateBack 3 times does seem to work to reset the cto editor,
    // but that feels too hacky for now...
    // return await commands.executeCommand('workbench.action.navigateBack')
  });
}

function handleInstallResponse(options) {
  console.log(`CLIENT installHandler: ${JSON.stringify(options)}`);

  let cmd;
  if (os.platform() === 'win32') {
    cmd = spawn('code.cmd', ['--install-extension', 'jebbs.plantuml']);
  } else {
    cmd = spawn('code', ['--install-extension', 'jebbs.plantuml']);
  }
  cmd.stdout.on('data', (data) => { window.showInformationMessage(data.toString()); });
  cmd.stderr.on('data', (data) => { window.showErrorMessage(data.toString()); });
  cmd.on('close', (code) => { console.log('Fin:' + code.toString()); });
  // todo reset vscode editor!
}
