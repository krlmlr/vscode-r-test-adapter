import { Uri, workspace } from "vscode";
import * as util from "util";
import * as path from "path";
import * as winreg from "winreg";
import * as fs from "fs";
import * as tmp from "tmp-promise";
import { exec } from "child_process";
import * as vscode from "vscode";
import * as crypto from "crypto";
import { TestInfo, TestSuiteInfo } from "vscode-test-adapter-api";
import { findTests } from "./parser";
import { appendFile as _appendFile } from "fs";
import { TestthatAdapter } from "./adapter";
import { lookpath } from "lookpath";

const appendFile = util.promisify(_appendFile);
let RscriptPath: string | undefined;

export async function runSingleTestFile(
    adapter: TestthatAdapter,
    filePath: string
): Promise<string> {
    let cleanFilePath = filePath.replace(/\\/g, "/");
    let projectDirMatch = cleanFilePath.match(/(.+?)\/tests\/testthat.+?/i);
    let devtoolsCall = `options("testthat.use_colours"=F);devtools::test_file('${cleanFilePath}')`;
    let RscriptCommand = await getRscriptCommand(adapter);
    let command = `${RscriptCommand} -e "${devtoolsCall}"`;
    let cwd = projectDirMatch
        ? projectDirMatch[1]
        : vscode.workspace.workspaceFolders![0].uri.fsPath;
    return new Promise(async (resolve, reject) => {
        let childProcess = exec(command, { cwd }, (err, stdout: string, stderr: string) => {
            adapter.childProcess = undefined;
            if (err) reject(stderr);
            resolve(stdout);
        });
        adapter.childProcess = childProcess;
    });
}

export async function runDescribeTestSuite(adapter: TestthatAdapter, suite: TestSuiteInfo) {
    let documentUri = Uri.file(suite.file!);
    let document = await workspace.openTextDocument(documentUri);
    let source = document.getText();
    let allTests = await findTests(documentUri);

    for (const parsedTest of allTests) {
        const { testSuperLabel, testStartIndex, testEndIndex, testSuperEndIndex } = parsedTest;
        if (testEndIndex >= source.length) break;
        if (testSuperLabel != suite.label) {
            source =
                source.slice(0, testStartIndex) +
                " ".repeat(testEndIndex - testStartIndex) +
                source.slice(testEndIndex!);
        } else {
            source = source.slice(0, testSuperEndIndex!);
            break;
        }
    }

    let randomFileInfix = randomChars();
    let tmpFileName = `test-${randomFileInfix}.R`;
    let tmpFilePath = path.normalize(path.join(path.dirname(suite.file!), tmpFileName));
    adapter.tempFilePaths.add(tmpFilePath); // Do not clean up tempFilePaths, not possible to get around the race condition
    // cleanup is not guaranteed to unlink the file immediately
    let tmpFileResult = await tmp.file({
        name: tmpFileName,
        tmpdir: path.dirname(suite.file!),
    });
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

export async function runSingleTest(adapter: TestthatAdapter, test: TestInfo) {
    let documentUri = Uri.file(test.file!);
    let document = await workspace.openTextDocument(documentUri);
    let source = document.getText();
    let allTests = await findTests(documentUri);

    for (const parsedTest of allTests) {
        const { testStartIndex, testEndIndex, testSuperEndIndex, testLabel } = parsedTest;
        if (testEndIndex >= source.length) break;
        if (testLabel != test.label) {
            source =
                source.slice(0, testStartIndex) +
                " ".repeat(testEndIndex - testStartIndex) +
                source.slice(testEndIndex!);
        } else {
            let lastIndex = testSuperEndIndex ? testSuperEndIndex : testEndIndex;
            source = source.slice(0, lastIndex);
        }
    }

    let randomFileInfix = randomChars();
    let tmpFileName = `test-${randomFileInfix}.R`;
    let tmpFilePath = path.normalize(path.join(path.dirname(test.file!), tmpFileName));
    adapter.tempFilePaths.add(tmpFilePath); // Do not clean up tempFilePaths, not possible to get around the race condition
    // cleanup is not guaranteed to unlink the file immediately
    let tmpFileResult = await tmp.file({
        name: tmpFileName,
        tmpdir: path.dirname(test.file!),
    });
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

async function getRscriptCommand(adapter: TestthatAdapter) {
    let config = vscode.workspace.getConfiguration("RTestAdapter");
    let configPath: string | undefined = config.get("RscriptPath");
    if (configPath !== undefined && configPath !== null) {
        if ((<string>configPath).length > 0 && fs.existsSync(configPath))
            return Promise.resolve(`"${configPath}"`);
        else {
            adapter.log.warn(
                `Rscript path given in the configuration ${configPath} is invalid. Falling back to defaults.`
            );
        }
    }
    if (RscriptPath !== undefined) return Promise.resolve(`"${RscriptPath}"`);
    RscriptPath = await lookpath("Rscript");
    if (RscriptPath !== undefined) return Promise.resolve(`"${RscriptPath}"`);
    if (process.platform != "win32") {
        let candidates = ["/usr/bin", "/usr/local/bin"];
        for (const candidate of candidates) {
            let possibleRscriptPath = path.join(candidate, "Rscript");
            if (fs.existsSync(possibleRscriptPath)) {
                adapter.log.info(`found Rscript among candidate paths: ${possibleRscriptPath}`);
                RscriptPath = possibleRscriptPath;
                return Promise.resolve(`"${RscriptPath}"`);
            }
        }
    } else {
        try {
            const key = new winreg({
                hive: winreg.HKLM,
                key: "\\Software\\R-Core\\R",
            });
            const item: winreg.RegistryItem = await new Promise((resolve, reject) =>
                key.get("InstallPath", (err, result) => (err ? reject(err) : resolve(result)))
            );

            const rhome = item.value;

            let possibleRscriptPath = rhome + "\\bin\\Rscript.exe";
            if (fs.existsSync(possibleRscriptPath)) {
                adapter.log.info(`found Rscript in registry: ${possibleRscriptPath}`);
                RscriptPath = possibleRscriptPath;
                return Promise.resolve(`"${RscriptPath}"`);
            }
        } catch (e) {}
    }
    throw Error("Rscript could not be found in PATH, cannot run the tests.");
}

function randomChars() {
    const RANDOM_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    const count = 12;

    let value = [],
        rnd = null;

    // make sure that we do not fail because we ran out of entropy
    try {
        rnd = crypto.randomBytes(count);
    } catch (e) {
        rnd = crypto.pseudoRandomBytes(count);
    }

    for (var i = 0; i < 12; i++) {
        value.push(RANDOM_CHARS[rnd[i] % RANDOM_CHARS.length]);
    }

    return value.join("");
}

export const _unittestable = {
    getRscriptCommand,
    randomChars,
};
