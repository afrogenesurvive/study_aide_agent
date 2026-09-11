import type { Database } from "../../services/database/db";
import * as syllabusRepo from "../../services/syllabus/repo";
import type { Subject } from "../../src/shared/syllabus-types";

/** Shared fixtures for the FSRS suites. */

/** A fixed instant, so every due-date assertion is deterministic. */
export const NOW = new Date("2026-09-10T12:00:00.000Z");
export const NOW_ISO = "2026-09-10T12:00:00.000Z";

export interface SeededSyllabus {
  syllabusId: number;
  topicIds: number[];
}

/**
 * Create a syllabus with one topic per code.
 *
 * Goes through the real syllabus repository rather than raw SQL so the tests
 * exercise the same code path the importer uses.
 */
export function seedSyllabus(
  db: Database,
  subject: Subject,
  codes: string[],
): SeededSyllabus {
  const syllabusId = syllabusRepo.createSyllabus(db, {
    subject,
    board: "cambridge",
    level: "a-level",
    title: `${subject} fixture`,
  });
  const topicIds = codes.map((code, index) =>
    syllabusRepo.upsertTopic(db, syllabusId, {
      code,
      title: `Topic ${code}`,
      section: "Section 1",
      orderIndex: index,
    }),
  );
  return { syllabusId, topicIds };
}

export interface CardSeed {
  question: string;
  answer: string;
  topicId?: number | null;
  state?: string;
  dueAt?: string | null;
  difficulty?: number | null;
  stability?: number | null;
  lastReview?: string | null;
  elapsedDays?: number;
  scheduledDays?: number;
  learningSteps?: number;
  reps?: number;
  lapses?: number;
  archivedAt?: string | null;
}

/**
 * Insert a card directly.
 *
 * `repo.createCard` always produces a brand-new, immediately-due card, which is
 * the wrong starting point for testing the queues — those need cards in
 * arbitrary states. Writing the row directly is the point of this helper.
 */
export function insertCard(db: Database, seed: CardSeed): number {
  const result = db
    .prepare(
      `INSERT INTO flashcards
         (topic_id, question, answer, source, state, next_review, last_review,
          difficulty, stability, elapsed_days, scheduled_days, learning_steps,
          reps, lapses, archived_at, created_at, updated_at)
       VALUES (?, ?, ?, 'manual', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      seed.topicId ?? null,
      seed.question,
      seed.answer,
      seed.state ?? "new",
      seed.dueAt === undefined ? NOW_ISO : seed.dueAt,
      seed.lastReview ?? null,
      seed.difficulty ?? null,
      seed.stability ?? null,
      seed.elapsedDays ?? 0,
      seed.scheduledDays ?? 0,
      seed.learningSteps ?? 0,
      seed.reps ?? 0,
      seed.lapses ?? 0,
      seed.archivedAt ?? null,
      NOW_ISO,
      NOW_ISO,
    );
  return Number(result.lastInsertRowid);
}
