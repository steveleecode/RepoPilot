import { homedir } from "node:os";
import path from "node:path";
import { installZshCompletion } from "./completion-install.js";

/** Default personal setup for global zsh installs; never a requirement for installation. */
export async function offerInstalledCompletion(
  environment: NodeJS.ProcessEnv = process.env
): Promise<void> {
  if (
    environment.CI ||
    environment.REPOPILOT_SKIP_COMPLETION_SETUP ||
    environment.SUDO_USER ||
    process.getuid?.() === 0 ||
    environment.npm_config_global !== "true" ||
    path.basename(environment.SHELL ?? "") !== "zsh"
  )
    return;
  try {
    await installZshCompletion({
      environment,
      homeDirectory: environment.HOME || homedir(),
      confirm: () => Promise.resolve(true)
    });
  } catch {
    // Optional integration never fails installation or prints startup-file contents.
    // Users can inspect and retry through `repopilot settings`.
  }
}
