import { readFileSync } from "node:fs";

import type { Database } from "../database/db";
import { withTransaction } from "../database/migrations";
import type {
  OverlayConnection,
  OverlaySeedResult,
  OverlayTheme,
  ResolvedTheme,
  ResolvedThemeConnection,
  ResolvedThemeTopic,
} from "../../src/shared/scheduler-types";
import type { Subject, TopicStatus } from "../../src/shared/syllabus-types";
import { SUBJECTS } from "../../src/shared/syllabus-types";

/**
 * Cross-subject overlay themes.
 *
 * The committed `data/overlap-map.json` is the *source*, the database is the
 * working copy. Seeding is idempotent and one-way: the file's themes are upserted
 * and any seeded row that the file no longer mentions is removed, so editing the
 * JSON and restarting is enough to change the overlay map.
 *
 * Topics are keyed by syllabus **code**, never by row id. A theme has to keep
 * meaning the same thing after a syllabus is re-imported, and codes are the only
 * identifier stable across that.
 */

const THEME_SELECT = "SELECT theme, common_principle, source FROM overlay_themes ORDER BY theme";
// Ordered by id, not by code: `25` sorts before `7` as a string, which would
// silently reorder the codes the overlap map's author wrote.
const CONNECTION_SELECT =
  "SELECT id, theme, subject, concept, topic_code FROM overlay_theme_topics ORDER BY theme, id";

interface ThemeRow {
  theme: string;
  common_principle: string;
  source: string;
}

interface ConnectionRow {
  id: number;
  theme: string;
  subject: string;
  concept: string;
  topic_code: string;
}

function isSubject(value: unknown): value is Subject {
  return typeof value === "string" && (SUBJECTS as string[]).includes(value);
}

/**
 * Validate and normalise an overlap map.
 *
 * Deliberately forgiving: one malformed theme should not cost the user the other
 * three, so bad entries are skipped with a warning rather than thrown on.
 */
export function parseOverlapMap(raw: unknown): { themes: OverlayTheme[]; warnings: string[] } {
  const warnings: string[] = [];
  if (!raw || typeof raw !== "object") {
    return { themes: [], warnings: ["Overlap map is not an object."] };
  }

  const list = (raw as { themes?: unknown }).themes;
  if (!Array.isArray(list)) {
    return { themes: [], warnings: ["Overlap map has no `themes` array."] };
  }

  const themes: OverlayTheme[] = [];

  list.forEach((entry, index) => {
    const label = `Theme #${index + 1}`;
    if (!entry || typeof entry !== "object") {
      warnings.push(`${label} is not an object.`);
      return;
    }

    const record = entry as Record<string, unknown>;
    const theme = typeof record.theme === "string" ? record.theme.trim() : "";
    if (!theme) {
      warnings.push(`${label} has no name.`);
      return;
    }

    const rawConnections = record.connections;
    if (!Array.isArray(rawConnections)) {
      warnings.push(`${label} (${theme}) has no connections array.`);
      return;
    }

    const connections: OverlayConnection[] = [];
    rawConnections.forEach((connection, position) => {
      if (!connection || typeof connection !== "object") {
        warnings.push(`${theme}: connection #${position + 1} is not an object.`);
        return;
      }
      const item = connection as Record<string, unknown>;
      if (!isSubject(item.subject)) {
        warnings.push(`${theme}: connection #${position + 1} has an unknown subject.`);
        return;
      }
      const topicCodes = Array.isArray(item.topics)
        ? item.topics
            .map((code) => (typeof code === "string" ? code.trim() : String(code ?? "").trim()))
            .filter((code): code is string => code.length > 0)
        : [];
      if (!topicCodes.length) {
        warnings.push(`${theme}: ${item.subject} lists no topic codes.`);
        return;
      }
      connections.push({
        subject: item.subject,
        concept: typeof item.concept === "string" ? item.concept : "",
        topicCodes,
      });
    });

    if (!connections.length) {
      warnings.push(`${theme} has no usable connections and was skipped.`);
      return;
    }

    themes.push({
      theme,
      commonPrinciple: typeof record.commonPrinciple === "string" ? record.commonPrinciple : "",
      source: typeof record.source === "string" && record.source ? record.source : "seeded",
      connections,
    });
  });

  return { themes, warnings };
}

