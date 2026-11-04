import { codexAgentRoles } from "./codex-setup.js";

export const completionCommands = [
  ["setup", "Configure policy and specialist agents"],
  ["doctor", "Check the local development environment"],
  ["init", "Initialize repository policy"],
  ["scan", "Analyze evidence-backed repository metadata"],
  ["plan", "Create a read-only provider-backed plan"],
  ["run", "Plan work or supervise a development task"],
  ["resume", "Continue planning or unfinished development delivery"],
  ["status", "Show recorded task and publishing state"],
  ["propose", "Generate bounded changes for a planned task"],
  ["inspect", "Inspect plans, changes, checks and delivery evidence"],
  ["apply", "Apply a proposal in an isolated worktree"],
  ["verify", "Run authorized checks in the applied worktree"],
  ["repair", "Propose a bounded repair after failed checks"],
  ["commit", "Commit reviewed changes locally or optionally push"],
  ["push", "Publish a recorded commit to its allowed branch"],
  ["providers", "Inspect or configure model providers"],
  ["codex", "Generate specialist setup or a task prompt"],
  ["config", "Configure project setup and Groq/Gemini access"],
  ["chat", "Start read-only Groq advice (Gemini optional)"],
  ["policy", "Inspect or update deterministic execution policy"],
  ["runs", "Create or list durable workflow runs"],
  ["validate", "Validate repository policy"],
  ["completion", "Generate shell completion support"],
  ["settings", "Configure personal shell completion settings"],
  ["help", "Show focused command guides"],
  ["version", "Print the CLI version"]
] as const;

const choices: Record<string, readonly (readonly [string, string])[]> = {
  help: [
    ["setup", "Project setup"],
    ["workflow", "Development workflow"],
    ["providers", "Model integrations"],
    ["policy", "Permissions and checks"]
  ],
  providers: [
    ["list", "List available provider adapters"],
    ["doctor", "Check configured providers"],
    ["codex", "Codex authentication"],
    ["configure", "Configure a local provider"]
  ],
  "providers codex": [
    ["login", "Sign in through the Codex CLI"],
    ["status", "Check Codex authentication"]
  ],
  "providers configure": [["ollama", "Configure a loopback Ollama model"]],
  codex: [
    ["setup", "Generate specialist configuration"],
    ["prompt", "Generate a feature workflow prompt"]
  ],
  config: [
    ["setup", "Configure this project"],
    ["groq", "Configure a local Groq key (default chat provider)"],
    ["gemini", "Configure a local Gemini key (may be slower)"],
    ["status", "Show local configuration status"]
  ],
  runs: [
    ["create", "Create a durable planning run"],
    ["list", "List recorded runs"]
  ],
  policy: [
    ["show", "Show effective execution policy"],
    ["validate", "Validate policy configuration"],
    ["init", "Initialize repository policy"],
    ["set", "Update one policy value"]
  ],
  completion: [
    ["zsh", "Descriptions, arrow-key menus and optional automatic popup"],
    ["install", "Ask to enable completion in your zsh startup file"]
  ],
  "completion install": [["zsh", "Enable zsh menus after explicit confirmation"]]
};

