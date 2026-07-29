import { z } from "zod";
import type { Evidence } from "@repopilot/shared";
import { normalizeRelativePath } from "@repopilot/shared";

export interface GenerationProvenance {
  templateId: string;
  variables: Record<string, unknown>;
  evidence: Evidence[];
}

export interface ProposedFile {
  path: string;
  content: string;
  provenance: GenerationProvenance;
}

export interface ProposedEdit {
  path: string;
  description: string;
  replacement: string;
  provenance: GenerationProvenance;
}

export interface GenerationWarning {
  message: string;
  evidence?: Evidence[];
}

export interface GenerationPlan {
  files: ProposedFile[];
  edits: ProposedEdit[];
  warnings: GenerationWarning[];
}

export interface TemplateDefinition<T extends z.ZodType> {
  id: string;
  schema: T;
  render: (variables: z.infer<T>) => string;
}

const agentTemplateSchema = z.object({
  projectName: z.string().min(1),
  packageManager: z.string().min(1)
});

const templates = new Map<string, TemplateDefinition<z.ZodType>>([
  [
    "agents/basic-agents-md",
    {
      id: "agents/basic-agents-md",
      schema: agentTemplateSchema,
      render: (input) => {
        const variables = agentTemplateSchema.parse(input);
        return [
          `# ${variables.projectName} Agent Guidance`,
          "",
          `- Use ${variables.packageManager} for dependency and script management.`,
          "- Attach evidence to repository analysis claims.",
          "- Validate generated changes before writing files.",
          ""
        ].join("\n");
      }
    }
  ]
]);

export function renderTemplate(templateId: string, variables: unknown): ProposedFile {
  const template = templates.get(templateId);
  if (!template) {
    throw new Error(`Unknown template: ${templateId}`);
  }
  const parsed = template.schema.parse(variables);
  const content = template.render(parsed);
  return {
    path: normalizeRelativePath("AGENTS.md"),
    content,
    provenance: {
      templateId,
      variables: parsed as Record<string, unknown>,
      evidence: [
        {
          sourcePath: `templates/${templateId}`,
          sourceType: "config",
          description: "Rendered deterministic built-in template."
        }
      ]
    }
  };
}

export function listTemplateIds(): string[] {
  return [...templates.keys()];
}