/** Read and parse an overlap map from disk, reporting failures instead of throwing. */
export function loadOverlapMapFile(file: string): { themes: OverlayTheme[]; warnings: string[] } {
  try {
    return parseOverlapMap(JSON.parse(readFileSync(file, "utf8")));
  } catch (error) {
    return { themes: [], warnings: [`Could not read ${file}: ${(error as Error).message}`] };
  }
}

/**
 * Write the given themes into the database, replacing whatever was seeded before.
 *
 * Only rows with `source = 'seeded'` are cleaned up, so a theme a user has added
 * by hand survives a re-seed.
 */
export function seedOverlayThemes(db: Database, themes: OverlayTheme[]): OverlaySeedResult {
  const upsertTheme = db.prepare(
    `INSERT INTO overlay_themes (theme, common_principle, source, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(theme) DO UPDATE SET
       common_principle = excluded.common_principle,
       source           = excluded.source,
       updated_at       = datetime('now')`,
  );
  const upsertConnection = db.prepare(
    `INSERT INTO overlay_theme_topics (theme, subject, concept, topic_code, source)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(theme, subject, topic_code) DO UPDATE SET
       concept = excluded.concept,
       source  = excluded.source`,
  );
  const selectSeededThemes = db.prepare("SELECT theme FROM overlay_themes WHERE source = 'seeded'");
  const selectSeededConnections = db.prepare(
    "SELECT id, subject, topic_code FROM overlay_theme_topics WHERE theme = ? AND source = 'seeded'",
  );
  const deleteConnection = db.prepare("DELETE FROM overlay_theme_topics WHERE id = ?");
  const deleteThemeConnections = db.prepare("DELETE FROM overlay_theme_topics WHERE theme = ?");
  const deleteTheme = db.prepare("DELETE FROM overlay_themes WHERE theme = ?");

  let connections = 0;
  let removed = 0;

  withTransaction(db, () => {
    const incoming = new Set(themes.map((theme) => theme.theme));
    const existingThemes = selectSeededThemes.all() as unknown as Array<{ theme: string }>;
    for (const row of existingThemes) {
      if (incoming.has(row.theme)) continue;
      removed += (selectSeededConnections.all(row.theme) as unknown[]).length;
      deleteThemeConnections.run(row.theme);
      deleteTheme.run(row.theme);
    }

    for (const theme of themes) {
      upsertTheme.run(theme.theme, theme.commonPrinciple, theme.source);

      const wanted = new Set(
        theme.connections.flatMap((connection) =>
          connection.topicCodes.map((code) => `${connection.subject}|${code}`),
        ),
      );
      const existing = selectSeededConnections.all(theme.theme) as unknown as Array<{
        id: number;
        subject: string;
        topic_code: string;
      }>;
      for (const row of existing) {
        if (wanted.has(`${row.subject}|${row.topic_code}`)) continue;
        deleteConnection.run(row.id);
        removed += 1;
      }

      for (const connection of theme.connections) {
        for (const code of connection.topicCodes) {
          upsertConnection.run(theme.theme, connection.subject, connection.concept, code, theme.source);
          connections += 1;
        }
      }
    }
  });

  return { themes: themes.length, connections, removed, warnings: [] };
}

/** Seed straight from the committed overlap map. */
export function seedOverlayMapFile(db: Database, file: string): OverlaySeedResult {
  const { themes, warnings } = loadOverlapMapFile(file);
  if (!themes.length) return { themes: 0, connections: 0, removed: 0, warnings };
  const result = seedOverlayThemes(db, themes);
  return { ...result, warnings };
}

