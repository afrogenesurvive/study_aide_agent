import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  findPlaceholders,
  interpolate,
  parsePipelineFile,
  resolveRunPlan,
  selectPipeline,
  MATERIAL_GENERATION,
  type PipelineDefinition,
} from "../services/generation/pipeline";
import { mergeToolLists, parseToolList, TOOL_EXECUTORS, type ToolDef } from "../services/generation/tools";
import { validateAgentConfig } from "../services/generation/validate";

/**
 * The committed `agent-config/` templates are shipped content, so they are
 * checked here rather than in an ad-hoc script: a missing tool definition or a
 * `terminal_tools` entry that disagrees with a step's `isTerminal` flag is a
 * config bug that would otherwise only appear at run time.
 */
function readTemplate(name: string): unknown {
  const file = path.resolve(process.cwd(), "..", "agent-config", name);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

const REAL_TOOLS = parseToolList(readTemplate("tools.template.json"));
const REAL_PIPELINE = parsePipelineFile(readTemplate("pipeline.template.json"));

describe("parsePipelineFile", () => {
  it("reads the committed template with no warnings", () => {
    expect(REAL_PIPELINE.warnings).toEqual([]);
    expect(REAL_PIPELINE.file.maxPipelineSteps).toBe(20);
    expect(REAL_PIPELINE.file.maxRetries).toBe(3);
    expect(REAL_PIPELINE.file.retryBaseDelayMs).toBe(4000);
    expect(REAL_PIPELINE.file.pipelines.map((p) => p.name)).toEqual([
      "material-generation",
      "socratic",
      "weekly-review",
    ]);
  });

  it("defaults a missing step flag rather than dropping the step", () => {
    const { file } = parsePipelineFile({
      pipelines: [{ name: "p", steps: [{ id: "step-0", toolName: "generate_flashcards" }] }],
    });
    expect(file.pipelines[0].steps[0].enabled).toBe(true);
    expect(file.pipelines[0].steps[0].isTerminal).toBe(false);
  });

  it("honours an explicit enabled:false", () => {
    const { file } = parsePipelineFile({
      pipelines: [{ name: "p", steps: [{ toolName: "generate_flashcards", enabled: false }] }],
    });
    expect(file.pipelines[0].steps[0].enabled).toBe(false);
  });

  it("falls back to the safe value when a bound is out of range", () => {
    const { file, warnings } = parsePipelineFile({
      max_pipeline_steps: 999,
      max_retries: -4,
      retry_base_delay_ms: 10,
      pipelines: [{ name: "p", steps: [{ toolName: "generate_flashcards" }] }],
    });
    expect(file.maxPipelineSteps).toBe(20);
    expect(file.maxRetries).toBe(3);
    expect(file.retryBaseDelayMs).toBe(4000);
    expect(warnings).toHaveLength(3);
  });

  it("warns instead of throwing on a non-object payload", () => {
    expect(parsePipelineFile("nope").warnings).toHaveLength(1);
  });

  it("skips a pipeline with no steps", () => {
    const { file, warnings } = parsePipelineFile({ pipelines: [{ name: "empty", steps: [] }] });
    expect(file.pipelines).toEqual([]);
    expect(warnings[0]).toMatch(/no steps/);
  });

  it("keeps going after a step with no toolName", () => {
    const { file, warnings } = parsePipelineFile({
      pipelines: [{ name: "p", steps: [{ id: "step-0" }, { toolName: "generate_quiz" }] }],
    });
    expect(file.pipelines[0].steps.map((s) => s.toolName)).toEqual(["generate_quiz"]);
    expect(warnings[0]).toMatch(/no toolName/);
  });
});

describe("selectPipeline", () => {
  it("finds a pipeline by name", () => {
    expect(selectPipeline(REAL_PIPELINE.file, MATERIAL_GENERATION)?.label).toBe("Material generation");
  });

  it("returns null for an unknown name", () => {
    expect(selectPipeline(REAL_PIPELINE.file, "nope")).toBeNull();
  });
});

describe("interpolate", () => {
  it("fills known placeholders", () => {
    expect(interpolate("Topic: {{topicCode}} — {{topicTitle}}", {
      topicCode: "1.1",
      topicTitle: "Atomic structure",
    })).toBe("Topic: 1.1 — Atomic structure");
  });

  it("tolerates spaces inside the braces", () => {
    expect(interpolate("{{ topicCode }}", { topicCode: "1.1" })).toBe("1.1");
  });

  it("leaves an unknown placeholder visible instead of blanking it", () => {
    expect(interpolate("{{topicTitel}}", { topicTitle: "Typo" })).toBe("{{topicTitel}}");
  });

  it("renders numbers", () => {
    expect(interpolate("max {{maxCards}}", { maxCards: 8 })).toBe("max 8");
  });

  it("treats null and undefined as unfilled", () => {
    expect(interpolate("{{a}}/{{b}}", { a: null, b: undefined })).toBe("{{a}}/{{b}}");
  });

  it("handles an empty template", () => {
    expect(interpolate("", { a: 1 })).toBe("");
  });
});

describe("findPlaceholders", () => {
  it("lists each placeholder once", () => {
    expect(findPlaceholders("{{a}} {{a}} {{b}}").sort()).toEqual(["a", "b"]);
  });

  it("returns nothing for plain text", () => {
    expect(findPlaceholders("no placeholders")).toEqual([]);
  });
});

describe("resolveRunPlan", () => {
  const plan = () => {
    const pipeline = selectPipeline(REAL_PIPELINE.file, MATERIAL_GENERATION) as PipelineDefinition;
    return resolveRunPlan(pipeline, REAL_TOOLS.tools, {
      maxSteps: REAL_PIPELINE.file.maxPipelineSteps,
    });
  };

  it("produces a runnable plan from the shipped config", () => {
    const result = plan();
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("splits the steps into the four stages", () => {
    const result = plan();
    expect(result.pre.map((s) => s.toolName)).toEqual([
      "syllabus_list_topics",
      "syllabus_get_overlay",
    ]);
    expect(result.work.map((s) => s.toolName)).toEqual(["generate_flashcards", "generate_quiz"]);
    expect(result.gate?.toolName).toBe("review_gate");
    expect(result.commit?.toolName).toBe("materials_save");
  });

  it("runs only the model calls in the child process", () => {
    const result = plan();
    const childSteps = result.steps.filter((s) => s.executor === "child");
    expect(childSteps.map((s) => s.toolName)).toEqual(["generate_flashcards", "generate_quiz"]);
  });

  it("numbers steps from one in execution order", () => {
    expect(plan().steps.map((s) => s.index)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("errors when a step names a tool that does not exist", () => {
    const pipeline: PipelineDefinition = {
      name: "p",
      label: "p",
      description: "",
      steps: [
        {
          id: "step-0",
          toolName: "no_such_tool",
          label: "x",
          description: "",
          systemPromptTemplate: "",
          hintTemplate: "",
          enabled: true,
          isTerminal: false,
        },
      ],
    };
    const result = resolveRunPlan(pipeline, REAL_TOOLS.tools);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/not defined in agent-config\/tools.json/);
  });

  it("errors on duplicate step ids", () => {
    const step = {
      id: "step-0",
      toolName: "generate_flashcards",
      label: "x",
      description: "",
      systemPromptTemplate: "",
      hintTemplate: "",
      enabled: true,
      isTerminal: false,
    };
    const result = resolveRunPlan(
      { name: "p", label: "p", description: "", steps: [step, { ...step }] },
      REAL_TOOLS.tools,
    );
    expect(result.errors[0]).toMatch(/Duplicate step id/);
  });

  it("errors when every step is disabled", () => {
    const result = resolveRunPlan(
      {
        name: "p",
        label: "p",
        description: "",
        steps: [
          {
            id: "step-0",
            toolName: "generate_flashcards",
            label: "x",
            description: "",
            systemPromptTemplate: "",
            hintTemplate: "",
            enabled: false,
            isTerminal: false,
          },
        ],
      },
      REAL_TOOLS.tools,
    );
    expect(result.ok).toBe(false);
    expect(result.warnings[0]).toMatch(/disabled/);
  });

  it("warns about a template placeholder it cannot fill", () => {
    const result = resolveRunPlan(
      {
        name: "p",
        label: "p",
        description: "",
        steps: [
          {
            id: "step-0",
            toolName: "generate_flashcards",
            label: "x",
            description: "",
            systemPromptTemplate: "Explain {{topicTitel}}",
            hintTemplate: "",
            enabled: true,
            isTerminal: false,
          },
        ],
      },
      REAL_TOOLS.tools,
    );
    expect(result.warnings.some((w) => w.includes("topicTitel"))).toBe(true);
  });

  it("warns when a terminal step has no gate in front of it", () => {
    const result = resolveRunPlan(
      {
        name: "p",
        label: "p",
        description: "",
        steps: [
          {
            id: "step-0",
            toolName: "materials_save",
            label: "save",
            description: "",
            systemPromptTemplate: "",
            hintTemplate: "",
            enabled: true,
            isTerminal: true,
          },
        ],
      },
      REAL_TOOLS.tools,
    );
    expect(result.warnings.some((w) => w.includes("no review gate"))).toBe(true);
  });

  it("truncates at max_pipeline_steps", () => {
    const pipeline = selectPipeline(REAL_PIPELINE.file, MATERIAL_GENERATION) as PipelineDefinition;
    const result = resolveRunPlan(pipeline, REAL_TOOLS.tools, { maxSteps: 2 });
    expect(result.steps).toHaveLength(2);
    expect(result.warnings.some((w) => w.includes("max_pipeline_steps"))).toBe(true);
  });
});

describe("tool registry", () => {
  it("defines an executor for every tool in the committed template", () => {
    const unregistered = REAL_TOOLS.tools
      .map((tool) => tool.name)
      .filter((name) => TOOL_EXECUTORS[name] === undefined);
    expect(unregistered).toEqual([]);
  });

  it("gives the phase 3 material-generation tools an available executor", () => {
    for (const name of ["generate_flashcards", "generate_quiz", "review_gate", "materials_save"]) {
      expect(TOOL_EXECUTORS[name]).toMatchObject({ available: true });
    }
  });
});

describe("parseToolList and mergeToolLists", () => {
  const tool = (name: string, extra: Partial<ToolDef> = {}): ToolDef => ({
    name,
    description: "",
    terminal: false,
    handler: "direct",
    inputSchema: { type: "object", properties: {} },
    ...extra,
  });

  it("keeps the template tools merged in for a live file that lacks them", () => {
    const live = [tool("syllabus_list_topics")];
    const template = [tool("syllabus_list_topics"), tool("generate_flashcards")];
    const { tools, added } = mergeToolLists(live, template);
    expect(added).toEqual(["generate_flashcards"]);
    expect(tools).toHaveLength(2);
  });

  it("never overwrites a tool the user already has", () => {
    const live = [tool("generate_flashcards", { description: "mine" })];
    const template = [tool("generate_flashcards", { description: "shipped" })];
    const { tools, added } = mergeToolLists(live, template);
    expect(added).toEqual([]);
    expect(tools[0].description).toBe("mine");
  });

  it("drops an invalid tool name and keeps the rest", () => {
    const { tools, warnings } = parseToolList([{ name: "Not Valid" }, { name: "generate_quiz" }]);
    expect(tools.map((t) => t.name)).toEqual(["generate_quiz"]);
    expect(warnings[0]).toMatch(/invalid name/);
  });

  it("keeps the first definition when a tool is repeated", () => {
    const { tools, warnings } = parseToolList([tool("generate_quiz"), tool("generate_quiz")]);
    expect(tools).toHaveLength(1);
    expect(warnings[0]).toMatch(/more than once/);
  });

  it("warns when the file is not an array", () => {
    expect(parseToolList({}).warnings).toHaveLength(1);
  });
});

describe("validateAgentConfig", () => {
  it("passes the committed templates with no errors", () => {
    const report = validateAgentConfig({
      file: REAL_PIPELINE.file,
      tools: REAL_TOOLS.tools,
    });
    expect(report.errors).toEqual([]);
    expect(report.runnable).toContain(MATERIAL_GENERATION);
  });

  it("flags a terminal tool missing from terminal_tools", () => {
    const file = { ...REAL_PIPELINE.file, terminalTools: ["gmail_send_message", "calendar_create_event"] };
    const report = validateAgentConfig({ file, tools: REAL_TOOLS.tools });
    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.includes("materials_save"))).toBe(true);
  });

  it("flags a terminal_tools entry that is not a real tool", () => {
    const file = { ...REAL_PIPELINE.file, terminalTools: [...REAL_PIPELINE.file.terminalTools, "ghost_tool"] };
    const report = validateAgentConfig({ file, tools: REAL_TOOLS.tools });
    expect(report.errors.some((e) => e.includes("ghost_tool"))).toBe(true);
  });

  it("reports tools merged in from the template", () => {
    const report = validateAgentConfig({
      file: REAL_PIPELINE.file,
      tools: REAL_TOOLS.tools,
      addedTools: ["generate_flashcards"],
    });
    expect(report.warnings[0]).toMatch(/missing 1 shipped tool/);
  });

  it("counts a pipeline whose tools are unimplemented as non-runnable", () => {
    const socratic = selectPipeline(REAL_PIPELINE.file, "socratic") as PipelineDefinition;
    const file = { ...REAL_PIPELINE.file, pipelines: [socratic] };
    const report = validateAgentConfig({ file, tools: REAL_TOOLS.tools });
    // `syllabus_get_topic` is available, so the plan is structurally fine, but
    // `socratic_reply` is not implemented yet and must be warned about.
    expect(report.warnings.some((w) => w.includes("socratic_reply"))).toBe(true);
  });
});
