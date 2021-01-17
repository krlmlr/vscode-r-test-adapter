import { Uri, workspace } from "vscode";
import * as util from "util";
import * as path from "path";
import * as tmp from "tmp-promise";
import { exec } from "child_process";
import * as vscode from "vscode";
import { TestInfo } from "vscode-test-adapter-api";
import { parseTestsFromFile } from "./parser";
import { appendFile as _appendFile } from "fs";
import { TestthatAdapter } from "./adapter";

const appendFile = util.promisify(_appendFile);

export async function runAllTests(adapter: TestthatAdapter): Promise<string> {
    let devtoolsCall = `options("testthat.use_colours"=F);devtools::test('.')`;
    let command = `Rscript -e "${devtoolsCall}"`;
    let cwd = vscode.workspace.workspaceFolders![0].uri.fsPath;
    return new Promise(async (resolve) => {
        let childProcess = exec(command, { cwd }, (err, stdout: string, stderr: string) => {
            if (err) throw stderr;
            adapter.processes.delete(childProcess);
            resolve(stdout);
        });
        adapter.processes.add(childProcess);
    });
}

export async function runSingleTestFile(
    adapter: TestthatAdapter,
    filePath: string
): Promise<string> {
    let devtoolsCall = `options("testthat.use_colours"=F);devtools::test_file('${filePath.replace(/\\/g, "/")}')`;
    let command = `Rscript -e "${devtoolsCall}"`;
    let cwd = vscode.workspace.workspaceFolders![0].uri.fsPath;
    return new Promise(async (resolve) => {
        let childProcess = exec(command, { cwd }, (err, stdout: string, stderr: string) => {
            if (err) throw stderr;
            adapter.processes.delete(childProcess);
            resolve(stdout);
        });
        adapter.processes.add(childProcess);
    });
}

export async function runTest(adapter: TestthatAdapter, test: TestInfo) {
    let documentUri = Uri.file(test.file!);
    let document = await workspace.openTextDocument(documentUri);
    let source = document.getText();
    let allTests = (await parseTestsFromFile(adapter, documentUri)).children;

    for (const parsedTest of allTests) {
        const { startIndex, endIndex } = getRangeOfTest(parsedTest.label, source);
        if (parsedTest.label != test.label) {
            source = source.slice(0, startIndex) + source.slice(endIndex! + 1);
        } else {
            source = source.slice(0, endIndex! + 1);
            break;
        }
    }

    let tmpFileResult = await tmp.file({
        prefix: "test-",
        postfix: ".R",
        tmpdir: path.dirname(test.file!),
    });
    let tmpFilePath = path.normalize(tmpFileResult.path);
    adapter.tempFilePaths.add(tmpFilePath); // Do not clean up tempFilePaths, not possible to get around the race condition
    await appendFile(tmpFilePath, source);
    return runSingleTestFile(adapter, tmpFilePath)
        .catch(async (err) => {
            await tmpFileResult.cleanup();
            throw err;
        })
        .then(async (value) => {
            await tmpFileResult.cleanup();
            return value;
        });
}

function getRangeOfTest(label: string, source: string) {
    let escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    let startIndex = RegExp(`test_that\\s*\\([\\"'\\s]+` + escapedLabel).exec(source)!.index;
    let endIndex;
    let paranthesis = 0;
    for (let index = startIndex; index < source.length; index++) {
        const char = source[index];
        if (char == ")" && paranthesis == 1) {
            endIndex = index;
            break;
        }
        if (char == "(") paranthesis += 1;
        if (char == ")") paranthesis -= 1;
    }
    return { startIndex, endIndex };
}