/** Every theme with its connections, assembled from the two tables. */
export function listThemes(db: Database): OverlayTheme[] {
  const themeRows = db.prepare(THEME_SELECT).all() as unknown as ThemeRow[];
  const connectionRows = db.prepare(CONNECTION_SELECT).all() as unknown as ConnectionRow[];

  const grouped = new Map<string, OverlayConnection[]>();
  for (const row of connectionRows) {
    if (!isSubject(row.subject)) continue;
    const bucket = grouped.get(row.theme) ?? [];
    const existing = bucket.find((connection) => connection.subject === row.subject);
    if (existing) {
      existing.topicCodes.push(row.topic_code);
    } else {
      bucket.push({ subject: row.subject, concept: row.concept, topicCodes: [row.topic_code] });
    }
    grouped.set(row.theme, bucket);
  }

  return themeRows.map((row) => ({
    theme: row.theme,
    commonPrinciple: row.common_principle,
    source: row.source,
    connections: grouped.get(row.theme) ?? [],
  }));
}

export function getTheme(db: Database, theme: string): OverlayTheme | null {
  return listThemes(db).find((entry) => entry.theme === theme) ?? null;
}

export function themesForTopicCodes(db: Database, codes: string[]): string[] {
  if (!codes.length) return [];
  const placeholders = codes.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT DISTINCT theme FROM overlay_theme_topics WHERE topic_code IN (${placeholders}) ORDER BY theme`,
    )
    .all(...codes) as unknown as Array<{ theme: string }>;
  return rows.map((row) => row.theme);
}

/**
 * Match a theme's topic codes against the topics that actually exist, so the UI
 * only ever offers links the user can open.
 *
 * Matching is scoped **per subject** as well as per code. Each subject is its own
 * `syllabus` row (the table is unique on `subject, board, level`), so a theme leg
 * only counts when its code appears in a syllabus *for that subject* — otherwise a
 * chemistry code that happens to exist in the biology syllabus would be counted as
 * a chemistry link.
 *
 * `syllabusIds` narrows the search to specific syllabi (typically the active set,
 * one per subject). Omitting it searches every syllabus.
 */
export function resolveTheme(
  db: Database,
  theme: string,
  syllabusIds?: number[] | null,
): ResolvedTheme | null {
  const entry = getTheme(db, theme);
  if (!entry) return null;

  const restrict = syllabusIds?.length ? syllabusIds : null;
  const scopeSql = restrict
    ? `AND t.syllabus_id IN (${restrict.map(() => "?").join(", ")})`
    : "";
  const findTopics = db.prepare(
    `SELECT t.id, t.code, t.title, t.status
       FROM syllabus_topics t
       JOIN syllabus s ON s.id = t.syllabus_id
      WHERE t.archived_at IS NULL
        AND s.subject = ?
        AND t.code = ?
        ${scopeSql}
      ORDER BY t.id`,
  );

  const connections: ResolvedThemeConnection[] = entry.connections.map((connection) => {
    const topics: ResolvedThemeTopic[] = [];
    for (const code of connection.topicCodes) {
      const args: Array<string | number> = [connection.subject, code, ...(restrict ?? [])];
      const rows = findTopics.all(...args) as unknown as Array<{
        id: number;
        code: string;
        title: string;
        status: TopicStatus;
      }>;
      for (const row of rows) {
        if (topics.some((topic) => topic.id === row.id)) continue;
        topics.push({ id: row.id, code: row.code, title: row.title, status: row.status });
      }
    }
    return { ...connection, topics };
  });

  const topicIds = [...new Set(connections.flatMap((c) => c.topics.map((t) => t.id)))];

  return {
    ...entry,
    connections,
    topicIds,
    subjectCount: connections.filter((connection) => connection.topics.length > 0).length,
  };
}

/** Every stored theme, resolved against the given syllabi. */
export function resolveAllThemes(db: Database, syllabusIds?: number[] | null): ResolvedTheme[] {
  return listThemes(db)
    .map((theme) => resolveTheme(db, theme.theme, syllabusIds))
    .filter((theme): theme is ResolvedTheme => theme !== null);
}

/** Remove a theme and its connections. */
export function deleteTheme(db: Database, theme: string): boolean {
  return withTransaction(db, () => {
    db.prepare("DELETE FROM overlay_theme_topics WHERE theme = ?").run(theme);
    const result = db.prepare("DELETE FROM overlay_themes WHERE theme = ?").run(theme);
    return Number(result.changes) > 0;
  });
}