const common = [
  "--help[Show command help]",
  "--repo[Repository root]:directory:_directories",
  "--json[Print structured JSON]"
];
const setup = [
  "--agents[Comma-separated specialist roles]:roles:->agents",
  "--description[Project description]:description:",
  "--ai[Use optional Gemini tailoring]",
  "--yes[Accept validated setup choices]"
];
const delivery = [
  "--develop[Run supervised implementation]",
  "--approve[Authorize this invocation where policy requires approval]",
  "--execute-checks[Authorize target validation tooling]",
  "--delivery[What to do after validation and review]:delivery:->delivery",
  "--message[Explicit conventional commit message]:message:",
  "--message-provider[Model drafting the commit message]:message-provider:->message_provider"
];
const flagCatalog: Record<string, string[]> = {
  setup: [...setup, "--skip-gemini[Skip optional Gemini key setup]"],
  "codex setup": setup,
  "config setup": [...setup, "--skip-gemini[Skip optional Gemini key setup]"],
  "config groq": ["--stdin[Read the key from standard input]"],
  "config gemini": ["--stdin[Read the key from standard input]"],
  run: [
    "--provider[Planning provider]:provider:->provider",
    ...delivery,
    "--parallel[Preview parallelism policy]",
    "--max-workers[Preview worker limit]:workers:",
    "--auto-commit[Preview commit policy without a development task]",
    "--no-push[Preview disabled publishing policy]",
    "--non-interactive[Disable interactive prompts]"
  ],
  plan: ["--provider[Planning provider]:provider:->provider"],
  resume: delivery,
  "runs create": ["--provider[Planning provider]:provider:->provider"],
  propose: ["--task[Planned task ID]:task:", "*--file[Select scoped source context]:file:_files"],
  repair: ["*--file[Select scoped source context]:file:_files"],
  apply: ["--approve[Approve applying the proposal]"],
  verify: ["--execute-checks[Authorize target validation tooling]"],
  commit: [
    "--message-provider[Draft from all reviewed changes]:message-provider:->message_provider",
    "--message[Conventional commit message]:message:",
    "(--push)--commit-only[Keep the commit local]",
    "(--commit-only)--push[Publish after committing]",
    "--approve[Approve requested Git actions]",
    "--execute-checks[Authorize additional pre-push checks]"
  ],
  push: [
    "--approve[Approve publishing this commit]",
    "--execute-checks[Authorize additional pre-push checks]"
  ],
  chat: [
    "--provider[Chat provider (Groq default; Gemini may be slower)]:provider:(groq gemini)",
    "--model[Selected provider model name]:model:",
    "--no-context[Omit repository metadata]"
  ],
  "providers codex login": ["--device-code[Use device-code authentication]"],
  "providers configure ollama": [
    "--model[Installed Ollama model]:model:",
    "--endpoint[Loopback Ollama endpoint]:endpoint:"
  ],
  completion: ["--auto-menu[Open menus automatically at simple word boundaries]"],
  "completion zsh": ["--auto-menu[Open menus automatically at simple word boundaries]"]
};

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const array = (values: readonly (readonly [string, string])[]) =>
  values.map(([name, description]) => quote(`${name}:${description}`)).join(" ");

