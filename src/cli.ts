import path from "node:path";
import { fileURLToPath } from "node:url";
import { askPersonalAssistant, createPersonalAssistantAgent } from "./agent.js";
import {
  collectCandidateSecrets,
  formatCliError,
  loadModelConfig,
  redactSecrets,
  validateQuestionArgs,
} from "./config.js";

export interface RunCliOptions {
  argv?: readonly string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  createAgent?: typeof createPersonalAssistantAgent;
}

function silenceConsole(): () => void {
  const original = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  };
  const noop = () => {};
  console.log = noop;
  console.info = noop;
  console.warn = noop;
  console.error = noop;
  console.debug = noop;
  return () => {
    console.log = original.log;
    console.info = original.info;
    console.warn = original.warn;
    console.error = original.error;
    console.debug = original.debug;
  };
}

export async function runCli(options: RunCliOptions = {}): Promise<number> {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const envFilePath = path.resolve(cwd, ".env");
  const workspaceDir = path.resolve(cwd, "workspace");
  const writeStdout =
    options.stdout ?? ((text: string) => process.stdout.write(text));
  const writeStderr =
    options.stderr ?? ((text: string) => process.stderr.write(text));
  const createAgentFn = options.createAgent ?? createPersonalAssistantAgent;

  const secrets = collectCandidateSecrets({ env, envFilePath });
  const restoreConsole = silenceConsole();

  try {
    const question = validateQuestionArgs(argv);
    const config = loadModelConfig({ env, envFilePath });
    secrets.push(config.apiKey);

    const agent = createAgentFn(config, { workspaceDir });
    const answer = await askPersonalAssistant(agent, question, secrets);
    const safeAnswer = redactSecrets(answer, secrets);
    writeStdout(`${safeAnswer}\n`);
    return 0;
  } catch (error: unknown) {
    const message = formatCliError(error, secrets);
    writeStderr(`${message}\n`);
    return 1;
  } finally {
    restoreConsole();
  }
}

const isMainModule =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) ===
    path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  runCli()
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      process.stderr.write(
        "模型调用失败，请检查基础地址、密钥、模型名及网络后重试\n",
      );
      process.exitCode = 1;
    });
}
