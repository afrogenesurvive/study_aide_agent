import { useEffect, useRef, useState } from "react";

import type { IconName } from "../../icons";
import type { PlanBlock, PlanBlockKind, StudyPlan } from "../../../shared/scheduler-types";

/**
 * The session stepper's single source of truth.
 *
 * Mirrors the `pipelineStages.ts` pattern from the reference app: the stage list
 * is derived once and shared by the live stepper and any summary view, so the two
 * can never drift. The one addition here is `useMaxReachedStage`, which keeps the
 * stepper from visually regressing when a user steps back to an earlier block.
 */

export type StageState = "done" | "active" | "pending";

export interface StageDef {
  key: string;
  index: number;
  label: string;
  icon: IconName;
  kind: PlanBlockKind;
  minutes: number;
  startsAt: string;
}

const KIND_ICONS: Record<PlanBlockKind, IconName> = {
  intention: "check",
  subject: "review",
  break: "session",
  synthesis: "analytics",
};

export function stageFromBlock(block: PlanBlock): StageDef {
  return {
    key: `block-${block.index}`,
    index: block.index,
    label: block.label,
    icon: KIND_ICONS[block.kind],
    kind: block.kind,
    minutes: block.minutes,
    startsAt: block.startsAt,
  };
}

export function stagesFromPlan(plan: StudyPlan | null): StageDef[] {
  return plan?.blocks.map(stageFromBlock) ?? [];
}

export function stateFor(index: number, activeIndex: number, maxReached: number): StageState {
  if (index === activeIndex) return "active";
  return index < maxReached ? "done" : "pending";
}

/**
 * The furthest stage reached so far.
 *
 * Reset by `resetKey` (the plan id or date) so a new day starts at the top. The
 * guard exists so that stepping back to re-read block 2 does not grey out blocks
 * 3 and 4, which the user has already worked through.
 */
export function useMaxReachedStage(activeIndex: number, resetKey: unknown): number {
  const maxRef = useRef(0);
  const [maxReached, setMaxReached] = useState(0);

  useEffect(() => {
    maxRef.current = 0;
    setMaxReached(0);
  }, [resetKey]);

  useEffect(() => {
    if (activeIndex <= maxRef.current) return;
    maxRef.current = activeIndex;
    setMaxReached(activeIndex);
  }, [activeIndex]);

  return maxReached;
}