/** Generated support is entirely static: completing a word never runs RepoPilot or target code. */
export function zshCompletion(autoMenu = false): string {
  const subcommands = Object.entries(choices)
    .map(([path, entries]) => `    ${quote(path)}) candidates=( ${array(entries)} ) ;;`)
    .join("\n");
  const flags = Object.entries(flagCatalog)
    .map(([path, entries]) => `    ${quote(path)}) specs+=( ${entries.map(quote).join(" ")} ) ;;`)
    .join("\n");
  return `# RepoPilot zsh completion. Source this output after any shell completion plugins.
# No repository, provider, network, or Git commands run while completing.
if ! (( $+functions[compdef] )); then
  autoload -Uz compinit
  compinit
fi
zmodload zsh/complist
zle -C _repopilot_menu_select .menu-select _main_complete
zstyle ':completion:*:*:repopilot:*' menu select interactive
zstyle ':completion:*:*:repopilot:*' verbose yes

_repopilot() {
  local context state state_descr line command_path word
  local -a specs candidates
  local -A opt_args
  if (( CURRENT == 2 )) && [[ $words[CURRENT] != -* ]]; then
    candidates=( ${array(completionCommands)} )
    _describe 'RepoPilot command' candidates
    return
  fi
  if (( CURRENT == 2 )); then
    _arguments '--help[Show command help]'
    return
  fi
  command_path=$words[2]
  if [[ $words[2] == providers && ( $words[3] == codex || $words[3] == configure ) ]]; then
    command_path+=" $words[3]"
    (( CURRENT > 4 )) && command_path+=" $words[4]"
  elif [[ $words[2] == (codex|config|runs|policy|completion) ]] && (( CURRENT > 3 )); then
    command_path+=" $words[3]"
  fi
  case $command_path in
${subcommands}
  esac
  local -a path_parts
  path_parts=( \${=command_path} )
  if (( \${#candidates} && CURRENT == \${#path_parts} + 2 )) && [[ $words[CURRENT] != -* ]]; then
    _describe 'subcommand' candidates
    return
  fi
  specs=( ${common.map(quote).join(" ")} )
  case $words[2] in
    help) return ;;
    version) specs=( '--help[Show command help]' '--json[Print structured JSON]' ) ;;
    completion|settings) specs=( '--help[Show command help]' ) ;;
  esac
  case $command_path in
${flags}
  esac
  _arguments -s -S $specs '*:argument:'
  case $state in
    provider)
      candidates=( 'codex:Codex planning and development' 'ollama:Configured local Ollama model' )
      (( \${words[(Ie)--develop]} )) || candidates+=( 'fake:Offline deterministic planning fixture' )
      _describe 'provider' candidates ;;
    message_provider)
      candidates=( 'groq:Draft from all reviewed change metadata using Groq' 'codex:Draft from metadata through Codex' 'gemini:Draft from metadata using the configured Gemini key' )
      _describe 'commit message provider' candidates ;;
    delivery)
      candidates=( 'review:Stop with a review-ready change' 'commit:Automatically commit after the review gate' 'push:Automatically commit and publish when authorized' )
      _describe 'delivery mode' candidates ;;
    agents)
      _values -s , 'specialist role' ${codexAgentRoles.map((role) => quote(role.id)).join(" ")} none ;;
  esac
}
compdef _repopilot repopilot
${autoMenu ? autoMenuScript : "# Add --auto-menu when generating this script to opt into automatic Space menus."}
`;
}

const autoMenuScript = `
# Only Space is wrapped; Tab and other widgets retain their existing bindings.
typeset -gA _repopilot_space_original
_repopilot_space() {
  local current_map=$KEYMAP
  [[ $current_map == main ]] && current_map=\${\${(z)$(bindkey -lL main)}[3]}
  local original=\${_repopilot_space_original[$current_map]:-self-insert}
  zle "$original" -- "$@"
  (( CURSOR == \${#BUFFER} && ! PENDING )) || return 0
  # Only recognized complete word boundaries open menus; unfinished quoted arguments use Tab.
  [[ $BUFFER == repopilot\\ * && $BUFFER != *$'\\x24'* && $BUFFER != *$'\\x60'* && $BUFFER != *$'\\x5c'* ]] || return 0
  local -a parts
  parts=( \${(z)BUFFER} )
  local token
  for token in $parts; do
    case $token in ';'|'|'|'&'|'&&'|'||'|'<'|'>'|'>>'|'<<') return 0 ;; esac
  done
  local previous=$parts[-1]
  if (( \${#parts} == 1 )) || [[ $previous == (providers|codex|config|runs|policy|help|completion|install|configure|--provider|--message-provider|--delivery) ]]; then
    zle _repopilot_menu_select
  fi
}
zle -N _repopilot_space
local _repopilot_map _repopilot_binding
for _repopilot_map in emacs viins; do
  _repopilot_binding=\${\${(z)$(bindkey -M $_repopilot_map ' ')}[-1]}
  if [[ $_repopilot_binding != _repopilot_space ]]; then
    _repopilot_space_original[$_repopilot_map]=$_repopilot_binding
    bindkey -M $_repopilot_map ' ' _repopilot_space
  fi
done
unfunction _repopilot_disable_auto_menu 2>/dev/null
_repopilot_disable_auto_menu() {
  local map binding
  for map in emacs viins; do
    binding=\${\${(z)$(bindkey -M $map ' ')}[-1]}
    if [[ $binding == _repopilot_space ]]; then
      bindkey -M $map ' ' "\${_repopilot_space_original[$map]:-self-insert}"
    fi
  done
}
# Run _repopilot_disable_auto_menu to restore the captured Space bindings.
`;
